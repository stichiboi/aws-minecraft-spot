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
  | { status: "already_running"; instanceId: string }
  | { status: "volume_in_use"; volumeId: string };

export type StopResult =
  | { status: "stopped"; instanceId: string }
  | { status: "already_terminating"; instanceId: string }
  | { status: "not_found" };

export type McStatus = "ready" | "starting" | "offline" | "unknown";

export type MetricPoint = { timestamp: string; value: number };

// A time-series metric (e.g. CPU, network) — either a list of data points or an error.
export type SeriesMetric = { error: string } | { values: MetricPoint[] };

// A scalar metric (e.g. RAM, disk) — either a current value with optional maximum, or an error.
export type ScalarMetric = { error: string } | { value: number; max?: number };

export type RconStatus =
  | { error: string }
  | { online: number; max: number; players: string[] };

export type LogSnippet = { error: string } | { lines: string[] };

export type ServerStats = {
  cpu: SeriesMetric; // % utilization, Average, last 1h
  networkIn: SeriesMetric; // bytes, Sum, last 1h
  networkOut: SeriesMetric; // bytes, Sum, last 1h
  ram: ScalarMetric; // used GB (max = total GB), via SSM
  disk: ScalarMetric; // used GB on /opt/minecraft/data (max = total GB), via SSM
  rcon?: RconStatus;
  logs?: LogSnippet;
};

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
      statusChecksInitializing?: boolean;
    };

export type CommandResult = StartResult | StopResult | StatusResult;
