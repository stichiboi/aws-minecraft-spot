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

| Command             | What it does                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `task rcon`         | Runs an `rcon` command on the minecraft server. Use this to add a player to the operator list `task rcon -- "op Stichiboi"` |
| `task status`       | Instance state, public IP, DNS name, S3 bucket                                                                              |
| `task start-server` | Launch a new spot instance via EC2 Fleet; it attaches the data volume and starts Minecraft on boot                         |
| `task stop-server`  | Save the world, stop Minecraft and terminate the instance; the data volume is detached and kept                            |
| `task ssm`          | runs an SSM command on the EC2 instance                                                                                     |
| `task upload-mods`  | Sync local `resources/` (mods, config, server settings) to S3                                                               |
| `task deploy`       | Full deploy: bucket → upload → server → API → status                                                                        |
| `task set-discord-webhook -- <url>` | Post server lifecycle events to a Discord channel (see [Notifications](#notifications))          |
| `task destroy`      | Stops the server and destroys all stacks — **the S3 bucket is deleted; the data volume leaves a final EBS snapshot**       |

## The `resources/` directory

All server-specific files live under `resources/` at the project root. The entire directory is **gitignored** and every subdirectory is **optional** — scripts skip missing folders gracefully.

```
resources/
  mods/                 # Minecraft mod JARs (.jar)
  mods-config/          # Mod config files (.toml, .json, .cfg, etc.)
  datapacks/            # Minecraft data packs (.zip)
  server/               # jvm-args.txt, server.properties
```

Create whatever subdirectories you need:

```bash
mkdir -p resources/mods resources/mods-config resources/datapacks resources/server
```

## Adding Mods

1. Put `.jar` files in `resources/mods/`.
2. `task sync-mods` — uploads to S3 and syncs to the running instance via SSM, then restarts the server (no SSH needed).

Or to apply on next boot only (e.g. the server is offline): `task upload-mods`.

### Mod Configuration

Put mod config files (`.toml`, `.json`, `.cfg`, etc.) in `resources/mods-config/`. These are synced to `s3://BUCKET/mods-config/` and land at `/opt/minecraft/data/server/config/` on the instance — the standard mod config directory, sibling to `mods/`.

The sync uses `--delete`, so S3 (and therefore the instance) always mirrors your local `resources/mods-config/` folder exactly. If the folder doesn't exist locally, the upload step is skipped silently.

## Adding Data Packs

1. Put `.zip` files in `resources/datapacks/`.
2. `task sync-mods` — uploads to S3 and syncs to the running instance via SSM, then restarts the server.

Or to apply on next boot only: `task upload-mods`.

Data packs are synced to `s3://BUCKET/datapacks/` and land at `/opt/minecraft/data/server/world/datapacks/` on the instance — the standard Minecraft data pack directory inside the world folder. The sync uses `--delete`, so S3 always mirrors your local `resources/datapacks/` exactly.

## Customizing the Server

### Launcher type and Minecraft version

Edit `server-config/config.json`:

```json
{
  "type": "neoforge", // "vanilla", "forge", "neoforge", or "fabric"
  "mcVersion": "1.21.1",
  "loaderVersion": "21.1.222" // omit or leave empty for vanilla/fabric without a specific loader version
}
```

Then run `task upload-server` to download and upload the new server binary to S3, and restart the instance (`task stop-server` + `task start-server`).

### Java version

Set `javaVersion` in `cdk.json` context (default `"21"`):

```json
{
  "context": {
    "javaVersion": "21"
  }
}
```

This is pushed to SSM Parameter Store on deploy. The per-boot script reads it from SSM and installs the matching Amazon Corretto version. To change Java version, edit `cdk.json` and run `task deploy-instance`.

### Instance types (EC2 Fleet)

The server uses an **EC2 Fleet** (`instant` type, `price-capacity-optimized` spot allocation) to launch from a list of instance types. This reduces "no spot capacity" failures and interruptions by letting AWS pick the cheapest type among those with deep spare capacity.

Edit `instanceTypes` in `cdk.json`:

```json
{
  "context": {
    "amazonLinuxCpuType": "ARM_64",
    "instanceTypes": ["m7g.xlarge", "m6g.xlarge", "m7g.large", "m6g.large"]
  }
}
```

All types in the list **must share the same CPU architecture** — the AMI is built for one arch only. For Graviton (ARM) types (`m7g.*`, `m6g.*`, `c7g.*`, `r7g.*`), set `"amazonLinuxCpuType": "ARM_64"`. For x86 types, use `"X86_64"`.

After editing, run `task deploy SKIP_UPLOADS=true` to update both the launch template (used as the fleet's base) and the Lambda environment variable. The Lambda reads the list at runtime and passes all types as fleet overrides.

The launch template resolves the latest Amazon Linux 2023 AMI at launch time, so every start boots a patched OS without a redeploy.

### JVM memory and GC settings

The heap is sized automatically: `start.sh` passes `-Xms`/`-Xmx` set to **70% of the instance's RAM**, so it scales with whichever instance type the fleet picks. Override the percentage with a `HEAP_PERCENT` environment variable (systemd drop-in via `systemctl edit minecraft`), or pin a fixed heap by adding `-Xmx` (and `-Xms`) to `resources/server/jvm-args.txt` — an explicit `-Xmx` there disables auto-sizing.

Put GC and other flags in `resources/server/jvm-args.txt`, one per line:

```
-XX:+UseG1GC
...
```

To apply changes to a running instance: `task sync-server` (uploads to S3 and pushes to the instance via SSM, then restarts Minecraft).

## RCON

Run in-game console commands from your dev machine via SSM (no SSH, no exposed ports).

```bash
task rcon -- 'list'         # show online players
task rcon -- 'op [username]'  # make a player an operator
```

RCON runs on `localhost:25575` inside the instance — the security group never opens this port. The password (`password`) is not a real secret; the only path to RCON is through SSM, which requires AWS credentials. Commands go through `rcon_query.py`, which the instance pulls from S3 `tools/` at boot.

If RCON is disabled in `server.properties`, the idle monitor falls back to counting established TCP connections on the game port.


## Budget

**Monthly budget alert** — set `budgetEmail` (and optionally `monthlyBudgetUsd`, default 15) in `cdk.json` and run `task deploy-instance`. AWS Budgets emails you at 80% of actual spend and when the forecast exceeds 100%. Leave `budgetEmail` empty to skip it.

## Discord bot

Slash commands that work without AWS credentials. See [discord/README.md](discord/README.md) for setup, and [discord/register-commands.ts](discord/register-commands.ts) for the command list and help.

### Notifications

**Discord channel notifications** — the instance posts to a Discord channel webhook when the server is ready, idle-stops, stops unexpectedly, receives a spot reclaim notice, or fails to boot. Create a webhook in Discord (channel → *Edit Channel* → *Integrations* → *Webhooks*), then:

```bash
task set-discord-webhook -- 'https://discord.com/api/webhooks/...'
task set-discord-webhook -- --delete   # turn notifications off
```

The URL is stored as an SSM SecureString (`/minecraft/secrets/discord-webhook-url`) and read on each event, so no redeploy is needed. Without it, notifications are silently skipped.


## Adding a new bot (e.g. Telegram)

The Discord bot is the reference implementation. The pattern for adding another bot:

1. **Handler Lambda** (`lib/lambda/<platform>-handler.ts`) — validates the incoming webhook from your platform, routes the command
2. **Worker Lambda** (`lib/lambda/<platform>-worker.ts`) — calls `server-management.ts` and sends the reply back to your platform
3. **Stack wiring** (`lib/minecraft-api-stack.ts`) — add the two Lambdas, an API Gateway route, and env vars (bot token, etc.)
4. **Credentials** — add them to `.env.example` and `.env`

The core `lib/lambda/server-management.ts` already handles all EC2 logic — new bots just call it and format the response for their platform. See the Discord handler/worker pair as a working example.

## Architecture

- **EC2 Fleet** (spot, `price-capacity-optimized`) — the Lambda creates an `instant` fleet with multiple instance type overrides from `cdk.json`. Instances exist only while the server is running: they are terminated on stop, and the EBS data volume is reattached on next boot. CloudFormation manages the launch template, not an instance.
- **Detached EBS gp3** - separate CloudFormation `AWS::EC2::Volume` (size from `cdk.json` `volumeSize`; grow it online with `aws ec2 modify-volume` + `xfs_growfs`). Minecraft world and server files live under `/opt/minecraft/data` on this volume. If the volume is ever replaced or the stack destroyed, CloudFormation takes a final snapshot first (RemovalPolicy SNAPSHOT).
- **Small root volume** (8GB gp3) on the instance for the OS only.
- **S3** - `server/`, `mods/`, `mods-config/`, `server-bin/`, `tools/`; `upload-mods.sh` pushes local `resources/` into the bucket.
- **Route53** - A record updated on **every boot** by the per-boot script (no Elastic IP).
- **Lambda + API Gateway** - command logic lives in `lib/lambda/server-management.ts`; bots call this instead of AWS APIs directly. The Discord handler and worker Lambdas are deployed alongside it.
- **IMDSv2** - instance scripts use the metadata token API for instance id, public IP, and region.

## Boot scripts (CDK → EC2)

Infrastructure is TypeScript (`lib/minecraft-stack.ts`); **on the instance** behavior is shell:

| File                    | When it runs                         | Role                                                                                                                                                                                       |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/user-data.sh`      | First boot (cloud-init user-data)    | Installs `boot-bootstrap.sh` as a cloud-init per-boot hook and runs it once.                                                                                                              |
| `lib/boot-bootstrap.sh` | Every boot (embedded in user-data)   | Downloads `per-boot.sh` from S3 `tools/` and runs it. Terminates the instance if it can't.                                                                                                 |
| `lib/per-boot.sh`       | Every boot (fetched from S3)         | Reads config from SSM, installs Java, pulls the other `tools/` scripts, attaches & mounts the data volume, updates DNS, syncs server files/mods from S3, writes the systemd units, starts Minecraft. |

Only the small bootstrap is baked into the launch template. Everything else lives in S3 `tools/` (uploaded by `task upload-server-config`, which `task deploy-instance` runs), so script changes apply on the next start without replacing the launch template.

### Restart vs stop on the instance

`per-boot.sh` puts every service that runs with the server (the game, the idle monitor, the spot watcher, the backup watcher) under one systemd target, `minecraft.target`. Restarting the server and stopping it touch different units on purpose:

| Action | What it runs | Idle monitor |
| --- | --- | --- |
| Boot, `/restart`, `task sync-*` | `systemctl restart minecraft.target` | Stopped before the game, started again after it |
| `task reset-world` | `systemctl stop minecraft.target`, then `start` | Same: stopped first, started again after the game |
| `/stop`, spot reclaim (`graceful-shutdown.sh`) | Writes `/run/minecraft-graceful-shutdown`, then `systemctl stop minecraft.service` | Keeps running |

**Why restart uses the target.** The idle monitor reads "game is down" as a crash and terminates the instance. Restarting the target stops the monitor before the game and starts it again after, so a restart never trips it. No script has to remember which helper services to pause: a new service joins by adding `PartOf=minecraft.target` and one line on the target.

**Why stop leaves the monitor running.** When the instance is going away, the monitor is the safety net. It sees the game stop, finds the fresh marker file, and waits for the stop Lambda to terminate the instance. If the instance is still alive 5 minutes later, it calls the stop Lambda again, so a failed termination can't leave a spot instance billing. Stopping the target here would also stop the spot watcher, the process that runs `graceful-shutdown.sh` during a reclaim.

**Why the target uses `Wants=`, not `Requires=`.** With `Requires=`, stopping `minecraft.service` on its own would stop the target and, through `PartOf=`, every other service. The stop path above depends on that not happening.

Both paths save the world the same way: `minecraft.service` has `ExecStop=rcon-stop.sh` (RCON `save-all`, then `stop`), and SIGTERM is the fallback if RCON is unavailable.

If `per-boot.sh` fails, it uploads its log to `s3://BUCKET/logs/boot-failures/`, posts a Discord notification (if configured) and terminates the instance, so a broken boot never keeps a spot instance running.

## Cost (~eu-central-1)

- 24/7: ~$24–31/month
- Few hours/day: ~$8–14/month

## Next steps

- [x] Backup world data on shutdown / on a schedule — store in S3 cold storage. A combination of [Backup Mods](https://modrinth.com/mod/simple-backups) and S3 sync would be ideal.
- [x] Lambda commands to start the server
- [x] Automatic server shutdown when no players are online
- [x] Lifecycle notifications (ready / idle stop / spot reclaim / boot failure) posted to a Discord channel webhook
