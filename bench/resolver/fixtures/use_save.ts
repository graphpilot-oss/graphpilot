// Cross-file call to a name that exists in TWO files. The import says dup_a,
// but the name-based resolver can only guess (flags `ambiguous`). This is the
// precision case import-path resolution (#73) is meant to fix.
import { save } from './dup_a.js';
export function useSave(): string {
  return save();
}
