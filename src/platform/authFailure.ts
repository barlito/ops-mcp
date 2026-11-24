// vendored from second-brain-mcp@d4ba1c5
// Audit of failed authentications, shared by the Bearer and connector-key paths. Per-client coalescing
// lives in the caller's limiter; this adds a global per-minute cap so many clients cannot flood the log.
import type { AuditLog } from "./audit";
import { GlobalBudget } from "./rateLimit";
import { errorMessage, redact } from "./util";

const SWALLOWED = (n: number): string => `${n} further auth failures not logged (per-minute audit cap)`;

export class AuthFailureAudit {
  private readonly budget: GlobalBudget;

  constructor(
    private readonly audit: AuditLog,
    maxPerMin = 30,
  ) {
    this.budget = new GlobalBudget(maxPerMin);
  }

  // Best effort on shutdown: report failures swallowed by the cap that no later window would report.
  flush(): void {
    const n = this.budget.drain();
    if (n === 0) return;
    try {
      this.audit.logAuthFailure({ reason: SWALLOWED(n) });
    } catch {
      /* DB may already be closing */
    }
  }

  record(clientIp: string | undefined, reason: string): void {
    const b = this.budget.take();
    try {
      if (b.summary > 0) this.audit.logAuthFailure({ reason: SWALLOWED(b.summary) });
      if (b.log) this.audit.logAuthFailure({ clientIp, reason });
    } catch (err) {
      // A DB failure here must still yield a 401.
      console.error("auth failure audit write failed:", redact(errorMessage(err)));
    }
  }
}
