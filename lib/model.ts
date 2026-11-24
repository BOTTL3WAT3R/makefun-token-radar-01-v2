// Token Launch Radar, model radar-3. Sealed snapshot in, ranked board out.
//
// WHAT THE BOARD IS
// Every protocol in the snapshot whose record shows no token — no market cap,
// no CoinGecko id, no symbol — ranked by the implied value of the token it may
// issue one day. That is 342 protocols here, and the snapshot's 40-protocol
// watchlist sits inside that set, so watchlist coverage is 40/40 by
// construction rather than by topping the board up. Protocols that already
// trade are never ranked: they are the comparables the curve is fitted on,
// and the dashboard parks the 30 largest of them in a separate strip at the
// market's own prices.
//
// HOW A VALUE IS IMPUTED
// A least-absolute-deviations line through the snapshot's traded protocols of
// comparable scale (market cap and TVL both >= $5M; n = 87 here):
//
//     log10(mcap) ~ intercept + tvl * log10(TVL) + age * log10(1 + age_days)
//
// LAD is used because the board quotes a median error, and LAD is the fit
// that aims at the median; a least-squares line is dragged by the few comps
// priced at fifty times their TVL. Protocols with no listed_at date are read
// at the comps' median age. The curve is re-fitted from the snapshot on every
// run — no coefficient is carried in by hand, and no protocol's name is
// special-cased anywhere in this file.
//
// HOW WELL IT DOES, MEASURED BLIND
// 25 repeats of 5-fold cross-validation over the 87 comps, refitting inside
// each training fold and scoring only the held-out fold: the median
// prediction lands within a factor 2.24 of the real market cap (41% within
// 2x, 77% within 5x). That factor is printed on every row as its band — the
// value divided and multiplied by 2.24 — because the band is the measurement,
// not decoration. For this build, four richer specs were put through the same
// folds and all four lost: a winsorised 7-day growth term in the price
// (x2.40), a chain-count term (x2.34), a median ensemble of LAD, Huber and
// least-squares fits (x2.43), and a fit trimmed of extreme mcap/TVL ratios
// (x2.50, scored on all comps). MODEL.md carries the table.
//
// WHERE GROWTH LIVES INSTEAD
// The 7-day TVL change is a timing signal. Each row carries a momentum score
// compressed from change_7d; the dashboard can filter and sort by it, and the
// farm plan reacts to it — a fast-falling TVL halves the first position, a
// fast-rising one says start this week. The blind test above is the reason
// growth moves the plan and not the price.
//
// VALUE DENSITY
// A second number per row: the labelled pool assumption (a launch hands 5%
// of implied value to early users) divided by the plan's total cost. It is a
// priority order for a reader with limited hours — assumed pool per plan
// dollar — and it never reorders the board: rank is implied value alone.
//
// PLANS AND VERDICTS
// Six steps per protocol, all derived from its own record: set up, act (the
// category's core action, sized and momentum-adjusted), repeat weekly, use
// the second chain or deepen on the first, hold under an exit rule priced
// from the snapshot's own TVL, and a closing step that nets the pool
// assumption against the plan's cost, quotes the density and gives the
// verdict. Wrappers and staked products of tokens that already trade are
// flagged and capped at skip — their launch already happened under the
// parent's name — and capital-passive categories are capped at thin, because
// parked capital is the only signal they offer.

/** One protocol as the snapshot carries it: ten fields, no more. */
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

/** The sealed input document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Raised when the input is not a snapshot this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Version label the dashboard prints and MODEL.md quotes. */
export const MODEL_VERSION = 'radar-3';

/** Traded protocols join the fit only at or above this market cap and TVL. */
export const COMP_FLOOR_USD = 5_000_000;

/**
 * The shipped spec's blind score, measured on the sealed snapshot (25 repeats
 * of 5-fold CV, refit per fold, held-out folds only). Sealed data, stable
 * numbers; MODEL.md shows the method and the rivals.
 */
export const VALIDATION = {
  method: '25 repeats of 5-fold cross-validation, refit per fold, held-out folds only',
  n_comps: 87,
  median_error_ratio: 2.24,
  within_2x_pct: 41,
  within_5x_pct: 77,
};

/** Rival specs put through the same folds for this build, and their blind scores. */
export const REJECTED_SPECS = [
  { spec: 'price plus a winsorised 7-day growth term', median_error_ratio: 2.4 },
  { spec: 'price plus a chain-count term', median_error_ratio: 2.34 },
  { spec: 'ensemble of LAD, Huber and least-squares fits', median_error_ratio: 2.43 },
  { spec: 'fit trimmed of extreme market-cap/TVL ratios', median_error_ratio: 2.5 },
];

/** The stated pool assumption: a launch gives this share of implied value to early users. */
export const POOL_SHARE = 0.05;

// ---------------------------------------------------------------------------
// Reading the snapshot
// ---------------------------------------------------------------------------

/** Whole days between two ISO dates, never negative; null when a date is missing or unparseable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const from = Date.parse(`${listedAt}T00:00:00Z`);
  const to = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

/** Pre-token, by the record: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The fit's universe: traded, and at the board's own scale on both measures. */
export function compsOf(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd >= COMP_FLOOR_USD && p.tvl_usd >= COMP_FLOOR_USD,
  );
}

/** Middle value of a list, averaging the two middles when the count is even. */
function medianOf(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const half = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[half]! : (ordered[half - 1]! + ordered[half]!) / 2;
}

// ---------------------------------------------------------------------------
// The comps fit
// ---------------------------------------------------------------------------

/** Solve A x = b for a small symmetric positive-definite A, by Cholesky decomposition. */
function solveSpd(a: number[][], b: number[]): number[] {
  const n = b.length;
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      l[i]![j] = i === j ? Math.sqrt(sum) : sum / l[j]![j]!;
    }
  }
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= l[i]![k]! * y[k]!;
    y[i] = sum / l[i]![i]!;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= l[k]![i]! * x[k]!;
    x[i] = sum / l[i]![i]!;
  }
  return x;
}

/** Weighted least squares through the normal equations, for a design with a handful of columns. */
function weightedFit(rows: number[][], target: number[], weights: number[]): number[] {
  const k = rows[0]!.length;
  const normal: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const rhs = new Array<number>(k).fill(0);
  rows.forEach((row, i) => {
    const w = weights[i]!;
    for (let r = 0; r < k; r++) {
      rhs[r]! += w * row[r]! * target[i]!;
      for (let c = 0; c < k; c++) normal[r]![c]! += w * row[r]! * row[c]!;
    }
  });
  // A whisper of ridge keeps the system positive-definite without moving the fit.
  for (let d = 0; d < k; d++) normal[d]![d]! += 1e-10;
  return solveSpd(normal, rhs);
}

/**
 * Least absolute deviations by iteratively reweighted least squares: start at
 * the least-squares line, then reweight each comp by the inverse of its
 * residual until the coefficients settle. The reweighting is what pulls the
 * fit from the mean toward the median.
 */
function fitMedianLine(rows: number[][], target: number[]): number[] {
  let beta = weightedFit(rows, target, target.map(() => 1));
  for (let round = 0; round < 60; round++) {
    const weights = rows.map((row, i) => {
      const fitted = row.reduce((acc, v, j) => acc + v * beta[j]!, 0);
      return 1 / Math.max(Math.abs(target[i]! - fitted), 1e-3);
    });
    const next = weightedFit(rows, target, weights);
    const moved = Math.max(...next.map((v, j) => Math.abs(v - beta[j]!)));
    beta = next;
    if (moved < 1e-9) break;
  }
  return beta;
}

/** The fitted curve, plus the age a dateless protocol is read at. */
export interface FittedModel {
  intercept: number;
  tvl_coef: number;
  age_coef: number;
  median_age_days: number;
  n_comps: number;
}

/** Fit the comps curve on this snapshot. Same snapshot in, same curve out. */
export function fitModel(snapshot: Snapshot): FittedModel {
  const comps = compsOf(snapshot);
  if (comps.length < 10) throw new SnapshotError(`only ${comps.length} traded comps at scale: no curve to fit`);
  const knownAges = comps.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null);
  const medianAge = knownAges.length > 0 ? medianOf(knownAges) : 365;
  const design = comps.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at) ?? medianAge;
    return [1, Math.log10(p.tvl_usd), Math.log10(1 + age)];
  });
  const target = comps.map((p) => Math.log10(p.mcap_usd!));
  const [intercept, tvlCoef, ageCoef] = fitMedianLine(design, target) as [number, number, number];
  return { intercept, tvl_coef: tvlCoef, age_coef: ageCoef, median_age_days: medianAge, n_comps: comps.length };
}

/** A protocol's imputed value, its error band, and its age under the fitted curve. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  model: FittedModel,
): { implied: number; low: number; high: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const logValue =
    model.intercept +
    model.tvl_coef * Math.log10(p.tvl_usd) +
    model.age_coef * Math.log10(1 + (age ?? model.median_age_days));
  const implied = Math.max(1, Math.round(10 ** logValue));
  const band = VALIDATION.median_error_ratio;
  return { implied, low: Math.max(1, Math.round(implied / band)), high: Math.round(implied * band), age };
}

/**
 * Momentum: the week's TVL change on a sign-preserving log scale, capped at a
 * 60% week, in -1..+1. Null when the snapshot reports no change. A timing
 * signal for plans and sorts — never an input to the price.
 */
export function momentumOf(p: SnapshotProtocol): number | null {
  if (p.change_7d === null) return null;
  const clipped = Math.max(-60, Math.min(60, p.change_7d));
  const scaled = (Math.sign(clipped) * Math.log10(1 + Math.abs(clipped))) / Math.log10(61);
  return Math.round(scaled * 100) / 100;
}

// ---------------------------------------------------------------------------
// Flags, costs, verdicts
// ---------------------------------------------------------------------------

const NAME_ENDS_VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const NAME_SAYS_WRAPPED = /\b(wrapped|staked|staking)\b/i;
const CATEGORIES_THAT_ARE_WRAPPERS = new Set(['Canonical Bridge', 'Stablecoin Wrapper', 'Restaked BTC', 'Anchor BTC', 'Decentralized BTC']);
/** The watchlist rule's exchange list: a name opening with one of these is that exchange's own product. */
const NAME_OPENS_WITH_EXCHANGE = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** What a row is beyond pre-token: a wrapper, an exchange, a versioned product, or none. */
export type ProductFlag = 'wrapper' | 'cex' | 'versioned' | null;

export function productFlag(p: SnapshotProtocol): ProductFlag {
  // An exchange's own record (category CEX) is a cex row. An exchange-named
  // product under any other category is that exchange's wrapped or staked
  // version of an asset that already trades.
  if (p.category === 'CEX') return 'cex';
  if (CATEGORIES_THAT_ARE_WRAPPERS.has(p.category ?? '') || NAME_SAYS_WRAPPED.test(p.name)) return 'wrapper';
  if (NAME_OPENS_WITH_EXCHANGE.test(p.name)) return 'wrapper';
  // A Bridge record living on exactly one chain is the bridged asset itself
  // parked there — the snapshot's WBTC and USDT0 are the type cases — or a
  // chain's canonical bridge pool, not a bridge protocol.
  if (p.category === 'Bridge' && p.chains.length === 1) return 'wrapper';
  if (NAME_ENDS_VERSIONED.test(p.name)) return 'versioned';
  return null;
}

/** Categories whose only farm signal is parked capital; their verdict never passes thin. */
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

/** Chains where a month of small transactions costs little; anything unlisted is mid-priced. */
const CHEAP_CHAINS = new Set([
  'Solana', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'BNB Chain', 'Avalanche', 'Fantom',
  'Tron', 'Sui', 'Aptos', 'Near', 'Algorand', 'Cosmos', 'Osmosis', 'Sei', 'Linea', 'Scroll',
  'zkSync Era', 'Mantle', 'Blast', 'Mode', 'Celo', 'Gnosis', 'Moonbeam', 'Kava', 'Metis',
  'Bitcoin', 'Stacks', 'Core', 'BSquared', 'Rootstock', 'Monad', 'Hyperliquid', 'Sonic', 'Berachain',
]);

/** What a month of staying active costs, from the protocol's own chain set. */
export function monthlyCostUsd(p: SnapshotProtocol): number {
  if (p.chains.length === 0) return 60;
  if (p.chains.includes('Ethereum')) return p.chains.length > 1 ? 90 : 130;
  if (p.chains.every((c) => CHEAP_CHAINS.has(c))) return 25;
  return 60;
}

/** Position size by TVL tier: bigger protocols are farmed with a bigger stake. */
function capitalTier(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 20_000_000) return 75;
  return 50;
}

/** Hold length by age: the younger the protocol, the longer the qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A plan's money: the position, the monthly burn, the months, and the total burn. */
export interface PlanCost {
  capital: number;
  monthly: number;
  months: number;
  total: number;
}

/** Cost a protocol's plan from its own record. */
export function planCost(p: SnapshotProtocol, age: number | null): PlanCost {
  const monthly = monthlyCostUsd(p);
  const months = Math.max(1, Math.round(holdDaysFor(age) / 30));
  return { capital: capitalTier(p), monthly, months, total: monthly * months };
}

/**
 * Value density: assumed pool per plan dollar. The reader's priority order
 * across the board; by design it never feeds back into rank.
 */
export function densityOf(implied: number, plan: PlanCost): number {
  return Math.round(((implied * POOL_SHARE) / Math.max(1, plan.total)) * 100) / 100;
}

/** Density written for a human: thousands grouped at the top of the board, decimals at the tail. */
function densityText(density: number): string {
  return density >= 100 ? Math.round(density).toLocaleString('en-US') : density.toFixed(2);
}

export type Verdict = 'farm' | 'thin' | 'skip';

/** The verdict, from the pool-versus-cost arithmetic and the caps in the header. */
export function verdictFor(p: SnapshotProtocol, implied: number, flag: ProductFlag): Verdict {
  if (flag === 'wrapper') return 'skip';
  const passive = PASSIVE_CATEGORIES.has(p.category ?? '') || flag === 'cex';
  if (passive) return implied >= 40_000_000 ? 'thin' : 'skip';
  if (implied >= 45_000_000) return 'farm';
  if (implied >= 20_000_000) return 'thin';
  return 'skip';
}

// ---------------------------------------------------------------------------
// Farm plans
// ---------------------------------------------------------------------------

/** The chain a plan starts on: the first the record names. */
function homeChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** The context every plan step is written from. */
interface PlanContext {
  name: string;
  chain: string;
  capital: number;
}

/**
 * The category's core action, as a rule table: the first pattern the
 * (lower-cased) category matches writes the step, with the plan's capital and
 * home chain filled in. A category no rule names falls through to a plain
 * deposit. Order matters only where patterns overlap.
 */
const ACTION_RULES: [RegExp, (ctx: PlanContext) => string][] = [
  [/^cex$/, (c) => `Open an account at ${c.name}, deposit ${money(c.capital)} and run small spot trades each week so the account shows real activity.`],
  [/lend|cdp|collateral/, (c) => `Supply ${money(c.capital)} of USDC to ${c.name} on ${c.chain} and borrow a small amount against it, keeping the loan healthy.`],
  [/dex|leveraged farm/, (c) => `Provide ${money(c.capital)} of liquidity to ${c.name}'s main pool on ${c.chain} and swap through it weekly.`],
  [/bridge/, (c) => `Bridge ${money(c.capital)} of USDC to ${c.chain} through ${c.name} and put the bridged funds to work in its app.`],
  [/staking|restak/, (c) => `Stake ${money(c.capital)} of the chain's staking asset through ${c.name} and keep the staking receipt in the wallet.`],
  [/perpetual|derivative/, (c) => `Deposit ${money(c.capital)} of USDC as margin on ${c.name} and open one small hedged position each week.`],
  [/prediction/, (c) => `Fund ${money(c.capital)} on ${c.name} and hold one position in an active market until it settles.`],
  [/curator|allocator|liquidity manager/, (c) => `Deposit ${money(c.capital)} into a ${c.name} vault on ${c.chain} and keep the vault shares untouched.`],
  [/stable|dual-token/, (c) => `Mint or deposit ${money(c.capital)} of the stable asset through ${c.name} on ${c.chain} and hold it.`],
  [/rwa/, (c) => `Mint ${money(c.capital)} of ${c.name}'s yield asset on ${c.chain} and hold it in the farming wallet.`],
  [/insurance/, (c) => `Buy ${money(c.capital)} of cover from ${c.name} on ${c.chain} and keep the policy to expiry.`],
  [/yield|farm/, (c) => `Deposit ${money(c.capital)} into ${c.name}'s main vault on ${c.chain} and compound the yield weekly.`],
  [/chain/, (c) => `Hold ${money(c.capital)} of gas on ${c.chain}, use two or three native apps weekly and keep the wallet active.`],
];

/** The core action for a protocol, from the rule table. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const category = (p.category ?? '').toLowerCase();
  const ctx: PlanContext = { name: p.name, chain, capital };
  for (const [pattern, write] of ACTION_RULES) if (pattern.test(category)) return write(ctx);
  return `Deposit ${money(capital)} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * Six steps, each an action carrying its cost and its time, all read off the
 * protocol's own record. Step two is sized by the momentum signal; step four
 * spends the protocol's second chain when it has one; step five holds under
 * an exit rule priced from the snapshot's TVL; step six closes the arithmetic
 * and states the verdict.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number, verdict: Verdict): string[] {
  const chain = homeChain(p);
  const plan = planCost(p, age);
  const hold = holdDaysFor(age);
  const pool = Math.round(implied * POOL_SHARE);
  const density = densityText(densityOf(implied, plan));
  const week = p.change_7d;
  const fallingFast = week !== null && week <= -10;
  const risingFast = week !== null && week >= 25;
  const firstStake = fallingFast ? Math.max(25, Math.round(plan.capital / 2)) : plan.capital;
  const timing =
    fallingFast
      ? ` Its TVL fell ${Math.abs(week!).toFixed(1)}% in the snapshot's week, so open with half the stake (${money(firstStake)}) and add the rest only once TVL steadies.`
      : risingFast
        ? ` Its TVL rose ${week!.toFixed(1)}% in the snapshot's week, so open this week, while the growth is live, not after it cools.`
        : '';
  const widen =
    p.chains.length > 1
      ? `Bridge about ${money(Math.max(25, Math.round(plan.capital / 4)))} to ${p.chains[1]}, ${p.name}'s second chain, and repeat one small action there, so the wallet is a user on two chains, not one. Cost: about ${money(Math.max(3, Math.round(plan.monthly / 8)))} of bridge and gas fees. Time: 15 minutes, once in the first week.`
      : `Deepen the single-chain footprint: add a second ${p.name} product (a second pool, market or vault on ${chain}) with about ${money(Math.max(25, Math.round(plan.capital / 4)))}, and cast any governance or feedback vote it opens. Cost: about ${money(Math.max(2, Math.round(plan.monthly / 10)))} of gas. Time: 15 minutes, once in the first week.`;
  const exitRule = `Exit rule: if ${p.name}'s TVL falls below ${money(Math.round(p.tvl_usd * 0.7))} (30% under the snapshot's ${money(p.tvl_usd)}) or it announces a token with no early-user allocation, withdraw within a week and redeploy.`;
  const closing =
    verdict === 'skip'
      ? `The maths does not clear the bar: if ${p.name} ever allocates 5% of its ${money(implied)} implied value to early users (an assumption, not a promise), the pool is about ${money(pool)} shared by every farmer, against about ${money(plan.total)} to farm it — a value density of ${density} before the pool is split. Verdict: skip — keep it on the watchlist instead. Cost: nothing. Time: 5 minutes to check back monthly.`
      : `If ${p.name} launches and allocates 5% of its ${money(implied)} implied value to early users (an assumption, not a promise), the early-user pool is about ${money(pool)}; this plan costs about ${money(plan.total)} over ${plan.months} month${plan.months === 1 ? '' : 's'} plus the ${money(plan.capital)} position — a value density of ${density} of assumed pool per plan dollar. Verdict: ${verdict}. Cost: about ${money(plan.total)} all-in. Time: 10 minutes to log the position and set a monthly review.`;
  const steps = [
    `Start with a wallet used for nothing else: create it for ${p.name}, fund it on ${chain}, and keep the seed phrase offline, with only money you are farming in it. Cost: about $3 of gas to start. Time: 10 minutes.`,
    `${coreAction(p, firstStake, chain)}${timing} Cost: ${money(firstStake)} of capital plus about ${money(Math.max(2, Math.round(plan.monthly / 6)))} of gas. Time: 15 minutes to set up.`,
    `Keep the wallet looking like a user's, not a snapshot's: one genuine action a week — a deposit, a borrow, a swap, a bridge or a vote — every week of the hold. Cost: about ${money(plan.monthly)} a month in gas and fees. Time: 10 minutes a week.`,
    widen,
    `Hold the position at least ${hold} days, across more than one activity snapshot, and check ${p.name}'s own points or rewards page weekly, claiming only from links it publishes. ${exitRule} Cost: the ${money(plan.capital)} stays in the position. Time: ${hold} days.`,
    closing,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** One row of board.json: the ranking, the model's working, and the plan. */
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

/** A protocol that already trades: shown at the market's value, never ranked. */
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

/** The dashboard's view of one board row. */
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

/** Everything the dashboard renders. */
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

/** Build the whole radar: fit, score every pre-token protocol, rank, set the traded aside. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = fitModel(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols.filter(isPreToken).map((p) => {
    const value = impliedValue(p, snapshot.as_of, model);
    const flag = productFlag(p);
    const plan = planCost(p, value.age);
    return {
      p,
      ...value,
      flag,
      plan,
      verdict: verdictFor(p, value.implied, flag),
      density: densityOf(value.implied, plan),
    };
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

// ---------------------------------------------------------------------------
// Parsing and gate checks
// ---------------------------------------------------------------------------

/** Read a required string field off a raw record, or say which field failed. */
function reqText(rec: Record<string, unknown>, field: string, where: string): string {
  const v = rec[field];
  if (typeof v !== 'string') throw new SnapshotError(`${where} has no ${field}`);
  return v;
}

/** Read an optional finite number field; anything else becomes null. */
function optNumber(rec: Record<string, unknown>, field: string): number | null {
  const v = rec[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Read an optional string field; anything else becomes null. */
function optText(rec: Record<string, unknown>, field: string): string | null {
  const v = rec[field];
  return typeof v === 'string' ? v : null;
}

/** Parse and validate one raw protocol record. */
function parseProtocol(raw: unknown, index: number): SnapshotProtocol {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError(`protocol ${index} is not an object`);
  }
  const rec = raw as Record<string, unknown>;
  const slug = reqText(rec, 'slug', `protocol ${index}`);
  const name = reqText(rec, 'name', `protocol ${index}`);
  const tvl = optNumber(rec, 'tvl_usd');
  if (tvl === null) throw new SnapshotError(`protocol ${index} has no usable tvl_usd`);
  return {
    slug,
    name,
    category: optText(rec, 'category'),
    chains: Array.isArray(rec.chains) ? rec.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: tvl,
    change_7d: optNumber(rec, 'change_7d'),
    mcap_usd: optNumber(rec, 'mcap_usd'),
    listed_at: optText(rec, 'listed_at'),
    gecko_id: optText(rec, 'gecko_id'),
    symbol: optText(rec, 'symbol'),
  };
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
  const doc = raw as Record<string, unknown>;
  const asOf = reqText(doc, 'as_of', 'snapshot.json');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new SnapshotError('snapshot.json has no as_of date');
  const source = reqText(doc, 'source', 'snapshot.json');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  return {
    as_of: asOf,
    source,
    floor_usd: doc.floor_usd,
    protocols: doc.protocols.map(parseProtocol),
    watchlist: doc.watchlist as string[],
  };
}

/**
 * Why a board is not one the gate will take, or null. Written as a list of
 * independent checks so the first failure names itself: coverage, watchlist,
 * ranks, value order, and every row's steps and value inside the gate's caps.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const preToken = snapshot.protocols.filter(isPreToken);
  const checks: (() => string | null)[] = [
    () => {
      const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
      return missing.length > 0 ? `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}` : null;
    },
    () => {
      const missing = preToken.filter((p) => !slugs.has(p.slug));
      return missing.length > 0
        ? `the board misses ${missing.length} pre-token protocols: ${missing.slice(0, 5).map((p) => p.slug).join(', ')}`
        : null;
    },
    () => (board.length !== preToken.length ? `the board holds ${board.length} rows for ${preToken.length} pre-token protocols` : null),
    () => {
      const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
      for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
      return null;
    },
    () => {
      for (let i = 1; i < board.length; i++) {
        if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
      }
      return null;
    },
    () =>
      board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd
        ? 'all rows share the same implied value: a board that ranks nothing by value is not a ranking'
        : null,
    () => {
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
    },
  ];
  for (const check of checks) {
    const issue = check();
    if (issue !== null) return issue;
  }
  return null;
}

/** The dashboard's dataset as one script the page loads beside itself: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
