#!/bin/bash
# Watches SimpleBackups output and uploads new .zip files to s3://$BUCKET_NAME/backups/world/ (flat keys).
# Env: BUCKET_NAME, WATCH_DIR, AWS_DEFAULT_REGION
set -euo pipefail
: "${BUCKET_NAME:?}" "${WATCH_DIR:?}" "${AWS_DEFAULT_REGION:?}"
export AWS_DEFAULT_REGION
DEST="s3://${BUCKET_NAME}/backups/world"
mkdir -p "${WATCH_DIR}"
inotifywait -m -e close_write -e moved_to --format '%w%f' "${WATCH_DIR}" 2>/dev/null | while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  b=$(basename "$f")
  [[ "$b" == *.zip ]] || continue
  aws s3 cp "$f" "${DEST}/${b}"
done
