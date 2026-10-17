#!/bin/bash
# cloud-init per-boot hook, installed by user-data.sh. Downloads per-boot.sh
# from s3://BUCKET/tools/ and runs it, so boot logic changes never touch the
# launch template. Terminates the instance if it can't get that far.
set -euo pipefail

INSTANCE_ID=""

on_exit() {
  local code=$?
  [[ ${code} -eq 0 ]] && return
  echo "ERROR: Minecraft boot bootstrap failed (exit ${code}) — terminating instance"
  if [[ -n "${INSTANCE_ID}" ]] \
    && aws ec2 terminate-instances --instance-ids "${INSTANCE_ID}" >/dev/null; then
    return
  fi
  shutdown -h now
}
trap on_exit EXIT

TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
imds() {
  curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" \
    "http://169.254.169.254/latest/meta-data/$1"
}
INSTANCE_ID=$(imds instance-id)
AWS_DEFAULT_REGION=$(imds placement/region)
export AWS_DEFAULT_REGION

BUCKET_NAME=$(aws ssm get-parameter --name /minecraft/config/bucket-name \
  --query Parameter.Value --output text)
aws s3 cp "s3://${BUCKET_NAME}/tools/per-boot.sh" /usr/local/sbin/minecraft-per-boot.sh \
  --only-show-errors
chmod 755 /usr/local/sbin/minecraft-per-boot.sh

trap - EXIT
exec /usr/local/sbin/minecraft-per-boot.sh
