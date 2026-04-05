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

  const isValid = nacl.sign.detached.verify(
    Buffer.from(timestamp + rawBody),
    Buffer.from(signature, "hex"),
    Buffer.from(publicKey, "hex")
  );

  if (!isValid) {
    return { statusCode: 401, body: "Invalid request signature" };
  }

  const interaction = JSON.parse(rawBody);

  // PING
  if (interaction.type === 1) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 1 }),
    };
  }

  // Slash command — deferred response, invoke worker asynchronously
  if (interaction.type === 2) {
    const payload: WorkerPayload = {
      commandName: interaction.data.name as WorkerPayload["commandName"],
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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 5 }),
    };
  }

  return { statusCode: 400, body: "Unknown interaction type" };
};
