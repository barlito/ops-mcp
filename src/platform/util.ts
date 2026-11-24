// vendored from second-brain-mcp@d4ba1c5
import { readFileSync } from "node:fs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

// Strips credentials from URLs before anything is logged.
export function redact(text: string): string {
  return text.replace(/:\/\/[^@/\s]+@/g, "://***@");
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Secrets come from a Docker secret file (`<NAME>_FILE`) rather than the service environment, which the
// Docker API (and so dockerproxy-ops) exposes. The plain variable stays as a local-dev fallback.
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env[`${name}_FILE`];
  const value = file ? readFileSync(file, "utf8") : env[name];
  return value?.trim() || undefined;
}
