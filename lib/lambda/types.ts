export interface WorkerPayload {
  commandName: "start" | "stop" | "status";
  interactionToken: string;
  applicationId: string;
}

export type StartResult =
  | {
      status: "started";
      instanceId: string;
      instanceType: string;
      fqdn: string;
      port: number;
    }
  | { status: "already_running"; instanceId: string };

export type StopResult =
  | { status: "stopped"; instanceId: string }
  | { status: "already_terminating"; instanceId: string }
  | { status: "not_found" };

export type McStatus = "ready" | "starting" | "offline" | "unknown";

export type MetricPoint = { timestamp: string; value: number };

export type SsmMetrics = {
  ramUsedGb: number | null; // current, via SSM
  ramTotalGb: number | null; // total, via SSM
  diskUsedGb: number | null; // current (/opt/minecraft/data), via SSM
  diskTotalGb: number | null; // total (/opt/minecraft/data), via SSM
};

export type ServerStats = {
  cpu: MetricPoint[]; // % utilization, Average, last 1h
  networkIn: MetricPoint[]; // bytes, Sum, last 1h
  networkOut: MetricPoint[]; // bytes, Sum, last 1h
} & SsmMetrics;

export type StatusResult =
  | { status: "not_found" }
  | {
      status: "found";
      instanceId: string;
      instanceType: string;
      instanceState: string;
      publicIp: string;
      fqdn: string;
      mcStatus: McStatus;
      stats?: ServerStats;
    };

export type CommandResult = StartResult | StopResult | StatusResult;
