import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";
import {
  DATA_VOLUME_NAME_TAG,
  INSTANCE_NAME_TAG,
  LAUNCH_TEMPLATE_NAME,
  SERVER_MANAGEMENT_FUNCTION_NAME,
  SSM_CONFIG_PATH,
} from "./constants";

export interface MinecraftApiStackProps extends cdk.StackProps {
  discordPublicKey: string;
  discordBotToken: string;
  discordApplicationId: string;
  minecraftPort: number;
  serverFqdn: string;
  instanceTypes: string[];
}

export class MinecraftApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MinecraftApiStackProps) {
    super(scope, id, props);

    // Written by the MinecraftServer stack; resolved by CloudFormation at deploy
    // time, so the stacks stay decoupled (no cross-stack exports).
    const subnetId = ssm.StringParameter.valueForStringParameter(
      this,
      `${SSM_CONFIG_PATH}/subnet-id`
    );

    // Must exceed GRACEFUL_SHUTDOWN_WAIT_MS (lib/lambda/config.ts) plus the
    // EC2 calls around it, or /stop is killed before the instance is terminated.
    const managementTimeout = cdk.Duration.seconds(300);

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

    const ec2Policy = new iam.PolicyStatement({
      actions: [
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeVolumes",
        "ec2:RunInstances",
        "ec2:CreateFleet",
        "ec2:TerminateInstances",
        "ec2:CancelSpotInstanceRequests",
        "ec2:DescribeSubnets",
        "ec2:DescribeSpotInstanceRequests",
        "ec2:CreateTags",
        "iam:PassRole",
      ],
      resources: ["*"],
    });

    const cloudwatchPolicy = new iam.PolicyStatement({
      actions: ["cloudwatch:GetMetricStatistics"],
      resources: ["*"],
    });

    const ssmRunPolicy = new iam.PolicyStatement({
      actions: ["ssm:SendCommand", "ssm:GetCommandInvocation"],
      resources: ["*"],
    });

    // The launch template's AMI is a resolve:ssm: reference, resolved with the caller's permissions.
    const amiParameterPolicy = new iam.PolicyStatement({
      actions: ["ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:*:parameter/aws/service/ami-amazon-linux-latest/*`],
    });

    const ec2Environment = {
      INSTANCE_TAG: INSTANCE_NAME_TAG,
      SUBNET_ID: subnetId,
      LAUNCH_TEMPLATE_NAME,
      DATA_VOLUME_TAG: DATA_VOLUME_NAME_TAG,
      MINECRAFT_PORT: String(props.minecraftPort),
      SERVER_FQDN: props.serverFqdn,
      INSTANCE_TYPES: JSON.stringify(props.instanceTypes),
    };

    // ── Server Management Lambda (EC2 start/stop/status — directly invocable) ──
    const serverManagementLogGroup = new logs.LogGroup(this, "ServerManagementLogGroup", {
      logGroupName: `/aws/lambda/${SERVER_MANAGEMENT_FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const serverManagement = new NodejsFunction(this, "ServerManagement", {
      functionName: SERVER_MANAGEMENT_FUNCTION_NAME,
      entry: "lib/lambda/server-management.ts",
      runtime: Runtime.NODEJS_20_X,
      timeout: managementTimeout,
      logGroup: serverManagementLogGroup,
      environment: ec2Environment,
    });

    serverManagement.addToRolePolicy(ec2Policy);
    serverManagement.addToRolePolicy(cloudwatchPolicy);
    serverManagement.addToRolePolicy(ssmRunPolicy);
    serverManagement.addToRolePolicy(amiParameterPolicy);

    // ── Worker Lambda (calls server-management logic + posts Discord follow-up) ──
    const worker = new NodejsFunction(this, "DiscordWorker", {
      functionName: "minecraft-discord-worker",
      entry: "lib/lambda/discord-worker.ts",
      runtime: Runtime.NODEJS_20_X,
      timeout: managementTimeout,
      logGroup: workerLogGroup,
      environment: {
        DISCORD_BOT_TOKEN: props.discordBotToken,
        DISCORD_APPLICATION_ID: props.discordApplicationId,
        ...ec2Environment,
      },
    });

    worker.addToRolePolicy(ec2Policy);
    worker.addToRolePolicy(cloudwatchPolicy);
    worker.addToRolePolicy(ssmRunPolicy);
    worker.addToRolePolicy(amiParameterPolicy);

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
