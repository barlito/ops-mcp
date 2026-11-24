import { isSensitiveName, redactSecrets } from "../platform/redact/secrets";
import { imageLabel, timeOf } from "./swarm";
import {
  type ImageRef,
  type NodeInfo,
  type ServiceDetail,
  type ServiceSummary,
  type ServiceUpdate,
  type TaskInfo,
  type UpdateStatus,
  STACK_LABEL,
} from "./types";

// Raw Docker API shapes: only the fields read below. Anything not named here (notably
// ContainerSpec.Env, Secrets[].SecretID, TLS info) can never reach an output.
interface RawResources {
  NanoCPUs?: number;
  MemoryBytes?: number;
}
interface RawContainerSpec {
  Image?: string;
  Labels?: Record<string, string>;
  Command?: string[];
  Args?: string[];
  Secrets?: Array<{ SecretName?: string }>;
  Configs?: Array<{ ConfigName?: string }>;
}
interface RawServiceSpec {
  Name?: string;
  Labels?: Record<string, string>;
  Mode?: { Replicated?: { Replicas?: number }; Global?: object; ReplicatedJob?: object; GlobalJob?: object };
  TaskTemplate?: {
    ContainerSpec?: RawContainerSpec;
    Resources?: { Limits?: RawResources; Reservations?: RawResources };
    Placement?: { Constraints?: string[] };
    Networks?: Array<{ Target?: string }>;
  };
}
export interface RawService {
  ID: string;
  CreatedAt?: string;
  UpdatedAt?: string;
  Spec?: RawServiceSpec;
  PreviousSpec?: RawServiceSpec;
  Endpoint?: { Ports?: Array<{ Protocol?: string; TargetPort?: number; PublishedPort?: number; PublishMode?: string }> };
  UpdateStatus?: { State?: string; StartedAt?: string; CompletedAt?: string; Message?: string };
  ServiceStatus?: { RunningTasks?: number; DesiredTasks?: number };
}
export interface RawTask {
  ID: string;
  CreatedAt?: string;
  UpdatedAt?: string;
  Slot?: number;
  NodeID?: string;
  ServiceID?: string;
  Spec?: { ContainerSpec?: { Image?: string } };
  DesiredState?: string;
  Status?: { Timestamp?: string; State?: string; Err?: string; ContainerStatus?: { ExitCode?: number } };
}
export interface RawNode {
  ID: string;
  Spec?: { Role?: string; Availability?: string };
  Description?: { Hostname?: string };
  Status?: { State?: string };
  ManagerStatus?: { Leader?: boolean };
}

// Bounded quantifiers and bounded inputs: these run on untrusted text.
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]{1,128}@/gi;
const MAX_TEXT_CHARS = 500;
const MAX_ERROR_CHARS = 300;
const MAX_ARG_CHARS = 100;
const MAX_LABEL_CHARS = 120;
const MAX_LABEL_KEY_CHARS = 100;
const MAX_LABELS = 15;
const MAX_ARGS = 20;
const MAX_LIST = 10;
const SHORT_ID = 12;
const SHORT_DIGEST = "sha256:".length + 12;
const ALLOWED_LABEL_PREFIXES = ["com.docker.", "fr.barlito."];
const ROUTER_RULE = /^traefik\.(?:http|tcp)\.routers\.(.+)\.rule$/;

// Truncates first: the output is bounded and the regexes never see more than `max` chars.
export function redactText(text: string, max = MAX_TEXT_CHARS): string {
  return redactSecrets(text.slice(0, max).replace(URL_USERINFO, "$1[REDACTED]@"));
}

// A sensitive flag given without `=` hides the next argument too.
export function redactArgs(args: string[]): string[] {
  let maskNext = false;
  return args.map((arg) => {
    if (maskNext) {
      maskNext = false;
      return "[REDACTED]";
    }
    const flag = /^--?[\w.-]+$/.test(arg) && isSensitiveName(arg);
    maskNext = flag;
    return flag ? arg : redactText(arg, MAX_ARG_CHARS);
  }).slice(0, MAX_ARGS);
}

export function filterLabels(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (ALLOWED_LABEL_PREFIXES.some((p) => key.startsWith(p))) merged[key.slice(0, MAX_LABEL_KEY_CHARS)] = redactText(value, MAX_LABEL_CHARS);
    }
  }
  return Object.fromEntries(Object.entries(merged).slice(0, MAX_LABELS));
}

// Router names and Host() rules only; middlewares (basicauth users, ...) are dropped.
export function traefikRoutes(labels: Record<string, string> = {}): Array<{ router: string; hosts: string[] }> {
  const routes: Array<{ router: string; hosts: string[] }> = [];
  for (const [key, rule] of Object.entries(labels)) {
    const router = ROUTER_RULE.exec(key)?.[1];
    if (router === undefined) continue;
    const hosts = [...rule.slice(0, 1000).matchAll(/Host\(([^)]*)\)/g)].flatMap((m) => [...(m[1] ?? "").matchAll(/`([^`]+)`/g)].map((h) => h[1]!.slice(0, 100)));
    routes.push({ router: router.slice(0, 64), hosts: hosts.slice(0, MAX_LIST) });
  }
  return routes;
}

export function parseImage(raw = ""): ImageRef {
  const [ref = "", digest] = raw.split("@");
  const colon = ref.lastIndexOf(":");
  const hasTag = colon > ref.lastIndexOf("/");
  return {
    name: hasTag ? ref.slice(0, colon) : ref,
    ...(hasTag ? { tag: ref.slice(colon + 1) } : {}),
    ...(digest ? { digest: digest.slice(0, SHORT_DIGEST) } : {}),
  };
}

function modeOf(spec?: RawServiceSpec): string {
  const mode = spec?.Mode;
  if (mode?.Replicated) return "replicated";
  if (mode?.Global) return "global";
  if (mode?.ReplicatedJob) return "replicated-job";
  if (mode?.GlobalJob) return "global-job";
  return "unknown";
}

function updateStatusOf(raw: RawService["UpdateStatus"]): UpdateStatus | undefined {
  if (!raw?.State) return undefined;
  return {
    state: raw.State,
    ...(raw.Message ? { message: redactText(raw.Message, MAX_ERROR_CHARS) } : {}),
    ...(raw.StartedAt ? { started_at: raw.StartedAt } : {}),
    ...(raw.CompletedAt ? { completed_at: raw.CompletedAt } : {}),
  };
}

export function sanitizeNode(raw: RawNode): NodeInfo {
  return {
    id: raw.ID,
    hostname: raw.Description?.Hostname ?? raw.ID.slice(0, SHORT_ID),
    role: raw.Spec?.Role ?? "unknown",
    availability: raw.Spec?.Availability ?? "unknown",
    state: raw.Status?.State ?? "unknown",
    leader: raw.ManagerStatus?.Leader === true,
  };
}

export function sanitizeServiceSummary(raw: RawService, status: RawService["ServiceStatus"] = raw.ServiceStatus): ServiceSummary {
  const container = raw.Spec?.TaskTemplate?.ContainerSpec;
  const labels = filterLabels(container?.Labels, raw.Spec?.Labels);
  const stack = labels[STACK_LABEL];
  return {
    id: raw.ID,
    name: raw.Spec?.Name ?? raw.ID,
    ...(stack === undefined ? {} : { stack }),
    mode: modeOf(raw.Spec),
    desired: status?.DesiredTasks ?? raw.Spec?.Mode?.Replicated?.Replicas ?? 0,
    running: status?.RunningTasks ?? 0,
    image: parseImage(container?.Image),
    labels,
    created_at: raw.CreatedAt ?? "",
    updated_at: raw.UpdatedAt ?? "",
  };
}

export function sanitizeServiceDetail(raw: RawService, status?: RawService["ServiceStatus"]): ServiceDetail {
  const template = raw.Spec?.TaskTemplate;
  const container = template?.ContainerSpec;
  const resources = (r?: RawResources) =>
    r === undefined ? undefined : { ...(r.NanoCPUs === undefined ? {} : { nano_cpus: r.NanoCPUs }), ...(r.MemoryBytes === undefined ? {} : { memory_bytes: r.MemoryBytes }) };
  const limits = resources(template?.Resources?.Limits);
  const reservations = resources(template?.Resources?.Reservations);
  const updateStatus = updateStatusOf(raw.UpdateStatus);
  const previous = raw.PreviousSpec?.TaskTemplate?.ContainerSpec?.Image;
  return {
    ...sanitizeServiceSummary(raw, status),
    ...(updateStatus ? { update_status: updateStatus } : {}),
    ...(previous ? { previous_image: parseImage(previous) } : {}),
    networks: (template?.Networks ?? []).flatMap((n) => (n.Target ? [n.Target.slice(0, SHORT_ID)] : [])).slice(0, MAX_LIST),
    constraints: (template?.Placement?.Constraints ?? []).slice(0, MAX_LIST).map((c) => redactText(c, MAX_ARG_CHARS)),
    ...(limits ? { limits } : {}),
    ...(reservations ? { reservations } : {}),
    ports: (raw.Endpoint?.Ports ?? []).slice(0, MAX_LIST).map((p) => ({
      protocol: p.Protocol ?? "tcp",
      target: p.TargetPort ?? 0,
      ...(p.PublishedPort === undefined ? {} : { published: p.PublishedPort }),
      ...(p.PublishMode ? { mode: p.PublishMode } : {}),
    })),
    routes: traefikRoutes(raw.Spec?.Labels).slice(0, MAX_LIST),
    secrets: (container?.Secrets ?? []).flatMap((s) => (s.SecretName ? [s.SecretName.slice(0, 100)] : [])).slice(0, MAX_LIST),
    configs: (container?.Configs ?? []).flatMap((c) => (c.ConfigName ? [c.ConfigName.slice(0, 100)] : [])).slice(0, MAX_LIST),
    ...(container?.Command ? { command: redactArgs(container.Command) } : {}),
    ...(container?.Args ? { args: redactArgs(container.Args) } : {}),
  };
}

export function sanitizeUpdate(raw: RawService): ServiceUpdate {
  const summary = sanitizeServiceSummary(raw);
  const updateStatus = updateStatusOf(raw.UpdateStatus);
  const previous = raw.PreviousSpec?.TaskTemplate?.ContainerSpec?.Image;
  return {
    service: summary.name,
    ...(summary.stack === undefined ? {} : { stack: summary.stack }),
    created_at: summary.created_at,
    updated_at: summary.updated_at,
    ...(updateStatus ? { update_status: updateStatus } : {}),
    image: summary.image,
    ...(previous ? { previous_image: parseImage(previous) } : {}),
  };
}

// An automatic rollback restores the old spec and clears PreviousSpec: the version that failed is
// only visible in the most recent failed task running a different image.
export function failedImage(tasks: RawTask[], current: ImageRef): ImageRef | undefined {
  const failed = tasks
    .filter((t) => t.Status?.State === "failed" || t.Status?.State === "rejected")
    .sort((a, b) => timeOf(b.Status?.Timestamp ?? b.UpdatedAt ?? "") - timeOf(a.Status?.Timestamp ?? a.UpdatedAt ?? ""));
  for (const task of failed) {
    const image = parseImage(task.Spec?.ContainerSpec?.Image);
    if (image.name !== "" && (image.name !== current.name || image.tag !== current.tag)) return image;
  }
  return undefined;
}

export function sanitizeTask(raw: RawTask, serviceNames: ReadonlyMap<string, string>, nodeNames: ReadonlyMap<string, string>): TaskInfo {
  const exitCode = raw.Status?.ContainerStatus?.ExitCode;
  const node = raw.NodeID === undefined ? undefined : (nodeNames.get(raw.NodeID) ?? raw.NodeID.slice(0, SHORT_ID));
  const image = raw.Spec?.ContainerSpec?.Image;
  return {
    id: raw.ID,
    service: serviceNames.get(raw.ServiceID ?? "") ?? (raw.ServiceID ?? "").slice(0, SHORT_ID),
    ...(raw.Slot === undefined ? {} : { slot: raw.Slot }),
    ...(node === undefined ? {} : { node }),
    ...(image ? { image: imageLabel(parseImage(image)) } : {}),
    state: raw.Status?.State ?? "unknown",
    desired_state: raw.DesiredState ?? "unknown",
    ...(raw.Status?.Err ? { error: redactText(raw.Status.Err, MAX_ERROR_CHARS) } : {}),
    ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    created_at: raw.CreatedAt ?? "",
    updated_at: raw.Status?.Timestamp ?? raw.UpdatedAt ?? "",
  };
}
