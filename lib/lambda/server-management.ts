import * as net from "net";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  DescribeVolumesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  CancelSpotInstanceRequestsCommand,
  DescribeSubnetsCommand,
} from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  Statistic,
} from "@aws-sdk/client-cloudwatch";
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import type {
  StartResult,
  StopResult,
  StatusResult,
  ServerStats,
  SeriesMetric,
  ScalarMetric,
  RconStatus,
  LogSnippet,
  CommandResult,
  McStatus,
} from "./types";

const ec2 = new EC2Client({});
const cw = new CloudWatchClient({});
const ssm = new SSMClient({});

const INSTANCE_TAG = process.env.INSTANCE_TAG ?? "MinecraftServer";
const SUBNET_FILTER =
  process.env.SUBNET_FILTER ?? "MinecraftServer/Vpc/PublicSubnet1";
const LAUNCH_TEMPLATE_NAME =
  process.env.LAUNCH_TEMPLATE_NAME ?? "MinecraftServer";
const MINECRAFT_PORT = Number(process.env.MINECRAFT_PORT ?? "25565");
const SERVER_FQDN = process.env.SERVER_FQDN ?? "";
const INSTANCE_TYPE = process.env.INSTANCE_TYPE ?? "r3.large";
const DATA_VOLUME_TAG = process.env.DATA_VOLUME_TAG ?? "MinecraftData";

const STATE_PRIORITY: Record<string, number> = {
  running: 0,
  pending: 1,
  stopping: 2,
  stopped: 3,
};

async function getInstance() {
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [INSTANCE_TAG] },
        {
          Name: "instance-state-name",
          Values: ["pending", "running", "stopping", "stopped"],
        },
      ],
    })
  );
  const allInstances =
    result.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
  return allInstances.sort(
    (a, b) =>
      (STATE_PRIORITY[a.State?.Name ?? ""] ?? 99) -
      (STATE_PRIORITY[b.State?.Name ?? ""] ?? 99)
  )[0];
}

function probePort(
  host: string,
  port: number,
  timeoutMs = 3000
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
    socket.connect(port, host);
  });
}

async function getDataVolumeState(): Promise<{ volumeId: string; state: string } | null> {
  const res = await ec2.send(
    new DescribeVolumesCommand({
      Filters: [{ Name: "tag:Name", Values: [DATA_VOLUME_TAG] }],
    })
  );
  const vol = res.Volumes?.[0];
  if (!vol?.VolumeId) return null;
  return { volumeId: vol.VolumeId, state: vol.State ?? "unknown" };
}

async function startServer(): Promise<StartResult> {
  console.log("startServer: checking for existing pending/running instance", {
    tag: INSTANCE_TAG,
  });
  const existing = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [INSTANCE_TAG] },
        { Name: "instance-state-name", Values: ["pending", "running"] },
      ],
    })
  );

  const existingId = existing.Reservations?.[0]?.Instances?.[0]?.InstanceId;
  if (existingId) {
    console.log("startServer: instance already running", {
      instanceId: existingId,
    });
    return { status: "already_running", instanceId: existingId };
  }

  console.log("startServer: checking data volume availability", {
    tag: DATA_VOLUME_TAG,
  });
  const vol = await getDataVolumeState();
  if (vol && vol.state !== "available") {
    console.log("startServer: data volume not available", vol);
    return { status: "volume_in_use", volumeId: vol.volumeId };
  }

  console.log("startServer: no existing instance, looking up subnet", {
    filter: SUBNET_FILTER,
  });
  const subnets = await ec2.send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: "tag:Name", Values: [SUBNET_FILTER] }],
    })
  );

  const subnetId = subnets.Subnets?.[0]?.SubnetId;
  if (!subnetId) {
    throw new Error(`Could not find subnet tagged Name=${SUBNET_FILTER}`);
  }
  console.log("startServer: found subnet", { subnetId });

  console.log("startServer: launching instance", {
    launchTemplate: LAUNCH_TEMPLATE_NAME,
    instanceType: INSTANCE_TYPE,
    subnetId,
  });
  const run = await ec2.send(
    new RunInstancesCommand({
      MinCount: 1,
      MaxCount: 1,
      LaunchTemplate: {
        LaunchTemplateName: LAUNCH_TEMPLATE_NAME,
        Version: "$Latest",
      },
      InstanceType: INSTANCE_TYPE as never,
      SubnetId: subnetId,
    })
  );

  const instanceId = run.Instances?.[0]?.InstanceId ?? "unknown";
  const instanceType = run.Instances?.[0]?.InstanceType ?? INSTANCE_TYPE;
  console.log("startServer: instance launched", { instanceId, instanceType });
  return {
    status: "started",
    instanceId,
    instanceType,
    fqdn: SERVER_FQDN,
    port: MINECRAFT_PORT,
  };
}

async function stopServer(): Promise<StopResult> {
  console.log("stopServer: looking up instance", { tag: INSTANCE_TAG });
  const instance = await getInstance();
  if (!instance || !instance.InstanceId) {
    console.log("stopServer: no instance found");
    return { status: "not_found" };
  }

  const { InstanceId, State, SpotInstanceRequestId } = instance;
  const state = State?.Name;
  console.log("stopServer: found instance", {
    instanceId: InstanceId,
    state,
    spotRequestId: SpotInstanceRequestId,
  });

  if (state === "shutting-down" || state === "terminated") {
    return { status: "already_terminating", instanceId: InstanceId };
  }

  if (SpotInstanceRequestId && SpotInstanceRequestId !== "None") {
    console.log("stopServer: cancelling spot request", {
      spotRequestId: SpotInstanceRequestId,
    });
    await ec2.send(
      new CancelSpotInstanceRequestsCommand({
        SpotInstanceRequestIds: [SpotInstanceRequestId],
      })
    );
  }

  console.log("stopServer: terminating instance", { instanceId: InstanceId });
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: [InstanceId] }));

  return { status: "stopped", instanceId: InstanceId };
}

async function getCwMetric(
  instanceId: string,
  metricName: string,
  stat: Statistic,
  now: Date,
  startTime: Date
): Promise<SeriesMetric> {
  try {
    const res = await cw.send(
      new GetMetricStatisticsCommand({
        Namespace: "AWS/EC2",
        MetricName: metricName,
        Dimensions: [{ Name: "InstanceId", Value: instanceId }],
        StartTime: startTime,
        EndTime: now,
        Period: 300,
        Statistics: [stat],
      })
    );
    const values = (res.Datapoints ?? [])
      .sort(
        (a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0)
      )
      .map((dp) => ({
        timestamp: dp.Timestamp?.toISOString() ?? "",
        value: dp[stat] ?? 0,
      }));
    return { values };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

type StatusQueryResult = {
  ram: ScalarMetric;
  disk: ScalarMetric;
  rcon: RconStatus;
  logs: LogSnippet;
};

async function getStatusQuery(instanceId: string): Promise<StatusQueryResult> {
  const failed = (reason: string): StatusQueryResult => ({
    ram: { error: reason },
    disk: { error: reason },
    rcon: { error: reason },
    logs: { error: reason },
  });

  let commandId: string;
  try {
    const send = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands: ["python3 /opt/minecraft/status_query.py"] },
      })
    );
    commandId = send.Command?.CommandId ?? "";
    if (!commandId) return failed("SSM command returned no ID");
  } catch (err) {
    console.warn("getStatusQuery: SendCommand failed", err);
    return failed((err as Error).message);
  }

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const inv = await ssm.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        })
      );
      if (inv.Status === "Success") {
        const output = inv.StandardOutputContent ?? "";
        try {
          const parsed = JSON.parse(output);
          return {
            ram: parseScalarFromQuery(parsed.ram),
            disk: parseScalarFromQuery(parsed.disk),
            rcon: parseRconFromQuery(parsed.rcon),
            logs: parseLogsFromQuery(parsed.logs),
          };
        } catch (parseErr) {
          console.warn("getStatusQuery: failed to parse JSON", output);
          return failed("failed to parse status_query.py output");
        }
      }
      if (
        inv.Status === "Failed" ||
        inv.Status === "TimedOut" ||
        inv.Status === "Cancelled"
      ) {
        const stderr = inv.StandardErrorContent?.trim() ?? "";
        const stdout = inv.StandardOutputContent?.trim() ?? "";
        console.warn("getStatusQuery: command ended with status", inv.Status, { stderr, stdout });
        const stderrLines = stderr.split("\n").filter((l) => l.trim());
        // SSM appends its own "failed to run commands: exit status N" as the
        // last line — the real error is usually right above it.
        const meaningful = stderrLines.filter(
          (l) => !l.startsWith("failed to run commands:")
        );
        const detail = meaningful.length > 0
          ? meaningful.slice(-3).join(" | ")
          : stderrLines.pop() ?? `SSM command ${inv.Status.toLowerCase()}`;
        return failed(detail);
      }
    } catch (err) {
      console.warn("getStatusQuery: GetCommandInvocation failed", err);
      return failed((err as Error).message);
    }
  }

  console.warn("getStatusQuery: timed out waiting for command result");
  return failed("timed out waiting for SSM result");
}

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

async function isInstanceInitializing(instanceId: string): Promise<boolean> {
  try {
    const res = await ec2.send(
      new DescribeInstanceStatusCommand({ InstanceIds: [instanceId] })
    );
    const s = res.InstanceStatuses?.[0];
    return (
      s?.InstanceStatus?.Status === "initializing" ||
      s?.SystemStatus?.Status === "initializing"
    );
  } catch {
    return false;
  }
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

async function getStatus(): Promise<StatusResult> {
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

export type CommandName = "start" | "stop" | "status";

export async function runCommand(
  commandName: CommandName
): Promise<CommandResult> {
  switch (commandName) {
    case "start":
      return startServer();
    case "stop":
      return stopServer();
    case "status":
      return getStatus();
    default:
      throw new Error(`Unknown command: ${commandName as string}`);
  }
}

export const handler = async (event: {
  commandName: CommandName;
}): Promise<CommandResult> => {
  console.log("handler invoked", { commandName: event.commandName });
  const result = await runCommand(event.commandName);
  console.log("handler complete", { commandName: event.commandName, result });
  return result;
};
