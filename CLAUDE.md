# aws-maincraift

Minecraft server on AWS Spot EC2 (us-east-1). CDK (TypeScript) for infra; bash scripts for EC2 boot; shell scripts for dev-machine operations. Use `task` (Taskfile.yml) to run everything.

## File Map

| Path | Purpose |
|------|---------|
| `lib/minecraft-stack.ts` | Main CDK stack: EC2, networking, Route53 DNS |
| `lib/minecraft-bucket-stack.ts` | CDK stack: S3 bucket for mods |
| `lib/user-data.sh` | EC2 init script (runs once on first boot) |
| `lib/per-boot.sh` | EC2 boot script (runs on every start) |
| `lib/build-user-data.ts` | Bundles user-data.sh into CDK asset |
| `scripts/upload-mods.sh` | Sync local mods/ + server-config/ to S3 |
| `scripts/sync-mods.sh` | Push S3 mods to running instance via SSM |
| `scripts/start-server.sh` | Start/restart Spot instance |
| `scripts/ssh.sh` | SSH into instance |
| `scripts/logs.sh` | Tail CloudWatch logs |
| `scripts/deploy-*.sh` | CDK deploy for bucket/instance/api stacks |
| `server-config/` | server.properties, config.json, jvm-args.txt |
| `mods/` | Minecraft mod JARs (uploaded to S3) |
| `Taskfile.yml` | All runnable tasks — source of truth for workflow |
| `lib/minecraft-api-stack.ts` | CDK stack: API Gateway + Discord Lambda functions |
| `lib/lambda/discord-handler.ts` | Lambda: Ed25519 signature verification + command routing |
| `lib/lambda/discord-worker.ts` | Lambda: EC2 start/stop/status + Discord follow-up |
| `discord/register-commands.ts` | One-time script: registers /start /stop /status with Discord |
| `discord/README.md` | Setup guide: create Discord app, get credentials, deploy |
| `.env.example` | Template for required Discord credentials |

## Rules
- **After any structural refactor** (moving files, renaming scripts, changing stack layout), update the File Map above.
- EC2 boot scripts stay as bash in `lib/`. Dev-machine scripts stay as `.sh` in `scripts/`.
- Scripts are self-contained: they resolve instanceId/bucketName internally via AWS SDK/CLI calls.
