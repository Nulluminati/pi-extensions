"""Bake the extension suite into the pi-terminal-bench adapter (idempotent).

Patches the adapter's pi_agent.py so that, when PI_TB_SUITE_DIR is set on the
host, the run:
  1. packs extensions/{missions,messenger,agents,autoresearch} + lib/ from
     PI_TB_SUITE_DIR into an in-memory tar.gz (base64) on the host,
  2. extracts it to /opt/suite inside the task container,
  3. loads the four extensions via -e flags on the pi command.

Without PI_TB_SUITE_DIR the adapter behaves exactly like upstream (plain pi).

Usage: python bake_suite.py <adapter-dir>
Exits 0 on success or when already applied.
"""

import sys

MARKER = "PI_TB_SUITE_DIR"


def main(adapter_dir: str) -> int:
    path = f"{adapter_dir}/src/pi_terminal_bench/pi_agent.py"
    src = open(path).read()

    if MARKER in src:
        print("    already applied")
        return 0

    old_commands = '''        return [
            ExecInput(
                command=f"mkdir -p {output_dir}",
                env=env,
            ),
            ExecInput(
                command=(
                    f"pi --print --mode json --session {session_file} "
                    f"{model_args} "
                    f"{escaped_instruction} "
                    f"2>&1 | tee {json_output_file}"
                ),
                env=env,
            ),
        ]'''
    new_commands = '''        # Optional: bake the extension suite into the container.
        # PI_TB_SUITE_DIR points at a repo root containing extensions/ and lib/.
        suite_dir = os.environ.get("PI_TB_SUITE_DIR")
        suite_names = ["missions", "messenger", "agents", "autoresearch"]
        suite_members = [f"extensions/{n}" for n in suite_names] + ["lib"]
        pre_commands: list[ExecInput] = []
        ext_flags = ""
        if suite_dir:
            import base64
            import gzip
            import io
            import tarfile

            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                for member in suite_members:
                    tf.add(os.path.join(suite_dir, member), arcname=member)
            payload = base64.b64encode(buf.getvalue()).decode("ascii")
            pre_commands.append(
                ExecInput(
                    command=(
                        "mkdir -p /opt/suite && "
                        f"echo {payload} | base64 -d | tar -xzf - -C /opt/suite && "
                        "ls /opt/suite/extensions"
                    ),
                    env=env,
                )
            )
            ext_flags = " ".join(
                f"-e /opt/suite/extensions/{n}/{n}.ts" for n in suite_names
            )

        return [
            *pre_commands,
            ExecInput(
                command=f"mkdir -p {output_dir}",
                env=env,
            ),
            ExecInput(
                command=(
                    f"pi --print --mode json --session {session_file} "
                    f"{ext_flags} "
                    f"{model_args} "
                    f"{escaped_instruction} "
                    f"2>&1 | tee {json_output_file}"
                ),
                env=env,
            ),
        ]'''

    if old_commands not in src:
        print("    ERROR: expected create_run_agent_commands block not found;")
        print("    the adapter diverged from the version this patch targets.")
        return 1

    src = src.replace(old_commands, new_commands, 1)
    open(path, "w").write(src)
    print("    suite baking applied (set PI_TB_SUITE_DIR to enable)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
