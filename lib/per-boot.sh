#!/bin/bash
# Full boot logic for the Minecraft instance. Fetched from s3://BUCKET/tools/
# by boot-bootstrap.sh on every boot, so changes only need an upload
# (`task upload-server-config`, also run by deploy-instance).
#
# Any failure uploads this log to s3://BUCKET/logs/boot-failures/ and
# terminates the instance: without the idle monitor it would run forever.
set -euo pipefail

MC_USER="minecraft"
MC_HOME="/opt/minecraft"
MC_DATA="${MC_HOME}/data"
SERVER_DIR="${MC_DATA}/server"
MODS_DIR="${SERVER_DIR}/mods"
BOOT_LOG="/var/log/minecraft-boot.log"
NOTIFY="${MC_HOME}/notify.sh"

exec > >(tee -a "${BOOT_LOG}") 2>&1
echo "=== Minecraft per-boot script started at $(date) ==="

TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
imds() {
  curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" \
    "http://169.254.169.254/latest/meta-data/$1"
}
INSTANCE_ID=$(imds instance-id)
PUBLIC_IP=$(imds public-ipv4)
REGION=$(imds placement/region)
export AWS_DEFAULT_REGION="${REGION}"

BUCKET_NAME=""

terminate_self() {
  aws ec2 terminate-instances --instance-ids "${INSTANCE_ID}" >/dev/null \
    || shutdown -h now
}

notify() {
  [[ -x "${NOTIFY}" ]] && "${NOTIFY}" "$1" || true
}

on_exit() {
  local code=$?
  [[ ${code} -eq 0 ]] && return
  echo "ERROR: per-boot failed (exit ${code}) — terminating ${INSTANCE_ID}"
  local where="see ${BOOT_LOG} (instance is gone)"
  if [[ -n "${BUCKET_NAME}" ]]; then
    local key="logs/boot-failures/$(date -u +%Y%m%dT%H%M%SZ)-${INSTANCE_ID}.log"
    aws s3 cp "${BOOT_LOG}" "s3://${BUCKET_NAME}/${key}" --only-show-errors \
      && where="s3://${BUCKET_NAME}/${key}"
  fi
  notify "❌ **Server failed to boot** — instance terminated. Boot log: \`${where}\`"
  terminate_self
}
trap on_exit EXIT

# ── Config from SSM ───────────────────────────────────────────────
CFG=$(aws ssm get-parameters-by-path --path /minecraft/config \
  --query 'Parameters[*].[Name,Value]' --output text)
get_param() {
  awk -v n="/minecraft/config/$1" '$1 == n { print $2 }' <<< "${CFG}"
}

BUCKET_NAME=$(get_param bucket-name)
VOLUME_ID=$(get_param volume-id)
HOSTED_ZONE_ID=$(get_param hosted-zone-id)
FQDN=$(get_param fqdn)
MINECRAFT_PORT=$(get_param port)
SHUTDOWN_TIMER=$(get_param shutdown-timer)
MANAGEMENT_FUNCTION=$(get_param management-function)
JAVA_VERSION=$(get_param java-version)
JAVA_VERSION="${JAVA_VERSION:-21}"

# ── User + tools ──────────────────────────────────────────────────
if ! id "${MC_USER}" &>/dev/null; then
  useradd -r -m -d "${MC_HOME}" -s /bin/bash "${MC_USER}"
fi
mkdir -p /etc/minecraft

# Everything in tools/ except the server launcher and this script lands in
# /opt/minecraft/ (paths the Lambdas and systemd units rely on).
aws s3 cp "s3://${BUCKET_NAME}/tools/" "${MC_HOME}/" --recursive --only-show-errors \
  --exclude "start.sh" --exclude "per-boot.sh"
chmod 755 "${MC_HOME}"/*.sh "${MC_HOME}"/*.py

# ── Packages (the AMI is the latest AL2023 at launch, so no dnf update) ──
dnf install -y nvme-cli inotify-tools "java-${JAVA_VERSION}-amazon-corretto-headless"

# ── Data volume ───────────────────────────────────────────────────
read -r ATTACHED_TO ATTACH_STATE < <(aws ec2 describe-volumes \
  --volume-ids "${VOLUME_ID}" \
  --query 'Volumes[0].Attachments[0].[InstanceId,State]' \
  --output text) || true

if [[ "${ATTACHED_TO:-None}" == "${INSTANCE_ID}" ]]; then
  echo "Volume ${VOLUME_ID} already attached."
else
  if [[ "${ATTACH_STATE:-}" == "detaching" ]]; then
    echo "Volume ${VOLUME_ID} is detaching from ${ATTACHED_TO} — waiting..."
    aws ec2 wait volume-available --volume-ids "${VOLUME_ID}"
  elif [[ "${ATTACHED_TO:-None}" != "None" ]]; then
    echo "Volume ${VOLUME_ID} is in use by ${ATTACHED_TO} — this is a duplicate instance."
    notify "⚠️ A second server instance started while \`${ATTACHED_TO}\` holds the world volume — terminating the duplicate \`${INSTANCE_ID}\`."
    terminate_self
    exit 0
  fi
  echo "Attaching volume ${VOLUME_ID} to ${INSTANCE_ID}..."
  aws ec2 attach-volume \
    --volume-id "${VOLUME_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --device /dev/sdf
  aws ec2 wait volume-in-use --volume-ids "${VOLUME_ID}"
  sleep 5
fi

# Nitro instances remap /dev/sdf to /dev/nvme*n1; find via volume serial
VOLUME_ID_CLEAN="${VOLUME_ID//-/}"
REAL_DEVICE=""

for attempt in $(seq 1 30); do
  for link in /dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_*; do
    if [[ -e "${link}" && "$(basename "${link}")" == *"${VOLUME_ID_CLEAN}"* ]]; then
      REAL_DEVICE=$(readlink -f "${link}")
      break 2
    fi
  done
  for dev in /dev/sdf /dev/xvdf; do
    if [[ -b "${dev}" ]]; then
      REAL_DEVICE="${dev}"
      break 2
    fi
  done
  sleep 2
done

if [[ -z "${REAL_DEVICE}" ]]; then
  echo "ERROR: Could not find block device for volume ${VOLUME_ID} after 60s"
  exit 1
fi

echo "Data volume device: ${REAL_DEVICE}"

if ! blkid -o value -s TYPE "${REAL_DEVICE}" &>/dev/null; then
  echo "New volume — formatting as xfs..."
  mkfs.xfs "${REAL_DEVICE}"
fi

mkdir -p "${MC_DATA}"
if ! mountpoint -q "${MC_DATA}"; then
  mount "${REAL_DEVICE}" "${MC_DATA}"
  echo "Mounted ${REAL_DEVICE} at ${MC_DATA}"
fi

mkdir -p "${SERVER_DIR}" "${MODS_DIR}" "${SERVER_DIR}/config" \
  "${SERVER_DIR}/world/datapacks" \
  "${SERVER_DIR}/simplebackups/world"

# ── DNS ───────────────────────────────────────────────────────────
echo "Updating DNS: ${FQDN} -> ${PUBLIC_IP}"
aws route53 change-resource-record-sets \
  --hosted-zone-id "${HOSTED_ZONE_ID}" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"${FQDN}\",
        \"Type\": \"A\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"${PUBLIC_IP}\"}]
      }
    }]
  }"

# ── Server files from S3 ──────────────────────────────────────────
aws s3 cp "s3://${BUCKET_NAME}/server/jvm-args.txt" "${SERVER_DIR}/jvm-args.txt" \
  || : > "${SERVER_DIR}/jvm-args.txt"

aws s3 cp "s3://${BUCKET_NAME}/server/server.properties" "${SERVER_DIR}/server.properties" \
  || true

echo "Syncing server files from S3..."
# libraries/ is mirrored (--delete) so loader upgrades drop old jars without
# re-downloading the unchanged ones; the rest must not delete local files.
aws s3 sync "s3://${BUCKET_NAME}/server-bin/libraries/" "${SERVER_DIR}/libraries/" \
  --delete --only-show-errors
aws s3 sync "s3://${BUCKET_NAME}/server-bin/" "${SERVER_DIR}/" --only-show-errors \
  --exclude "libraries/*" --exclude "mods/*" --exclude "world/*" --exclude "config/*"

aws s3 sync "s3://${BUCKET_NAME}/mods/" "${MODS_DIR}/" --delete --only-show-errors
aws s3 sync "s3://${BUCKET_NAME}/mods-config/" "${SERVER_DIR}/config/" --delete --only-show-errors
aws s3 sync "s3://${BUCKET_NAME}/datapacks/" "${SERVER_DIR}/world/datapacks/" --delete --only-show-errors

aws s3 cp "s3://${BUCKET_NAME}/tools/start.sh" "${SERVER_DIR}/start.sh"
chmod +x "${SERVER_DIR}/start.sh"

echo "eula=true" > "${SERVER_DIR}/eula.txt"

if [[ ! -f "${SERVER_DIR}/server.properties" ]]; then
  cat > "${SERVER_DIR}/server.properties" <<PROPS
server-port=${MINECRAFT_PORT}
enable-rcon=false
motd=Maincraift - powered by AWS Spot
max-players=10
view-distance=12
simulation-distance=10
PROPS
fi

sed -i "s/^server-port=.*/server-port=${MINECRAFT_PORT}/" "${SERVER_DIR}/server.properties"

cat > /etc/minecraft/instance.env <<ENV
INSTANCE_ID=${INSTANCE_ID}
PUBLIC_IP=${PUBLIC_IP}
REGION=${REGION}
AWS_DEFAULT_REGION=${REGION}
BUCKET_NAME=${BUCKET_NAME}
VOLUME_ID=${VOLUME_ID}
HOSTED_ZONE_ID=${HOSTED_ZONE_ID}
FQDN=${FQDN}
MINECRAFT_PORT=${MINECRAFT_PORT}
SHUTDOWN_TIMER=${SHUTDOWN_TIMER}
MANAGEMENT_FUNCTION=${MANAGEMENT_FUNCTION}
JAVA_VERSION=${JAVA_VERSION}
MC_DATA=${MC_DATA}
SERVER_DIR=${SERVER_DIR}
MODS_DIR=${MODS_DIR}
WATCH_DIR=${SERVER_DIR}/simplebackups/world
MC_USER=${MC_USER}
ENV
chmod 644 /etc/minecraft/instance.env

chown -R "${MC_USER}:${MC_USER}" "${MC_DATA}"

# ── systemd units ─────────────────────────────────────────────────
# minecraft.target groups every unit that runs with the server. Boot and
# /restart both restart the target; to add a unit, list it in Wants= and After=
# below and give it PartOf=minecraft.target. Stopping for termination
# (graceful-shutdown.sh) stops only minecraft.service so the idle monitor keeps
# watching; see README "Restart vs stop on the instance".
# Wants=, not Requires=: with Requires=, `systemctl stop minecraft.service`
# (what graceful-shutdown.sh runs) would stop the target and, through PartOf=,
# every other member, including the spot watcher running that script.
# After= makes `systemctl restart minecraft.target` return only once members are
# back up. Stop order is the reverse of After=, so the idle monitor stops before
# the game process and does not see the gap as a crash.
cat > /etc/systemd/system/minecraft.target <<'UNIT'
[Unit]
Description=Minecraft server
Wants=minecraft.service minecraft-monitor.service spot-termination-watch.service simplebackups-s3-watcher.service
After=minecraft.service minecraft-monitor.service spot-termination-watch.service simplebackups-s3-watcher.service
UNIT

cat > /etc/systemd/system/minecraft.service <<'UNIT'
[Unit]
Description=Minecraft Server
After=network.target
PartOf=minecraft.target

[Service]
Type=simple
User=minecraft
WorkingDirectory=/opt/minecraft/data/server
ExecStart=/opt/minecraft/data/server/start.sh
# "-" so a failed RCON attempt still lets systemd SIGTERM the JVM.
ExecStop=-/opt/minecraft/rcon-stop.sh
Restart=on-failure
RestartSec=10
# RCON stop exits 0; SIGTERM exits 143. Covers rcon-stop.sh plus the save.
SuccessExitStatus=143
TimeoutStopSec=120
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/minecraft-monitor.service <<'UNIT'
[Unit]
Description=Minecraft idle shutdown monitor
After=minecraft.service
PartOf=minecraft.target

[Service]
Type=simple
User=root
EnvironmentFile=/etc/minecraft/instance.env
ExecStart=/opt/minecraft/monitor.sh
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/spot-termination-watch.service <<'UNIT'
[Unit]
Description=Spot instance termination notice watcher
After=network-online.target minecraft.service
PartOf=minecraft.target

[Service]
Type=simple
User=root
EnvironmentFile=/etc/minecraft/instance.env
ExecStart=/opt/minecraft/spot-termination-watch.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/simplebackups-s3-watcher.service <<'UNIT'
[Unit]
Description=Upload SimpleBackups zips to S3
After=network-online.target
PartOf=minecraft.target
ConditionPathIsMountPoint=/opt/minecraft/data

[Service]
Type=simple
User=minecraft
EnvironmentFile=-/etc/minecraft/instance.env
ExecStart=/opt/minecraft/simplebackups-s3-watcher.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable minecraft-monitor.service spot-termination-watch.service \
  simplebackups-s3-watcher.service

systemctl restart minecraft.target

echo "=== Minecraft per-boot script completed at $(date) ==="
