#!/usr/bin/env node
import "source-map-support/register";
import * as dotenv from "dotenv";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { MinecraftBucketStack } from "../lib/minecraft-bucket-stack";
import { MinecraftStack } from "../lib/minecraft-stack";
import { MinecraftApiStack } from "../lib/minecraft-api-stack";

dotenv.config();

const app = new cdk.App();

// CDK CLI resolves these from your AWS credentials (awsume, profiles, env vars)
// and passes them as CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:
    app.node.tryGetContext("region") ||
    process.env.CDK_DEFAULT_REGION ||
    "eu-central-1",
};

/** All tunables live in cdk.json `context`; this is the only place that reads them. */
function readConfig(app: cdk.App) {
  const ctx = (key: string) => app.node.tryGetContext(key);
  const required = (key: string) => {
    const value = ctx(key);
    if (value === undefined || value === "") {
      throw new Error(`Missing required cdk.json context value "${key}"`);
    }
    return value;
  };

  const instanceTypes = required("instanceTypes") as string[];
  if (!Array.isArray(instanceTypes) || instanceTypes.length === 0) {
    throw new Error(`cdk.json context "instanceTypes" must be a non-empty array`);
  }

  return {
    instanceTypes,
    amazonLinuxCpuType:
      ctx("amazonLinuxCpuType") === "X86_64"
        ? ec2.AmazonLinuxCpuType.X86_64
        : ec2.AmazonLinuxCpuType.ARM_64,
    volumeSize: Number(ctx("volumeSize") ?? 30),
    minecraftPort: Number(ctx("minecraftPort") ?? 25565),
    hostedZoneName: required("hostedZoneName") as string,
    serverSubdomain: (ctx("serverSubdomain") ?? "minecraft") as string,
    idleShutdownTimer: Number(ctx("idleShutdownTimer") ?? 900),
    javaVersion: String(ctx("javaVersion") ?? "21"),
  };
}

const config = readConfig(app);

const bucketStack = new MinecraftBucketStack(app, "MinecraftBucket", {
  env,
  description: "Modded Minecraft server - S3 bucket for mods and backups",
});

const serverStack = new MinecraftStack(app, "MinecraftServer", {
  env,
  description: "Modded Minecraft server - Spot EC2, S3 mods, Route53 DNS",
  bucket: bucketStack.bucket,
  ...config,
});

new MinecraftApiStack(app, "MinecraftApi", {
  env,
  description: "Minecraft server Discord bot — API Gateway + Lambda",
  discordPublicKey: process.env.DISCORD_PUBLIC_KEY ?? "",
  minecraftPort: serverStack.minecraftPort,
  serverFqdn: serverStack.fqdn,
  instanceTypes: config.instanceTypes,
});
