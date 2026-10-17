import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { buildUserDataBundle } from "./build-user-data";
import {
  DATA_VOLUME_NAME_TAG,
  INSTANCE_NAME_TAG,
  LAUNCH_TEMPLATE_NAME,
  SERVER_MANAGEMENT_FUNCTION_NAME,
  SSM_CONFIG_PATH,
} from "./constants";

export interface MinecraftStackProps extends cdk.StackProps {
  bucket: s3.IBucket;
  instanceTypes: string[];
  volumeSize: number;
  minecraftPort: number;
  hostedZoneName: string;
  serverSubdomain: string;
  /** Seconds of player inactivity before the server auto-shuts down. Default: 900 (15 min). */
  idleShutdownTimer: number;
  /** Java major version for Amazon Corretto on the instance. Default: "21". */
  javaVersion: string;
  /** Amazon Linux 2023 AMI CPU. Must match `instanceTypes` arch (e.g. ARM_64 for m7g/m6g Graviton). Default: X86_64. */
  amazonLinuxCpuType: ec2.AmazonLinuxCpuType;
}

export class MinecraftStack extends cdk.Stack {
  public readonly fqdn: string;
  public readonly minecraftPort: number;

  constructor(scope: Construct, id: string, props: MinecraftStackProps) {
    super(scope, id, props);

    // ── VPC (single public subnet, no NAT) ──────────────────────────
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ── Security Group ──────────────────────────────────────────────
    const sg = new ec2.SecurityGroup(this, "ServerSg", {
      vpc,
      allowAllOutbound: true,
      // Changing the description replaces the security group; keep it as-is.
      description: "Minecraft server - game port + SSH",
    });

    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(props.minecraftPort),
      "Minecraft game traffic"
    );

    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.icmpPing(), "Allow ping");

    const { bucket } = props;

    // ── Route53 Hosted Zone (lookup existing) ───────────────────────
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: props.hostedZoneName,
    });

    const fqdn = `${props.serverSubdomain}.${props.hostedZoneName}`;
    this.fqdn = fqdn;
    this.minecraftPort = props.minecraftPort;

    // ── Standalone EBS Data Volume ──────────────────────────────────
    // SNAPSHOT: a replacement (AZ change, construct rename) or stack delete
    // leaves a final snapshot of the world instead of deleting it.
    const dataVolume = new ec2.Volume(this, "DataVolume", {
      availabilityZone: vpc.publicSubnets[0].availabilityZone,
      size: cdk.Size.gibibytes(props.volumeSize),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    cdk.Tags.of(dataVolume).add("Name", DATA_VOLUME_NAME_TAG);

    // Force-detach the EBS volume on stack deletion so CloudFormation can delete
    // it even if a fleet instance (unknown to CFN) has it attached.
    // Delete order: custom resource runs first (detach), then DataVolume is deleted.
    const detachOnDelete = new cr.AwsCustomResource(this, "DetachVolumeOnDelete", {
      onDelete: {
        service: "EC2",
        action: "detachVolume",
        parameters: {
          VolumeId: dataVolume.volumeId,
          Force: true,
        },
        ignoreErrorCodesMatching: "IncorrectState", // already detached = no-op
      },
      installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["ec2:DetachVolume"],
          resources: ["*"],
        }),
      ]),
    });
    detachOnDelete.node.addDependency(dataVolume);

    // ── IAM Role ────────────────────────────────────────────────────
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });
    bucket.grantReadWrite(role);
    dataVolume.grantAttachVolume(role);
    dataVolume.grantDetachVolume(role);

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeVolumes"],
        resources: ["*"],
      })
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["route53:ChangeResourceRecordSets"],
        resources: [`arn:aws:route53:::hostedzone/${hostedZone.hostedZoneId}`],
      })
    );

    // per-boot.sh terminates its own instance when boot fails, so a broken
    // instance never keeps running without the idle monitor.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:TerminateInstances"],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
        conditions: {
          StringEquals: { "aws:ResourceTag/Name": INSTANCE_NAME_TAG },
        },
      })
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["route53:GetChange"],
        resources: ["arn:aws:route53:::change/*"],
      })
    );

    // ── SSM Config Parameters ────────────────────────────────────────
    // Boot scripts read these at runtime. The API stack resolves subnet-id at
    // deploy time instead of searching for a subnet by name.
    const configPath = SSM_CONFIG_PATH;
    const configEntries: [string, string][] = [
      ["bucket-name",     bucket.bucketName],
      ["volume-id",       dataVolume.volumeId],
      ["subnet-id",           vpc.publicSubnets[0].subnetId],
      ["instance-role-arn",   role.roleArn],
      ["hosted-zone-id",      hostedZone.hostedZoneId],
      ["fqdn",            fqdn],
      ["port",            String(props.minecraftPort)],
      ["shutdown-timer",  String(props.idleShutdownTimer)],
      ["java-version",        props.javaVersion],
      ["management-function", SERVER_MANAGEMENT_FUNCTION_NAME],
    ];
    for (const [name, value] of configEntries) {
      new ssm.StringParameter(this, `Param-${name}`, {
        parameterName: `${configPath}/${name}`,
        stringValue: value,
      });
    }

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParametersByPath", "ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${configPath}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${configPath}/*`,
        ],
      })
    );

    // Allow the idle-shutdown monitor to invoke the management Lambda so it
    // can cancel the spot request and terminate the instance cleanly.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:${SERVER_MANAGEMENT_FUNCTION_NAME}`,
        ],
      })
    );

    // ── User Data (bootstrap only; real boot logic is pulled from S3) ──
    const userData = ec2.UserData.forLinux();
    const { userDataScript } = buildUserDataBundle({ templatesDir: __dirname });
    userData.addCommands(userDataScript);

    // ── Launch Template (used by the EC2 Fleet in start-server.ts) ──
    // The AMI is resolved from the public SSM parameter at every launch, so a
    // new AL2023 release never changes the launch template.
    const amiArch =
      props.amazonLinuxCpuType === ec2.AmazonLinuxCpuType.ARM_64 ? "arm64" : "x86_64";
    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      // required even if we override with fleet requests because EC2 will default to a `t2.small` otherwise
      instanceType: new ec2.InstanceType(props.instanceTypes[0]),
      machineImage: ec2.MachineImage.resolveSsmParameterAtLaunch(
        `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${amiArch}`,
        { os: ec2.OperatingSystemType.LINUX }
      ),
      role,
      userData,
      securityGroup: sg,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      launchTemplateName: LAUNCH_TEMPLATE_NAME,
    });

    // Tag every fleet instance so the Lambdas, scripts and IAM conditions can find it.
    // There is no CloudFormation-managed instance: the fleet creates one on start
    // and stop terminates it.
    const cfnLaunchTemplate = launchTemplate.node
      .defaultChild as ec2.CfnLaunchTemplate;
    cfnLaunchTemplate.addPropertyOverride(
      "LaunchTemplateData.TagSpecifications",
      [
        {
          ResourceType: "instance",
          Tags: [{ Key: "Name", Value: INSTANCE_NAME_TAG }],
        },
      ]
    );

    // Route53 A record is NOT managed here — the per-boot script upserts it on
    // every boot with the real public IP. Keeping it in CDK would reset it to
    // 127.0.0.1 on every `cdk deploy`. On `cdk destroy` you must delete the
    // A record manually from the hosted zone.

    // ── Outputs ─────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ServerAddress", {
      value: fqdn,
      description: "Minecraft server address (connect with this hostname)",
    });

    new cdk.CfnOutput(this, "HostedZoneId", {
      value: hostedZone.hostedZoneId,
      description: "Route53 hosted zone ID",
    });

    new cdk.CfnOutput(this, "DataVolumeId", {
      value: dataVolume.volumeId,
      description: "EBS data volume ID (Minecraft world + server files)",
    });

    new cdk.CfnOutput(this, "MinecraftPort", {
      value: String(props.minecraftPort),
      description: "Minecraft server port",
    });
  }
}
