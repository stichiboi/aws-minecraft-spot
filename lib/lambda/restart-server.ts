import type { RestartResult } from "./types";
import { getInstance } from "./utils/ec2";
import { formatSsmOutput, runSsmShellCommand } from "./utils/ssm";

/** Covers minecraft.service TimeoutStopSec (120s, per-boot.sh) plus the start. */
const RESTART_WAIT_MS = 240_000;

// Same unit per-boot.sh starts. The target stops the idle monitor before the
// game, so the restart is not taken for a crash. /stop deliberately stops only
// minecraft.service instead (see README "Restart vs stop on the instance").
const RESTART_SCRIPT = "systemctl restart minecraft.target";

export async function restartServer(): Promise<RestartResult> {
  console.log("restartServer: looking up instance");
  const instance = await getInstance();
  if (!instance?.InstanceId) {
    console.log("restartServer: no instance found");
    return { status: "not_found" };
  }

  const { InstanceId, State } = instance;
  const instanceState = State?.Name ?? "unknown";
  console.log("restartServer: found instance", { instanceId: InstanceId, instanceState });

  if (instanceState !== "running") {
    return { status: "not_running", instanceId: InstanceId, instanceState };
  }

  const result = await runSsmShellCommand(InstanceId, RESTART_SCRIPT, RESTART_WAIT_MS);
  if (result.status === "Success") {
    console.log("restartServer: minecraft.target restarted", { instanceId: InstanceId });
    return { status: "restarted", instanceId: InstanceId };
  }

  const log =
    formatSsmOutput(result.stdout, result.stderr) ||
    `SSM command ${result.status.toLowerCase()}`;
  console.warn("restartServer: failed", { instanceId: InstanceId, status: result.status, log });
  return { status: "restart_failed", instanceId: InstanceId, log };
}
