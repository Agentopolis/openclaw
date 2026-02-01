import type { OpenClawConfig } from "../config/config.js";
import type { EndpointEntryConfig } from "../config/types.endpoints.js";

export type EndpointEntryResolved = EndpointEntryConfig & {
  /** Map of token value → name (or "unnamed"). Empty map = unauthenticated. */
  tokenMap: Map<string, string>;
};

export type EndpointsConfigResolved = {
  basePath: string;
  rateLimit: { maxRequests: number; windowSeconds: number } | null;
  entries: Map<string, EndpointEntryResolved>;
};

export function resolveEndpointsConfig(cfg: OpenClawConfig): EndpointsConfigResolved | null {
  if (cfg.endpoints?.enabled !== true) {
    return null;
  }
  const raw = cfg.endpoints;
  const entries = new Map<string, EndpointEntryResolved>();
  for (const entry of raw.entries ?? []) {
    if (!entry.id?.trim()) {
      continue;
    }
    const tokenMap = new Map<string, string>();
    for (const t of entry.tokens ?? []) {
      const v = t.value?.trim();
      if (v) {
        tokenMap.set(v, t.name?.trim() || "unnamed");
      }
    }
    entries.set(entry.id.trim(), { ...entry, tokenMap });
  }
  if (entries.size === 0) {
    return null;
  }
  let basePath = (raw.basePath ?? "/endpoints").trim();
  if (!basePath.startsWith("/")) {
    basePath = `/${basePath}`;
  }
  basePath = basePath.replace(/\/+$/, "");

  const rl = raw.rateLimit;
  const rateLimit =
    rl && (rl.maxRequests || rl.windowSeconds)
      ? {
          maxRequests: rl.maxRequests ?? 60,
          windowSeconds: rl.windowSeconds ?? 60,
        }
      : null;

  return { basePath, rateLimit, entries };
}
