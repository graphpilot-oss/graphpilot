/**
 * The 10-task benchmark corpus. Hand-curated against graphpilot indexing
 * itself, so anyone can `git clone` + `pnpm install` + `pnpm bench` and
 * see the same numbers.
 *
 * Each task carries its OWN ground truth so this file is the single
 * source of truth for what "correct" means. Ground truth was computed
 * by probing the live index at the time this file was authored; if the
 * corpus repo (graphpilot itself) is materially edited, ground truth
 * needs to be refreshed (see bench/README.md §Refreshing).
 *
 * Mix of task types is deliberate:
 *  - 7 tasks where GraphPilot's structural index should win
 *  - 1 task that's roughly a tie (negative result)
 *  - 1 task where grep should outperform GraphPilot (string-literal
 *    search). Keeping this in the corpus is what makes the benchmark
 *    honest.
 */

export type TaskKind =
  | 'callers' // who calls X?
  | 'recall' // find symbol by exact name
  | 'recall-substring' // find symbols whose name contains a fragment
  | 'kind-filter' // find all symbols of kind=...
  | 'impact' // blast-radius analysis
  | 'tests-affected' // which tests depend on this symbol
  | 'recall-miss' // symbol that doesn't exist
  | 'string-literal'; // text-only search — grep should win

export interface Task {
  id: string;
  description: string;
  /** What a developer / agent would naturally ask. */
  prompt: string;
  kind: TaskKind;
  /** Argument to the task's natural tool (graphpilot side). */
  query: string;
  /**
   * Set of expected symbol names (sorted) that the correct answer must
   * contain. For tests-affected tasks, this is the set of test file paths.
   */
  groundTruth: string[];
  /** Which side we expect to win on F1 score. */
  expectedWinner: 'graphpilot' | 'grep' | 'tie';
  /** Helpful for the README/results: structural vs text-only. */
  difficulty: 'low' | 'medium' | 'high';
}

export const TASKS: Task[] = [
  {
    id: 't01-callers-analyzeImpact',
    description: 'Find every function that calls analyzeImpact',
    prompt: 'In this repo, what functions call analyzeImpact?',
    kind: 'callers',
    query: 'analyzeImpact',
    groundTruth: ['handleGpImpact'],
    expectedWinner: 'graphpilot',
    difficulty: 'low',
  },
  {
    id: 't02-callers-extractSymbols',
    description: 'Find every direct caller of extractSymbols',
    prompt: 'Who calls extractSymbols in this codebase?',
    kind: 'callers',
    query: 'extractSymbols',
    groundTruth: ['indexDirectory', 'applyUpdate', 'symbolsOf'],
    expectedWinner: 'graphpilot',
    difficulty: 'low',
  },
  {
    id: 't03-callers-validateRootPath',
    description: 'Find every direct caller of validateRootPath',
    prompt:
      'Where is validateRootPath used in the codebase? List every callsite.',
    kind: 'callers',
    query: 'validateRootPath',
    // Note: GraphWatcher constructor calls validateRootPath; the SymbolRecord
    // for that constructor has name="constructor" (not "GraphWatcher").
    groundTruth: ['cmdIndex', 'main', 'handleGpIndex', 'constructor'],
    expectedWinner: 'graphpilot',
    difficulty: 'medium',
  },
  {
    id: 't04-recall-substring-parse',
    description: 'Find every symbol whose name contains "parse"',
    prompt: 'List every function, class, or interface whose name contains "parse".',
    kind: 'recall-substring',
    query: 'parse',
    groundTruth: [
      'ParsedFile',
      'getParser',
      'parseFile',
      'parseSource',
      'parseToken',
    ],
    expectedWinner: 'graphpilot',
    difficulty: 'low',
  },
  {
    id: 't05-kind-filter-interfaces',
    description: 'Enumerate all TypeScript interfaces under src/',
    prompt: 'List every TypeScript interface defined under src/.',
    kind: 'kind-filter',
    query: 'interface', // means: kind === "interface"
    groundTruth: [
      'CallEdge',
      'EdgeQueryOptions',
      'Graph',
      'GpCallersArgs',
      'GpImpactArgs',
      'GpIndexArgs',
      'GpRecallArgs',
      'GpStatsArgs',
      'ImpactCaller',
      'ImpactOptions',
      'ImpactResult',
      'IndexOptions',
      'IndexResult',
      'InteractionEntry',
      'ParsedFile',
      'RawCall',
      'RecallOptions',
      'SecretPattern',
      'SymbolRecord',
      'ToolResult',
      'UpdateResult',
      'ValidationContext',
      'WatcherOptions',
    ],
    expectedWinner: 'graphpilot',
    difficulty: 'medium',
  },
  {
    id: 't06-impact-extractSymbols-depth2',
    description:
      'Compute blast radius of changing extractSymbols (depth 2)',
    prompt:
      "If I change extractSymbols's signature, what functions will I need to update? Include indirect callers up to two hops.",
    kind: 'impact',
    query: 'extractSymbols',
    // Direct callers + their direct callers
    groundTruth: [
      // d=1
      'indexDirectory',
      'applyUpdate',
      'symbolsOf',
      // d=2 — callers of the above
      'cmdIndex',
      'handleGpIndex',
      'handleEvent',
      // symbolsOf has no callers in production code; it's only in tests
    ],
    expectedWinner: 'graphpilot',
    difficulty: 'high',
  },
  {
    id: 't07-tests-affected-parseFile',
    description: 'Identify test files that exercise parseFile (directly)',
    prompt:
      'If I change the behavior of parseFile, which test files are most likely to break?',
    kind: 'tests-affected',
    query: 'parseFile',
    // The test file containing symbolsOf which calls parseFile
    groundTruth: ['tests/symbols.test.ts'],
    expectedWinner: 'graphpilot',
    difficulty: 'medium',
  },
  {
    id: 't08-recall-substring-args',
    description: 'Find every MCP-tool input-args interface',
    prompt: 'List every TypeScript type whose name ends with "Args".',
    kind: 'recall-substring',
    query: 'Args',
    groundTruth: [
      'GpCallersArgs',
      'GpImpactArgs',
      'GpIndexArgs',
      'GpRecallArgs',
      'GpStatsArgs',
    ],
    expectedWinner: 'graphpilot',
    difficulty: 'low',
  },
  {
    id: 't09-recall-miss',
    description: 'Look up a symbol that does not exist (negative test)',
    prompt: 'Find the function definitelyNotARealSymbol in this codebase.',
    kind: 'recall-miss',
    query: 'definitelyNotARealSymbol',
    groundTruth: [], // empty set
    expectedWinner: 'tie',
    difficulty: 'low',
  },
  {
    id: 't10-string-literal-MAX_FILE_BYTES',
    description:
      'Find every literal occurrence of the constant name "MAX_FILE_BYTES"',
    prompt: 'Find every place the string "MAX_FILE_BYTES" appears in the source.',
    kind: 'string-literal',
    query: 'MAX_FILE_BYTES',
    // We don't index string literals or identifier usages outside structural
    // contexts — but for THIS specific constant the structural index has the
    // declaration. Both should find the declaration; only grep finds every
    // usage. We expect grep to win on recall here.
    groundTruth: [
      'src/validation.ts', // declared here
      'src/parser.ts', // imported and used
      'tests/security.test.ts', // referenced in a test
    ],
    expectedWinner: 'grep',
    difficulty: 'medium',
  },
];
