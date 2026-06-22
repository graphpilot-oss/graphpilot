/**
 * Resolver-accuracy baseline (#72).
 *
 * Two measurements, both objective:
 *
 *  1. Controlled corpus (bench/resolver/fixtures/) with hand-labeled GOLD
 *     edges → precision / recall of the name-based resolver. Because we author
 *     the fixtures, every true target is unambiguous ground truth. The corpus
 *     deliberately includes the cases import-path resolution (#73), re-export
 *     chains (#74), and scope-aware binding (#75) will improve, so the suite
 *     doubles as a regression baseline.
 *
 *  2. GraphPilot's own src/ → in-repo resolution rate (resolved / total) and
 *     ambiguity rate. No labels needed; this is the real-world number that
 *     replaces the "~25–35%" estimate in docs/limitations.md.
 *
 * This is a measurement, not a gate — it always exits 0. The CI precision gate
 * is #76.
 *
 * Run: pnpm bench:resolver
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { indexDirectory } from '../../src/indexer.js';
import type { CallEdge } from '../../src/edges.js';
import type { SymbolRecord } from '../../src/symbols.js';

const here = dirname(fileURLToPath(import.meta.url));

/** A hand-labeled true call edge in the controlled corpus. */
interface Gold {
  desc: string;
  fromName: string;
  toName: string;
  /** Expected definition file (basename), or 'external' if it should NOT resolve. */
  expect: string | 'external';
}

const GOLD: Gold[] = [
  { desc: 'same-file call', fromName: 'alpha', toName: 'beta', expect: 'same_file.ts' },
  { desc: 'cross-file, unique name', fromName: 'useHelper', toName: 'helper', expect: 'lib.ts' },
  {
    desc: 'cross-file, ambiguous name (import says dup_a)',
    fromName: 'useSave',
    toName: 'save',
    expect: 'dup_a.ts',
  },
  {
    desc: 'cross-file, ambiguous name (import says dup_b)',
    fromName: 'useSaveB',
    toName: 'save',
    expect: 'dup_b.ts',
  },
  {
    desc: 'stdlib call (no in-repo def)',
    fromName: 'useExternal',
    toName: 'max',
    expect: 'external',
  },
];

type Outcome = 'correct' | 'wrong-file' | 'unresolved' | 'false-resolve' | 'missing-edge';

function basename(file: string): string {
  return file.split('/').pop() ?? file;
}

async function scoreCorpus(): Promise<void> {
  const res = await indexDirectory(join(here, 'fixtures'));
  const byId = new Map<string, SymbolRecord>(res.symbols.map((s) => [s.id, s]));
  const nameOfFrom = (e: CallEdge): string | undefined => byId.get(e.fromId)?.name;

  let resolved = 0; // gold edges (expecting in-repo) that resolved to *something*
  const inRepoGold = GOLD.filter((g) => g.expect !== 'external');
  const rows: Array<{ desc: string; outcome: Outcome; got: string }> = [];

  for (const g of GOLD) {
    const edge = res.edges.find((e) => e.toName === g.toName && nameOfFrom(e) === g.fromName);
    let outcome: Outcome;
    let got = '—';
    if (!edge) {
      outcome = 'missing-edge';
    } else if (edge.toId === null) {
      outcome = g.expect === 'external' ? 'correct' : 'unresolved';
    } else {
      const targetFile = basename(byId.get(edge.toId)?.file ?? '');
      got = targetFile + (edge.ambiguous ? ' (ambiguous)' : '');
      if (g.expect === 'external') {
        outcome = 'false-resolve';
      } else if (targetFile === g.expect) {
        outcome = 'correct';
        resolved++;
      } else {
        outcome = 'wrong-file';
        resolved++;
      }
    }
    rows.push({ desc: g.desc, outcome, got });
  }

  // Precision = correct in-repo resolutions / in-repo edges that resolved at all.
  // Recall = correct in-repo resolutions / all true in-repo edges.
  const inRepoCorrect = rows.filter(
    (r, i) => GOLD[i].expect !== 'external' && r.outcome === 'correct',
  ).length;
  const prec = resolved > 0 ? inRepoCorrect / resolved : 0;
  const rec = inRepoGold.length > 0 ? inRepoCorrect / inRepoGold.length : 0;

  console.log('\n=== Controlled corpus (bench/resolver/fixtures) ===');
  for (const r of rows) {
    const mark = r.outcome === 'correct' ? '✓' : '✗';
    console.log(`  ${mark} ${r.desc.padEnd(48)} ${r.outcome.padEnd(13)} got=${r.got}`);
  }
  console.log(
    `\n  Precision: ${(prec * 100).toFixed(0)}%  (${inRepoCorrect}/${resolved} resolved in-repo edges correct)`,
  );
  console.log(
    `  Recall:    ${(rec * 100).toFixed(0)}%  (${inRepoCorrect}/${inRepoGold.length} true in-repo edges resolved correctly)`,
  );
}

async function scoreSelf(): Promise<void> {
  const res = await indexDirectory(join(here, '..', '..', 'src'));
  const total = res.edges.length;
  const resolved = res.edges.filter((e) => e.toId !== null).length;
  const ambiguous = res.edges.filter((e) => e.ambiguous).length;
  console.log('\n=== GraphPilot src/ (in-repo resolution rate — no labels needed) ===');
  console.log(`  files=${res.filesIndexed}  symbols=${res.symbols.length}  edges=${total}`);
  console.log(
    `  Resolution rate: ${((resolved / total) * 100).toFixed(1)}%  (${resolved}/${total} edges resolve to an in-repo symbol)`,
  );
  console.log(
    `  Ambiguity rate:  ${((ambiguous / Math.max(resolved, 1)) * 100).toFixed(1)}%  (${ambiguous}/${resolved} resolved edges were a homonym guess)`,
  );
}

await scoreCorpus();
await scoreSelf();
console.log('\nBaseline captured. See bench/resolver/README.md.\n');
