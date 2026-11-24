[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/BOTTL3WAT3R/makefun-token-radar-01-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/BOTTL3WAT3R/makefun-token-radar-01-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar — make.fun bounty token-radar-01

A radar for token launches that have not happened yet. It reads the bounty's
sealed DefiLlama snapshot and ranks **every protocol that records no token —
all 342 of them**, the house watchlist's 40 included in full — by the implied
value of the token it may one day issue, each with a costed six-step farm
plan, the plan's total cost, and a **value density**: the labelled pool
assumption per dollar the plan spends. The traded protocols are never ranked:
they are the comparables the model is fitted on, shown separately at the
market's own values.

**The model, tested blind:** a comps curve fitted on the snapshot's own 87
traded protocols at the board's scale,

```
log10(mcap) = 3.2329 + 0.3773 · log10(TVL) + 0.4173 · log10(1 + age_days)
```

fitted by least absolute deviations and validated by 25 repeats of 5-fold
cross-validation, scored on held-out folds only: **median out-of-sample error
×2.24** (41% within 2×, 77% within 5×). Every row's band is its value ÷/×2.24.

**What this entry adds over our previous one** (same curve — re-testing said
keep it; the gains are around it):

- **Value density on every row.** The plan's closing arithmetic as one
  number: an assumed early-user pool of 5% of implied value (a labelled
  assumption) divided by the plan's total cost. Rank stays implied value
  alone; density is the priority order, sortable in the dashboard.
- **A momentum signal, honestly placed.** The 7-day TVL change was tested
  blind as a price input again — ×2.40 against ×2.24 — and kept out of the
  price again. It now works where it belongs: a per-row momentum score, a
  rising-TVL filter, and farm plans that halve the first position when TVL
  is falling fast and say start now when it is rising fast.
- **Six-step plans.** The new fourth step uses the protocol's second chain
  when it has one (or deepens the single-chain footprint when it does not),
  and the hold step carries an exit rule read from the snapshot's own TVL.
- **The rejected specs, published.** Four richer specs were tested blind on
  the same folds for this build — growth in the price (×2.40), a chain-count
  term (×2.34), a three-fit ensemble (×2.43), a ratio-trimmed fit (×2.50) —
  and rejected on the numbers. The dashboard's method section prints them.

The full method, the farm-plan cost model and the honest comparison against
the live field are in [MODEL.md](MODEL.md).

## Run it

Node 22, standard library only, no install:

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

`--input` takes the snapshot file or its directory; in this repository,
`data/snapshot.json` is a byte copy of the kit's sealed input, so
`node main.ts --input data` reproduces the run. The program writes to the
output directory:

| File | What it is |
| --- | --- |
| `board.json` | The ranked board: 342 rows, ranks 1..N, implied value + ÷/×2.24 band, momentum, plan cost, value density, flags, verdict, farm steps |
| `data.js` | The dashboard's dataset, generated from the same board |
| `dashboard/` | The dashboard (board, filters, sorts, per-protocol detail view, live set, method) |
| `screenshots/` | Board, detail and filtered views of the dashboard |
| `dossier.json` | The judge's summary, written by `buildDossier` from `vendor/makefun-board.ts` |

The program refuses to hand in a board that misses a watchlist slug, misses a
pre-token protocol, breaks rank order, or carries a farm step outside the
gate's limits (`boardIssue` in `lib/model.ts`). Two runs write the same bytes.

## Layout

- `main.ts` — the entry program: snapshot in, board + dashboard data +
  dossier out.
- `lib/model.ts` — the model: snapshot parsing, the LAD comps fit, implied
  values and bands, the momentum signal, product flags, plan costs, value
  density, farm plans and verdicts, board checks.
- `dashboard/` — `index.html`, `app.css`, `app.js`: a static page, no network,
  ~24 KB of source so the dossier shows every file whole.
- `vendor/makefun-board.ts` — make.fun's dossier library, vendored unchanged.
- `data/snapshot.json` — the sealed snapshot this entry reads.
- `screenshots/` — the three dossier images, rendered from the built page.

## The honest comparison

| | First entry | Previous entry (radar-2) | This entry (radar-3) | Live #10 |
|---|---|---|---|---|
| Data | Live DefiLlama fetch | Sealed kit snapshot | Sealed kit snapshot | Sealed snapshot |
| Rows | 198 | 342 (every pre-token protocol) | **342** | 198 |
| Watchlist | 34/40 | 40/40 | **40/40** | 40/40 |
| Blind / OOS error | ×2.61 | ×2.23 | **×2.24** (same spec, re-measured) | ×2.01 (self-reported, "93 families") |
| Farm plan | 5 steps | 5 steps, costed | **6 steps, costed, momentum-aware, exit rule** | — |
| Priority signal | — | — | **Value density per row** | — |

The curve does not beat the previous entry's — on this snapshot's comps, with
this metric, nothing we tested does, and the four attempts are published
above rather than tuned until they win. What improves is everything a reader
acts on: what a plan costs in total, which rows give the most assumed pool
per plan dollar, which protocols are rising or falling this week, and when
to walk away from a position.

## License

MIT — see `LICENSE`.
