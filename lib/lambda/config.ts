import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SSMClient } from "@aws-sdk/client-ssm";

export const ec2 = new EC2Client({});
export const cw = new CloudWatchClient({});
export const ssm = new SSMClient({});

export const INSTANCE_TAG = process.env.INSTANCE_TAG ?? "MinecraftServer";
export const SUBNET_FILTER =
  process.env.SUBNET_FILTER ?? "MinecraftServer/Vpc/PublicSubnet1";
export const LAUNCH_TEMPLATE_NAME =
  process.env.LAUNCH_TEMPLATE_NAME ?? "MinecraftServer";
export const MINECRAFT_PORT = Number(process.env.MINECRAFT_PORT ?? "25565");
export const SERVER_FQDN = process.env.SERVER_FQDN ?? "";
export const INSTANCE_TYPES: string[] = JSON.parse(
  process.env.INSTANCE_TYPES ?? '["r3.large"]'
);
export const DATA_VOLUME_TAG = process.env.DATA_VOLUME_TAG ?? "MinecraftData";
export const GRACEFUL_SHUTDOWN_SCRIPT = "/opt/minecraft/graceful-shutdown.sh";
export const GRACEFUL_SHUTDOWN_WAIT_MS = 130_000;
export const SSM_POLL_INTERVAL_MS = 2_000;

export const STATE_PRIORITY: Record<string, number> = {
  running: 0,
  pending: 1,
  stopping: 2,
  stopped: 3,
};
