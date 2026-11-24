import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { isValidSlug } from "./platform/util";

const slug = z.string().refine(isValidSlug, "must be a slug (a-z, 0-9, hyphen, max 64 chars)");

const TenantSchema = z.strictObject({ slug });

// `agent` is accepted so the registry can describe phase 7 servers; the runtime reports them unreachable.
const SourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("local"), url: z.string().regex(/^(tcp|http):\/\/[^\s/]+$/, "must be tcp://host:port or http://host:port") }),
  z.strictObject({ type: z.literal("agent"), url: z.string().min(1).optional() }),
]);

const ServerSchema = z.strictObject({
  slug,
  env: slug,
  kind: z.enum(["swarm", "compose"]),
  tenant: slug,
  source: SourceSchema,
});

const RegistrySchema = z
  .strictObject({
    tenants: z.array(TenantSchema).min(1),
    servers: z.array(ServerSchema).min(1),
    // Stack name -> compose project, for stacks whose fr.barlito.repo label does not match.
    stack_projects: z.record(z.string().min(1), z.string().min(1)).default({}),
  })
  .superRefine((r, ctx) => {
    const dup = (items: Array<{ slug: string }>, path: string): void => {
      const seen = new Set<string>();
      items.forEach((it, i) => {
        if (seen.has(it.slug)) ctx.addIssue({ code: "custom", path: [path, i, "slug"], message: `duplicate slug "${it.slug}"` });
        seen.add(it.slug);
      });
    };
    dup(r.tenants, "tenants");
    dup(r.servers, "servers");
    const tenants = new Set(r.tenants.map((t) => t.slug));
    r.servers.forEach((s, i) => {
      if (!tenants.has(s.tenant)) ctx.addIssue({ code: "custom", path: ["servers", i, "tenant"], message: `unknown tenant "${s.tenant}"` });
    });
  });

export type Registry = z.infer<typeof RegistrySchema>;
export type ServerEntry = Registry["servers"][number];

export class RegistryError extends Error {}

export function parseRegistry(text: string, origin = "registry"): Registry {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new RegistryError(`Invalid ${origin}: not valid YAML (${(err as Error).message.split("\n")[0]})`);
  }
  const r = RegistrySchema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
    throw new RegistryError(`Invalid ${origin}:\n${lines.join("\n")}`);
  }
  return r.data;
}

export function loadRegistry(path: string | undefined = process.env.REGISTRY_PATH): Registry {
  if (!path) throw new RegistryError("REGISTRY_PATH environment variable is required");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new RegistryError(`Cannot read registry ${path}: ${(err as Error).message}`);
  }
  return parseRegistry(text, `registry ${path}`);
}
