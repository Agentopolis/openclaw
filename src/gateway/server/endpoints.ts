import { randomUUID } from "node:crypto";

import type { CliDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { createEndpointsRequestHandler, type EndpointsRequestHandler } from "../endpoints-http.js";
import { resolveEndpointsConfig, type EndpointsConfigResolved } from "../endpoints.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayEndpointsRequestHandler(params: {
  deps: CliDeps;
  getEndpointsConfig: () => EndpointsConfigResolved | null;
  bindHost: string;
  port: number;
  log: SubsystemLogger;
}): EndpointsRequestHandler {
  const { deps, getEndpointsConfig, bindHost, port, log } = params;

  return createEndpointsRequestHandler({
    getEndpointsConfig,
    bindHost,
    port,
    log,
    dispatch: async (value) => {
      const cfg = loadConfig();
      const sessionKey = `endpoint:${value.endpointId}:${randomUUID()}`;
      const mainSessionKey = resolveMainSessionKeyFromConfig();
      const jobId = randomUUID();
      const now = Date.now();

      const job: CronJob = {
        id: jobId,
        name: `Endpoint ${value.endpointId}`,
        enabled: true,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "at", atMs: now },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: value.message,
          model: value.model,
          thinking: value.thinking,
          timeoutSeconds: value.timeoutSeconds,
        },
        state: { nextRunAtMs: now },
      };

      const result = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job,
        message: value.message,
        sessionKey,
        lane: "endpoint",
        instructions: value.instructions,
      });

      const summary = result.summary?.trim() || result.error?.trim() || result.status;
      const prefix =
        result.status === "ok"
          ? `Endpoint ${value.endpointId}`
          : `Endpoint ${value.endpointId} (${result.status})`;
      enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
        sessionKey: mainSessionKey,
      });
      requestHeartbeatNow({ reason: `endpoint:${jobId}` });

      if (result.status === "error") {
        throw new Error(result.error ?? "endpoint run failed");
      }

      return {
        runId: jobId,
        reply: result.outputText ?? result.summary ?? "",
      };
    },
  });
}

/** Build a getter that resolves endpoints config from the live config snapshot. */
export function createEndpointsConfigGetter(): () => EndpointsConfigResolved | null {
  return () => {
    const cfg = loadConfig();
    return resolveEndpointsConfig(cfg);
  };
}
