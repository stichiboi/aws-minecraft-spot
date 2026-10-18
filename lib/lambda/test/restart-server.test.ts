import { beforeEach, describe, expect, it, vi } from "vitest";

const { getInstance, runSsmShellCommand } = vi.hoisted(() => ({
  getInstance: vi.fn(),
  runSsmShellCommand: vi.fn(),
}));

vi.mock("../utils/ec2", () => ({ getInstance }));
vi.mock("../utils/ssm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/ssm")>()),
  runSsmShellCommand,
}));

import { restartServer } from "../restart-server";

describe("restart-server", () => {
  beforeEach(() => {
    getInstance.mockReset();
    runSsmShellCommand.mockReset();
  });

  it("returns not_found when there is no instance", async () => {
    getInstance.mockResolvedValue(undefined);

    expect(await restartServer()).toEqual({ status: "not_found" });
    expect(runSsmShellCommand).not.toHaveBeenCalled();
  });

  it("does not restart when the instance is not running", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-pending",
      State: { Name: "pending" },
    });

    expect(await restartServer()).toEqual({
      status: "not_running",
      instanceId: "i-pending",
      instanceState: "pending",
    });
    expect(runSsmShellCommand).not.toHaveBeenCalled();
  });

  it("restarts minecraft.target, the same unit boot starts", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-run",
      State: { Name: "running" },
    });
    runSsmShellCommand.mockResolvedValue({
      status: "Success",
      stdout: "minecraft.service restarted\n",
      stderr: "",
    });

    expect(await restartServer()).toEqual({
      status: "restarted",
      instanceId: "i-run",
    });

    expect(runSsmShellCommand).toHaveBeenCalledOnce();
    const [instanceId, script] = runSsmShellCommand.mock.calls[0];
    expect(instanceId).toBe("i-run");
    expect(script).toBe("systemctl restart minecraft.target");
  });

  it("returns restart_failed with SSM output when the command fails", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-run",
      State: { Name: "running" },
    });
    runSsmShellCommand.mockResolvedValue({
      status: "Failed",
      stdout: "",
      stderr: "Failed to restart minecraft.target: Unit minecraft.target not found.",
    });

    expect(await restartServer()).toEqual({
      status: "restart_failed",
      instanceId: "i-run",
      log: "Failed to restart minecraft.target: Unit minecraft.target not found.",
    });
  });
});
