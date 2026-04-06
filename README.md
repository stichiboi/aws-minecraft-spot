# aws-maincraift

Modded Minecraft server on AWS - Spot EC2, S3 mod sync, Route53 dynamic DNS, managed with CDK.

## Prerequisites

- **AWS account** with programmatic access — install and configure the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then run `aws configure`
- **Node.js 18+** — https://nodejs.org/en/download
- **Task** (the task runner) — https://taskfile.dev/installation/ (macOS: `brew install go-task`)
- **`.env` file** — copy the template and fill in credentials for any bots you want to use:
  ```bash
  cp .env.example .env
  ```

## Quick Start

```bash
task setup    # installs deps and bootstraps CDK
task deploy   # deploy bucket + upload mods/config + deploy server + show status
```

After deploy, run `task status` to see the server address.

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
| `task logs:server` | Tail a specific stream: `boot` or `server` |

## Adding Mods

1. Put `.jar` files in `mods/` (directory is gitignored).
2. `task sync-mods` — uploads to S3 and syncs to the running instance via SSM, then restarts the server (no SSH needed).

Or to apply on next boot only (e.g. the server is offlilne): `task upload-mods`.

## Customizing the Server

### Launcher type and Minecraft version

Edit `server-config/config.json`:

```json
{
  "type": "neoforge",     // "vanilla", "forge", "neoforge", or "fabric"
  "mcVersion": "1.21.1",
  "loaderVersion": "21.1.222",  // omit or leave empty for vanilla/fabric without a specific loader version
  "javaVersion": "21"           // major version, e.g. "17" or "21"
}
```

Then run `task upload-mods` and restart the instance (`task stop-server` + `task start-server`). The per-boot script reinstalls the server only when the type/version/loader combo changes (tracked via a `.installed_*` marker on the data volume). Java is installed on every boot via `dnf` (idempotent — fast if already present).

### Instance type

Edit `instanceType` in `cdk.json`:

```json
{
  "context": {
    "instanceType": "r5.large"
  }
}
```

`task start-server` reads this value at launch time and passes it to `run-instances`, so **no CDK deploy is needed** — just stop the server, edit `cdk.json`, and start it again:

```bash
task stop-server
# edit cdk.json
task start-server
```

Run `task deploy-instance` afterwards if you also want the launch template updated for future spot relaunches (e.g. after an interruption).

### JVM memory and GC settings

Edit `server-config/jvm-args.txt` — one flag per line:

```
-Xms1G
-Xmx2500M
-XX:+UseG1GC
...
```

**`-Xms`** is the initial heap size (allocated immediately on start). **`-Xmx`** is the maximum. A good rule of thumb: leave at least 1–1.5GB free for the OS and JVM non-heap overhead.

| Instance   | RAM   | Recommended `-Xmx` |
|------------|-------|---------------------|
| t3.medium  | 4 GB  | `2500M`             |
| r5.large   | 16 GB | `12G`               |
| r5.xlarge  | 32 GB | `26G`               |

To apply changes to a running instance: `task sync-mods` (uploads to S3 and pushes to the instance via SSM, no SSH or reboot needed).

## Discord bot

Slash commands (`/start`, `/stop`, `/status`) that work without AWS credentials. See [discord/README.md](discord/README.md) for setup.

## Adding a new bot (e.g. Telegram)

The Discord bot is the reference implementation. The pattern for adding another bot:

1. **Handler Lambda** (`lib/lambda/<platform>-handler.ts`) — validates the incoming webhook from your platform, routes the command
2. **Worker Lambda** (`lib/lambda/<platform>-worker.ts`) — calls `server-management.ts` and sends the reply back to your platform
3. **Stack wiring** (`lib/minecraft-api-stack.ts`) — add the two Lambdas, an API Gateway route, and env vars (bot token, etc.)
4. **Credentials** — add them to `.env.example` and `.env`

The core `lib/lambda/server-management.ts` already handles all EC2 logic — new bots just call it and format the response for their platform. See the Discord handler/worker pair as a working example.

## Architecture

- **EC2 Spot** (`r5.large` default) with **stop** interruption - instance stops, not terminated; EBS data volume is reattached on next boot.
- **Detached EBS gp3** - separate CloudFormation `AWS::EC2::Volume` (size from `cdk.json` `volumeSize`, default 30GB). Minecraft world and server files live under `/opt/minecraft/data` on this volume. Replacing or resizing the instance in CDK does **not** create a new data volume; the same volume is attached each boot.
- **Small root volume** (8GB gp3) on the instance for the OS only.
- **S3** - `config/`, `mods/`, and future `backups/`; `upload-mods.sh` pushes local `server-config/` and `mods/` into the bucket.
- **Route53** - A record updated on **every boot** by the per-boot script (no Elastic IP).
- **Lambda + API Gateway** - start/stop/status logic lives in `lib/lambda/server-management.ts`; bots call this instead of AWS APIs directly. The Discord handler and worker Lambdas are deployed alongside it.
- **IMDSv2** - instance scripts use the metadata token API for instance id, public IP, and region.

## Boot scripts (CDK → EC2)

Infrastructure is TypeScript (`lib/minecraft-stack.ts`); **on the instance** behavior is shell:

| File | When it runs | Role |
|---|---|---|
| `lib/user-data.sh` | First boot only (cloud-init) | Installs jq/nvme-cli/cloudwatch-agent, creates `minecraft` user, writes systemd unit, decodes and installs the per-boot script, runs it once. |
| `lib/per-boot.sh` | Every boot (`/var/lib/cloud/scripts/per-boot/`) | Applies security patches (`dnf update --security`), attaches & mounts the data volume, updates DNS, syncs S3 config/mods, installs Java and server if needed, writes `start.sh`, `systemctl restart minecraft`. |

At synth time, CDK reads both files, substitutes `${BUCKET_NAME}`, `${VOLUME_ID}`, etc., and embeds the per-boot script (base64) into user-data.

## Cost (~eu-central-1)

- 24/7: ~$24–31/month
- Few hours/day: ~$8–14/month

## Next steps
- [ ] Backup world data on shutdown / on a schedule — store in S3 cold storage. A combination of [HBackup](https://www.curseforge.com/minecraft/mc-mods/hbackup) and S3 sync would be ideal.
- [x] Lambda commands to start the server
- [ ] Automatic server shutdown when no players are online
- [ ] On instance start / stop event, trigger lambda to update bot's commands: currently, sending a /start command will just tell you "Instance is terminating"; it would be nice to have an update once the instance is actually terminated "Instance was terminated at 18:04:33". Same for starting.