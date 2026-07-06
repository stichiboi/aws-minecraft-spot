import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  DescribeVolumesCommand,
} from "@aws-sdk/client-ec2";
import { mockConfig, mockEc2Send, resetAwsMocks } from "../helpers/aws-mocks";

vi.mock("../../config", () => mockConfig);

import {
  getDataVolumeState,
  getInstance,
  isInstanceInitializing,
} from "../../utils/ec2";

describe("utils/ec2", () => {
  beforeEach(resetAwsMocks);

  describe("getInstance", () => {
    it("returns the highest-priority instance state", async () => {
      mockEc2Send.mockResolvedValue({
        Reservations: [
          {
            Instances: [
              { InstanceId: "i-stopped", State: { Name: "stopped" } },
              { InstanceId: "i-running", State: { Name: "running" } },
            ],
          },
        ],
      });

      const instance = await getInstance();
      expect(instance?.InstanceId).toBe("i-running");
      expect(mockEc2Send).toHaveBeenCalledWith(expect.any(DescribeInstancesCommand));
    });
  });

  describe("getDataVolumeState", () => {
    it("returns null when no volume exists", async () => {
      mockEc2Send.mockResolvedValue({ Volumes: [] });
      expect(await getDataVolumeState()).toBeNull();
    });

    it("returns volume id and state", async () => {
      mockEc2Send.mockResolvedValue({
        Volumes: [{ VolumeId: "vol-123", State: "available" }],
      });
      expect(await getDataVolumeState()).toEqual({
        volumeId: "vol-123",
        state: "available",
      });
      expect(mockEc2Send).toHaveBeenCalledWith(expect.any(DescribeVolumesCommand));
    });
  });

  describe("isInstanceInitializing", () => {
    it("returns true when instance status is initializing", async () => {
      mockEc2Send.mockResolvedValue({
        InstanceStatuses: [
          {
            InstanceStatus: { Status: "initializing" },
            SystemStatus: { Status: "ok" },
          },
        ],
      });
      expect(await isInstanceInitializing("i-1")).toBe(true);
      expect(mockEc2Send).toHaveBeenCalledWith(
        expect.any(DescribeInstanceStatusCommand)
      );
    });

    it("returns false when describe fails", async () => {
      mockEc2Send.mockRejectedValue(new Error("not found"));
      expect(await isInstanceInitializing("i-missing")).toBe(false);
    });
  });
});
