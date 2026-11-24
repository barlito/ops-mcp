import { z } from "zod";

export const STACK_LABEL = "com.docker.stack.namespace";
export const REPO_LABEL = "fr.barlito.repo";

export const ImageRefSchema = z.object({ name: z.string(), tag: z.string().optional(), digest: z.string().optional() });
export type ImageRef = z.infer<typeof ImageRefSchema>;

export const NodeSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  role: z.string(),
  availability: z.string(),
  state: z.string(),
  leader: z.boolean(),
});
export type NodeInfo = z.infer<typeof NodeSchema>;

export const ServiceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  stack: z.string().optional(),
  mode: z.string(),
  desired: z.number(),
  running: z.number(),
  image: ImageRefSchema,
  labels: z.record(z.string(), z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ServiceSummary = z.infer<typeof ServiceSummarySchema>;

export const UpdateStatusSchema = z.object({
  state: z.string(),
  message: z.string().optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

const ResourcesSchema = z.object({ nano_cpus: z.number().optional(), memory_bytes: z.number().optional() });

export const ServiceDetailSchema = ServiceSummarySchema.extend({
  update_status: UpdateStatusSchema.optional(),
  previous_image: ImageRefSchema.optional(),
  networks: z.array(z.string()),
  constraints: z.array(z.string()),
  limits: ResourcesSchema.optional(),
  reservations: ResourcesSchema.optional(),
  ports: z.array(z.object({ protocol: z.string(), target: z.number(), published: z.number().optional(), mode: z.string().optional() })),
  routes: z.array(z.object({ router: z.string(), hosts: z.array(z.string()) })),
  secrets: z.array(z.string()),
  configs: z.array(z.string()),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
});
export type ServiceDetail = z.infer<typeof ServiceDetailSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  service: z.string(),
  slot: z.number().optional(),
  node: z.string().optional(),
  image: z.string().optional(),
  state: z.string(),
  desired_state: z.string(),
  error: z.string().optional(),
  exit_code: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type TaskInfo = z.infer<typeof TaskSchema>;

export const ServiceUpdateSchema = z.object({
  service: z.string(),
  stack: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  update_status: UpdateStatusSchema.optional(),
  image: ImageRefSchema,
  previous_image: ImageRefSchema.optional(),
  failed_image: ImageRefSchema.optional(),
});
export type ServiceUpdate = z.infer<typeof ServiceUpdateSchema>;

export interface StackInfo {
  name: string;
  services: ServiceSummary[];
}

export interface ServiceFilter {
  stack?: string;
  service?: string;
}

export interface TaskFilter extends ServiceFilter {
  state?: string;
}
