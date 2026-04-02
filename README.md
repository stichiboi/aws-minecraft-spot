# aws-maincraift

Modded Minecraft server on AWS - Spot EC2, S3 mod sync, Route53 dynamic DNS, managed with CDK.

## Quick Start

```bash
npm install
# Edit cdk.json context values (instance type, SSH key, domain, etc.)
# Edit server-config/config.json (Forge/Fabric/Vanilla, MC version)
npx cdk bootstrap   # first time only
bash scripts/deploy.sh
```

After deploy, CloudFormation outputs include **InstanceId**, **BucketName**, **ServerAddress**, **HostedZoneId**, and **DataVolumeId** (the persistent Minecraft data volume).

## Day-to-Day

These scripts wrap the AWS CLI and CDK. They read stack outputs from the `MinecraftServer` stack by name.

| Command | What it does |
|---|---|
| `bash scripts/status.sh` | Instance state, public IP, DNS name, S3 bucket |
| `bash scripts/start-server.sh` | Start a stopped instance (per-boot logic runs on boot) |
| `bash scripts/stop-server.sh` | Stop the instance; **data EBS stays attached until next start** |
| `bash scripts/ssh.sh [key.pem]` | SSH to `ec2-user@` current public IP |
| `bash scripts/upload-mods.sh` | `aws s3 sync` local `mods/*.jar` → bucket `mods/` |
| `bash scripts/deploy.sh` | Uploads `server-config/` to S3, then `npx cdk deploy` |
| `bash scripts/destroy.sh` | `cdk destroy` - **S3 bucket and data EBS volume are retained** (RemovalPolicy RETAIN) |

## Adding Mods

1. Put `.jar` files in `mods/` (directory is gitignored).
2. `bash scripts/upload-mods.sh`
3. Restart so per-boot sync runs: `bash scripts/stop-server.sh && bash scripts/start-server.sh`

## Switching Mod Loaders

Edit `server-config/config.json`:

```json
{
  "type": "forge",        // "vanilla", "forge", or "fabric"
  "mcVersion": "1.20.4",
  "loaderVersion": "49.0.49",
  "jvmArgs": "-Xms4G -Xmx12G ..."
}
```

Then `bash scripts/deploy.sh` and restart the instance. The per-boot script reinstalls the server only when the type/version/loader combo changes (see `.installed_*` marker on the data volume).

## Architecture

- **EC2 Spot** (`r5.large` default) with **stop** interruption - instance stops, not terminated; EBS data volume is reattached on next boot.
- **Detached EBS gp3** - separate CloudFormation `AWS::EC2::Volume` (size from `cdk.json` `volumeSize`, default 30GB). Minecraft world and server files live under `/opt/minecraft/data` on this volume. Replacing or resizing the instance in CDK does **not** create a new data volume; the same volume is attached each boot.
- **Small root volume** (8GB gp3) on the instance for the OS only.
- **S3** - `config/`, `mods/`, and future `backups/`; `deploy.sh` pushes local `server-config/` into `config/`.
- **Route53** - A record updated on **every boot** by the per-boot script (no Elastic IP).
- **IMDSv2** - instance scripts use the metadata token API for instance id, public IP, and region.

## Boot scripts (CDK → EC2)

Infrastructure is TypeScript (`lib/minecraft-stack.ts`); **on the instance** behavior is shell:

| File | When it runs | Role |
|---|---|---|
| `lib/user-data.sh` | First boot only (cloud-init) | Installs Java/jq/nvme-cli, creates `minecraft` user, writes systemd unit, decodes and installs the per-boot script, runs it once. |
| `lib/per-boot.sh` | Every boot (`/var/lib/cloud/scripts/per-boot/`) | Attaches & mounts the data volume, updates DNS, syncs S3 config/mods, installs server if needed, writes `start.sh`, `systemctl restart minecraft`. |

At synth time, CDK reads both files, substitutes `${BUCKET_NAME}`, `${VOLUME_ID}`, etc., and embeds the per-boot script (base64) into user-data.

## Cost (~eu-central-1)

- 24/7: ~$24–31/month
- Few hours/day: ~$8–14/month
