import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";

export interface MinecraftApiStackProps extends cdk.StackProps {
  discordPublicKey: string;
  discordBotToken: string;
  discordApplicationId: string;
  minecraftPort: number;
  serverFqdn: string;
  instanceType: string;
}

export class MinecraftApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MinecraftApiStackProps) {
    super(scope, id, props);

    const workerLogGroup = new logs.LogGroup(this, "WorkerLogGroup", {
      logGroupName: "/aws/lambda/minecraft-discord-worker",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const handlerLogGroup = new logs.LogGroup(this, "HandlerLogGroup", {
      logGroupName: "/aws/lambda/minecraft-discord-handler",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Worker Lambda (runs EC2 operations + posts Discord follow-up) ──
    const worker = new NodejsFunction(this, "DiscordWorker", {
      functionName: "minecraft-discord-worker",
      entry: "lib/lambda/discord-worker.ts",
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      logGroup: workerLogGroup,
      environment: {
        DISCORD_BOT_TOKEN: props.discordBotToken,
        DISCORD_APPLICATION_ID: props.discordApplicationId,
        INSTANCE_TAG: "MinecraftServer",
        SUBNET_FILTER: "MinecraftServer/Vpc/PublicSubnet1",
        LAUNCH_TEMPLATE_NAME: "MinecraftServer",
        MINECRAFT_PORT: String(props.minecraftPort),
        SERVER_FQDN: props.serverFqdn,
        INSTANCE_TYPE: props.instanceType,
      },
    });

    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:DescribeInstances",
          "ec2:RunInstances",
          "ec2:TerminateInstances",
          "ec2:CancelSpotInstanceRequests",
          "ec2:DescribeSubnets",
          "ec2:DescribeSpotInstanceRequests",
          "ec2:CreateTags",
        ],
        resources: ["*"],
      })
    );

    // ── Handler Lambda (signature verification + command routing) ──────
    const handler = new NodejsFunction(this, "DiscordHandler", {
      functionName: "minecraft-discord-handler",
      entry: "lib/lambda/discord-handler.ts",
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(5),
      logGroup: handlerLogGroup,
      environment: {
        DISCORD_PUBLIC_KEY: props.discordPublicKey,
        WORKER_FUNCTION_NAME: worker.functionName,
      },
    });

    worker.grantInvoke(handler);

    // ── API Gateway HTTP API ───────────────────────────────────────────
    const api = new HttpApi(this, "Api", {
      description: "Discord webhook endpoint for Minecraft server management",
    });

    api.addRoutes({
      path: "/discord",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("DiscordIntegration", handler),
    });

    new cdk.CfnOutput(this, "DiscordEndpoint", {
      value: `${api.apiEndpoint}/discord`,
      description: "Set this URL as the Discord Interactions Endpoint URL",
    });
  }
}
