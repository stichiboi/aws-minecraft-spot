#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { MinecraftBucketStack } from "../lib/minecraft-bucket-stack";
import { MinecraftStack } from "../lib/minecraft-stack";

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

const bucketStack = new MinecraftBucketStack(app, "MinecraftBucket", {
  env,
  description: "Modded Minecraft server - S3 bucket for mods and backups",
});

new MinecraftStack(app, "MinecraftServer", {
  env,
  description: "Modded Minecraft server - Spot EC2, S3 mods, Route53 DNS",
  bucket: bucketStack.bucket,

  instanceType: app.node.tryGetContext("instanceType") || "r5.large",
  volumeSize: Number(app.node.tryGetContext("volumeSize")) || 30,
  sshKeyName: app.node.tryGetContext("sshKeyName") || undefined,
  sshCidr: app.node.tryGetContext("sshCidr") || "0.0.0.0/0",
  minecraftPort: Number(app.node.tryGetContext("minecraftPort")) || 25565,
  hostedZoneName: app.node.tryGetContext("hostedZoneName") || "broccoli-dependence.stichiboi.com",
  serverSubdomain: app.node.tryGetContext("serverSubdomain") || "minecraft",
});
