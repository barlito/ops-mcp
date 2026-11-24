// One table every redaction entry point must satisfy: `leaks` must be gone, `keeps` must survive.
export interface RedactionCase {
  input: string;
  leaks: string[];
  keeps?: string[];
}

export const REDACTION_CASES: RedactionCase[] = [
  { input: "DB_PASS=hunter2x", leaks: ["hunter2x"], keeps: ["DB_PASS"] },
  { input: "auth_key=abcdef123", leaks: ["abcdef123"] },
  { input: "Cookie: authelia_session=abcdefghijkl; other=zzzzzz", leaks: ["abcdefghijkl", "zzzzzz"], keeps: ["Cookie"] },
  { input: "Set-Cookie: sid=qwertyuiop; Path=/", leaks: ["qwertyuiop"] },
  { input: "password: hunter2 access_token: abc12345", leaks: ["hunter2", "abc12345"] },
  { input: "PGPASSWORD=foo123 MYSQL_ROOT_PASSWORD=bar456", leaks: ["foo123", "bar456"] },
  { input: "run --api-key=zzz999 TOKEN=abc999 plain=ok", leaks: ["zzz999", "abc999"], keeps: ["plain=ok"] },
  { input: "X-Api-Key: k2k2k2k2", leaks: ["k2k2k2k2"] },
  { input: "dsn=postgres://u:pw1234@db/x credential=cred5678 session=sess9012", leaks: ["pw1234", "cred5678", "sess9012"] },
  { input: "psql postgresql://app:fake-pass@db:5432/app", leaks: ["fake-pass"], keeps: ["db:5432"] },
  { input: "mysql://u:p@ss@h/db", leaks: ["p@ss"], keeps: ["h/db"] },
  { input: "Authorization: Bearer abc.def-ghi_jkl", leaks: ["abc.def-ghi_jkl"] },
  { input: "Authorization: Token tok1234567", leaks: ["tok1234567"] },
  { input: '{"user":"bob","password":"p\\"w","client_secret": "t0k"}', leaks: ["p\\\"w", "t0k"], keeps: ["bob"] },
  { input: "tokens=5 passwordless login monkey=banana author=ann keyword=x", leaks: [], keeps: ["tokens=5", "passwordless", "monkey=banana", "author=ann", "keyword=x"] },
  { input: "task: non-zero exit (1)", leaks: [], keeps: ["task: non-zero exit (1)"] },
];
