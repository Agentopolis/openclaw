import { randomUUID } from "node:crypto";

import type { CliDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { HookMessageChannel, HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  type AgentHookValue = {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
    instructions?: string;
    mode?: "sync" | "async";
    callbackUrl?: string;
  };

  /** Prepend server-side instructions to the message if configured. */
  function applyInstructions(message: string, instructions?: string): string {
    if (!instructions?.trim()) {
      return message;
    }
    return `<instructions>\n${instructions.trim()}\n</instructions>\n\n${message}`;
  }

  function buildJob(value: AgentHookValue, message: string) {
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", atMs: now },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.mode === "sync" || value.callbackUrl ? false : value.deliver,
        channel: value.channel,
        to: value.to,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
      },
      state: { nextRunAtMs: now },
    };
    return { jobId, job };
  }

  const dispatchAgentHook = (
    value: AgentHookValue,
  ): string | Promise<{ runId: string; reply?: string; status: string }> => {
    const sessionKey = value.sessionKey.trim() ? value.sessionKey.trim() : `hook:${randomUUID()}`;
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const message = applyInstructions(value.message, value.instructions);
    const { jobId, job } = buildJob(value, message);
    const runId = randomUUID();

    if (value.mode === "sync") {
      // Synchronous path: await the agent turn and return the result.
      return (async () => {
        try {
          const cfg = loadConfig();
          const result = await runCronIsolatedAgentTurn({
            cfg,
            deps,
            job,
            message,
            sessionKey,
            lane: "cron",
          });
          const summary = result.summary?.trim() || result.error?.trim() || result.status;
          const prefix =
            result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
          enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}` });
          }
          return { runId, reply: result.outputText, status: result.status };
        } catch (err) {
          logHooks.warn(`hook agent failed: ${String(err)}`);
          enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}:error` });
          }
          return { runId, status: "error" };
        }
      })();
    }

    // Async fire-and-forget path (existing behavior).
    void (async () => {
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message,
          sessionKey,
          lane: "cron",
        });
        const summary = result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
        enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}` });
        }
        if (value.callbackUrl) {
          await postCallback(
            value.callbackUrl,
            {
              runId,
              status: result.status,
              reply: result.outputText ?? null,
              error: result.error ?? null,
            },
            logHooks,
          );
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
        if (value.callbackUrl) {
          await postCallback(
            value.callbackUrl,
            {
              runId,
              status: "error",
              reply: null,
              error: String(err),
            },
            logHooks,
          );
        }
      }
    })();

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}

async function postCallback(
  url: string,
  body: { runId: string; status: string; reply: string | null; error: string | null },
  log: SubsystemLogger,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      log.warn(`hook callbackUrl POST to ${url} returned ${res.status}`);
    }
  } catch (err) {
    log.warn(`hook callbackUrl POST to ${url} failed: ${String(err)}`);
  }
}
