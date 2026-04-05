export interface WorkerPayload {
  commandName: "start" | "stop" | "status";
  interactionToken: string;
  applicationId: string;
}
