import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export class MinecraftLogging extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // ── CloudWatch Log Groups ────────────────────────────────────────
    const logGroupDefaults = {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    };
    new logs.LogGroup(this, "BootLogGroup", {
      logGroupName: "/minecraft/boot",
      ...logGroupDefaults,
    });
    new logs.LogGroup(this, "SetupLogGroup", {
      logGroupName: "/minecraft/setup",
      ...logGroupDefaults,
    });
    new logs.LogGroup(this, "ServerLogGroup", {
      logGroupName: "/minecraft/server",
      ...logGroupDefaults,
    });

    // ── CWAgent config in SSM Parameter Store ────────────────────────
    // Parameter name MUST start with AmazonCloudWatch- for CloudWatchAgentServerPolicy
    // to allow ssm:GetParameter on it.
    const cwAgentConfig = new ssm.StringParameter(this, "CWAgentConfig", {
      parameterName: "AmazonCloudWatch-minecraft",
      stringValue: JSON.stringify({
        logs: {
          logs_collected: {
            files: {
              collect_list: [
                {
                  file_path: "/var/log/minecraft-setup.log",
                  log_group_name: "/minecraft/setup",
                  log_stream_name: "{instance_id}",
                  initial_position: "beginning_of_file",
                },
                {
                  file_path: "/var/log/minecraft-boot.log",
                  log_group_name: "/minecraft/boot",
                  log_stream_name: "{instance_id}",
                  initial_position: "beginning_of_file",
                },
              ],
            },
            journald: {
              collect_list: [
                {
                  log_group_name: "/minecraft/server",
                  log_stream_name: "{instance_id}",
                  units: ["minecraft.service"],
                },
              ],
            },
          },
        },
      }),
    });

    // ── SSM State Manager Association ────────────────────────────────
    // Targets instances by tag so spot relaunches are automatically configured.
    new ssm.CfnAssociation(this, "CWAgentAssociation", {
      associationName: "MinecraftCWAgentConfig",
      name: "AmazonCloudWatch-ManageAgent",
      targets: [{ key: "tag:Name", values: ["MinecraftServer"] }],
      scheduleExpression: "rate(1 day)",
      parameters: {
        action: ["configure"],
        mode: ["ec2"],
        optionalConfigurationSource: ["ssm"],
        optionalConfigurationLocation: [cwAgentConfig.parameterName],
        optionalRestart: ["yes"],
      },
    });
  }

  /** Attach the managed policies needed by the CWAgent to an instance role. */
  static addPoliciesToRole(role: iam.IRole): void {
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy")
    );
  }
}
