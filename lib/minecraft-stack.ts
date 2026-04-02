import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

export interface MinecraftStackProps extends cdk.StackProps {
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

    // ── S3 Bucket (mods + backups) ──────────────────────────────────
    const bucket = new s3.Bucket(this, "ModsBucket", {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: "CleanupOldBackups",
          prefix: "backups/",
          expiration: cdk.Duration.days(30),
        },
      ],
    });

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
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    cdk.Tags.of(dataVolume).add("Name", "MinecraftData");

    // ── IAM Role ────────────────────────────────────────────────────
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
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

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["route53:GetChange"],
        resources: ["arn:aws:route53:::change/*"],
      })
    );

    // ── User Data (two-stage: one-time setup + per-boot) ────────────
    const userData = ec2.UserData.forLinux();

    const interpolationVars: Record<string, string> = {
      BUCKET_NAME: bucket.bucketName,
      HOSTED_ZONE_ID: hostedZone.hostedZoneId,
      FQDN: fqdn,
      MINECRAFT_PORT: String(props.minecraftPort),
      VOLUME_ID: dataVolume.volumeId,
    };

    const interpolate = (script: string) =>
      Object.entries(interpolationVars).reduce(
        (s, [key, val]) => s.replace(new RegExp(`\\$\\{${key}\\}`, "g"), val),
        script
      );

    const perBootRaw = fs.readFileSync(
      path.join(__dirname, "per-boot.sh"),
      "utf-8"
    );
    const perBootInterpolated = interpolate(perBootRaw);
    const perBootB64 = Buffer.from(perBootInterpolated).toString("base64");

    const userDataRaw = fs.readFileSync(
      path.join(__dirname, "user-data.sh"),
      "utf-8"
    );
    const userDataInterpolated = interpolate(userDataRaw).replace(
      /\$\{PER_BOOT_SCRIPT_B64\}/g,
      perBootB64
    );

    userData.addCommands(userDataInterpolated);

    // ── Launch Template (small root volume only) ────────────────────
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
    });

    // ── EC2 Instance ────────────────────────────────────────────────
    const instance = new ec2.CfnInstance(this, "Server", {
      launchTemplate: {
        launchTemplateId: launchTemplate.launchTemplateId,
        version: launchTemplate.versionNumber,
      },
      subnetId: vpc.publicSubnets[0].subnetId,
    });

    // Tag for easy identification
    cdk.Tags.of(instance).add("Name", "MinecraftServer");

    // ── Route53 A Record (placeholder - updated by per-boot script) ─
    new route53.ARecord(this, "DnsRecord", {
      zone: hostedZone,
      recordName: props.serverSubdomain,
      target: route53.RecordTarget.fromIpAddresses("127.0.0.1"),
      ttl: cdk.Duration.seconds(60),
    });

    // ── Outputs ─────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "InstanceId", {
      value: instance.ref,
      description: "EC2 Instance ID",
    });

    new cdk.CfnOutput(this, "BucketName", {
      value: bucket.bucketName,
      description: "S3 bucket for mods and backups",
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
  }
}
