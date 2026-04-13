# aws-maincraift

Minecraft server on AWS Spot EC2 (us-east-1). CDK (TypeScript) for infra; bash scripts for EC2 boot; shell scripts for dev-machine operations. Use `task` (Taskfile.yml) to run everything.

## File Map

| Path | Purpose |
|------|---------|
| `lib/minecraft-stack.ts` | Main CDK stack: EC2, networking, Route53 DNS |
| `lib/minecraft-bucket-stack.ts` | CDK stack: S3 bucket for mods |
| `lib/user-data.sh` | EC2 init script (runs once on first boot) |
| `lib/per-boot.sh` | EC2 boot script (runs on every start) |
| `lib/monitor.sh` | EC2 idle-shutdown monitor: polls RCON, shuts down after inactivity |
| `lib/rcon_query.py` | Minimal RCON client used by monitor.sh (uploaded to S3, pulled at boot) |
| `lib/status_query.py` | EC2 status collector: RCON /list, journal errors/warnings, RAM, disk — outputs JSON (uploaded to S3, pulled at boot) |
| `lib/build-user-data.ts` | Bundles user-data.sh + per-boot.sh + monitor.sh into CDK asset via heredocs |
| `scripts/upload-server.sh` | Download MC server JAR + upload server files (JAR, config, rcon) to S3 |
| `scripts/upload-server-config.sh` | Lightweight: upload server.properties, jvm-args.txt, rcon_query.py, status_query.py to S3 |
| `scripts/upload-mods.sh` | Upload mod JARs and mod configs to S3 |
| `scripts/sync-server.sh` | Sync server files from S3 to running instance via SSM (no restart) |
| `scripts/sync-mods.sh` | Sync mods + mod configs from S3 to running instance via SSM (no restart) |
| `scripts/restart-server.sh` | Restart minecraft.service on instance via SSM (shared by sync tasks) |
| `scripts/start-server.sh` | Invoke `minecraft-server-management` Lambda (start) |
| `scripts/stop-server.sh` | Invoke `minecraft-server-management` Lambda (stop) |
| `scripts/status.sh` | Invoke `minecraft-server-management` Lambda (status) + show bucket |
| `scripts/ssm.sh` | Run a shell command on the instance via SSM and print output |
| `scripts/reset-world.sh` | Delete world folders on running instance via SSM and restart |
| `server-paths.txt` | Gitignored: extra server paths for world reset and backup (relative to server dir) |
| `scripts/deploy-*.sh` | CDK deploy for bucket/instance/api stacks |
| `server-config/config.json` | Server type, MC version, loader version — used locally by upload-server.sh |
| `resources/mods/` | Gitignored: Minecraft mod JARs (uploaded to S3) |
| `resources/mods-config/` | Gitignored: mod config files synced to S3 and deployed to server/config/ on the instance |
| `resources/server/` | Gitignored: jvm-args.txt, server.properties (uploaded to S3 `server/` prefix) |
| `Taskfile.yml` | All runnable tasks — source of truth for workflow |
| `lib/minecraft-api-stack.ts` | CDK stack: API Gateway + Lambda functions |
| `lib/lambda/server-management.ts` | Lambda: EC2 start/stop/status logic — directly invocable |
| `lib/lambda/discord-handler.ts` | Lambda: Ed25519 signature verification + command routing |
| `lib/lambda/discord-worker.ts` | Lambda: calls server-management + posts Discord follow-up |
| `discord/register-commands.ts` | One-time script: registers /start /stop /status with Discord |
| `discord/README.md` | Setup guide: create Discord app, get credentials, deploy |
| `.env.example` | Template for required Discord credentials |

## Rules
- **After any structural refactor** (moving files, renaming scripts, changing stack layout), update the File Map above.
- EC2 boot scripts stay as bash in `lib/`. Dev-machine scripts stay as `.sh` in `scripts/`.
- `start-server.sh`, `stop-server.sh`, `status.sh` delegate to the `minecraft-server-management` Lambda — no direct EC2 calls. Other scripts (`ssm.sh`, `sync-mods.sh`, etc.) still call AWS CLI directly and resolve instanceId/bucketName themselves.
