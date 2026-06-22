// Same-file call — name-based resolver should get this right.
export function alpha(): number {
  return beta();
}
export function beta(): number {
  return 1;
}
