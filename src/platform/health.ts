// vendored from second-brain-mcp@d4ba1c5
import type { Db } from "./db";

export function dbOk(db: Db): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}
