# npm ci reports adm-zip vulnerabilities

- Category: dependency security
- Severity: high (audit result; exploitability not assessed)
- Found during: isolated worker `npm ci`, 2026-09-25
- Status: open

## Evidence

`npm ci` exited 0 but reported two vulnerabilities: one high and one moderate. `npm audit --json` attributes both to `adm-zip@0.6.0` and its dependent `onnxruntime-node`. The root `package.json` overrides `onnxruntime-node` to use `adm-zip@0.6.0`.

The advisories are [GHSA-vwc7-r8mq-g2x9](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9), for extraction through destination symlinks, and [GHSA-7q85-xj36-vmfc](https://github.com/advisories/GHSA-7q85-xj36-vmfc), for uncontrolled allocation from a declared uncompressed size. The audit reports a fix is available.

## Impact

`onnxruntime-node` uses `adm-zip` during its install script to extract downloaded GPU libraries. No exploit was tested. The install succeeded inside the worker sandbox, but the audit warnings remain.

## Resolution direction

1. Check whether `adm-zip@0.6.1` works with `onnxruntime-node` under the existing override.
2. If it does, bump the override and lockfile, then run the voice tests and an isolated `npm ci`.
