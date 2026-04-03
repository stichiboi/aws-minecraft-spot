# aws-maincraift

Modded Minecraft server on AWS - Spot EC2, S3 mod sync, Route53 dynamic DNS, managed with CDK.

## Quick Start

```bash
npm install
# Edit cdk.json context values (instance type, SSH key, domain, etc.)
# Edit server-config/config.json (Forge/Fabric/Vanilla, MC version)
task setup    # installs deps and bootstraps CDK (first time only)
task deploy   # deploy bucket + upload mods/config + deploy server + show status
```

After deploy, CloudFormation outputs include **InstanceId**, **BucketName**, **ServerAddress**, **HostedZoneId**, and **DataVolumeId** (the persistent Minecraft data volume).

## Day-to-Day

Run `task` to list all available tasks.

| Command | What it does |
|---|---|
| `task status` | Instance state, public IP, DNS name, S3 bucket |
| `task start-server` | Start a stopped instance (per-boot logic runs on boot) |
| `task stop-server` | Stop the instance; **data EBS stays attached until next start** |
| `task ssh` | SSH to `ec2-user@` current public IP (`task ssh KEY=~/.ssh/key.pem` to specify a key) |
| `task upload-mods` | Sync local `mods/*.jar` and `server-config/` to S3 |
| `task deploy` | Full deploy: bucket → upload → server → status |
| `task destroy` | `cdk destroy` — **S3 bucket and data EBS volume are retained** (RemovalPolicy RETAIN) |
| `task logs` | Tail all CloudWatch log streams (add `-- --follow` to stream) |
| `task logs:server` | Tail a specific stream: `boot`, `setup`, or `server` |

## Adding Mods

1. Put `.jar` files in `mods/` (directory is gitignored).
2. `task sync-mods` — uploads to S3 and syncs to the running instance via SSM, then restarts the server (no SSH needed).

Or to apply on next boot only: `task upload-mods`, then `task stop-server && task start-server`.

## Switching Mod Loaders

Edit `server-config/config.json`:

```json
{
  "type": "forge",        // "vanilla", "forge", "neoforge", or "fabric"
  "mcVersion": "1.20.4",
  "loaderVersion": "49.0.49",
  "jvmArgs": "-Xms4G -Xmx12G ..."
}
```

Then `task deploy` and restart the instance. The per-boot script reinstalls the server only when the type/version/loader combo changes (see `.installed_*` marker on the data volume).

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
