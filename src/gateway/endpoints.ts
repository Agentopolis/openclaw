import type { OpenClawConfig } from "../config/config.js";
import type { EndpointEntryConfig } from "../config/types.endpoints.js";

export type EndpointsConfigResolved = {
  basePath: string;
  token: string | null;
  entries: Map<string, EndpointEntryConfig>;
};

export function resolveEndpointsConfig(cfg: OpenClawConfig): EndpointsConfigResolved | null {
  if (cfg.endpoints?.enabled !== true) {
    return null;
  }
  const raw = cfg.endpoints;
  const entries = new Map<string, EndpointEntryConfig>();
  for (const entry of raw.entries ?? []) {
    if (entry.id?.trim()) {
      entries.set(entry.id.trim(), entry);
    }
  }
  if (entries.size === 0) {
    return null;
  }
  let basePath = (raw.basePath ?? "/endpoints").trim();
  if (!basePath.startsWith("/")) {
    basePath = `/${basePath}`;
  }
  basePath = basePath.replace(/\/+$/, "");
  return {
    basePath,
    token: raw.token?.trim() || null,
    entries,
  };
}
