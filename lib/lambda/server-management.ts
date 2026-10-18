import type { CommandName, CommandResult } from "./types";
import { startServer } from "./start-server";
import { stopServer } from "./stop-server";
import { getStatus } from "./get-status";
import { restartServer } from "./restart-server";

export type { CommandName };

export type RunCommandOptions = {
  instanceType?: string;
};

export async function runCommand(
  commandName: CommandName,
  options?: RunCommandOptions
): Promise<CommandResult> {
  switch (commandName) {
    case "start":
      return startServer(options?.instanceType);
    case "stop":
      return stopServer();
    case "status":
      return getStatus();
    case "restart":
      return restartServer();
    default:
      throw new Error(`Unknown command: ${commandName as string}`);
  }
}

export const handler = async (event: {
  commandName: CommandName;
  instanceType?: string;
}): Promise<CommandResult> => {
  console.log("handler invoked", {
    commandName: event.commandName,
    instanceType: event.instanceType,
  });
  const result = await runCommand(event.commandName, {
    instanceType: event.instanceType,
  });
  console.log("handler complete", { commandName: event.commandName, result });
  return result;
};
