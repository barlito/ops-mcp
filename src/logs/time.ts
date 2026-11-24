const NS_PER_MS = 1_000_000n;

export const toNs = (d: Date): bigint => BigInt(d.getTime()) * NS_PER_MS;

// RFC 3339 with nanosecond precision, so a cursor or a context lookup can round-trip a Loki timestamp.
export function isoNs(ns: bigint): string {
  const ms = ns / NS_PER_MS;
  const frac = (ns - ms * NS_PER_MS).toString().padStart(6, "0");
  return new Date(Number(ms)).toISOString().replace("Z", `${frac}Z`);
}

// Input must already match the RFC 3339 shape (see contract.ts); fractional digits beyond ms are kept.
export function parseNs(rfc3339: string): bigint {
  const frac = /\.(\d+)/.exec(rfc3339)?.[1] ?? "";
  const whole = Date.parse(rfc3339.replace(/\.\d+/, ""));
  if (Number.isNaN(whole)) throw new RangeError(`invalid timestamp ${rfc3339}`);
  return BigInt(whole) * NS_PER_MS + BigInt(frac.padEnd(9, "0").slice(0, 9));
}
