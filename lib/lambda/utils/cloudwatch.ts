import { GetMetricStatisticsCommand, Statistic } from "@aws-sdk/client-cloudwatch";
import type { SeriesMetric } from "../types";
import { cw } from "../config";

export async function getCwMetric(
  instanceId: string,
  metricName: string,
  stat: Statistic,
  now: Date,
  startTime: Date
): Promise<SeriesMetric> {
  try {
    const res = await cw.send(
      new GetMetricStatisticsCommand({
        Namespace: "AWS/EC2",
        MetricName: metricName,
        Dimensions: [{ Name: "InstanceId", Value: instanceId }],
        StartTime: startTime,
        EndTime: now,
        Period: 300,
        Statistics: [stat],
      })
    );
    const values = (res.Datapoints ?? [])
      .sort(
        (a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0)
      )
      .map((dp) => ({
        timestamp: dp.Timestamp?.toISOString() ?? "",
        value: dp[stat] ?? 0,
      }));
    return { values };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
