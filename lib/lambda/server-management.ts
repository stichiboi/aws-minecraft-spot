import * as net from "net";
import {
  EC2Client,
  DescribeInstancesCommand,
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

type SsmResult = { ram: ScalarMetric; disk: ScalarMetric };

async function getSsmMetrics(instanceId: string): Promise<SsmResult> {
  const cmd = [
    'printf "RAM_USED=%.2f\\nRAM_TOTAL=%.2f\\n" \\',
    '  "$(free -m | awk \'/^Mem:/{printf "%.2f",$3/1024}\')" \\',
    '  "$(free -m | awk \'/^Mem:/{printf "%.2f",$2/1024}\')"',
    "if mountpoint -q /opt/minecraft/data 2>/dev/null; then",
    '  printf "DISK_USED=%.2f\\nDISK_TOTAL=%.2f\\n" \\',
    "    \"$(df /opt/minecraft/data --output=used -BM | tail -1 | tr -d 'M' | awk '{printf \"%.2f\",$1/1024}')\" \\",
    "    \"$(df /opt/minecraft/data --output=size -BM | tail -1 | tr -d 'M' | awk '{printf \"%.2f\",$1/1024}')\"",
    "else",
    '  echo "DISK_ERROR=data volume not mounted"',
    "fi",
  ].join("\n");

  const failed = (reason: string): SsmResult => ({
    ram: { error: reason },
    disk: { error: reason },
  });

  let commandId: string;
  try {
    const send = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands: [cmd] },
      })
    );
    commandId = send.Command?.CommandId ?? "";
    if (!commandId) return failed("SSM command returned no ID");
  } catch (err) {
    console.warn("getSsmMetrics: SendCommand failed", err);
    return failed((err as Error).message);
  }

  for (let i = 0; i < 8; i++) {
    // there is a delay between the command being sent and the actual execution
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
        const parseNum = (key: string) => {
          const v = parseFloat(
            output.match(new RegExp(`${key}=([\\d.]+)`))?.[1] ?? ""
          );
          return isNaN(v) ? null : v;
        };

        const ramUsed = parseNum("RAM_USED");
        const ramTotal = parseNum("RAM_TOTAL");
        const ram: ScalarMetric =
          ramUsed !== null
            ? { value: ramUsed, ...(ramTotal !== null && { max: ramTotal }) }
            : { error: "could not parse RAM metrics" };

        const diskError = output.match(/DISK_ERROR=(.+)/)?.[1]?.trim();
        const diskUsed = parseNum("DISK_USED");
        const diskTotal = parseNum("DISK_TOTAL");
        const disk: ScalarMetric = diskError
          ? { error: diskError }
          : diskUsed !== null
          ? { value: diskUsed, ...(diskTotal !== null && { max: diskTotal }) }
          : { error: "could not parse disk metrics" };

        return { ram, disk };
      }
      if (
        inv.Status === "Failed" ||
        inv.Status === "TimedOut" ||
        inv.Status === "Cancelled"
      ) {
        console.warn("getSsmMetrics: command ended with status", inv.Status);
        return failed(`SSM command ${inv.Status.toLowerCase()}`);
      }
    } catch (err) {
      console.warn("getSsmMetrics: GetCommandInvocation failed", err);
      return failed((err as Error).message);
    }
  }

  console.warn("getSsmMetrics: timed out waiting for command result");
  return failed("timed out waiting for SSM result");
}

async function getStats(instanceId: string): Promise<ServerStats> {
  const now = new Date();
  const startTime = new Date(now.getTime() - 60 * 60 * 1000);

  const [cpu, networkIn, networkOut, { ram, disk }] = await Promise.all([
    getCwMetric(instanceId, "CPUUtilization", "Average", now, startTime),
    getCwMetric(instanceId, "NetworkIn", "Sum", now, startTime),
    getCwMetric(instanceId, "NetworkOut", "Sum", now, startTime),
    getSsmMetrics(instanceId),
  ]);

  return { cpu, networkIn, networkOut, ram, disk };
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
    console.log("getStatus: fetching server stats", { instanceId });
    const stats = await getStats(instanceId);
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
