import type {
  StatusResult,
  ServerStats,
  ScalarMetric,
  RconStatus,
  LogSnippet,
  McStatus,
} from "./types";
import { MINECRAFT_PORT, SERVER_FQDN, INSTANCE_TAG } from "./config";
import { getInstance, isInstanceInitializing } from "./utils/ec2";
import { probePort } from "./utils/network";
import { getCwMetric } from "./utils/cloudwatch";
import { runSsmShellCommand } from "./utils/ssm";

type StatusQueryResult = {
  ram: ScalarMetric;
  disk: ScalarMetric;
  rcon: RconStatus;
  logs: LogSnippet;
};

function parseScalarFromQuery(
  data: { used_gb?: number; total_gb?: number; error?: string } | undefined
): ScalarMetric {
  if (!data || data.error) return { error: data?.error ?? "missing" };
  if (data.used_gb === undefined) return { error: "could not parse metric" };
  return { value: data.used_gb, ...(data.total_gb !== undefined && { max: data.total_gb }) };
}

function parseRconFromQuery(
  data: { online?: number; max?: number; players?: string[]; error?: string } | undefined
): RconStatus {
  if (!data || data.error) return { error: data?.error ?? "missing" };
  return {
    online: data.online ?? 0,
    max: data.max ?? 0,
    players: data.players ?? [],
  };
}

function parseLogsFromQuery(
  data: { lines?: string[]; error?: string } | undefined
): LogSnippet {
  if (!data || data.error) return { error: data?.error ?? "missing" };
  return { lines: data.lines ?? [] };
}

async function getStatusQuery(instanceId: string): Promise<StatusQueryResult> {
  const failed = (reason: string): StatusQueryResult => ({
    ram: { error: reason },
    disk: { error: reason },
    rcon: { error: reason },
    logs: { error: reason },
  });

  const result = await runSsmShellCommand(
    instanceId,
    "python3 /opt/minecraft/status_query.py",
    15_000
  );

  if (result.status === "Success") {
    const output = result.stdout;
    try {
      const parsed = JSON.parse(output);
      return {
        ram: parseScalarFromQuery(parsed.ram),
        disk: parseScalarFromQuery(parsed.disk),
        rcon: parseRconFromQuery(parsed.rcon),
        logs: parseLogsFromQuery(parsed.logs),
      };
    } catch {
      console.warn("getStatusQuery: failed to parse JSON", output);
      return failed("failed to parse status_query.py output");
    }
  }

  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  console.warn("getStatusQuery: command ended with status", result.status, { stderr, stdout });
  const stderrLines = stderr.split("\n").filter((l) => l.trim());
  const meaningful = stderrLines.filter(
    (l) => !l.startsWith("failed to run commands:")
  );
  const detail = meaningful.length > 0
    ? meaningful.slice(-3).join(" | ")
    : (stderrLines.pop() ?? stdout) || `SSM command ${result.status.toLowerCase()}`;
  return failed(detail);
}

async function getStats(instanceId: string, mcReady: boolean): Promise<ServerStats> {
  const now = new Date();
  const startTime = new Date(now.getTime() - 60 * 60 * 1000);

  const [cpu, networkIn, networkOut, statusQuery] = await Promise.all([
    getCwMetric(instanceId, "CPUUtilization", "Average", now, startTime),
    getCwMetric(instanceId, "NetworkIn", "Sum", now, startTime),
    getCwMetric(instanceId, "NetworkOut", "Sum", now, startTime),
    getStatusQuery(instanceId),
  ]);

  return {
    cpu,
    networkIn,
    networkOut,
    ram: statusQuery.ram,
    disk: statusQuery.disk,
    ...(mcReady && { rcon: statusQuery.rcon }),
    logs: statusQuery.logs,
  };
}

export async function getStatus(): Promise<StatusResult> {
  console.log("getStatus: describing instances", { tag: INSTANCE_TAG });
  const instance = await getInstance();
  if (!instance) {
    console.log("getStatus: no instance found");
    return { status: "not_found" };
  }

  const instanceState = instance.State?.Name ?? "unknown";
  const publicIp = instance.PublicIpAddress ?? "N/A";
  const instanceId = instance.InstanceId ?? "N/A";
  const instanceType = instance.InstanceType ?? "N/A";
  console.log("getStatus: instance found", {
    instanceId,
    instanceType,
    instanceState,
    publicIp,
  });

  let mcStatus: McStatus = "offline";
  if (instanceState === "running" && publicIp !== "N/A") {
    console.log("getStatus: probing port", {
      host: publicIp,
      port: MINECRAFT_PORT,
    });
    const ready = await probePort(publicIp, MINECRAFT_PORT);
    mcStatus = ready ? "ready" : "starting";
    console.log("getStatus: port probe result", { mcStatus });
  } else if (instanceState === "running") {
    mcStatus = "unknown";
  }

  if (instanceState === "running") {
    const initializing = await isInstanceInitializing(instanceId);
    if (initializing) {
      console.log("getStatus: instance status checks still initializing, skipping stats");
      return {
        status: "found",
        instanceId,
        instanceType,
        instanceState,
        publicIp,
        fqdn: SERVER_FQDN,
        mcStatus,
        statusChecksInitializing: true,
      };
    }
    console.log("getStatus: fetching server stats", { instanceId });
    const stats = await getStats(instanceId, mcStatus === "ready");
    return {
      status: "found",
      instanceId,
      instanceType,
      instanceState,
      publicIp,
      fqdn: SERVER_FQDN,
      mcStatus,
      stats,
    };
  }

  return {
    status: "found",
    instanceId,
    instanceType,
    instanceState,
    publicIp,
    fqdn: SERVER_FQDN,
    mcStatus,
  };
}
