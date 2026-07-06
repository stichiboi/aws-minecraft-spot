import {
  DescribeInstancesCommand,
  DescribeSubnetsCommand,
  CreateFleetCommand,
} from "@aws-sdk/client-ec2";
import type { StartResult } from "./types";
import {
  ec2,
  INSTANCE_TAG,
  SUBNET_FILTER,
  LAUNCH_TEMPLATE_NAME,
  MINECRAFT_PORT,
  SERVER_FQDN,
  INSTANCE_TYPES,
  DATA_VOLUME_TAG,
} from "./config";
import { getDataVolumeState } from "./utils/ec2";

function resolveFleetInstanceTypes(instanceType?: string): string[] {
  if (!instanceType) return INSTANCE_TYPES;
  if (!INSTANCE_TYPES.includes(instanceType)) {
    throw new Error(
      `Instance type "${instanceType}" is not allowed. Must be one of: ${INSTANCE_TYPES.join(", ")}`
    );
  }
  return [instanceType];
}

export async function startServer(instanceType?: string): Promise<StartResult> {
  console.log("startServer: checking for existing pending/running instance", {
    tag: INSTANCE_TAG,
  });
  const existing = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [INSTANCE_TAG] },
        { Name: "instance-state-name", Values: ["pending", "running"] },
      ],
    })
  );

  const existingId = existing.Reservations?.[0]?.Instances?.[0]?.InstanceId;
  if (existingId) {
    console.log("startServer: instance already running", {
      instanceId: existingId,
    });
    return { status: "already_running", instanceId: existingId };
  }

  console.log("startServer: checking data volume availability", {
    tag: DATA_VOLUME_TAG,
  });
  const vol = await getDataVolumeState();
  if (vol && vol.state !== "available") {
    console.log("startServer: data volume not available", vol);
    return { status: "volume_in_use", volumeId: vol.volumeId };
  }

  console.log("startServer: no existing instance, looking up subnet", {
    filter: SUBNET_FILTER,
  });
  const subnets = await ec2.send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: "tag:Name", Values: [SUBNET_FILTER] }],
    })
  );

  const subnet = subnets.Subnets?.[0];
  const subnetId = subnet?.SubnetId;
  if (!subnetId) {
    throw new Error(`Could not find subnet tagged Name=${SUBNET_FILTER}`);
  }
  console.log("startServer: found subnet", { subnetId, az: subnet.AvailabilityZone });

  const fleetInstanceTypes = resolveFleetInstanceTypes(instanceType);
  console.log("startServer: creating fleet", {
    launchTemplate: LAUNCH_TEMPLATE_NAME,
    instanceTypes: fleetInstanceTypes,
    subnetId,
  });
  const fleet = await ec2.send(
    new CreateFleetCommand({
      Type: "instant",
      TargetCapacitySpecification: {
        TotalTargetCapacity: 1,
        DefaultTargetCapacityType: "spot",
      },
      SpotOptions: {
        AllocationStrategy: "capacity-optimized",
      },
      LaunchTemplateConfigs: [
        {
          LaunchTemplateSpecification: {
            LaunchTemplateName: LAUNCH_TEMPLATE_NAME,
            Version: "$Latest",
          },
          Overrides: fleetInstanceTypes.map((type) => ({
            InstanceType: type as never,
            SubnetId: subnetId,
          })),
        },
      ],
    })
  );

  const launched = fleet.Instances?.[0]?.InstanceIds?.[0];
  const launchedType = fleet.Instances?.[0]?.InstanceType;
  if (!launched) {
    const perTypeErrors = fleet.Errors?.map((e) => {
      const type = e.LaunchTemplateAndOverrides?.Overrides?.InstanceType ?? "unknown";
      return `${type}: ${e.ErrorCode}`;
    });
    console.error("startServer: fleet failed to launch", {
      az: subnet.AvailabilityZone,
      perTypeErrors,
    });
    return {
      status: "no_capacity",
      types: fleetInstanceTypes,
      az: subnet.AvailabilityZone ?? "unknown",
    };
  }

  console.log("startServer: instance launched via fleet", {
    instanceId: launched,
    instanceType: launchedType,
  });
  return {
    status: "started",
    instanceId: launched,
    instanceType: launchedType ?? fleetInstanceTypes[0],
    fqdn: SERVER_FQDN,
    port: MINECRAFT_PORT,
  };
}
