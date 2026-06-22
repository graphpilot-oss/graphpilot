// Same name `save`, but imported from dup_b. The name-based resolver can only
// pick ONE global `save` for both use_save and use_save_b, so at least one is
// guaranteed wrong today — exactly the precision miss #73 fixes.
import { save } from './dup_b.js';
export function useSaveB(): string {
  return save();
}
