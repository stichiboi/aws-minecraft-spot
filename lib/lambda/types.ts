export interface WorkerPayload {
  commandName: "start" | "stop" | "status";
  interactionToken: string;
  applicationId: string;
}

export type StartResult =
  | { status: "started"; instanceId: string; instanceType: string; fqdn: string; port: number }
  | { status: "already_running"; instanceId: string };

export type StopResult =
  | { status: "stopped"; instanceId: string }
  | { status: "already_terminating"; instanceId: string }
  | { status: "not_found" };

export type McStatus = "ready" | "starting" | "offline" | "unknown";

export type StatusResult =
  | { status: "not_found" }
  | { status: "found"; instanceId: string; instanceType: string; instanceState: string; publicIp: string; fqdn: string; mcStatus: McStatus };

export type CommandResult = StartResult | StopResult | StatusResult;
