// Cross-file call to a uniquely-named export — name-based resolves it
// correctly today (only one `helper` in the corpus).
import { helper } from './lib.js';
export function useHelper(): number {
  return helper();
}
