import * as net from "net";
import type { WorkerPayload } from "./types";
import {
  EC2Client,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  CancelSpotInstanceRequestsCommand,
  DescribeSubnetsCommand,
} from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({});

const DISCORD_API = "https://discord.com/api/v10";
const INSTANCE_TAG = process.env.INSTANCE_TAG ?? "MinecraftServer";
const SUBNET_FILTER = process.env.SUBNET_FILTER ?? "MinecraftServer/Vpc/PublicSubnet1";
const LAUNCH_TEMPLATE_NAME = process.env.LAUNCH_TEMPLATE_NAME ?? "MinecraftServer";
const MINECRAFT_PORT = Number(process.env.MINECRAFT_PORT ?? "25565");
const SERVER_FQDN = process.env.SERVER_FQDN ?? "";
const INSTANCE_TYPE = process.env.INSTANCE_TYPE ?? "r3.large";

async function sendFollowUp(
  applicationId: string,
  interactionToken: string,
  content: string
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    console.error("Discord follow-up failed:", res.status, await res.text());
  }
}

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

async function startServer(): Promise<string> {
  // Check if already running
  const existing = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [INSTANCE_TAG] },
        { Name: "instance-state-name", Values: ["pending", "running"] },
      ],
    })
  );

  const existingId =
    existing.Reservations?.[0]?.Instances?.[0]?.InstanceId;
  if (existingId) {
    return `Instance \`${existingId}\` is already pending/running.`;
  }

  // Find the public subnet
  const subnets = await ec2.send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: "tag:Name", Values: [SUBNET_FILTER] }],
    })
  );

  const subnetId = subnets.Subnets?.[0]?.SubnetId;
  if (!subnetId) {
    throw new Error(`Could not find subnet tagged Name=${SUBNET_FILTER}`);
  }

  // RunInstances with a spot-configured launch template implicitly creates a
  // spot request — same as start-server.sh. Spot behavior (persistent request,
  // stop-on-interruption) is baked into the launch template, not this call.
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

  const instanceId = run.Instances?.[0]?.InstanceId;
  return `Server is starting... (instance \`${instanceId}\`)\nConnect: \`${SERVER_FQDN}:${MINECRAFT_PORT}\``;
}

async function stopServer(): Promise<string> {
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
    return "No running instance found.";
  }

  const { InstanceId, State, SpotInstanceRequestId } = instance;
  const state = State?.Name;

  if (state === "shutting-down" || state === "terminated") {
    return `Instance \`${InstanceId}\` is already terminating/terminated.`;
  }

  if (SpotInstanceRequestId && SpotInstanceRequestId !== "None") {
    await ec2.send(
      new CancelSpotInstanceRequestsCommand({
        SpotInstanceRequestIds: [SpotInstanceRequestId],
      })
    );
  }

  await ec2.send(
    new TerminateInstancesCommand({ InstanceIds: [InstanceId] })
  );

  return `Server stopped. Instance \`${InstanceId}\` is terminating.`;
}

async function getStatus(): Promise<string> {
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [{ Name: "tag:Name", Values: [INSTANCE_TAG] }],
    })
  );

  const instance = result.Reservations?.[0]?.Instances?.[0];
  if (!instance) {
    return "No instance found (server is offline).";
  }

  const state = instance.State?.Name ?? "unknown";
  const publicIp = instance.PublicIpAddress ?? "N/A";
  const instanceId = instance.InstanceId ?? "N/A";

  let mcStatus = "offline";
  if (state === "running" && publicIp !== "N/A") {
    const ready = await probePort(publicIp, MINECRAFT_PORT);
    mcStatus = ready ? "ready" : "starting...";
  } else if (state === "running") {
    mcStatus = "unknown (no IP)";
  }

  return [
    "**Minecraft Server Status**",
    `Instance: \`${instanceId}\``,
    `State: \`${state}\``,
    `Public IP: \`${publicIp}\``,
    `Address: \`${SERVER_FQDN}\``,
    `Server: \`${mcStatus}\``,
  ].join("\n");
}

export const handler = async (event: WorkerPayload): Promise<void> => {
  const { commandName, interactionToken, applicationId } = event;

  try {
    let message: string;
    switch (commandName) {
      case "start":
        message = await startServer();
        break;
      case "stop":
        message = await stopServer();
        break;
      case "status":
        message = await getStatus();
        break;
      default:
        message = `Unknown command: \`${commandName}\``;
    }
    await sendFollowUp(applicationId, interactionToken, message);
  } catch (err) {
    console.error("Worker error:", err);
    await sendFollowUp(
      applicationId,
      interactionToken,
      `Error: ${(err as Error).message}`
    );
  }
};
