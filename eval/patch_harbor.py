"""Check/patch Harbor's upload_dir bug (idempotent).

The upstream bug: `docker cp source target` copies the directory itself when
`target` already exists, so an agent creating `/tests` corrupts verifier
layout (`/tests/tests/test.sh`). Harbor 0.1.40+ copies `source/.` (contents),
which is the fix; older releases need the string patch.

Usage: python patch_harbor.py   (run inside the adapter venv)
Exits 0 unless manual action is required.
"""

import inspect
import sys

import harbor.environments.docker.docker as m


def main() -> int:
    path = m.__file__
    source = open(path).read()

    if "source_dir}/." in source or "rstrip('/') + '/.'" in source:
        print("    OK: upload_dir copies contents (fixed or patched)")
        return 0

    broken = '''[
                "cp",
                str(source_dir),
                f"main:{target_dir}",
            ],'''
    fixed = '''[
                "cp",
                f"{source_dir}/.",
                f"main:{target_dir}",
            ],'''

    if broken in source:
        open(path, "w").write(source.replace(broken, fixed, 1))
        print("    patch applied")
        return 0

    print("    WARNING: unrecognized upload_dir source; verify manually against")
    print("    https://github.com/badlogic/pi-terminal-bench#required-apply-harbor-fix")
    print(f"    harbor file: {path}")
    return 1


if __name__ == "__main__":
    current = inspect.getsource(m.DockerEnvironment.upload_dir)
    if "source_dir}/." in current or "rstrip('/') + '/.'" in current:
        print("    OK: upload_dir copies contents (fixed or patched)")
        sys.exit(0)
    sys.exit(main())
