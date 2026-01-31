import { z } from "zod";

export const EndpointEntrySchema = z
  .object({
    id: z.string().min(1),
    instructions: z.string().optional(),
    mode: z.union([z.literal("sync"), z.literal("async")]).optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict();

export const EndpointsSchema = z
  .object({
    enabled: z.boolean().optional(),
    token: z.string().optional(),
    basePath: z.string().optional(),
    entries: z.array(EndpointEntrySchema).optional(),
  })
  .strict()
  .optional();
