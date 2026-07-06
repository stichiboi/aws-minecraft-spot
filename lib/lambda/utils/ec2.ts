import {
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  DescribeVolumesCommand,
} from "@aws-sdk/client-ec2";
import { ec2, INSTANCE_TAG, DATA_VOLUME_TAG, STATE_PRIORITY } from "../config";

export async function getInstance() {
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [INSTANCE_TAG] },
        {
          Name: "instance-state-name",
          Values: ["pending", "running", "stopping", "stopped"],
        },
      ],
    })
  );
  const allInstances =
    result.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
  return allInstances.sort(
    (a, b) =>
      (STATE_PRIORITY[a.State?.Name ?? ""] ?? 99) -
      (STATE_PRIORITY[b.State?.Name ?? ""] ?? 99)
  )[0];
}

export async function getDataVolumeState(): Promise<{
  volumeId: string;
  state: string;
} | null> {
  const res = await ec2.send(
    new DescribeVolumesCommand({
      Filters: [{ Name: "tag:Name", Values: [DATA_VOLUME_TAG] }],
    })
  );
  const vol = res.Volumes?.[0];
  if (!vol?.VolumeId) return null;
  return { volumeId: vol.VolumeId, state: vol.State ?? "unknown" };
}

export async function isInstanceInitializing(
  instanceId: string
): Promise<boolean> {
  try {
    const res = await ec2.send(
      new DescribeInstanceStatusCommand({ InstanceIds: [instanceId] })
    );
    const s = res.InstanceStatuses?.[0];
    return (
      s?.InstanceStatus?.Status === "initializing" ||
      s?.SystemStatus?.Status === "initializing"
    );
  } catch {
    return false;
  }
}
