import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateFleetCommand,
  DescribeInstancesCommand,
  DescribeSubnetsCommand,
} from "@aws-sdk/client-ec2";
import { mockConfig, mockEc2Send, resetAwsMocks } from "./helpers/aws-mocks";

const { getDataVolumeState } = vi.hoisted(() => ({
  getDataVolumeState: vi.fn(),
}));

vi.mock("../config", () => mockConfig);
vi.mock("../utils/ec2", () => ({ getDataVolumeState }));

import { startServer } from "../start-server";

function mockNoExistingInstance() {
  mockEc2Send.mockImplementation(async (command) => {
    if (command instanceof DescribeInstancesCommand) {
      return { Reservations: [] };
    }
    if (command instanceof DescribeSubnetsCommand) {
      return {
        Subnets: [{ SubnetId: "subnet-1", AvailabilityZone: "us-east-1a" }],
      };
    }
    if (command instanceof CreateFleetCommand) {
      return {
        Instances: [
          { InstanceIds: ["i-new"], InstanceType: "r3.large" },
        ],
      };
    }
    throw new Error(`unexpected command: ${command.constructor.name}`);
  });
}

describe("start-server", () => {
  beforeEach(() => {
    resetAwsMocks();
    getDataVolumeState.mockReset();
  });

  it("returns already_running when an instance is pending or running", async () => {
    mockEc2Send.mockResolvedValue({
      Reservations: [{ Instances: [{ InstanceId: "i-existing" }] }],
    });

    const result = await startServer();

    expect(result).toEqual({
      status: "already_running",
      instanceId: "i-existing",
    });
    expect(getDataVolumeState).not.toHaveBeenCalled();
  });

  it("returns volume_in_use when the data volume is not available", async () => {
    mockEc2Send.mockResolvedValue({ Reservations: [] });
    getDataVolumeState.mockResolvedValue({
      volumeId: "vol-1",
      state: "in-use",
    });

    const result = await startServer();

    expect(result).toEqual({
      status: "volume_in_use",
      volumeId: "vol-1",
    });
  });

  it("launches a fleet and returns started", async () => {
    mockNoExistingInstance();
    getDataVolumeState.mockResolvedValue(null);

    const result = await startServer();

    expect(result).toEqual({
      status: "started",
      instanceId: "i-new",
      instanceType: "r3.large",
      fqdn: "mc.example.com",
      port: 25565,
    });
    expect(mockEc2Send).toHaveBeenCalledWith(expect.any(CreateFleetCommand));
  });

  it("returns no_capacity when the fleet does not launch an instance", async () => {
    mockEc2Send.mockImplementation(async (command) => {
      if (command instanceof DescribeInstancesCommand) {
        return { Reservations: [] };
      }
      if (command instanceof DescribeSubnetsCommand) {
        return {
          Subnets: [{ SubnetId: "subnet-1", AvailabilityZone: "us-east-1a" }],
        };
      }
      if (command instanceof CreateFleetCommand) {
        return {
          Errors: [
            {
              ErrorCode: "InsufficientInstanceCapacity",
              LaunchTemplateAndOverrides: {
                Overrides: { InstanceType: "r3.large" },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected command: ${command.constructor.name}`);
    });
    getDataVolumeState.mockResolvedValue(null);

    const result = await startServer();

    expect(result).toEqual({
      status: "no_capacity",
      types: ["r3.large", "r5.large"],
      az: "us-east-1a",
    });
  });

  it("throws when the requested instance type is not allowed", async () => {
    mockNoExistingInstance();
    getDataVolumeState.mockResolvedValue(null);

    await expect(startServer("m5.large")).rejects.toThrow(
      'Instance type "m5.large" is not allowed'
    );
  });

  it("throws when the subnet cannot be found", async () => {
    mockEc2Send.mockImplementation(async (command) => {
      if (command instanceof DescribeInstancesCommand) {
        return { Reservations: [] };
      }
      if (command instanceof DescribeSubnetsCommand) {
        return { Subnets: [] };
      }
      throw new Error(`unexpected command: ${command.constructor.name}`);
    });
    getDataVolumeState.mockResolvedValue(null);

    await expect(startServer()).rejects.toThrow(
      "Could not find subnet tagged Name=MinecraftServer/Vpc/PublicSubnet1"
    );
  });
});
