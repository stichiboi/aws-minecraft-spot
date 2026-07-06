import * as net from "net";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  DescribeVolumesCommand,
  CreateFleetCommand,
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
const INSTANCE_TYPES: string[] = JSON.parse(
  process.env.INSTANCE_TYPES ?? '["r3.large"]'
);
const DATA_VOLUME_TAG = process.env.DATA_VOLUME_TAG ?? "MinecraftData";
const GRACEFUL_SHUTDOWN_SCRIPT = "/opt/minecraft/graceful-shutdown.sh";
const GRACEFUL_SHUTDOWN_WAIT_MS = 130_000;
const SSM_POLL_INTERVAL_MS = 2_000;

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

function resolveFleetInstanceTypes(instanceType?: string): string[] {
  if (!instanceType) return INSTANCE_TYPES;
  if (!INSTANCE_TYPES.includes(instanceType)) {
    throw new Error(
      `Instance type "${instanceType}" is not allowed. Must be one of: ${INSTANCE_TYPES.join(", ")}`
    );
  }
  return [instanceType];
}

async function startServer(instanceType?: string): Promise<StartResult> {
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

  const subnet = subnets.Subnets?.[0];
  const subnetId = subnet?.SubnetId;
  if (!subnetId) {
    throw new Error(`Could not find subnet tagged Name=${SUBNET_FILTER}`);
  }
  console.log("startServer: found subnet", { subnetId, az: subnet.AvailabilityZone });

  const fleetInstanceTypes = resolveFleetInstanceTypes(instanceType);
  console.log("startServer: creating fleet", {
    launchTemplate: LAUNCH_TEMPLATE_NAME,
    instanceTypes: fleetInstanceTypes,
    subnetId,
  });
  const fleet = await ec2.send(
    new CreateFleetCommand({
      Type: "instant",
      TargetCapacitySpecification: {
        TotalTargetCapacity: 1,
        DefaultTargetCapacityType: "spot",
      },
      SpotOptions: {
        AllocationStrategy: "capacity-optimized",
      },
      LaunchTemplateConfigs: [
        {
          LaunchTemplateSpecification: {
            LaunchTemplateName: LAUNCH_TEMPLATE_NAME,
            Version: "$Latest",
          },
          Overrides: fleetInstanceTypes.map((type) => ({
            InstanceType: type as never,
            SubnetId: subnetId,
          })),
        },
      ],
    })
  );

  const launched = fleet.Instances?.[0]?.InstanceIds?.[0];
  const launchedType = fleet.Instances?.[0]?.InstanceType;
  if (!launched) {
    const perTypeErrors = fleet.Errors?.map((e) => {
      const type = e.LaunchTemplateAndOverrides?.Overrides?.InstanceType ?? "unknown";
      return `${type}: ${e.ErrorCode}`;
    });
    console.error("startServer: fleet failed to launch", {
      az: subnet.AvailabilityZone,
      perTypeErrors,
    });
    return {
      status: "no_capacity",
      types: fleetInstanceTypes,
      az: subnet.AvailabilityZone ?? "unknown",
    };
  }

  console.log("startServer: instance launched via fleet", {
    instanceId: launched,
    instanceType: launchedType,
  });
  return {
    status: "started",
    instanceId: launched,
    instanceType: launchedType ?? fleetInstanceTypes[0],
    fqdn: SERVER_FQDN,
    port: MINECRAFT_PORT,
  };
}

async function runSsmShellCommand(
  instanceId: string,
  command: string,
  maxWaitMs: number
): Promise<{ status: string; stdout: string; stderr: string }> {
  let commandId: string;
  try {
    const send = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands: [command] },
      })
    );
    commandId = send.Command?.CommandId ?? "";
    if (!commandId) {
      return { status: "Failed", stdout: "", stderr: "SSM command returned no ID" };
    }
  } catch (err) {
    return { status: "Failed", stdout: "", stderr: (err as Error).message };
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SSM_POLL_INTERVAL_MS));
    try {
      const inv = await ssm.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        })
      );
      const status = inv.Status ?? "Pending";
      if (status === "Success") {
        return {
          status,
          stdout: inv.StandardOutputContent ?? "",
          stderr: inv.StandardErrorContent ?? "",
        };
      }
      if (status === "Failed" || status === "TimedOut" || status === "Cancelled") {
        return {
          status,
          stdout: inv.StandardOutputContent ?? "",
          stderr: inv.StandardErrorContent ?? "",
        };
      }
    } catch (err) {
      return { status: "Failed", stdout: "", stderr: (err as Error).message };
    }
  }

  return { status: "TimedOut", stdout: "", stderr: "timed out waiting for SSM result" };
}

async function runGracefulShutdown(instanceId: string): Promise<{ ok: boolean; detail: string }> {
  console.log("runGracefulShutdown: sending SSM command", { instanceId });
  const result = await runSsmShellCommand(
    instanceId,
    GRACEFUL_SHUTDOWN_SCRIPT,
    GRACEFUL_SHUTDOWN_WAIT_MS
  );

  if (result.status === "Success") {
    const detail = result.stdout.trim().split("\n").pop() ?? "completed";
    console.log("runGracefulShutdown: success", { detail });
    return { ok: true, detail };
  }

  const detail = result.stderr.trim() || result.stdout.trim() || result.status;
  console.warn("runGracefulShutdown: failed", { status: result.status, detail });
  return { ok: false, detail };
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

  let graceful = false;
  if (state === "running") {
    const gracefulResult = await runGracefulShutdown(InstanceId);
    graceful = gracefulResult.ok;
    if (!graceful) {
      console.warn("stopServer: graceful shutdown failed — terminating anyway", gracefulResult);
    }
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

  return { status: "stopped", instanceId: InstanceId, graceful };
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

export type RunCommandOptions = {
  instanceType?: string;
};

export async function runCommand(
  commandName: CommandName,
  options?: RunCommandOptions
): Promise<CommandResult> {
  switch (commandName) {
    case "start":
      return startServer(options?.instanceType);
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
  instanceType?: string;
}): Promise<CommandResult> => {
  console.log("handler invoked", {
    commandName: event.commandName,
    instanceType: event.instanceType,
  });
  const result = await runCommand(event.commandName, {
    instanceType: event.instanceType,
  });
  console.log("handler complete", { commandName: event.commandName, result });
  return result;
};
