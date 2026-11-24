// `sel` is a trusted matcher list built with labels.ts, e.g. `server="ovh-prod-1",host_name="h1"`.
const PSEUDO_FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|devtmpfs|fuse.*"';

export const cpuPct = (sel: string, range: string): string => `100 * (1 - avg by (host_name) (rate(node_cpu_seconds_total{${sel},mode="idle"}[${range}])))`;

export const ramPct = (sel: string): string => `100 * (1 - node_memory_MemAvailable_bytes{${sel}} / node_memory_MemTotal_bytes{${sel}})`;

const avail = (sel: string): string => `max by (host_name, mountpoint) (node_filesystem_avail_bytes{${sel},${PSEUDO_FS}})`;

export const diskUsedPct = (sel: string): string => `100 * (1 - ${avail(sel)} / max by (host_name, mountpoint) (node_filesystem_size_bytes{${sel},${PSEUDO_FS}}))`;

// Days until the filesystem is full at the recent trend; empty when it is not filling within a year.
export const diskDaysUntilFull = (sel: string, lookback: string): string =>
  `(${avail(sel)} / -deriv((${avail(sel)})[${lookback}:5m]) / 86400) and (predict_linear((${avail(sel)})[${lookback}:5m], 365 * 86400) < 0)`;
