import { vi } from "vitest";

export const mockEc2Send = vi.fn();
export const mockCwSend = vi.fn();
export const mockSsmSend = vi.fn();

export function resetAwsMocks() {
  mockEc2Send.mockReset();
  mockCwSend.mockReset();
  mockSsmSend.mockReset();
}

export const mockConfig = {
  ec2: { send: mockEc2Send },
  cw: { send: mockCwSend },
  ssm: { send: mockSsmSend },
  INSTANCE_TAG: "MinecraftServer",
  SUBNET_FILTER: "MinecraftServer/Vpc/PublicSubnet1",
  LAUNCH_TEMPLATE_NAME: "MinecraftServer",
  MINECRAFT_PORT: 25565,
  SERVER_FQDN: "mc.example.com",
  INSTANCE_TYPES: ["r3.large", "r5.large"],
  DATA_VOLUME_TAG: "MinecraftData",
  GRACEFUL_SHUTDOWN_SCRIPT: "/opt/minecraft/graceful-shutdown.sh",
  GRACEFUL_SHUTDOWN_WAIT_MS: 130_000,
  SSM_POLL_INTERVAL_MS: 10,
  STATE_PRIORITY: {
    running: 0,
    pending: 1,
    stopping: 2,
    stopped: 3,
  },
};
