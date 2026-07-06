import {
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import {
  ssm,
  SSM_POLL_INTERVAL_MS,
  GRACEFUL_SHUTDOWN_SCRIPT,
  GRACEFUL_SHUTDOWN_WAIT_MS,
} from "../config";

export async function runSsmShellCommand(
  instanceId: string,
  command: string,
  maxWaitMs: number
): Promise<{ status: string; stdout: string; stderr: string }> {
  let commandId: string;
  try {
    const send = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands: [command] },
      })
    );
    commandId = send.Command?.CommandId ?? "";
    if (!commandId) {
      return { status: "Failed", stdout: "", stderr: "SSM command returned no ID" };
    }
  } catch (err) {
    return { status: "Failed", stdout: "", stderr: (err as Error).message };
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SSM_POLL_INTERVAL_MS));
    try {
      const inv = await ssm.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        })
      );
      const status = inv.Status ?? "Pending";
      if (status === "Success") {
        return {
          status,
          stdout: inv.StandardOutputContent ?? "",
          stderr: inv.StandardErrorContent ?? "",
        };
      }
      if (status === "Failed" || status === "TimedOut" || status === "Cancelled") {
        return {
          status,
          stdout: inv.StandardOutputContent ?? "",
          stderr: inv.StandardErrorContent ?? "",
        };
      }
    } catch (err) {
      return { status: "Failed", stdout: "", stderr: (err as Error).message };
    }
  }

  return { status: "TimedOut", stdout: "", stderr: "timed out waiting for SSM result" };
}

function formatSsmOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

export async function runGracefulShutdown(
  instanceId: string
): Promise<{ ok: boolean; detail: string; log?: string }> {
  console.log("runGracefulShutdown: sending SSM command", { instanceId });
  const result = await runSsmShellCommand(
    instanceId,
    GRACEFUL_SHUTDOWN_SCRIPT,
    GRACEFUL_SHUTDOWN_WAIT_MS
  );

  if (result.status === "Success") {
    const detail = result.stdout.trim().split("\n").pop() ?? "completed";
    console.log("runGracefulShutdown: success", { detail });
    return { ok: true, detail };
  }

  const log =
    formatSsmOutput(result.stdout, result.stderr) ||
    `SSM command ${result.status.toLowerCase()}`;
  console.warn("runGracefulShutdown: failed", { status: result.status, log });
  return { ok: false, detail: log.split("\n").pop() ?? log, log };
}
