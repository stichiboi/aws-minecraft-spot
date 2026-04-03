import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { buildUserDataBundle } from "./build-user-data";
import { MinecraftLogging } from "./minecraft-logging";

export interface MinecraftStackProps extends cdk.StackProps {
  bucket: s3.IBucket;
  instanceType: string;
  volumeSize: number;
  sshKeyName?: string;
  sshCidr: string;
  minecraftPort: number;
  hostedZoneName: string;
  serverSubdomain: string;
}

export class MinecraftStack extends cdk.Stack {
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
      description: "Minecraft server - game port + SSH",
    });

    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(props.minecraftPort),
      "Minecraft game traffic"
    );

    sg.addIngressRule(
      ec2.Peer.ipv4(props.sshCidr),
      ec2.Port.tcp(22),
      "SSH access"
    );

    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.icmpPing(), "Allow ping");

    const { bucket } = props;

    // ── Route53 Hosted Zone (lookup existing) ───────────────────────
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: props.hostedZoneName,
    });

    const fqdn = `${props.serverSubdomain}.${props.hostedZoneName}`;

    // ── Standalone EBS Data Volume ──────────────────────────────────
    const dataVolume = new ec2.Volume(this, "DataVolume", {
      availabilityZone: vpc.publicSubnets[0].availabilityZone,
      size: cdk.Size.gibibytes(props.volumeSize),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    cdk.Tags.of(dataVolume).add("Name", "MinecraftData");

    // ── IAM Role ────────────────────────────────────────────────────
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });
    MinecraftLogging.addPoliciesToRole(role);

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

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["route53:GetChange"],
        resources: ["arn:aws:route53:::change/*"],
      })
    );

    // ── SSM Config Parameters ────────────────────────────────────────
    // Per-boot script reads these at runtime instead of relying on values
    // baked into user-data. Decouples config from CloudFormation user-data
    // and eliminates the Fn::Sub escaping that was required previously.
    const configPath = "/minecraft/config";
    const configEntries: [string, string][] = [
      ["bucket-name",    bucket.bucketName],
      ["volume-id",      dataVolume.volumeId],
      ["hosted-zone-id", hostedZone.hostedZoneId],
      ["fqdn",           fqdn],
      ["port",           String(props.minecraftPort)],
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

    // ── User Data (two-stage: one-time setup + per-boot) ────────────
    const userData = ec2.UserData.forLinux();
    const { userDataScript } = buildUserDataBundle({ templatesDir: __dirname });
    userData.addCommands(userDataScript);

    // ── Launch Template (small root volume only) ────────────────────
    // TagSpecifications ensure instances launched from this template (including
    // spot relaunches) always receive the Name tag, independent of CloudFormation.
    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      userData,
      securityGroup: sg,
      keyPair: props.sshKeyName
        ? ec2.KeyPair.fromKeyPairName(this, "SshKeyPair", props.sshKeyName)
        : undefined,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      spotOptions: {
        interruptionBehavior: ec2.SpotInstanceInterruption.STOP,
        requestType: ec2.SpotRequestType.PERSISTENT,
      },
      launchTemplateName: "MinecraftServer",
    });

    // ── EC2 Instance ────────────────────────────────────────────────
    const instance = new ec2.CfnInstance(this, "Server", {
      launchTemplate: {
        launchTemplateId: launchTemplate.launchTemplateId,
        version: launchTemplate.versionNumber,
      },
      subnetId: vpc.publicSubnets[0].subnetId,
    });

    // Propagate the Name tag to instances via the launch template so spot
    // relaunches are also tagged — cdk.Tags.of(instance) only tags the
    // CloudFormation-managed instance and becomes stale after a spot relaunch.
    const cfnLaunchTemplate = launchTemplate.node
      .defaultChild as ec2.CfnLaunchTemplate;
    cfnLaunchTemplate.addPropertyOverride(
      "LaunchTemplateData.TagSpecifications",
      [
        {
          ResourceType: "instance",
          Tags: [{ Key: "Name", Value: "MinecraftServer" }],
        },
      ]
    );

    // Route53 A record is NOT managed here — the per-boot script upserts it on
    // every boot with the real public IP. Keeping it in CDK would reset it to
    // 127.0.0.1 on every `cdk deploy`. On `cdk destroy` you must delete the
    // A record manually from the hosted zone.

    // ── CloudWatch Logging (log groups + CWAgent via SSM State Manager) ──
    new MinecraftLogging(this, "Logging");

    // ── Outputs ─────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "InstanceId", {
      value: instance.ref,
      description: "EC2 Instance ID",
    });

    new cdk.CfnOutput(this, "InstancePublicIp", {
      value: instance.attrPublicIp,
      description: "EC2 Instance IP",
    });

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
