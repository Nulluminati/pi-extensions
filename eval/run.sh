#!/usr/bin/env bash
# Run Terminal-Bench 2.0 tasks with the pi coding agent.
#
# Usage:
#   eval/run.sh [--model provider/model] [--tasks id1,id2,...] [--trials N] [--jobs N] [--oracle]
#
# Defaults: 12-task curated subset, openrouter/~z-ai/glm-flash-latest, 1 trial,
# 3 parallel jobs. Requires eval/setup.sh to have been run and
# OPENROUTER_API_KEY (or the provider key for your chosen model) in the env.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

MODEL="openrouter/~z-ai/glm-flash-latest"
# Default: the curated subset in tasks-subset.txt (NOT the full 89-task set).
TASKS="$(grep -v '^#' "$SCRIPT_DIR/tasks-subset.txt" | grep -v '^$' | tr '\n' ',' | sed 's/,$//')"

TRIALS=1
JOBS=3
ORACLE=0
SUITE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --tasks) TASKS="$2"; shift 2 ;;
    --trials) TRIALS="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --oracle) ORACLE=1; shift ;;
    --suite) SUITE=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

HARBOR="$PWD/pi-terminal-bench/.venv/bin/harbor"
[ -x "$HARBOR" ] || { echo "ERROR: run eval/setup.sh first"; exit 1; }

if [ "$ORACLE" -eq 0 ] && [ -z "${OPENROUTER_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: no provider API key in env (OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY)"
  exit 1
fi

TASK_ARGS=()
if [ -n "$TASKS" ]; then
  IFS=',' read -ra IDS <<< "$TASKS"
  for id in "${IDS[@]}"; do TASK_ARGS+=(-t "$id"); done
fi

AGENT_ARGS=()
if [ "$ORACLE" -eq 1 ]; then
  echo "==> Oracle smoke run (no LLM cost)"
  AGENT_ARGS=(-a oracle)
else
  echo "==> Agent: pi ($MODEL)$([ "$SUITE" -eq 1 ] && echo ' + extension suite baked')"
  AGENT_ARGS=(--agent-import-path pi_terminal_bench:PiAgent -m "$MODEL")
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
TAG=""; [ "$SUITE" -eq 1 ] && TAG="-suite"
JOBS_DIR="results/${STAMP}${TAG}"
mkdir -p "$JOBS_DIR"
if [ "$SUITE" -eq 1 ]; then
  # Repo root = parent of eval/
  export PI_TB_SUITE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

cd pi-terminal-bench
echo "==> harbor run -> ../$JOBS_DIR"
"$HARBOR" run \
  -d terminal-bench@2.0 \
  "${AGENT_ARGS[@]}" \
  "${TASK_ARGS[@]+"${TASK_ARGS[@]}"}" \
  -k "$TRIALS" \
  -n "$JOBS" \
  --jobs-dir "../$JOBS_DIR"

echo
echo "==> Done. Results in eval/$JOBS_DIR"
echo "    Summary:  uv run harbor show-trial --job-dir ../$JOBS_DIR/<trial>"
echo "    Compare:  see eval/README.md for the results parser."
