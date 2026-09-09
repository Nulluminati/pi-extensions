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
cd "$(dirname "$0")"

ADAPTER_DIR="pi-terminal-bench"

echo "==> Checking prerequisites"
command -v uv >/dev/null || { echo "ERROR: uv is required (https://docs.astral.sh/uv/)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "ERROR: docker must be installed and running"; exit 1; }

echo "==> Installing Harbor (uv tool)"
uv tool install harbor --force

# Make harbor tools visible even if ~/.local/bin is not on PATH in this shell.
export PATH="$HOME/.local/bin:$PATH"
command -v harbor >/dev/null || { echo "ERROR: harbor not found on PATH after install"; exit 1; }

echo "==> Fetching pi-terminal-bench adapter"
if [ ! -d "$ADAPTER_DIR" ]; then
  git clone --depth 1 https://github.com/badlogic/pi-terminal-bench.git "$ADAPTER_DIR"
else
  echo "    already cloned"
fi

echo "==> Installing adapter (virtualenv)"
cd "$ADAPTER_DIR"
if [ ! -d .venv ]; then
  uv venv
fi
# uv run resolves the project (install -e .[dev] equivalent) on each call.
uv sync --extra dev >/dev/null 2>&1 || uv sync >/dev/null

echo "==> Patching Harbor upload_dir bug (idempotent)"
uv run python - <<'PYEOF'
import harbor.environments.docker.docker as m

p = m.__file__
t = open(p).read()
old = '''    async def upload_dir(self, source_dir: Path | str, target_dir: str):
        await self._run_docker_compose_command(
            [
                "cp",
                str(source_dir),
                f"main:{target_dir}",
            ],
            check=True,
        )'''
new = '''    async def upload_dir(self, source_dir: Path | str, target_dir: str):
        # Append /. to source to copy contents, not the directory itself
        source = str(source_dir).rstrip('/') + '/.'
        await self._run_docker_compose_command(
            [
                "cp",
                str(source),
                f"main:{target_dir}",
            ],
            check=True,
        )'''
if "rstrip('/') + '/.'" in t:
    print("    already patched")
elif old in t:
    open(p, "w").write(t.replace(old, new))
    print("    patch applied")
else:
    print("    WARNING: harbor source changed; apply the upload_dir fix manually")
    print("    (see https://github.com/badlogic/pi-terminal-bench#required-apply-harbor-fix)")
PYEOF

echo "==> Verifying"
uv run python -c "from harbor.environments.docker.docker import DockerEnvironment; import inspect; print('    harbor upload_dir:', 'PATCHED' if 'rstrip' in inspect.getsource(DockerEnvironment.upload_dir) else 'NOT PATCHED')"
uv run python -c "import pi_terminal_bench; print('    adapter import: OK')"

echo
echo "Setup complete. Next:"
echo "  eval/run.sh                     # 12-task subset, glm flash via openrouter"
echo "  eval/run.sh --tasks a,b,c       # specific tasks"
echo "  See eval/README.md for cost notes."
