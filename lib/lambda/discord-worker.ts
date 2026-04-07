import type {
  WorkerPayload,
  CommandResult,
  ServerStats,
  SeriesMetric,
  ScalarMetric,
  MetricPoint,
} from "./types";
import { runCommand, type CommandName } from "./server-management";

const SPARKS = "▁▂▃▄▅▆▇█";

function sparkline(
  pts: MetricPoint[],
  limits?: { min: number; max: number }
): string {
  if (pts.length === 0) return "no data";
  const values = pts.map((p) => p.value);
  const min = limits?.min ?? Math.min(...values);
  const maxValue = limits?.max ?? Math.max(...values);
  const range = maxValue - min || 1;
  return values
    .map((v) => SPARKS[Math.min(7, Math.round(((v - min) / range) * 7))])
    .join("");
}

function formatSeries(
  metric: SeriesMetric,
  opts: {
    sparkLimits?: { min: number; max: number };
    summarize: (pts: MetricPoint[]) => string;
  }
): { graph: string; summary: string } {
  if ("error" in metric) {
    return { graph: "error", summary: metric.error };
  }
  return {
    graph: sparkline(metric.values, opts.sparkLimits),
    summary: metric.values.length > 0 ? opts.summarize(metric.values) : "N/A",
  };
}

function formatScalar(metric: ScalarMetric): string {
  if ("error" in metric) return `error: ${metric.error}`;
  return `${metric.value} GB${metric.max !== undefined ? ` / ${metric.max} GB` : ""}`;
}

function formatStats(stats: ServerStats): string {
  const cpu = formatSeries(stats.cpu, {
    sparkLimits: { min: 0, max: 100 },
    summarize: (pts) => {
      const avg = pts.reduce((s, p) => s + p.value, 0) / pts.length;
      const max = Math.max(...pts.map((p) => p.value));
      return `avg ${avg.toFixed(1)}%  max ${max.toFixed(1)}%`;
    },
  });
  const netIn = formatSeries(stats.networkIn, {
    summarize: (pts) =>
      (pts.reduce((s, p) => s + p.value, 0) / 1_048_576).toFixed(1) + " MB",
  });
  const netOut = formatSeries(stats.networkOut, {
    summarize: (pts) =>
      (pts.reduce((s, p) => s + p.value, 0) / 1_048_576).toFixed(1) + " MB",
  });

  return [
    `> \`CPU (1h):     ${cpu.graph}\`  ${cpu.summary}`,
    `> \`Net in (1h):  ${netIn.graph}\`  ${netIn.summary}`,
    `> \`Net out (1h): ${netOut.graph}\`  ${netOut.summary}`,
    `> **RAM:** ${formatScalar(stats.ram)}`,
    `> **Disk:** ${formatScalar(stats.disk)}`,
  ].join("\n");
}

const STATE_EMOJI: Record<string, string> = {
  running: "🟢",
  pending: "🟡",
  stopping: "🟠",
  "shutting-down": "🟠",
  stopped: "🔴",
  terminated: "⭕",
};

const MC_STATUS_EMOJI: Record<string, string> = {
  ready: "✅",
  starting: "⏳",
  offline: "⭕",
  unknown: "❓",
};

function formatForDiscord(
  commandName: CommandName,
  result: CommandResult
): string {
  if (commandName === "start") {
    const r = result as Extract<
      CommandResult,
      { status: "started" | "already_running" }
    >;
    if (r.status === "already_running") {
      return `⚠️ Instance \`${r.instanceId}\` is already pending/running.`;
    }
    if (r.status === "started") {
      return `🚀 **Server is starting!**\n> Instance: \`${r.instanceId}\` (${r.instanceType})\n> Connect: \`${r.fqdn}:${r.port}\``;
    }
  }

  if (commandName === "stop") {
    const r = result as Extract<
      CommandResult,
      { status: "stopped" | "already_terminating" | "not_found" }
    >;
    if (r.status === "not_found") return "⭕ No running instance found.";
    if (r.status === "already_terminating")
      return `⭕ Instance \`${r.instanceId}\` is already terminating.`;
    if (r.status === "stopped")
      return `🛑 **Server stopped.** Instance \`${r.instanceId}\` is terminating.`;
  }

  if (commandName === "status") {
    const r = result as Extract<
      CommandResult,
      { status: "not_found" | "found" }
    >;
    if (r.status === "not_found")
      return "⭕ **Server is offline.** No instance found.";
    if (r.status === "found") {
      const stateLabel = `${STATE_EMOJI[r.instanceState] ?? "❓"} ${
        r.instanceState
      }`;
      const mcLabel = `${MC_STATUS_EMOJI[r.mcStatus] ?? "❓"} ${r.mcStatus}`;
      const lines = [
        `📡 **Minecraft Server Status**`,
        `> **Instance:** \`${r.instanceId}\` (${r.instanceType})`,
        `> **State:** ${stateLabel}`,
        `> **IP:** \`${r.publicIp}\``,
        `> **Address:** \`${r.fqdn}\``,
        `> **Server:** ${mcLabel}`,
      ];
      if (r.stats) {
        lines.push(`> ─────────────`, formatStats(r.stats));
      }
      return lines.join("\n");
    }
  }

  return `Unexpected result: \`${JSON.stringify(result)}\``;
}

const DISCORD_API = "https://discord.com/api/v10";

async function sendFollowUp(
  applicationId: string,
  interactionToken: string,
  content: string
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`;
  console.log("sendFollowUp: posting to Discord", {
    applicationId,
    contentLength: content.length,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    console.error("sendFollowUp: Discord request failed", {
      status: res.status,
      body: await res.text(),
    });
  } else {
    console.log("sendFollowUp: Discord request succeeded", {
      status: res.status,
    });
  }
}

export const handler = async (event: WorkerPayload): Promise<void> => {
  const { commandName, applicationId } = event;
  console.log("handler invoked", { commandName, applicationId });
  try {
    const result = await runCommand(commandName);
    const message = formatForDiscord(commandName, result);
    console.log("handler: command completed, sending follow-up");
    await sendFollowUp(event.applicationId, event.interactionToken, message);
  } catch (err) {
    console.error("handler: unhandled error", err);
    await sendFollowUp(
      event.applicationId,
      event.interactionToken,
      `Error: ${(err as Error).message}`
    );
  }
};
