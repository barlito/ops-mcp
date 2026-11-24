// Writes deterministic OpenMetrics (canonical labels) for `promtool tsdb create-blocks-from openmetrics`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: genMetrics <output file>");

const STEP = 15;
const HOURS = 7;
// Ends 30 min ahead so queries at `now` never see the tail of the data (rate() windows would be short).
const end = Math.floor(Date.now() / 1000 / STEP) * STEP + 30 * 60;
const start = end - HOURS * 3600;
const times: number[] = [];
for (let t = start; t <= end; t += STEP) times.push(t);

const lines: string[] = [];
function series(name: string, labels: Record<string, string>, value: (t: number, i: number) => number): void {
  const l = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",");
  lines.push(`# TYPE ${name} gauge`);
  for (const [i, t] of times.entries()) lines.push(`${name}{${l}} ${value(t, i)} ${t}`);
}

const GiB = 1024 ** 3;
const base = (server: string) => ({ server, deployment_environment: "test" });
const container = (server: string, service: string, id: string) => ({ ...base(server), service_namespace: service.split("_")[0]!, service_name: service, container: `${service}.1.${id}`, host_name: "node-a" });
const node = (server: string, extra: Record<string, string> = {}) => ({ ...base(server), host_name: "node-a", ...extra });

// ovh-prod-1: shop_web uses 0.5 core (0.4 on lab), 256 MiB of a 512 MiB limit.
for (const [server, cores] of [["ovh-prod-1", 0.5], ["lab", 0.4]] as const) {
  const c = container(server, "shop_web", "aaa");
  series("container_cpu_usage_seconds_total", c, (_t, i) => i * STEP * cores);
  series("container_memory_working_set_bytes", c, () => 256 * 1024 ** 2);
  series("container_spec_memory_limit_bytes", c, () => 512 * 1024 ** 2);
  series("container_network_receive_bytes_total", c, (_t, i) => i * STEP * 1000);
  series("container_network_transmit_bytes_total", c, (_t, i) => i * STEP * 2000);
}
// One container from 3 h ago replaced 20 minutes ago: a single start inside a 1 h window.
series("container_start_time_seconds", container("ovh-prod-1", "shop_web", "old"), () => end - 3 * 3600);
series("container_start_time_seconds", container("ovh-prod-1", "shop_web", "new"), () => end - 20 * 60);

// Traefik names the service after the router label (shop@swarm), not the Swarm service.
const tf = { ...base("ovh-prod-1"), service: "shop@swarm", method: "GET" };
series("traefik_service_requests_total", { ...tf, code: "200" }, (_t, i) => i * STEP * 9);
series("traefik_service_requests_total", { ...tf, code: "500" }, (_t, i) => i * STEP * 1);
for (const [le, share] of [["0.1", 0.5], ["0.5", 1], ["+Inf", 1]] as const) {
  series("traefik_service_request_duration_seconds_bucket", { ...tf, le }, (_t, i) => i * STEP * 10 * share);
}

for (const server of ["ovh-prod-1", "lab"]) {
  const idle = server === "lab" ? 0.5 : 0.75;
  series("node_cpu_seconds_total", node(server, { cpu: "0", mode: "idle" }), (_t, i) => i * STEP * idle);
  series("node_cpu_seconds_total", node(server, { cpu: "0", mode: "user" }), (_t, i) => i * STEP * (1 - idle));
  series("node_load1", node(server), () => 1.5);
  series("node_load5", node(server), () => 1.25);
  series("node_load15", node(server), () => 1);
  series("node_memory_MemTotal_bytes", node(server), () => 8 * GiB);
  series("node_memory_MemAvailable_bytes", node(server), () => 2 * GiB);
  series("node_disk_io_time_seconds_total", node(server, { device: "sda" }), (_t, i) => i * STEP * 0.1);
  series("node_disk_read_bytes_total", node(server, { device: "sda" }), (_t, i) => i * STEP * 1000);
  series("node_disk_written_bytes_total", node(server, { device: "sda" }), (_t, i) => i * STEP * 3000);
  const fs = (mountpoint: string, fstype = "ext4") => node(server, { device: "sda1", mountpoint, fstype });
  series("node_filesystem_size_bytes", fs("/"), () => 100e9);
  series("node_filesystem_size_bytes", fs("/data"), () => 100e9);
  series("node_filesystem_size_bytes", fs("/run", "tmpfs"), () => 1e9);
  // "/" fills in exactly 10 days (5 GB/day); "/data" and the tmpfs are flat.
  series("node_filesystem_avail_bytes", fs("/"), (t) => 50e9 + (5e9 / 86400) * (end - t));
  series("node_filesystem_avail_bytes", fs("/data"), () => 80e9);
  series("node_filesystem_avail_bytes", fs("/run", "tmpfs"), () => 0.1e9);
}

lines.push("# EOF");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`${lines.length} lines, ${times.length} samples per series`);
