import {
  CancelSpotInstanceRequestsCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import type { StopResult } from "./types";
import { ec2, INSTANCE_TAG } from "./config";
import { getInstance } from "./utils/ec2";
import { runGracefulShutdown } from "./utils/ssm";

export async function stopServer(): Promise<StopResult> {
  console.log("stopServer: looking up instance", { tag: INSTANCE_TAG });
  const instance = await getInstance();
  if (!instance || !instance.InstanceId) {
    console.log("stopServer: no instance found");
    return { status: "not_found" };
  }

  const { InstanceId, State, SpotInstanceRequestId } = instance;
  const state = State?.Name;
  console.log("stopServer: found instance", {
    instanceId: InstanceId,
    state,
    spotRequestId: SpotInstanceRequestId,
  });

  if (state === "shutting-down" || state === "terminated") {
    return { status: "already_terminating", instanceId: InstanceId };
  }

  let graceful = false;
  if (state === "running") {
    const gracefulResult = await runGracefulShutdown(InstanceId);
    graceful = gracefulResult.ok;
    if (!graceful) {
      console.warn("stopServer: graceful shutdown failed — terminating anyway", gracefulResult);
    }
  }

  if (SpotInstanceRequestId && SpotInstanceRequestId !== "None") {
    console.log("stopServer: cancelling spot request", {
      spotRequestId: SpotInstanceRequestId,
    });
    await ec2.send(
      new CancelSpotInstanceRequestsCommand({
        SpotInstanceRequestIds: [SpotInstanceRequestId],
      })
    );
  }

  console.log("stopServer: terminating instance", { instanceId: InstanceId });
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: [InstanceId] }));

  return { status: "stopped", instanceId: InstanceId, graceful };
}
