import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CancelSpotInstanceRequestsCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { mockConfig, mockEc2Send, resetAwsMocks } from "./helpers/aws-mocks";

const { getInstance, runGracefulShutdown } = vi.hoisted(() => ({
  getInstance: vi.fn(),
  runGracefulShutdown: vi.fn(),
}));

vi.mock("../config", () => mockConfig);
vi.mock("../utils/ec2", () => ({ getInstance }));
vi.mock("../utils/ssm", () => ({ runGracefulShutdown }));

import { stopServer } from "../stop-server";

describe("stop-server", () => {
  beforeEach(() => {
    resetAwsMocks();
    getInstance.mockReset();
    runGracefulShutdown.mockReset();
  });

  it("returns not_found when there is no instance", async () => {
    getInstance.mockResolvedValue(undefined);

    expect(await stopServer()).toEqual({ status: "not_found" });
  });

  it("returns already_terminating for shutting-down instances", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-1",
      State: { Name: "shutting-down" },
    });

    expect(await stopServer()).toEqual({
      status: "already_terminating",
      instanceId: "i-1",
    });
    expect(runGracefulShutdown).not.toHaveBeenCalled();
  });

  it("gracefully shuts down, cancels spot, and terminates a running instance", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-run",
      State: { Name: "running" },
      SpotInstanceRequestId: "sir-1",
    });
    runGracefulShutdown.mockResolvedValue({ ok: true, detail: "saved" });
    mockEc2Send.mockResolvedValue({});

    const result = await stopServer();

    expect(runGracefulShutdown).toHaveBeenCalledWith("i-run");
    expect(mockEc2Send).toHaveBeenCalledWith(
      expect.any(CancelSpotInstanceRequestsCommand)
    );
    expect(mockEc2Send).toHaveBeenCalledWith(
      expect.any(TerminateInstancesCommand)
    );
    expect(result).toEqual({
      status: "stopped",
      instanceId: "i-run",
      graceful: true,
    });
  });

  it("still terminates when graceful shutdown fails", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-run",
      State: { Name: "running" },
      SpotInstanceRequestId: "None",
    });
    runGracefulShutdown.mockResolvedValue({
      ok: false,
      detail: "rcon timeout",
      log: "2026-01-01 00:00:00 [graceful-shutdown] ERROR: rcon timeout",
    });
    mockEc2Send.mockResolvedValue({});

    const result = await stopServer();

    expect(result).toEqual({
      status: "stopped",
      instanceId: "i-run",
      graceful: false,
      gracefulLog: "2026-01-01 00:00:00 [graceful-shutdown] ERROR: rcon timeout",
    });
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    expect(mockEc2Send).toHaveBeenCalledWith(
      expect.any(TerminateInstancesCommand)
    );
  });

  it("skips graceful shutdown for non-running instances", async () => {
    getInstance.mockResolvedValue({
      InstanceId: "i-stop",
      State: { Name: "stopped" },
    });
    mockEc2Send.mockResolvedValue({});

    const result = await stopServer();

    expect(runGracefulShutdown).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "stopped",
      instanceId: "i-stop",
      graceful: false,
    });
  });
});
