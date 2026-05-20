/**
 * Scoring: precision/recall/F1 of a returned set against ground truth.
 *
 * We score whether the set of names returned MATCHES the expected set,
 * not whether it's identical — partial credit is honest. F1 is the
 * primary metric. Per-task results show all three.
 */

export interface Scored {
  precision: number;
  recall: number;
  f1: number;
  intersectionSize: number;
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
}

export function score(returned: string[], groundTruth: string[]): Scored {
  const ret = new Set(returned);
  const gt = new Set(groundTruth);

  const tp: string[] = [];
  for (const r of ret) if (gt.has(r)) tp.push(r);

  const fp: string[] = [];
  for (const r of ret) if (!gt.has(r)) fp.push(r);

  const fn: string[] = [];
  for (const g of gt) if (!ret.has(g)) fn.push(g);

  // Edge case: empty ground truth + empty return = perfect.
  // (The recall-miss task hits this.)
  if (gt.size === 0 && ret.size === 0) {
    return {
      precision: 1,
      recall: 1,
      f1: 1,
      intersectionSize: 0,
      truePositives: [],
      falsePositives: [],
      falseNegatives: [],
    };
  }

  const precision = ret.size === 0 ? 0 : tp.length / ret.size;
  const recall = gt.size === 0 ? 0 : tp.length / gt.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    precision,
    recall,
    f1,
    intersectionSize: tp.length,
    truePositives: tp.sort(),
    falsePositives: fp.sort(),
    falseNegatives: fn.sort(),
  };
}
