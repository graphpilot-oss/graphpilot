/**
 * index.ts — CLI entry point.
 *
 * Usage:
 *   pnpm setup     — clone fastify, build GP, index
 *   pnpm generate  — read fastify, generate 40 questions, compute ground truth
 *   pnpm run       — run benchmark (both modes)
 *   pnpm report    — generate markdown report from latest run
 *   pnpm all       — setup + generate + run + report in one go
 */
import { setup } from './setup.js';
import { generateTasks } from './generate.js';
import { runBenchmark } from './run.js';
import { generateReport, findLatestRun } from './report.js';

const cmd = process.argv[2] ?? 'help';
const extra = process.argv.slice(3);

async function main(): Promise<void> {
  switch (cmd) {
    case 'setup':
      await setup();
      break;

    case 'generate':
      await generateTasks();
      break;

    case 'run': {
      // Optional: --tasks T01,T03 --mode baseline
      const taskArg = extra.find((a) => a.startsWith('--tasks='))?.split('=')[1];
      const modeArg = extra.find((a) => a.startsWith('--mode='))?.split('=')[1] as
        | 'baseline'
        | 'gp'
        | undefined;
      const taskFilter = taskArg ? taskArg.split(',') : undefined;
      const modesOnly = modeArg ? [modeArg] : undefined;
      const rawPath = await runBenchmark({ taskFilter, modesOnly });
      generateReport(rawPath);
      break;
    }

    case 'report': {
      const latest = findLatestRun();
      if (!latest) {
        console.error('No results found. Run `pnpm run` first.');
        process.exit(1);
      }
      generateReport(latest);
      break;
    }

    case 'all':
      await setup();
      await generateTasks();
      const rawPath = await runBenchmark({});
      generateReport(rawPath);
      break;

    default:
      console.log(`
GraphPilot Benchmark — measures token savings vs baseline (file reads only)

Commands:
  pnpm setup      Clone fastify, build GraphPilot, index the repo
  pnpm generate   Generate 40 benchmark questions from fastify source
  pnpm run        Run benchmark in both modes, generate report
  pnpm report     Re-generate report from most recent run

Options for run:
  --tasks=T01,T05   Only run specific tasks
  --mode=baseline   Only run one mode

Prerequisites:
  Copy .env.example → .env and set ANTHROPIC_API_KEY
`);
  }
}

main().catch((err) => {
  console.error('\nFatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
