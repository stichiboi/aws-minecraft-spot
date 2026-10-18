import { beforeEach, describe, expect, it, vi } from "vitest";

const { startServer, stopServer, getStatus, restartServer } = vi.hoisted(() => ({
  startServer: vi.fn(),
  stopServer: vi.fn(),
  getStatus: vi.fn(),
  restartServer: vi.fn(),
}));

vi.mock("../start-server", () => ({ startServer }));
vi.mock("../stop-server", () => ({ stopServer }));
vi.mock("../get-status", () => ({ getStatus }));
vi.mock("../restart-server", () => ({ restartServer }));

import { handler, runCommand } from "../server-management";

describe("server-management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("runCommand", () => {
    it("delegates start with optional instance type", async () => {
      startServer.mockResolvedValue({ status: "started", instanceId: "i-1" });
      await runCommand("start", { instanceType: "r5.large" });
      expect(startServer).toHaveBeenCalledWith("r5.large");
    });

    it("delegates stop", async () => {
      stopServer.mockResolvedValue({ status: "not_found" });
      await runCommand("stop");
      expect(stopServer).toHaveBeenCalledOnce();
    });

    it("delegates status", async () => {
      getStatus.mockResolvedValue({ status: "not_found" });
      await runCommand("status");
      expect(getStatus).toHaveBeenCalledOnce();
    });

    it("delegates restart", async () => {
      restartServer.mockResolvedValue({ status: "restarted", instanceId: "i-1" });
      await runCommand("restart");
      expect(restartServer).toHaveBeenCalledOnce();
    });
  });

  describe("handler", () => {
    it("forwards the event to runCommand and returns the result", async () => {
      const result = { status: "already_running" as const, instanceId: "i-abc" };
      startServer.mockResolvedValue(result);

      const out = await handler({
        commandName: "start",
        instanceType: "r3.large",
      });

      expect(startServer).toHaveBeenCalledWith("r3.large");
      expect(out).toEqual(result);
    });
  });
});
