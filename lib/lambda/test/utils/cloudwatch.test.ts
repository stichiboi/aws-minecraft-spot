import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { mockConfig, mockCwSend, resetAwsMocks } from "../helpers/aws-mocks";

vi.mock("../../config", () => mockConfig);

import { getCwMetric } from "../../utils/cloudwatch";

describe("utils/cloudwatch", () => {
  beforeEach(resetAwsMocks);

  it("sorts datapoints chronologically", async () => {
    mockCwSend.mockResolvedValue({
      Datapoints: [
        { Timestamp: new Date("2026-01-01T01:00:00Z"), Average: 20 },
        { Timestamp: new Date("2026-01-01T00:00:00Z"), Average: 10 },
      ],
    });

    const now = new Date("2026-01-01T02:00:00Z");
    const start = new Date("2026-01-01T00:00:00Z");
    const result = await getCwMetric("i-1", "CPUUtilization", "Average", now, start);

    expect(result).toEqual({
      values: [
        { timestamp: "2026-01-01T00:00:00.000Z", value: 10 },
        { timestamp: "2026-01-01T01:00:00.000Z", value: 20 },
      ],
    });
    expect(mockCwSend).toHaveBeenCalledWith(expect.any(GetMetricStatisticsCommand));
  });

  it("returns an error object when CloudWatch fails", async () => {
    mockCwSend.mockRejectedValue(new Error("throttled"));

    const now = new Date();
    const start = new Date(now.getTime() - 3_600_000);
    const result = await getCwMetric("i-1", "NetworkIn", "Sum", now, start);

    expect(result).toEqual({ error: "throttled" });
  });
});
