import { z } from "zod";

export const EndpointTokenSchema = z
  .object({
    value: z.string().min(1),
    name: z.string().optional(),
  })
  .strict();

export const EndpointEntrySchema = z
  .object({
    id: z.string().min(1),
    instructions: z.string().optional(),
    mode: z.union([z.literal("sync"), z.literal("async")]).optional(),
    tokens: z.array(EndpointTokenSchema).optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict();

export const EndpointRateLimitSchema = z
  .object({
    maxRequests: z.number().int().positive().optional(),
    windowSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const EndpointsSchema = z
  .object({
    enabled: z.boolean().optional(),
    basePath: z.string().optional(),
    rateLimit: EndpointRateLimitSchema,
    entries: z.array(EndpointEntrySchema).optional(),
  })
  .strict()
  .optional();
