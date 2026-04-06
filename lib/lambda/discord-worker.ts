import type { WorkerPayload, CommandResult } from "./types";
import { runCommand, type CommandName } from "./server-management";

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

function formatForDiscord(commandName: CommandName, result: CommandResult): string {
  if (commandName === "start") {
    const r = result as Extract<CommandResult, { status: "started" | "already_running" }>;
    if (r.status === "already_running") {
      return `⚠️ Instance \`${r.instanceId}\` is already pending/running.`;
    }
    if (r.status === "started") {
      return `🚀 **Server is starting!**\n> Instance: \`${r.instanceId}\` (${r.instanceType})\n> Connect: \`${r.fqdn}:${r.port}\``;
    }
  }

  if (commandName === "stop") {
    const r = result as Extract<CommandResult, { status: "stopped" | "already_terminating" | "not_found" }>;
    if (r.status === "not_found") return "⭕ No running instance found.";
    if (r.status === "already_terminating") return `⭕ Instance \`${r.instanceId}\` is already terminating.`;
    if (r.status === "stopped") return `🛑 **Server stopped.** Instance \`${r.instanceId}\` is terminating.`;
  }

  if (commandName === "status") {
    const r = result as Extract<CommandResult, { status: "not_found" | "found" }>;
    if (r.status === "not_found") return "⭕ **Server is offline.** No instance found.";
    if (r.status === "found") {
      const stateLabel = `${STATE_EMOJI[r.instanceState] ?? "❓"} ${r.instanceState}`;
      const mcLabel = `${MC_STATUS_EMOJI[r.mcStatus] ?? "❓"} ${r.mcStatus}`;
      return [
        `📡 **Minecraft Server Status**`,
        `> **Instance:** \`${r.instanceId}\` (${r.instanceType})`,
        `> **State:** ${stateLabel}`,
        `> **IP:** \`${r.publicIp}\``,
        `> **Address:** \`${r.fqdn}\``,
        `> **Server:** ${mcLabel}`,
      ].join("\n");
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
  console.log("sendFollowUp: posting to Discord", { applicationId, contentLength: content.length });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    console.error("sendFollowUp: Discord request failed", { status: res.status, body: await res.text() });
  } else {
    console.log("sendFollowUp: Discord request succeeded", { status: res.status });
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
