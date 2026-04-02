#!/usr/bin/env bash
# List or terminate EC2 instances linked to this stack but not the stack's
# current InstanceId (e.g. unnamed leftovers after a failed replacement).
#
# Candidates are the union of instances matching ANY of:
#   - tag Name=INSTANCE_TAG_NAME (default MinecraftServer)
#   - tag aws:cloudformation:stack-name=STACK_NAME
#   - tag aws:ec2launchtemplate:id = stack's LaunchTemplate physical id
#   - security group = stack SecurityGroup whose logical id contains ServerSg
#
# Default: dry-run. Use --execute to terminate; use --yes to skip the prompt.
set -euo pipefail

STACK_NAME="${STACK_NAME:-MinecraftServer}"
TAG_NAME="${INSTANCE_TAG_NAME:-MinecraftServer}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--execute] [--yes]

  Finds instances in the current AWS region that look like this stack's
  servers (see header comment), except the stack output InstanceId.

  Default       Dry-run: print current instance and any orphans only.
  --execute     Call terminate-instances for orphan IDs.
  --yes         With --execute, skip the confirmation prompt.

  Env: STACK_NAME (default ${STACK_NAME}), INSTANCE_TAG_NAME (default ${TAG_NAME})

  The stack's security group filter uses LogicalResourceId matching *ServerSg*
  (this project's CDK construct). Override discovery only by forking the script
  if you renamed that construct.
EOF
  exit 0
}

EXECUTE=0
YES=0
for arg in "$@"; do
  case "${arg}" in
    --execute) EXECUTE=1 ;;
    --yes) YES=1 ;;
    -h | --help) usage ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

# Append line-separated instance ids from AWS CLI tab/space output.
append_instance_ids() {
  tr '\t\n' ' ' | tr -s ' ' '\n' | grep -E '^i-[0-9a-f]+$' >>"${TMP}" || true
}

stack_exists() {
  aws cloudformation describe-stacks --stack-name "${STACK_NAME}" &>/dev/null
}

if ! stack_exists; then
  echo "Stack '${STACK_NAME}' does not exist; cannot resolve current InstanceId." >&2
  exit 1
fi

CURRENT_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)

if [[ -z "${CURRENT_ID}" || "${CURRENT_ID}" == "None" ]]; then
  echo "Could not read InstanceId from stack outputs." >&2
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "${TMP}"' EXIT

STATE_FILTER="Name=instance-state-name,Values=pending,running,stopping,stopped"

# 1) Name tag (same as CDK cdk.Tags.of(instance).add("Name", ...))
aws ec2 describe-instances \
  --filters \
    "Name=tag:Name,Values=${TAG_NAME}" \
    "${STATE_FILTER}" \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text 2>/dev/null | append_instance_ids

# 2) CloudFormation stack tag (often still present on failed replacements)
aws ec2 describe-instances \
  --filters \
    "Name=tag:aws:cloudformation:stack-name,Values=${STACK_NAME}" \
    "${STATE_FILTER}" \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text 2>/dev/null | append_instance_ids

# 3) Launch template id from stack (unnamed instances usually keep this tag)
LT_PHYSICAL=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK_NAME}" \
  --query 'StackResources[?ResourceType==`AWS::EC2::LaunchTemplate`].PhysicalResourceId' \
  --output text 2>/dev/null | awk 'NF { print $1; exit }')
if [[ -n "${LT_PHYSICAL}" ]]; then
  aws ec2 describe-instances \
    --filters \
      "Name=tag:aws:ec2launchtemplate:id,Values=${LT_PHYSICAL}" \
      "${STATE_FILTER}" \
    --query 'Reservations[].Instances[].InstanceId' \
    --output text 2>/dev/null | append_instance_ids
fi

# 4) Server security group from stack (matches *ServerSg* logical id)
while read -r sg_id; do
  [[ -z "${sg_id}" ]] && continue
  aws ec2 describe-instances \
    --filters \
      "Name=instance.group-id,Values=${sg_id}" \
      "${STATE_FILTER}" \
    --query 'Reservations[].Instances[].InstanceId' \
    --output text 2>/dev/null | append_instance_ids
done < <(
  aws cloudformation describe-stack-resources \
    --stack-name "${STACK_NAME}" \
    --query 'StackResources[?ResourceType==`AWS::EC2::SecurityGroup`].[LogicalResourceId,PhysicalResourceId]' \
    --output text 2>/dev/null | awk '$1 ~ /ServerSg/ { print $2 }'
)

ORPHANS=()
while read -r id; do
  [[ -z "${id}" || "${id}" == "${CURRENT_ID}" ]] && continue
  ORPHANS+=("${id}")
done < <(sort -u "${TMP}")

echo "Stack: ${STACK_NAME}"
echo "Current instance (keep): ${CURRENT_ID}"
if [[ -n "${LT_PHYSICAL:-}" ]]; then
  echo "Stack launch template: ${LT_PHYSICAL}"
fi

if [[ ${#ORPHANS[@]} -eq 0 ]]; then
  echo "No orphan instances (stack-linked signals, excluding current ID)."
  exit 0
fi

echo "Orphan instance(s):"
printf '  %s\n' "${ORPHANS[@]}"

if [[ "${EXECUTE}" -eq 0 ]]; then
  echo ""
  echo "Dry-run only. Re-run with --execute to terminate these instances."
  exit 0
fi

if [[ "${YES}" -eq 0 ]]; then
  read -r -p "Terminate ${#ORPHANS[@]} orphan instance(s)? [y/N] " reply
  if [[ ! "${reply}" =~ ^[yY](es)?$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

aws ec2 terminate-instances --instance-ids "${ORPHANS[@]}"
echo "TerminateInstances requested for: ${ORPHANS[*]}"
