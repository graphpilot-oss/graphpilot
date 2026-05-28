export type TaskType = 'navigation' | 'callers' | 'impact' | 'trace' | 'dependency';

export interface Task {
  id: string;
  type: TaskType;
  question: string;
  /** Keyword(s) that must appear in a correct answer (case-insensitive). */
  expectedKeywords: string[];
  /** Ground-truth answer produced by GP tools during generation phase. */
  groundTruth: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  resultBytes: number;
}

export interface TaskResult {
  taskId: string;
  mode: 'baseline' | 'gp';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: ToolCall[];
  filesRead: string[];
  answer: string;
  correct: boolean;
  score: number; // 0.0–1.0 keyword hit-rate
  durationMs: number;
  peakHeapMb: number;
}

export interface BenchmarkRun {
  timestamp: string;
  fastifySha: string;
  gpVersion: string;
  model: string;
  tasks: Task[];
  results: TaskResult[];
}

export interface Summary {
  totalTasks: number;
  baselineTokens: { input: number; output: number; total: number };
  gpTokens: { input: number; output: number; total: number };
  savedTokens: number;
  savedPercent: number;
  baselineFilesRead: number;
  gpFilesRead: number;
  baselineToolCalls: number;
  gpToolCalls: number;
  baselineCorrect: number;
  gpCorrect: number;
  baselineAvgMs: number;
  gpAvgMs: number;
  byType: Record<
    TaskType,
    {
      baselineTokens: number;
      gpTokens: number;
      savedPercent: number;
    }
  >;
}
