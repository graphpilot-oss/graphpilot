/**
 * score.ts — keyword-match rubric.
 *
 * A task is "correct" if at least 60% of expected keywords appear in the
 * answer (case-insensitive). The score is the hit-rate (0.0–1.0).
 */

export function score(
  answer: string,
  expectedKeywords: string[],
): { correct: boolean; score: number } {
  if (!expectedKeywords.length) return { correct: true, score: 1.0 };

  const lower = answer.toLowerCase();
  const hits = expectedKeywords.filter((kw) => lower.includes(kw.toLowerCase()));
  const ratio = hits.length / expectedKeywords.length;

  return {
    correct: ratio >= 0.6,
    score: Math.round(ratio * 100) / 100,
  };
}
