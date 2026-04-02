#!/bin/bash
set -euo pipefail

exec > >(tee /var/log/minecraft-setup.log) 2>&1
echo "=== Minecraft one-time setup started at $(date) ==="

# ── 1. Install system packages ───────────────────────────────────
dnf install -y java-17-amazon-corretto-headless jq nvme-cli

# ── 2. Create minecraft user ────────────────────────────────────
MC_USER="minecraft"
MC_HOME="/opt/minecraft"

if ! id "${!MC_USER}" &>/dev/null; then
  useradd -r -m -d "${!MC_HOME}" -s /bin/bash "${!MC_USER}"
fi

# ── 3. Install per-boot script ──────────────────────────────────
mkdir -p /var/lib/cloud/scripts/per-boot
# Per-boot script content, base64-encoded by CDK at deploy time (Fn::Base64(Fn::Sub(...)))
echo "${PER_BOOT_SCRIPT_B64}" | base64 -d > /var/lib/cloud/scripts/per-boot/minecraft-boot.sh
chmod +x /var/lib/cloud/scripts/per-boot/minecraft-boot.sh

# ── 4. Create systemd service ───────────────────────────────────
cat > /etc/systemd/system/minecraft.service <<'UNIT'
[Unit]
Description=Minecraft Server
After=network.target

[Service]
Type=simple
User=minecraft
WorkingDirectory=/opt/minecraft/data/server
ExecStart=/opt/minecraft/data/server/start.sh
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload

# ── 5. Run per-boot script (first boot) ─────────────────────────
/var/lib/cloud/scripts/per-boot/minecraft-boot.sh

echo "=== Minecraft one-time setup completed at $(date) ==="
