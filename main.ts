// Token Launch Radar, model radar-3 — the program the grader runs.
//
//     node main.ts [--input <snapshot.json|directory>] [--output <directory>]
//
// It reads the sealed snapshot (default /input/snapshot.json), fits the comps
// curve in lib/model.ts on the snapshot's traded protocols, ranks every
// pre-token protocol by implied value, and fills the output directory
// (default /output, or $MAKEFUN_OUTPUT_DIR outside the grader):
//
//     board.json    the ranked board — every pre-token protocol, watchlist 40/40
//     data.js       the dashboard's dataset, generated from the same board
//     dashboard/    this repository's dashboard, copied across
//     screenshots/  this repository's screenshots, copied across
//     dossier.json  the judge's summary, from vendor/makefun-board.ts
//
// Node 22, standard library only. The board is validated before anything is
// written: a board the gate would refuse stops the run with the reason.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** Command-line flags as a map: `--name value` and `--name=value` both read. */
function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 2) out.set(token.slice(2, eq), token.slice(eq + 1));
    else if (i + 1 < argv.length) out.set(token.slice(2), argv[++i]!);
  }
  return out;
}

const args = flags(process.argv.slice(2));
const inputArg = args.get('input') ?? '/input';
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  process.stderr.write(`token radar: no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const outDir = args.get('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory of plain files into the output, skipping dotfiles; returns the names copied. */
function copyPlainFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  const names = readdirSync(from).filter((name) => !name.startsWith('.'));
  if (names.length === 0) return [];
  mkdirSync(to, { recursive: true });
  for (const name of names) cpSync(join(from, name), join(to, name));
  return names;
}

copyPlainFiles(join(repoDir, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyPlainFiles(join(repoDir, 'screenshots'), join(outDir, 'screenshots'));
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// Written last, from the finished output: the scorer rebuilds the dossier
// from this same directory and compares it byte for byte.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: 65_536,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const tally = new Map<string, number>();
for (const row of board) tally.set(row.farm_verdict, (tally.get(row.farm_verdict) ?? 0) + 1);
const densest = board.reduce((best, row) => (row.value_density > best.value_density ? row : best), board[0]!);
const covered = board.filter((r) => r.watchlist).length;
process.stdout.write(
  [
    `token radar: ${snapshot.protocols.length} protocols read, ${snapshot.watchlist.length} on the watchlist, ${board.length} pre-token rows ranked (watchlist ${covered}/${snapshot.watchlist.length}), ${radar.live.length} traded set aside`,
    `token radar: curve fitted on ${radar.model.n_comps} comps: log10(mcap) = ${radar.model.intercept.toFixed(4)} + ${radar.model.tvl_coef.toFixed(4)}*log10(TVL) + ${radar.model.age_coef.toFixed(4)}*log10(1+age_days); blind median error x${radar.model.band_ratio}`,
    `token radar: verdicts farm ${tally.get('farm') ?? 0} / thin ${tally.get('thin') ?? 0} / skip ${tally.get('skip') ?? 0}; densest row ${densest.slug} at ${densest.value_density.toFixed(2)} of assumed pool per plan dollar`,
    `token radar: wrote board.json, data.js, dashboard/, screenshots/ (${shots.length} images) and dossier.json under ${outDir}`,
  ].join('\n') + '\n',
);
