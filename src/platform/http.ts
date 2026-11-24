// vendored from second-brain-mcp@d4ba1c5
import dns from "node:dns";
import type { Server } from "node:http";
import net from "node:net";
import type { Response } from "express";
import { errorMessage, redact } from "./util";

export function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

// Counts /mcp requests from entry (before auth/body parsing) to response finish/close, so
// shutdown can wait for them before closing the DB.
export class Lifecycle {
  shuttingDown = false;
  private inflight = 0;
  private idleWaiters: Array<() => void> = [];

  get inFlight(): number {
    return this.inflight;
  }

  enter(res: Response): void {
    this.inflight++;
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      if (--this.inflight === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
    };
    res.once("finish", leave);
    res.once("close", leave);
  }

  waitIdle(): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

// ---- trusted proxies ------------------------------------------------------

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

export interface TrustedProxy {
  trust: (addr: string) => boolean;
  refresh: () => Promise<void>;
  stop: () => void;
}

function normalizeIp(addr: string): string {
  return addr.startsWith("::ffff:") && net.isIPv4(addr.slice(7)) ? addr.slice(7) : addr;
}

// TRUSTED_PROXY: comma-separated hostnames, IPs or CIDRs. XFF is honoured only when the direct peer is
// in the set. Hostnames are resolved by refresh() and cached; trust() never waits on DNS. Empty spec
// trusts nobody.
export function createTrustedProxy(spec: string | undefined, resolve: Resolver = defaultResolver, refreshMs = 60_000): TrustedProxy {
  const entries = (spec ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const fixed: Array<{ addr: string; prefix?: number }> = [];
  const hosts: string[] = [];
  for (const e of entries) {
    const [addr = "", prefix] = e.split("/");
    if (net.isIP(addr) === 0) hosts.push(e);
    else fixed.push({ addr, prefix: prefix === undefined ? undefined : Number(prefix) });
  }
  const fam = (a: string): "ipv4" | "ipv6" => (net.isIPv4(a) ? "ipv4" : "ipv6");

  const resolved = new Map<string, string[]>();
  // Replaced atomically on refresh; trust() only ever reads it.
  let list = new net.BlockList();
  const rebuild = (): void => {
    const next = new net.BlockList();
    for (const f of fixed) {
      if (f.prefix === undefined) next.addAddress(f.addr, fam(f.addr));
      else next.addSubnet(f.addr, f.prefix, fam(f.addr));
    }
    for (const addrs of resolved.values()) for (const a of addrs) next.addAddress(a, fam(a));
    list = next;
  };
  rebuild();

  const refresh = async (): Promise<void> => {
    await Promise.all(
      hosts.map(async (h) => {
        try {
          resolved.set(h, await resolve(h));
        } catch (err) {
          // Keep the last good answer for this host.
          console.error(`TRUSTED_PROXY: cannot resolve ${h}: ${redact(errorMessage(err))}`);
        }
      }),
    );
    rebuild();
  };

  let timer: NodeJS.Timeout | undefined;
  if (hosts.length > 0) {
    timer = setInterval(() => void refresh(), refreshMs);
    timer.unref();
  }

  return {
    trust: (addr) => {
      const ip = normalizeIp(addr);
      const family = net.isIP(ip);
      return family !== 0 && list.check(ip, family === 4 ? "ipv4" : "ipv6");
    },
    refresh,
    stop: () => timer && clearInterval(timer),
  };
}

// ---- auth-failure limiter -------------------------------------------------

// In-memory, per client IP. After `max` failures inside one window the IP is blocked until the window
// ends; audit rows are coalesced to one per window.
export class AuthFailureLimiter {
  private readonly map = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(ip: string): boolean {
    const e = this.map.get(ip);
    return !!e && this.now() - e.start < this.windowMs && e.count >= this.max;
  }

  // Records a failure. `audit` is true for the first failure of a window; `previous` is the failure
  // count of the window that just ended.
  record(ip: string): { audit: boolean; previous: number } {
    const t = this.now();
    const e = this.map.get(ip);
    if (e && t - e.start < this.windowMs) {
      e.count++;
      return { audit: false, previous: 0 };
    }
    this.map.delete(ip); // re-insert so eviction order follows window starts
    this.map.set(ip, { start: t, count: 1 });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value as string);
    }
    return { audit: true, previous: e?.count ?? 0 };
  }
}

// ---- shutdown --------------------------------------------------------------

export interface ShutdownDeps {
  servers: Array<Pick<Server, "close" | "closeAllConnections">>;
  lifecycle?: Lifecycle;
  stop?: () => void;
  closeDb: () => void;
  drainTimeoutMs?: number;
  exit?: (code: number) => void;
}

// Idempotent: the first call shuts down gracefully, any later call (second signal) exits immediately.
export function createShutdown(deps: ShutdownDeps): (signal?: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = deps.drainTimeoutMs ?? 25_000;
  let started = false;

  return async (signal = "shutdown") => {
    if (started) {
      console.error(`${signal} received again, exiting immediately`);
      exit(1);
      return;
    }
    started = true;
    console.log(`${signal} received, shutting down`);

    if (deps.lifecycle) deps.lifecycle.shuttingDown = true;
    const closed = Promise.all(deps.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    deps.stop?.();

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const r = await Promise.race([deps.lifecycle?.waitIdle().then(() => "idle" as const) ?? Promise.resolve("idle" as const), timedOut]);
    clearTimeout(timer);
    if (r === "timeout") console.error(`in-flight requests did not finish within ${timeoutMs} ms`);

    // Cut remaining (keep-alive) connections so close() can finish.
    for (const s of deps.servers) s.closeAllConnections();
    await Promise.race([closed, new Promise((res) => setTimeout(res, 1000).unref())]);
    try {
      deps.closeDb();
    } catch (err) {
      console.error("error closing DB:", err);
    }
    exit(0);
  };
}
