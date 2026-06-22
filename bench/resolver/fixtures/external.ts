// Call with no in-repo definition (stdlib) — should stay unresolved.
export function useExternal(): number {
  return Math.max(1, 2);
}
