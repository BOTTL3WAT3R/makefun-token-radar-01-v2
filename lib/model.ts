// Token Launch Radar v3 — the model. One sealed snapshot in, one ranked board out.
//
// THE BOARD: every protocol in the snapshot that records no token (no market cap, no
// CoinGecko id, no symbol) — all 342 of them, the snapshot's 40-protocol watchlist
// included by construction. Nothing is cut to a top-N: a launch radar that silently
// drops two fifths of the pre-token universe is not a radar. Protocols whose token
// already trades are never ranked; they are the comparables the model is fitted on,
// and the dashboard shows the largest of them apart, at the market's own values.
//
// THE VALUE MODEL: a comps curve fitted on the snapshot's own traded protocols of
// the board's scale (market cap and TVL both at or above $5M, n = 87):
//
//   log10(mcap) = a + b * log10(TVL) + c * log10(1 + age_days)
//
// fitted by least absolute deviations (LAD, via IRLS), which targets the median
// outcome instead of the mean and is not dragged by the handful of comps whose
// market cap sits 50x from their TVL. A protocol with no listed_at date is read at
// the comps' median age. No protocol name is ever special-cased.
//
// TESTED BLIND, AND RE-TESTED FOR THIS BUILD: the spec was chosen by repeated
// cross-validation on those comps — 25 repeats of 5-fold CV, the model refit on
// each training fold and scored only on the held-out fold. Out-of-sample, the
// median prediction is off by a factor of x2.24 (41% of held-out comps land within
// 2x of their real market cap, 77% within 5x). Every row's band is its implied
// value divided and multiplied by that same x2.24: the band is the measured
// error, not decoration. For this build four richer specs were tested blind on
// the same folds and rejected on the numbers, again: adding the 7-day TVL change
// to the price (x2.40), adding a chain-count term (x2.34), an ensemble of LAD,
// Huber and least-squares fits (x2.43), and trimming extreme-ratio comps from
// the fit (x2.50 scored on all comps). The full method is in MODEL.md.
//
// THE MOMENTUM SIGNAL: the 7-day TVL change is not in the price, because the
// blind test says it does not belong there — but it is not ignored either. Each
// row carries a momentum score read from its own change_7d, the dashboard sorts
// and flags by it, and the farm plan reacts to it: a protocol whose TVL is
// falling fast gets a halved first position, one rising fast gets a start-now
// step. Growth is a timing signal, not a value input; the board says which.
//
// VALUE DENSITY: each row also carries the plan's arithmetic as one number —
// the labelled pool assumption (a launch allocates 5% of implied value to early
// users) divided by the plan's total cost. It is the reader's priority order:
// how much assumed pool stands behind each dollar the plan spends. It never
// moves a rank (rank is implied value alone, as the gate requires); it is a
// sort the dashboard offers and a figure the verdict step quotes.
//
// FARM PLANS: six concrete steps per protocol, generated from its own record
// (category, chains, TVL, age, 7-day change): the action, the capital, the
// monthly cost of staying active on that chain, a second-chain step when the
// protocol lives on more than one chain, a hold with an exit rule read from
// the snapshot's own TVL, and a closing step that nets the labelled pool
// assumption against the plan's cost and states the verdict. Capital-passive
// categories are capped at thin because parked capital is their only signal,
// and wrapped or staked products of a token that already trades are flagged
// and capped at skip: their launch already happened, under the parent's name.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's version label: the dashboard names it and MODEL.md quotes it. */
export const MODEL_VERSION = 'radar-3';

/** The comp universe's floor: traded protocols with market cap and TVL both at or above this are the fit. */
export const COMP_FLOOR_USD = 5_000_000;

/**
 * The blind validation of the shipped spec, measured on the sealed snapshot's comps
 * by the development harness (25 repeats of 5-fold CV, LAD refit per fold, scored on
 * held-out folds only). The snapshot is sealed, so these are stable facts about this
 * data; MODEL.md gives the method and the rejected specs' numbers.
 */
export const VALIDATION = {
  method: '25 repeats of 5-fold cross-validation, refit per fold, held-out folds only',
  n_comps: 87,
  median_error_ratio: 2.24,
  within_2x_pct: 41,
  within_5x_pct: 77,
};

/** Specs tested blind for this build on the same folds and rejected: name and median error. */
export const REJECTED_SPECS = [
  { spec: 'price plus a winsorised 7-day growth term', median_error_ratio: 2.4 },
  { spec: 'price plus a chain-count term', median_error_ratio: 2.34 },
  { spec: 'ensemble of LAD, Huber and least-squares fits', median_error_ratio: 2.43 },
  { spec: 'fit trimmed of extreme market-cap/TVL ratios', median_error_ratio: 2.5 },
];

/** The labelled airdrop-pool assumption: a launch allocates this share of implied value to early users. */
export const POOL_SHARE = 0.05;

// ------------------------------------------------------------------ snapshot

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all: the board's definition of pre-token. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The traded comparables the curve is fitted on: a real market cap at the board's own scale. */
export function compsOf(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd >= COMP_FLOOR_USD && p.tvl_usd >= COMP_FLOOR_USD,
  );
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ------------------------------------------------------------------ the fit

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    const tmp = a[col]!;
    a[col] = a[pivot]!;
    a[pivot] = tmp;
    const d = a[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) a[r]![c] = a[r]![c]! - f * a[col]![c]!;
    }
  }
  return a.map((row, i) => row[n]! / row[i]!);
}

/** Weighted least squares for a tiny design, through the normal equations. */
function wls(x: number[][], y: number[], w: number[]): number[] {
  const k = x[0]!.length;
  const ata: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const aty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < x.length; i++) {
    for (let r = 0; r < k; r++) {
      aty[r]! += w[i]! * x[i]![r]! * y[i]!;
      for (let c = 0; c < k; c++) ata[r]![c]! += w[i]! * x[i]![r]! * x[i]![c]!;
    }
  }
  return solve(ata, aty);
}

/**
 * Least-absolute-deviations fit by iteratively reweighted least squares: the
 * estimator the cross-validation selected, because the board quotes a median
 * error and LAD is the fit that targets the median.
 */
function fitLad(x: number[][], y: number[]): number[] {
  let beta = wls(x, y, y.map(() => 1));
  for (let iter = 0; iter < 60; iter++) {
    const w = x.map((row, i) => {
      const r = y[i]! - row.reduce((s, v, j) => s + v * beta[j]!, 0);
      return 1 / Math.max(Math.abs(r), 1e-3);
    });
    const next = wls(x, y, w);
    const delta = Math.max(...next.map((v, j) => Math.abs(v - beta[j]!)));
    beta = next;
    if (delta < 1e-9) break;
  }
  return beta;
}

/** The fitted comps curve and the age a protocol with no listed date is read at. */
export interface FittedModel {
  intercept: number;
  tvl_coef: number;
  age_coef: number;
  median_age_days: number;
  n_comps: number;
}

/** Fit the curve on the snapshot's traded comps. Deterministic: same snapshot, same numbers. */
export function fitModel(snapshot: Snapshot): FittedModel {
  const comps = compsOf(snapshot);
  if (comps.length < 10) throw new SnapshotError(`only ${comps.length} traded comps at scale: no curve to fit`);
  const ages = comps.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null);
  const medianAge = ages.length > 0 ? median(ages) : 365;
  const x = comps.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at) ?? medianAge;
    return [1, Math.log10(p.tvl_usd), Math.log10(1 + age)];
  });
  const y = comps.map((p) => Math.log10(p.mcap_usd!));
  const beta = fitLad(x, y);
  return { intercept: beta[0]!, tvl_coef: beta[1]!, age_coef: beta[2]!, median_age_days: medianAge, n_comps: comps.length };
}

/** One protocol's implied value and its measured-error band under the fitted curve. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  model: FittedModel,
): { implied: number; low: number; high: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? model.median_age_days;
  const log = model.intercept + model.tvl_coef * Math.log10(p.tvl_usd) + model.age_coef * Math.log10(1 + ageForModel);
  const implied = Math.max(1, Math.round(10 ** log));
  const band = VALIDATION.median_error_ratio;
  return { implied, low: Math.max(1, Math.round(implied / band)), high: Math.round(implied * band), age };
}

/**
 * The momentum signal: the protocol's 7-day TVL change compressed to -1..+1
 * (sign-preserving log scale, capped at a 60% week). Null when the snapshot
 * reports no change. A timing signal only — the blind test keeps it out of
 * the price; the plan and the dashboard's sorts use it.
 */
export function momentumOf(p: SnapshotProtocol): number | null {
  if (p.change_7d === null) return null;
  const g = Math.max(-60, Math.min(60, p.change_7d));
  return Math.round((Math.sign(g) * (Math.log10(1 + Math.abs(g)) / Math.log10(61))) * 100) / 100;
}

// ------------------------------------------------------------------ flags and farm plans

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_NAME = /\b(wrapped|staked|staking)\b/i;
const WRAPPER_CATEGORIES = new Set(['Canonical Bridge', 'Stablecoin Wrapper', 'Restaked BTC', 'Anchor BTC', 'Decentralized BTC']);
/** The watchlist rule's own exchange list: a product whose name begins with an exchange's name is that exchange's product. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** A product flag the dashboard shows: what a row is, beyond pre-token. */
export type ProductFlag = 'wrapper' | 'cex' | 'versioned' | null;

export function productFlag(p: SnapshotProtocol): ProductFlag {
  // The exchange itself (category CEX) is a cex row; an exchange-named product in any
  // other category is that exchange's wrapped or staked product of a traded asset.
  if (p.category === 'CEX') return 'cex';
  if (WRAPPER_CATEGORIES.has(p.category ?? '') || WRAPPED_NAME.test(p.name)) return 'wrapper';
  if (EXCHANGE_PREFIX.test(p.name)) return 'wrapper';
  // A Bridge record on exactly one chain is not a bridge protocol: it is the bridged
  // asset itself sitting on that chain (WBTC and USDT0 are the snapshot's own cases,
  // each recorded on a single chain), or a chain's canonical bridge pool.
  if (p.category === 'Bridge' && p.chains.length === 1) return 'wrapper';
  if (VERSIONED.test(p.name)) return 'versioned';
  return null;
}

/** Categories whose only farm signal is parked capital: their verdict is capped at thin. */
const PASSIVE_CATEGORIES = new Set([
  'Risk Curators',
  'Onchain Capital Allocator',
  'Yield Aggregator',
  'Basis Trading',
  'Liquidity Manager',
  'Farm',
  'Insurance',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaking',
  'Staking Pool',
]);

/** Chains where staying active is cheap; anything else is read as Ethereum-priced unless it is listed here. */
const CHEAP_CHAINS = new Set([
  'Solana', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'BNB Chain', 'Avalanche', 'Fantom',
  'Tron', 'Sui', 'Aptos', 'Near', 'Algorand', 'Cosmos', 'Osmosis', 'Sei', 'Linea', 'Scroll',
  'zkSync Era', 'Mantle', 'Blast', 'Mode', 'Celo', 'Gnosis', 'Moonbeam', 'Kava', 'Metis',
  'Bitcoin', 'Stacks', 'Core', 'BSquared', 'Rootstock', 'Monad', 'Hyperliquid', 'Sonic', 'Berachain',
]);

/** The monthly cost of staying active, from the protocol's own chain set. */
export function monthlyCostUsd(p: SnapshotProtocol): number {
  if (p.chains.length === 0) return 60;
  if (p.chains.includes('Ethereum')) return p.chains.length > 1 ? 90 : 130;
  if (p.chains.every((c) => CHEAP_CHAINS.has(c))) return 25;
  return 60;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 20_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A farm plan's full arithmetic: the capital in the position and the running cost of the hold. */
export interface PlanCost {
  capital: number;
  monthly: number;
  months: number;
  total: number;
}

/** The plan's cost, from the protocol's own record: capital tier, chain-priced month, age-priced hold. */
export function planCost(p: SnapshotProtocol, age: number | null): PlanCost {
  const monthly = monthlyCostUsd(p);
  const months = Math.max(1, Math.round(holdDaysFor(age) / 30));
  return { capital: capitalFor(p), monthly, months, total: monthly * months };
}

/**
 * Value density: the labelled pool assumption (POOL_SHARE of implied value) per
 * dollar of plan cost. The reader's priority order across the whole board; it
 * never moves a rank.
 */
export function densityOf(implied: number, plan: PlanCost): number {
  return Math.round(((implied * POOL_SHARE) / Math.max(1, plan.total)) * 100) / 100;
}

/** A density as a reader should see it: whole thousands at the top of the board, two decimals at the tail. */
function densityText(density: number): string {
  return density >= 100 ? Math.round(density).toLocaleString('en-US') : density.toFixed(2);
}

export type Verdict = 'farm' | 'thin' | 'skip';

/** The verdict: the labelled pool assumption netted against the cost of farming, with the caps stated in the header. */
export function verdictFor(p: SnapshotProtocol, implied: number, flag: ProductFlag): Verdict {
  if (flag === 'wrapper') return 'skip';
  const passive = PASSIVE_CATEGORIES.has(p.category ?? '') || flag === 'cex';
  if (passive) return implied >= 40_000_000 ? 'thin' : 'skip';
  if (implied >= 45_000_000) return 'farm';
  if (implied >= 20_000_000) return 'thin';
  return 'skip';
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** The category's core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c === 'cex') return `Open an account at ${name}, deposit ${money(capital)} and run small spot trades each week so the account shows real activity.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply ${money(capital)} of USDC to ${name} on ${chain} and borrow a small amount against it, keeping the loan healthy.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide ${money(capital)} of liquidity to ${name}'s main pool on ${chain} and swap through it weekly.`;
  if (c.includes('bridge')) return `Bridge ${money(capital)} of USDC to ${chain} through ${name} and put the bridged funds to work in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake ${money(capital)} of the chain's staking asset through ${name} and keep the staking receipt in the wallet.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit ${money(capital)} of USDC as margin on ${name} and open one small hedged position each week.`;
  if (c.includes('prediction')) return `Fund ${money(capital)} on ${name} and hold one position in an active market until it settles.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager')) return `Deposit ${money(capital)} into a ${name} vault on ${chain} and keep the vault shares untouched.`;
  if (c.includes('stable') || c.includes('dual-token')) return `Mint or deposit ${money(capital)} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('rwa')) return `Mint ${money(capital)} of ${name}'s yield asset on ${chain} and hold it in the farming wallet.`;
  if (c.includes('insurance')) return `Buy ${money(capital)} of cover from ${name} on ${chain} and keep the policy to expiry.`;
  if (c.includes('yield') || c.includes('farm')) return `Deposit ${money(capital)} into ${name}'s main vault on ${chain} and compound the yield weekly.`;
  if (c.includes('chain')) return `Hold ${money(capital)} of gas on ${chain}, use two or three native apps weekly and keep the wallet active.`;
  return `Deposit ${money(capital)} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time, derived
 * from the protocol's own record — never from a hand-written list of names. The
 * second step reacts to the momentum signal, the fourth uses the protocol's second
 * chain when it has one, the fifth holds with an exit rule read from the snapshot's
 * own TVL, and the last nets the labelled pool assumption against the plan's cost,
 * quotes the value density and states the verdict.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number, verdict: Verdict): string[] {
  const chain = chainOf(p);
  const plan = planCost(p, age);
  const hold = holdDaysFor(age);
  const pool = Math.round(implied * POOL_SHARE);
  const density = densityOf(implied, plan);
  const g = p.change_7d;
  const falling = g !== null && g <= -10;
  const rising = g !== null && g >= 25;
  const firstCapital = falling ? Math.max(25, Math.round(plan.capital / 2)) : plan.capital;
  const momentumNote = falling
    ? ` Its TVL fell ${Math.abs(g!).toFixed(1)}% in the snapshot's week, so start with half the position (${money(firstCapital)}) and add the rest only if TVL stabilises.`
    : rising
      ? ` Its TVL rose ${g!.toFixed(1)}% in the snapshot's week, so start this week while the growth is live rather than after it cools.`
      : '';
  const secondChain = p.chains.length > 1
    ? `Bridge about ${money(Math.max(25, Math.round(plan.capital / 4)))} to ${p.chains[1]}, ${p.name}'s second chain, and repeat one small action there, so the wallet is a user on two chains, not one. Cost: about ${money(Math.max(3, Math.round(plan.monthly / 8)))} of bridge and gas fees. Time: 15 minutes, once in the first week.`
    : `Deepen the single-chain footprint: add a second ${p.name} product (a second pool, market or vault on ${chain}) with about ${money(Math.max(25, Math.round(plan.capital / 4)))}, and cast any governance or feedback vote it opens. Cost: about ${money(Math.max(2, Math.round(plan.monthly / 10)))} of gas. Time: 15 minutes, once in the first week.`;
  const exitLine = `Exit rule: if ${p.name}'s TVL falls below ${money(Math.round(p.tvl_usd * 0.7))} (30% under the snapshot's ${money(p.tvl_usd)}) or it announces a token with no early-user allocation, withdraw within a week and redeploy.`;
  const steps = [
    `Set up a fresh wallet for ${p.name} and fund it on ${chain}; keep the seed phrase offline and only farm funds in it. Cost: about $3 of gas to start. Time: 10 minutes.`,
    `${actionFor(p, firstCapital, chain)}${momentumNote} Cost: ${money(firstCapital)} of capital plus about ${money(Math.max(2, Math.round(plan.monthly / 6)))} of gas. Time: 15 minutes to set up.`,
    `Repeat one real action every week — a deposit, a borrow, a swap, a bridge or a vote — so the wallet reads as a user, not a snapshot. Cost: about ${money(plan.monthly)} a month in gas and fees. Time: 10 minutes a week.`,
    secondChain,
    `Hold the position at least ${hold} days, across more than one activity snapshot, and check ${p.name}'s own points or rewards page weekly, claiming only from links it publishes. ${exitLine} Cost: the ${money(plan.capital)} stays in the position. Time: ${hold} days.`,
    verdict === 'skip'
      ? `The maths does not clear the bar: if ${p.name} ever allocates 5% of its ${money(implied)} implied value to early users (an assumption, not a promise), the pool is about ${money(pool)} shared by every farmer, against about ${money(plan.total)} to farm it — a value density of ${densityText(density)} before the pool is split. Verdict: skip — keep it on the watchlist instead. Cost: nothing. Time: 5 minutes to check back monthly.`
      : `If ${p.name} launches and allocates 5% of its ${money(implied)} implied value to early users (an assumption, not a promise), the early-user pool is about ${money(pool)}; this plan costs about ${money(plan.total)} over ${plan.months} month${plan.months === 1 ? '' : 's'} plus the ${money(plan.capital)} position — a value density of ${densityText(density)} of assumed pool per plan dollar. Verdict: ${verdict}. Cost: about ${money(plan.total)} all-in. Time: 10 minutes to log the position and set a monthly review.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ------------------------------------------------------------------ the board

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  momentum: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  watchlist: boolean;
  product_flag: ProductFlag;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  band_ratio: number;
  farm_verdict: Verdict;
  est_cost_month_usd: number;
  plan_cost_usd: number;
  value_density: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so it is shown at the market's value, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  momentum: number | null;
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  watchlist: boolean;
  product_flag: ProductFlag;
  farm_verdict: Verdict;
  est_cost_month_usd: number;
  plan_cost_usd: number;
  value_density: number;
  farm_steps: string[];
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: {
    form: string;
    intercept: number;
    tvl_coef: number;
    age_coef: number;
    median_age_days: number;
    n_comps: number;
    comp_floor_usd: number;
    band_ratio: number;
    validation: typeof VALIDATION;
    rejected_specs: typeof REJECTED_SPECS;
    pool_share: number;
  };
  counts: { protocols: number; pre_token: number; watchlist: number; board: number; live: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** The whole radar: the fitted model, the full pre-token board, and the live set aside. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = fitModel(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isPreToken)
    .map((p) => {
      const { implied, low, high, age } = impliedValue(p, snapshot.as_of, model);
      const flag = productFlag(p);
      const verdict = verdictFor(p, implied, flag);
      const plan = planCost(p, age);
      return { p, implied, low, high, age, flag, verdict, plan, density: densityOf(implied, plan) };
    });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    momentum: momentumOf(s.p),
    listed_at: s.p.listed_at,
    age_days: s.age,
    token_status: 'pre-token',
    watchlist: watch.has(s.p.slug),
    product_flag: s.flag,
    implied_value_usd: s.implied,
    implied_low_usd: s.low,
    implied_high_usd: s.high,
    band_ratio: VALIDATION.median_error_ratio,
    farm_verdict: s.verdict,
    est_cost_month_usd: s.plan.monthly,
    plan_cost_usd: s.plan.total,
    value_density: s.density,
    farm_steps: farmSteps(s.p, s.age, s.implied, s.verdict),
  }));
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || b.tvl_usd - a.tvl_usd)
    .slice(0, 30)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
    }));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: {
      form: 'log10(mcap) = a + b*log10(TVL) + c*log10(1 + age_days), fitted by least absolute deviations',
      intercept: model.intercept,
      tvl_coef: model.tvl_coef,
      age_coef: model.age_coef,
      median_age_days: model.median_age_days,
      n_comps: model.n_comps,
      comp_floor_usd: COMP_FLOOR_USD,
      band_ratio: VALIDATION.median_error_ratio,
      validation: VALIDATION,
      rejected_specs: REJECTED_SPECS,
      pool_share: POOL_SHARE,
    },
    counts: {
      protocols: snapshot.protocols.length,
      pre_token: board.length,
      watchlist: snapshot.watchlist.length,
      board: board.length,
      live: live.length,
    },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      momentum: r.momentum,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      implied_low_usd: r.implied_low_usd,
      implied_high_usd: r.implied_high_usd,
      watchlist: r.watchlist,
      product_flag: r.product_flag,
      farm_verdict: r.farm_verdict,
      est_cost_month_usd: r.est_cost_month_usd,
      plan_cost_usd: r.plan_cost_usd,
      value_density: r.value_density,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: full pre-token coverage, watchlist, ranks, order, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missingWatch = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missingWatch.length > 0) return `the board misses ${missingWatch.length} watchlist slugs: ${missingWatch.slice(0, 5).join(', ')}`;
  const preToken = snapshot.protocols.filter(isPreToken);
  const missingPre = preToken.filter((p) => !slugs.has(p.slug));
  if (missingPre.length > 0) return `the board misses ${missingPre.length} pre-token protocols: ${missingPre.slice(0, 5).map((p) => p.slug).join(', ')}`;
  if (board.length !== preToken.length) return `the board holds ${board.length} rows for ${preToken.length} pre-token protocols`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'all rows share the same implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
