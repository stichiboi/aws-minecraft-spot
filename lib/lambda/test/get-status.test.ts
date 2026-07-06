import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConfig } from "./helpers/aws-mocks";

const {
  getInstance,
  isInstanceInitializing,
  probePort,
  getCwMetric,
  runSsmShellCommand,
} = vi.hoisted(() => ({
  getInstance: vi.fn(),
  isInstanceInitializing: vi.fn(),
  probePort: vi.fn(),
  getCwMetric: vi.fn(),
  runSsmShellCommand: vi.fn(),
}));

vi.mock("../config", () => mockConfig);
vi.mock("../utils/ec2", () => ({ getInstance, isInstanceInitializing }));
vi.mock("../utils/network", () => ({ probePort }));
vi.mock("../utils/cloudwatch", () => ({ getCwMetric }));
vi.mock("../utils/ssm", () => ({ runSsmShellCommand }));

import { getStatus } from "../get-status";

describe("get-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not_found when there is no instance", async () => {
    getInstance.mockResolvedValue(undefined);

    expect(await getStatus()).toEqual({ status: "not_found" });
  });

  it("returns found without stats for a stopped instance", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-stop",
      InstanceType: "r3.large",
      State: { Name: "stopped" },
      PublicIpAddress: "1.2.3.4",
    });

    const result = await getStatus();

    expect(result).toEqual({
      status: "found",
      instanceId: "i-stop",
      instanceType: "r3.large",
      instanceState: "stopped",
      publicIp: "1.2.3.4",
      fqdn: "mc.example.com",
      mcStatus: "offline",
    });
    expect(probePort).not.toHaveBeenCalled();
  });

  it("skips stats while instance status checks are initializing", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-run",
      InstanceType: "r3.large",
      State: { Name: "running" },
      PublicIpAddress: "1.2.3.4",
    });
    probePort.mockResolvedValue(false);
    isInstanceInitializing.mockResolvedValue(true);

    const result = await getStatus();

    expect(result).toMatchObject({
      status: "found",
      mcStatus: "starting",
      statusChecksInitializing: true,
    });
    expect(getCwMetric).not.toHaveBeenCalled();
  });

  it("includes stats and rcon when the server port is ready", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-run",
      InstanceType: "r3.large",
      State: { Name: "running" },
      PublicIpAddress: "1.2.3.4",
    });
    probePort.mockResolvedValue(true);
    isInstanceInitializing.mockResolvedValue(false);
    getCwMetric.mockResolvedValue({ values: [] });
    runSsmShellCommand.mockResolvedValue({
      status: "Success",
      stdout: JSON.stringify({
        ram: { used_gb: 4, total_gb: 16 },
        disk: { used_gb: 10, total_gb: 50 },
        rcon: { online: 2, max: 20, players: ["alice", "bob"] },
        logs: { lines: ["warn: lag spike"] },
      }),
      stderr: "",
    });

    const result = await getStatus();

    expect(result).toMatchObject({
      status: "found",
      mcStatus: "ready",
      stats: {
        cpu: { values: [] },
        networkIn: { values: [] },
        networkOut: { values: [] },
        ram: { value: 4, max: 16 },
        disk: { value: 10, max: 50 },
        rcon: { online: 2, max: 20, players: ["alice", "bob"] },
        logs: { lines: ["warn: lag spike"] },
      },
    });
    expect(probePort).toHaveBeenCalledWith("1.2.3.4", 25565);
  });

  it("omits rcon when the port is not ready", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-run",
      InstanceType: "r3.large",
      State: { Name: "running" },
      PublicIpAddress: "1.2.3.4",
    });
    probePort.mockResolvedValue(false);
    isInstanceInitializing.mockResolvedValue(false);
    getCwMetric.mockResolvedValue({ values: [] });
    runSsmShellCommand.mockResolvedValue({
      status: "Success",
      stdout: JSON.stringify({
        ram: { used_gb: 4 },
        disk: { used_gb: 10 },
        rcon: { online: 0, max: 20, players: [] },
        logs: { lines: [] },
      }),
      stderr: "",
    });

    const result = await getStatus();

    expect(result.status).toBe("found");
    if (result.status !== "found" || !result.stats) {
      throw new Error("expected found status with stats");
    }
    expect(result.mcStatus).toBe("starting");
    expect(result.stats.ram).toEqual({ value: 4 });
    expect(result.stats.disk).toEqual({ value: 10 });
    expect(result.stats.logs).toEqual({ lines: [] });
    expect(result.stats.rcon).toBeUndefined();
  });
});
