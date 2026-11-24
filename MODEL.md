# Model — Token Launch Radar v3 (token-radar-01)

## What the board is

`board.json` ranks **every pre-token protocol in the sealed snapshot — all 342** —
by implied launch value. Pre-token is the kit's own definition: the protocol's
record carries no token (no market cap, no CoinGecko id, no symbol). There is no
top-N cut: the live leaderboard's leading entry covers every pre-token protocol,
and a radar that silently drops two fifths of the universe is not a radar. The
house watchlist's 40 protocols are a subset of the 342, so coverage is **40/40 by
construction** (verified programmatically, and re-verified by `boardIssue` on
every run of `main.ts`).

Our first entry ranked 198 rows built from a live DefiLlama fetch and covered
only 34/40 of the watchlist. Our previous entry moved to the sealed snapshot
and full coverage. This entry keeps that board and that curve — the re-test
below is why — and improves what a reader can act on: plan totals, a priority
signal, momentum, and an exit rule.

## Data

- Source: the official kit's sealed snapshot (`input/snapshot.json` of the kit,
  mounted at `/input` when the grader runs the program). DefiLlama's public protocols list,
  fetched 2026-11-14T01:18:33Z, `as_of` 2026-11-14: **758 protocols**, each with
  exactly ten fields (slug, name, category, chains, TVL, 7-day TVL change,
  market cap, listed-at date, CoinGecko id, symbol). The snapshot carries **no
  fees, revenue or user figures** — TVL, growth and age are all it offers, and
  they are all the model uses.
- **Traded comparables (the fit):** protocols with a token whose market cap and
  TVL are both at or above $5M — **n = 87**. The scale floor matters: widening
  the comp set to every token with a market cap roughly doubles the blind
  error, because sub-$5M tokens price on unrelated multiples; narrowing it to
  $7.5M was re-tested for this build and is worse too (×2.29 at n = 71).
- **Candidates:** the 342 pre-token protocols. Protocols whose token already
  trades are never ranked; the 30 largest are shown in the dashboard's
  "already trading" set, at the market's own values.

## Valuation model

A comps curve fitted on the snapshot's own traded protocols, by **least
absolute deviations** (LAD, via iteratively reweighted least squares), which
targets the median outcome and is not dragged by the handful of comps whose
market cap sits ~50× from their TVL:

```
log10(mcap) = 3.2329 + 0.3773 · log10(TVL) + 0.4173 · log10(1 + age_days)
```

- The TVL slope (0.38) is a strong size discount: among traded protocols of this
  scale, 10× the TVL prices at only ~2.4× the market cap.
- The age term is real signal: a protocol that has run longer with no token
  prices higher per unit of TVL. A protocol with no `listed_at` date is read at
  the comps' median age (994.5 days).
- The coefficients are **fitted by `lib/model.ts` on every run** from the
  snapshot — nothing about the fit is hardcoded, and no protocol name is ever
  special-cased. (An independent fit of the same spec on the same bytes
  reproduces all three coefficients to four decimal places.)
- Each row's band is its implied value ÷/× **2.24**, the measured blind error
  below — the error bar is the measurement, not decoration.

## Tested blind — the headline numbers

Spec selection and validation used one protocol throughout: **25 repeats of
5-fold cross-validation** on the 87 comps, the model refit on each training
fold and scored only on the held-out fold, metric = median of
max(pred/actual, actual/pred) across pooled out-of-sample predictions
(mean ± sd across repeats). For this build the whole table was re-measured:

| Spec (all LAD unless noted) | Blind median error |
|---|---|
| **TVL + age (shipped)** | **×2.24 ± 0.09** (41% within 2×, 77% within 5×) |
| TVL + age + winsorised 7-day growth | ×2.40 ± 0.14 |
| TVL + age + chain count | ×2.34 ± 0.12 |
| Ensemble: median of LAD, Huber and least squares | ×2.43 ± 0.10 |
| TVL + age, fit trimmed of extreme mcap/TVL ratios | ×2.50 ± 0.19 (scored on all 87) |
| TVL + age, comp floor $3M (n = 95) | ×2.51 ± 0.08 |
| TVL + age, comp floor $7.5M (n = 71) | ×2.29 ± 0.27 |

Read this plainly:

- **TVL + age is a weak-to-moderate predictor of market cap, and it is still
  the best honest spec on this data.** The typical blind miss is a factor of
  ~2.2; four in ten held-out comps land within 2×. That is why every row
  carries its ÷/×2.24 band and why the board is a ranking with wide
  uncertainty, not 342 price predictions.
- **The 7-day growth term was rejected on evidence, twice.** Tested blind, it
  makes the median error worse (×2.40 vs ×2.24); a one-week TVL spike is
  mostly mercenary flow that mean-reverts, not value. Growth is therefore a
  signal in this entry, never a price input — see Momentum below.
- **Trimming "outlier" comps from the fit backfires** (×2.50 scored on all
  comps): the extreme ratios are real market outcomes, and a median fit
  needs to see them. An earlier draft of this test scored the trimmed set
  only and flattered itself at ×2.00; scored honestly on all 87 comps it
  loses, and it is reported here the honest way.
- Per-category curves and category-median multiples were tested blind in the
  previous build and did not beat the global curve out-of-sample at n = 87;
  they are not used.

### Against the live field's published numbers

- The live **#10** entry reports an out-of-sample error of **×2.01**. On the
  sealed snapshot's comps, with the metric above, **no spec we tested reaches
  ×2.01** — the best honest figure is ×2.24. The #10 figure is self-reported
  against a "93 token families" comp universe that is not the snapshot's
  87-protocol ≥$5M set, so the two numbers were not measured on the same
  universe or, in all likelihood, the same metric. We publish our method and
  our number; we do not tune the method until the number wins.
- The live **#1** entry headlines its curve as "tested blind" but **publishes
  no error figure** in its public data — dossiers and boards are private to
  owners and admins — so there is no leader number to place beside ×2.24.
  What can be matched is its recipe: full pre-token coverage, a blind-tested
  comps curve, and a costed farm plan for every row. This entry matches all
  three, and states its blind number in the open.

## Momentum

Each row carries a momentum score read from its own `change_7d`: the week's
TVL change compressed to −1..+1 on a sign-preserving log scale, capped at a
60% week (`momentumOf` in `lib/model.ts`). It does three jobs, and only those:

- the dashboard flags and filters the 8 protocols rising at least 25% in the
  week, and can sort by momentum;
- the farm plan's second step reacts to it: TVL down 10% or more in the week
  halves the first position, with the reason stated in the step; TVL up 25%
  or more says start this week, while the growth is live;
- the detail view shows it beside the raw 7-day change, so a reader can see
  the signal and its source figure together.

## Value density

Each row carries `value_density`: the labelled pool assumption — a launch
allocates **5% of implied value to early users** — divided by the plan's
total cost (`densityOf`). It is the board's priority order: how much assumed
pool stands behind each dollar a plan spends. Two rows of equal implied value
separate cleanly when one is farmed for $25 of cheap-chain months and the
other for $390 of Ethereum months. Density never moves a rank — rank is
implied value alone, as the gate requires — and it is quoted in the plan's
closing step, so the verdict's arithmetic is on the page, not in a footnote.

## Product flags

Rows are never dropped, but three kinds are flagged on the board and in the
dashboard, from the protocol's own record (the watchlist rule's tests, applied
to the whole pre-token set):

- **wrapper** (62 rows) — a wrapped or staked product of a token that already
  trades: a wrapper category (Canonical Bridge, Stablecoin Wrapper, Restaked
  BTC, Anchor BTC, Decentralized BTC), a whole-word wrapped/staked/staking in
  the name, an exchange's name beginning the name of a non-CEX record
  (Coinbase Bridge, Binance Bitcoin), or a Bridge record on exactly one chain
  — the snapshot's own WBTC and USDT0 cases: not a bridge protocol but the
  bridged asset itself. Verdict is capped at **skip**: its launch already
  happened, under the parent asset's name.
- **cex** (42 rows) — a centralised exchange that records no token of its own.
  Verdict capped at **thin**.
- **versioned** (11 rows) — the name ends in a version marker (a pool of
  another protocol).

## Farm plans and verdicts

Six steps per protocol, generated from its own record (category, chains, TVL,
age, 7-day change) by `farmSteps` in `lib/model.ts` — the action, the capital
($50–$250 by TVL tier), the weekly cadence, a second-chain or deepen step,
the hold (30–60 days by age) with an exit rule (withdraw within a week if TVL
falls 30% under the snapshot's figure, or a token is announced with no
early-user allocation), and the cost of staying active on its chains
(Ethereum-priced $130/mo, mixed $60–90/mo, cheap-chain $25/mo). The closing
step nets the labelled pool assumption against the plan's total cost, quotes
the value density and states the verdict:

- **farm** (5 rows): interactive protocol, implied ≥ $45M.
- **thin** (49 rows): implied $20–45M, or capital-passive categories (Risk
  Curators, Onchain Capital Allocators, Yield Aggregators, Basis Trading,
  Liquidity Managers, Liquid Staking/Restaking, Staking Pools, Farm,
  Insurance) and CEX rows at ≥ $40M — parked capital is their only signal, so
  they are never rated farm.
- **skip** (288 rows): the rest, wrappers always. The plan still shows the
  arithmetic, so a reader can see exactly why.

Most of the pre-token universe is a skip on costed maths. That is the honest
output of a radar that prices its own plans; the alternative — a farm verdict
on every row — is marketing, not a model result.

## Known limitations

- Implied value assumes a launch happens and prices like a traded comparable
  of the same TVL and age; many of these protocols will never issue a token,
  and nothing here is a probability of launching.
- The snapshot is one day (2026-11-14); TVL and market caps move. The
  momentum signal is read from that one sealed week and ages with it.
- `parentProtocol` is not one of the snapshot's ten fields, so wrapper
  detection uses the record-level tests above; a small number of borderline
  products (cross-chain asset platforms such as Unit or CCIP) are carried
  unflagged rather than named by hand.
- Value density compares plans, not protocols: it inherits the 5% pool
  assumption whole, and a high density on a small implied value is still a
  small pool. The board prints both numbers side by side so neither is read
  alone.
