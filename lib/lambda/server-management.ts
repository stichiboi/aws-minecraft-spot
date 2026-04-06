import * as net from "net";
import {
  EC2Client,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  CancelSpotInstanceRequestsCommand,
  DescribeSubnetsCommand,
} from "@aws-sdk/client-ec2";
import type { StartResult, StopResult, StatusResult, CommandResult, McStatus } from "./types";

const ec2 = new EC2Client({});

const INSTANCE_TAG = process.env.INSTANCE_TAG ?? "MinecraftServer";
const SUBNET_FILTER = process.env.SUBNET_FILTER ?? "MinecraftServer/Vpc/PublicSubnet1";
const LAUNCH_TEMPLATE_NAME = process.env.LAUNCH_TEMPLATE_NAME ?? "MinecraftServer";
const MINECRAFT_PORT = Number(process.env.MINECRAFT_PORT ?? "25565");
const SERVER_FQDN = process.env.SERVER_FQDN ?? "";
const INSTANCE_TYPE = process.env.INSTANCE_TYPE ?? "r3.large";

function probePort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
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
  console.log("startServer: checking for existing pending/running instance", { tag: INSTANCE_TAG });
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
    console.log("startServer: instance already running", { instanceId: existingId });
    return { status: "already_running", instanceId: existingId };
  }

  console.log("startServer: no existing instance, looking up subnet", { filter: SUBNET_FILTER });
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

  console.log("startServer: launching instance", { launchTemplate: LAUNCH_TEMPLATE_NAME, instanceType: INSTANCE_TYPE, subnetId });
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
  return { status: "started", instanceId, instanceType, fqdn: SERVER_FQDN, port: MINECRAFT_PORT };
}

async function stopServer(): Promise<StopResult> {
  console.log("stopServer: looking up instance", { tag: INSTANCE_TAG });
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [INSTANCE_TAG] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
      ],
    })
  );

  const instance = result.Reservations?.[0]?.Instances?.[0];
  if (!instance || !instance.InstanceId) {
    console.log("stopServer: no instance found");
    return { status: "not_found" };
  }

  const { InstanceId, State, SpotInstanceRequestId } = instance;
  const state = State?.Name;
  console.log("stopServer: found instance", { instanceId: InstanceId, state, spotRequestId: SpotInstanceRequestId });

  if (state === "shutting-down" || state === "terminated") {
    return { status: "already_terminating", instanceId: InstanceId };
  }

  if (SpotInstanceRequestId && SpotInstanceRequestId !== "None") {
    console.log("stopServer: cancelling spot request", { spotRequestId: SpotInstanceRequestId });
    await ec2.send(
      new CancelSpotInstanceRequestsCommand({
        SpotInstanceRequestIds: [SpotInstanceRequestId],
      })
    );
  }

  console.log("stopServer: terminating instance", { instanceId: InstanceId });
  await ec2.send(
    new TerminateInstancesCommand({ InstanceIds: [InstanceId] })
  );

  return { status: "stopped", instanceId: InstanceId };
}

async function getStatus(): Promise<StatusResult> {
  console.log("getStatus: describing instances", { tag: INSTANCE_TAG });
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [{ Name: "tag:Name", Values: [INSTANCE_TAG] }],
    })
  );

  const instance = result.Reservations?.[0]?.Instances?.[0];
  if (!instance) {
    console.log("getStatus: no instance found");
    return { status: "not_found" };
  }

  const instanceState = instance.State?.Name ?? "unknown";
  const publicIp = instance.PublicIpAddress ?? "N/A";
  const instanceId = instance.InstanceId ?? "N/A";
  const instanceType = instance.InstanceType ?? "N/A";
  console.log("getStatus: instance found", { instanceId, instanceType, instanceState, publicIp });

  let mcStatus: McStatus = "offline";
  if (instanceState === "running" && publicIp !== "N/A") {
    console.log("getStatus: probing port", { host: publicIp, port: MINECRAFT_PORT });
    const ready = await probePort(publicIp, MINECRAFT_PORT);
    mcStatus = ready ? "ready" : "starting";
    console.log("getStatus: port probe result", { mcStatus });
  } else if (instanceState === "running") {
    mcStatus = "unknown";
  }

  return { status: "found", instanceId, instanceType, instanceState, publicIp, fqdn: SERVER_FQDN, mcStatus };
}

export type CommandName = "start" | "stop" | "status";

export async function runCommand(commandName: CommandName): Promise<CommandResult> {
  switch (commandName) {
    case "start":  return startServer();
    case "stop":   return stopServer();
    case "status": return getStatus();
    default:       throw new Error(`Unknown command: ${commandName as string}`);
  }
}

export const handler = async (event: { commandName: CommandName }): Promise<CommandResult> => {
  console.log("handler invoked", { commandName: event.commandName });
  const result = await runCommand(event.commandName);
  console.log("handler complete", { commandName: event.commandName, result });
  return result;
};
