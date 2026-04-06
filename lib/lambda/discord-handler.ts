import * as nacl from "tweetnacl";
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
} from "@aws-sdk/client-lambda";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { WorkerPayload } from "./types";

const lambdaClient = new LambdaClient({});

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const publicKey = process.env.DISCORD_PUBLIC_KEY!;
  const workerFunctionName = process.env.WORKER_FUNCTION_NAME!;

  const signature = event.headers["x-signature-ed25519"] ?? "";
  const timestamp = event.headers["x-signature-timestamp"] ?? "";
  const rawBody = event.body ?? "";

  console.log("handler invoked", { hasSignature: !!signature, hasTimestamp: !!timestamp, bodyLength: rawBody.length });

  const isValid = nacl.sign.detached.verify(
    Buffer.from(timestamp + rawBody),
    Buffer.from(signature, "hex"),
    Buffer.from(publicKey, "hex")
  );

  if (!isValid) {
    console.warn("handler: invalid signature, rejecting request");
    return { statusCode: 401, body: "Invalid request signature" };
  }

  const interaction = JSON.parse(rawBody);
  console.log("handler: signature valid", { interactionType: interaction.type });

  // PING
  if (interaction.type === 1) {
    console.log("handler: responding to PING");
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 1 }),
    };
  }

  // Slash command — deferred response, invoke worker asynchronously
  if (interaction.type === 2) {
    const commandName = interaction.data.name as WorkerPayload["commandName"];
    console.log("handler: dispatching slash command", { commandName, applicationId: interaction.application_id });

    const payload: WorkerPayload = {
      commandName,
      interactionToken: interaction.token as string,
      applicationId: interaction.application_id as string,
    };

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: workerFunctionName,
        InvocationType: InvocationType.Event,
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );

    console.log("handler: worker invoked async, returning deferred response", { workerFunctionName });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 5 }),
    };
  }

  console.warn("handler: unhandled interaction type", { interactionType: interaction.type });
  return { statusCode: 400, body: "Unknown interaction type" };
};
