import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { EndpointsConfigResolved } from "./endpoints.js";
import { extractHookToken, readJsonBody } from "./hooks.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Sliding-window rate limiter (per endpoint id)
// ---------------------------------------------------------------------------

type RateLimitBucket = { timestamps: number[] };

const rateBuckets = new Map<string, RateLimitBucket>();

function isRateLimited(
  endpointId: string,
  maxRequests: number,
  windowMs: number,
  now: number,
): boolean {
  let bucket = rateBuckets.get(endpointId);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateBuckets.set(endpointId, bucket);
  }
  const cutoff = now - windowMs;
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
  if (bucket.timestamps.length >= maxRequests) {
    return true;
  }
  bucket.timestamps.push(now);
  return false;
}

// ---------------------------------------------------------------------------

export type EndpointDispatcher = (value: {
  endpointId: string;
  message: string;
  instructions?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  callbackUrl?: string;
  /** Name of the token used for auth (undefined if unauthenticated). */
  tokenName?: string;
}) => Promise<{ runId: string; reply?: string }>;

export type EndpointsRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

export function createEndpointsRequestHandler(opts: {
  getEndpointsConfig: () => EndpointsConfigResolved | null;
  bindHost: string;
  port: number;
  log: SubsystemLogger;
  dispatch: EndpointDispatcher;
}): EndpointsRequestHandler {
  const { getEndpointsConfig, bindHost, port, log, dispatch } = opts;

  return async (req, res) => {
    const config = getEndpointsConfig();
    if (!config) {
      return false;
    }
    const url = new URL(req.url ?? "/", `http://${bindHost}:${port}`);
    const { basePath } = config;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      sendJson(res, 404, { ok: false, error: "Endpoint id required in path" });
      return true;
    }

    const entry = config.entries.get(subPath);
    if (!entry) {
      sendJson(res, 404, { ok: false, error: `Unknown endpoint: ${subPath}` });
      return true;
    }

    // Auth: if tokens are configured, require a matching one.
    let tokenName: string | undefined;
    if (entry.tokenMap.size > 0) {
      const { token } = extractHookToken(req, url);
      if (!token) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return true;
      }
      const name = entry.tokenMap.get(token);
      if (!name) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return true;
      }
      tokenName = name;
    }

    // Rate limiting.
    if (config.rateLimit) {
      const windowMs = config.rateLimit.windowSeconds * 1000;
      if (isRateLimited(entry.id, config.rateLimit.maxRequests, windowMs, Date.now())) {
        res.setHeader("Retry-After", String(config.rateLimit.windowSeconds));
        sendJson(res, 429, { ok: false, error: "Rate limit exceeded" });
        return true;
      }
    }

    const body = await readJsonBody(req, 1024 * 1024);
    if (!body.ok) {
      const status = body.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const raw = payload as Record<string, unknown>;
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    if (!message) {
      sendJson(res, 400, { ok: false, error: "message is required" });
      return true;
    }

    const callbackUrl = typeof raw.callbackUrl === "string" ? raw.callbackUrl.trim() : undefined;
    const mode = entry.mode ?? "sync";

    if (mode === "async" && !callbackUrl) {
      sendJson(res, 400, {
        ok: false,
        error: `Endpoint "${entry.id}" is async — callbackUrl is required`,
      });
      return true;
    }

    if (mode === "sync" && callbackUrl) {
      sendJson(res, 400, {
        ok: false,
        error: `Endpoint "${entry.id}" is sync — callbackUrl is not supported`,
      });
      return true;
    }

    if (mode === "async") {
      const runId = crypto.randomUUID();
      sendJson(res, 202, { ok: true, runId });

      void (async () => {
        try {
          const result = await dispatch({
            endpointId: entry.id,
            message,
            instructions: entry.instructions,
            model: entry.model,
            thinking: entry.thinking,
            timeoutSeconds: entry.timeoutSeconds,
            callbackUrl,
            tokenName,
          });
          if (callbackUrl) {
            await postCallback(callbackUrl, {
              runId,
              status: "ok",
              reply: result.reply ?? "",
            });
          }
        } catch (err) {
          log.warn(`endpoint ${entry.id} async error: ${String(err)}`);
          if (callbackUrl) {
            await postCallback(callbackUrl, {
              runId,
              status: "error",
              error: String(err),
            }).catch(() => {});
          }
        }
      })();

      return true;
    }

    // Sync mode: hold connection.
    try {
      const result = await dispatch({
        endpointId: entry.id,
        message,
        instructions: entry.instructions,
        model: entry.model,
        thinking: entry.thinking,
        timeoutSeconds: entry.timeoutSeconds,
        tokenName,
      });
      sendJson(res, 200, { ok: true, reply: result.reply ?? "" });
    } catch (err) {
      log.warn(`endpoint ${entry.id} sync error: ${String(err)}`);
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return true;
  };
}

async function postCallback(
  url: string,
  body: { runId: string; status: string; reply?: string; error?: string },
): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
