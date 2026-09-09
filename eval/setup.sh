#!/usr/bin/env bash
# One-time setup for Terminal-Bench evaluation with the pi coding agent.
#
# Installs:
#   1. Harbor (the official Terminal-Bench harness) via uv tool
#   2. badlogic/pi-terminal-bench (Harbor agent adapter for pi) into eval/pi-terminal-bench
#   3. A documented fix for Harbor's upload_dir bug (breaks verifiers when the
#      agent creates a /tests directory — see pi-terminal-bench README)
#
# Idempotent: safe to re-run. Requires: uv, docker (running), git.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ADAPTER_DIR="pi-terminal-bench"

echo "==> Checking prerequisites"
command -v uv >/dev/null || { echo "ERROR: uv is required (https://docs.astral.sh/uv/)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "ERROR: docker must be installed and running"; exit 1; }

echo "==> Fetching pi-terminal-bench adapter"
if [ ! -d "$ADAPTER_DIR" ]; then
  git clone --depth 1 https://github.com/badlogic/pi-terminal-bench.git "$ADAPTER_DIR"
else
  echo "    already cloned"
fi

# Adapter fix: symlink pi into /usr/local/bin so the trial shell finds it
# (npm-installed pi lives under nvm's node bin dir, off PATH at run time).
TEMPLATE="$ADAPTER_DIR/src/pi_terminal_bench/install-pi.sh.j2"
if ! grep -q '/usr/local/bin/pi' "$TEMPLATE"; then
  sed -i 's|# Verify installation|ln -sf "$(npm prefix -g)/bin/pi" /usr/local/bin/pi\n\n# Verify installation|' "$TEMPLATE"
  echo "    adapter template patched (pi symlink)"
fi

echo "==> Installing adapter (virtualenv)"
cd "$ADAPTER_DIR"
# Harbor is pinned to the 0.1.x line: the adapter targets its API
# (ExecInput etc.); newer 0.2x CLI versions removed those symbols.
if [ ! -d .venv ]; then
  uv venv --python 3.13
fi
uv pip install -e ".[dev]" "harbor==0.1.45" >/dev/null
VENV_PY="$PWD/.venv/bin/python"

echo "==> Checking Harbor upload_dir (verifier corruption bug)"
"$VENV_PY" "$SCRIPT_DIR/patch_harbor.py"
RET=$?
if [ "$RET" -ne 0 ]; then echo "    setup incomplete (see above)"; exit "$RET"; fi

echo "==> Verifying"
"$VENV_PY" -c "from harbor.environments.docker.docker import DockerEnvironment; import inspect; src = inspect.getsource(DockerEnvironment.upload_dir); print('    harbor upload_dir:', 'OK (contents-copy)' if ('source_dir}/.' in src or 'rstrip' in src) else 'NEEDS PATCH')"
"$VENV_PY" -c "from pi_terminal_bench.pi_agent import PiAgent; print('    adapter import: OK')"
"$PWD/.venv/bin/harbor" --version | sed 's/^/    harbor /' 

echo
echo "Setup complete. Next:"
echo "  eval/run.sh                     # 12-task subset, glm flash via openrouter"
echo "  eval/run.sh --tasks a,b,c       # specific tasks"
echo "  See eval/README.md for cost notes."
