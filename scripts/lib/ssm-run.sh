#!/bin/bash
# Shared helpers for running shell commands on the instance via SSM Run Command.
# Source this file, then:
#
#   ssm_run <instance-id> <commands-json-array> [timeout-seconds]
#   json_array "cmd 1" "cmd 2" ...     # builds the JSON array for ssm_run
#
# ssm_run prints the command's stdout, prints stderr (if any) to stderr, and
# returns 0 only when the command finished with status Success.

json_array() {
  jq -cn '$ARGS.positional' --args "$@"
}

ssm_run() {
  local instance_id="$1" commands_json="$2" timeout="${3:-900}"
  local command_id status deadline result stdout stderr

  command_id=$(aws ssm send-command \
    --instance-ids "${instance_id}" \
    --document-name "AWS-RunShellScript" \
    --parameters "$(jq -cn --argjson c "${commands_json}" '{commands: $c}')" \
    --query 'Command.CommandId' \
    --output text)

  echo "  SSM command ${command_id} — waiting (up to ${timeout}s)..." >&2
  deadline=$(( $(date +%s) + timeout ))

  while true; do
    status=$(aws ssm get-command-invocation \
      --command-id "${command_id}" \
      --instance-id "${instance_id}" \
      --query 'Status' \
      --output text 2>/dev/null || echo "Pending")

    case "${status}" in
      Success|Failed|Cancelled|TimedOut|DeliveryTimedOut|ExecutionTimedOut) break ;;
    esac

    if (( $(date +%s) >= deadline )); then
      echo "Gave up after ${timeout}s; command ${command_id} is still ${status}." >&2
      return 1
    fi
    sleep 3
  done

  result=$(aws ssm get-command-invocation \
    --command-id "${command_id}" \
    --instance-id "${instance_id}" \
    --output json)
  stdout=$(jq -r '.StandardOutputContent // ""' <<< "${result}")
  stderr=$(jq -r '.StandardErrorContent // ""' <<< "${result}")

  [[ -n "${stdout}" ]] && printf '%s\n' "${stdout}"
  if [[ -n "${stderr}" ]]; then
    echo "--- stderr ---" >&2
    printf '%s\n' "${stderr}" >&2
  fi

  if [[ "${status}" != "Success" ]]; then
    echo "▸ SSM status: ${status}" >&2
    return 1
  fi
}
