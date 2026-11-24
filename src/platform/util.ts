// vendored from second-brain-mcp@d4ba1c5
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
