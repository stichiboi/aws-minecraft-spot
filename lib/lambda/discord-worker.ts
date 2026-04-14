import type {
  WorkerPayload,
  CommandResult,
  ServerStats,
  SeriesMetric,
  ScalarMetric,
  RconStatus,
  LogSnippet,
  MetricPoint,
} from "./types";
import { runCommand, type CommandName } from "./server-management";

const SPARKS = "▁▂▃▄▅▆▇█";
const DISCORD_API = "https://discord.com/api/v10";
/** Discord interaction follow-up `content` hard limit */
const DISCORD_MAX_CONTENT_LENGTH = 2000;

function clampToMaxLen(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return `${s.slice(0, max - 3)}...`;
}

function truncateDiscordContent(content: string): string {
  return clampToMaxLen(content, DISCORD_MAX_CONTENT_LENGTH);
}

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
  return `${metric.value} GB${
    metric.max !== undefined ? ` / ${metric.max} GB` : ""
  }`;
}

function formatRcon(rcon: RconStatus): string {
  if ("error" in rcon) return `error: ${rcon.error}`;
  const names = rcon.players.length > 0 ? ` — ${rcon.players.join(", ")}` : "";
  return `${rcon.online}/${rcon.max}${names}`;
}

function formatLogs(logs: LogSnippet, charBudget: number): string {
  if ("error" in logs) {
    const s = `> ⚠️ **Logs:** ${logs.error}`;
    return clampToMaxLen(s, charBudget);
  }
  if (logs.lines.length === 0) return "> ✅ No recent errors or warnings";
  if (charBudget < 40) {
    return "> ⚠️ **Logs:** (omitted — message too long)";
  }

  const wrap = (lineCount: number, body: string): string => {
    const header = `> ⚠️ **Logs (${lineCount} warning${lineCount === 1 ? "" : "s"}):**\n`;
    return `${header}||\`\`\`\n${body}\n\`\`\`||`;
  };

  // Lines are chronological (oldest first); drop from the front until the block fits.
  let slice = [...logs.lines];
  while (slice.length > 0) {
    const body = slice.join("\n");
    const out = wrap(slice.length, body);
    if (out.length <= charBudget) return out;
    slice.shift();
  }
  return "> ⚠️ **Logs:** (omitted — message too long)";
}

function formatStats(stats: ServerStats, maxChars: number): string {
  const max = Math.max(0, maxChars);
  if (max === 0) return "";

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

  const lines = [
    `> \`CPU (1h):     ${cpu.graph}\`  ${cpu.summary}`,
    `> \`Net in (1h):  ${netIn.graph}\`  ${netIn.summary}`,
    `> \`Net out (1h): ${netOut.graph}\`  ${netOut.summary}`,
    `> **RAM:** ${formatScalar(stats.ram)}`,
    `> **Disk:** ${formatScalar(stats.disk)}`,
  ];

  if (stats.rcon) {
    lines.push(`> **Players:** ${formatRcon(stats.rcon)}`);
  }

  if (stats.logs) {
    const baseText = lines.join("\n");
    const sep = "> ─────────────";
    const overhead = baseText.length + sep.length + 2; // two "\n" joins before log block
    const logBudget = max - overhead;
    if (logBudget > 0) {
      lines.push(sep, formatLogs(stats.logs, logBudget));
    }
  }

  return clampToMaxLen(lines.join("\n"), max);
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
  switch (result.status) {
    case "started":
      return `🚀 **Server is starting!**\n> Instance: \`${result.instanceId}\` (${result.instanceType})\n> Connect: \`${result.fqdn}:${result.port}\``;
    case "already_running":
      return `⚠️ Instance \`${result.instanceId}\` is already pending/running.`;
    case "volume_in_use":
      return `⚠️ Cannot start: data volume \`${result.volumeId}\` is still attached to the previous instance. Wait a moment and try again.`;
    case "stopped":
      return `🛑 **Server stopped.** Instance \`${result.instanceId}\` is terminating.`;
    case "already_terminating":
      return `⭕ Instance \`${result.instanceId}\` is already terminating.`;
    case "not_found":
      return commandName === "stop"
        ? "⭕ No running instance found."
        : "⭕ **Server is offline.** No instance found.";
    case "found": {
      const stateLabel = `${STATE_EMOJI[result.instanceState] ?? "❓"} ${result.instanceState}`;
      const mcLabel = `${MC_STATUS_EMOJI[result.mcStatus] ?? "❓"} ${result.mcStatus}`;
      const lines = [
        `📡 **Minecraft Server Status**`,
        `> **Instance:** \`${result.instanceId}\` (${result.instanceType})`,
        `> **State:** ${stateLabel}`,
        `> **IP:** \`${result.publicIp}\``,
        `> **Address:** \`${result.fqdn}\``,
        `> **Server:** ${mcLabel}`,
      ];
      if (result.statusChecksInitializing) {
        lines.push(
          `> ─────────────`,
          `> ⏳ Instance is initializing, stats unavailable.`
        );
      } else if (result.stats) {
        lines.push(`> ─────────────`);
        const prefixLen = lines.join("\n").length;
        const statsMax = Math.max(
          0,
          DISCORD_MAX_CONTENT_LENGTH - prefixLen - 1
        ); // newline before stats body
        lines.push(formatStats(result.stats, statsMax));
      }
      return clampToMaxLen(lines.join("\n"), DISCORD_MAX_CONTENT_LENGTH);
    }
  }
}

async function sendFollowUp(
  applicationId: string,
  interactionToken: string,
  content: string
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`;
  const safeContent = truncateDiscordContent(content);
  if (safeContent.length < content.length) {
    console.warn("sendFollowUp: content truncated to Discord limit", {
      applicationId,
      before: content.length,
      after: safeContent.length,
    });
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: safeContent }),
  });
  if (!res.ok) {
    console.error("sendFollowUp: Discord request failed", {
      status: res.status,
      body: await res.text(),
    });
  }
}

export const handler = async (event: WorkerPayload): Promise<void> => {
  const { commandName, applicationId } = event;
  console.log("handler invoked", { commandName, applicationId });
  try {
    const result = await runCommand(commandName);
    const message = formatForDiscord(commandName, result);
    console.log("handler: command completed, sending follow-up", {
      contentLength: message.length,
    });
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
