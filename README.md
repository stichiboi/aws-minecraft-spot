# aws-maincraift

Modded Minecraft server on AWS — Spot EC2, S3 mod sync, Route53 dynamic DNS, managed with CDK.

## Quick Start

```bash
npm install
# Edit cdk.json context values (instance type, SSH key, domain, etc.)
# Edit server-config/config.json (Forge/Fabric/Vanilla, MC version)
npx cdk bootstrap   # first time only
bash scripts/deploy.sh
```

## Day-to-Day

| Command | What it does |
|---|---|
| `bash scripts/status.sh` | Show instance state, IP, DNS |
| `bash scripts/start-server.sh` | Start a stopped instance |
| `bash scripts/stop-server.sh` | Gracefully stop (EBS preserved) |
| `bash scripts/ssh.sh [key.pem]` | SSH into the server |
| `bash scripts/upload-mods.sh` | Sync `mods/` folder to S3 |
| `bash scripts/deploy.sh` | CDK deploy (idempotent) |
| `bash scripts/destroy.sh` | Tear down the stack |

## Adding Mods

1. Drop `.jar` files into `mods/`
2. `bash scripts/upload-mods.sh`
3. Restart: `bash scripts/stop-server.sh && bash scripts/start-server.sh`

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

Then `bash scripts/deploy.sh` and restart the instance.

## Architecture

- **EC2 Spot** (`r5.large` default) with **stop** interruption behavior — no data loss
- **EBS gp3** 30GB persistent volume
- **S3** for mod storage and future backups
- **Route53** A record updated on every boot (no Elastic IP cost)
- **Dynamic DNS** with 60s TTL — players connect via `minecraft.broccoli-dependence.stichiboi.com`

## Cost (~eu-central-1)

- 24/7: ~$24–31/month
- Few hours/day: ~$8–14/month
