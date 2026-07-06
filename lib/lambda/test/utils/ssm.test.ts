import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GetCommandInvocationCommand,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";
import { mockConfig, mockSsmSend, resetAwsMocks } from "../helpers/aws-mocks";

vi.mock("../../config", () => mockConfig);

import { runGracefulShutdown, runSsmShellCommand } from "../../utils/ssm";

describe("utils/ssm", () => {
  beforeEach(() => {
    resetAwsMocks();
    vi.useRealTimers();
  });

  describe("runSsmShellCommand", () => {
    it("returns success output when the command completes", async () => {
      mockSsmSend
        .mockResolvedValueOnce({ Command: { CommandId: "cmd-1" } })
        .mockResolvedValueOnce({
          Status: "Success",
          StandardOutputContent: "hello\n",
          StandardErrorContent: "",
        });

      const result = await runSsmShellCommand("i-1", "echo hello", 1000);

      expect(result).toEqual({
        status: "Success",
        stdout: "hello\n",
        stderr: "",
      });
      expect(mockSsmSend).toHaveBeenNthCalledWith(1, expect.any(SendCommandCommand));
      expect(mockSsmSend).toHaveBeenNthCalledWith(
        2,
        expect.any(GetCommandInvocationCommand)
      );
    });

    it("returns failure when SendCommand throws", async () => {
      mockSsmSend.mockRejectedValueOnce(new Error("access denied"));

      const result = await runSsmShellCommand("i-1", "true", 1000);

      expect(result.status).toBe("Failed");
      expect(result.stderr).toBe("access denied");
    });

    it("times out when the command stays pending", async () => {
      vi.useFakeTimers();
      mockSsmSend
        .mockResolvedValueOnce({ Command: { CommandId: "cmd-1" } })
        .mockResolvedValue({ Status: "Pending" });

      const pending = runSsmShellCommand("i-1", "sleep 999", 50);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.status).toBe("TimedOut");
    });
  });

  describe("runGracefulShutdown", () => {
    it("returns ok with the last stdout line on success", async () => {
      mockSsmSend
        .mockResolvedValueOnce({ Command: { CommandId: "cmd-1" } })
        .mockResolvedValueOnce({
          Status: "Success",
          StandardOutputContent: "saving world\nshutdown complete\n",
          StandardErrorContent: "",
        });

      const result = await runGracefulShutdown("i-1");

      expect(result).toEqual({ ok: true, detail: "shutdown complete" });
    });

    it("returns not ok with combined output when the command fails", async () => {
      mockSsmSend
        .mockResolvedValueOnce({ Command: { CommandId: "cmd-1" } })
        .mockResolvedValueOnce({
          Status: "Failed",
          StandardOutputContent:
            "2026-01-01 00:00:00 [graceful-shutdown] Starting graceful Minecraft shutdown\n",
          StandardErrorContent: "rcon timeout",
        });

      const result = await runGracefulShutdown("i-1");

      expect(result).toEqual({
        ok: false,
        detail: "rcon timeout",
        log: "2026-01-01 00:00:00 [graceful-shutdown] Starting graceful Minecraft shutdown\nrcon timeout",
      });
    });
  });
});
