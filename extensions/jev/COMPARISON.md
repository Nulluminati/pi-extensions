# Built-in versus dedicated Jev access

Pi already provides Jev access through `codemode` and its classifier registry. The `jev` extension adds a direct tool, not another model capability.

For evidence checks, the built-in route is sufficient. Keep the extension only if direct access and its extra validation justify another tool. This comparison found no accuracy or Jev token-usage advantage for the extension.

## Method

The comparison ran on 2026-10-16 at 03:22 UTC with Pi 1.2.0 and Node.js v26.9.0.

1. Load the real built-in `codemode` tool and the repository's `jev` extension.
2. Check both execution paths against identical offline fixture answers and usage.
3. Call `typesafe/jev-latest` through each route with identical synthetic evidence and questions.
4. Record answers, reported tokens, request count, and elapsed tool-execution time.

Both routes used the same native Pi registry and configured credentials. The built-in route executed JavaScript in Pi's actual QuickJS sandbox. The dedicated route executed the registered `jev` tool. Neither route called the main language model.

The completed pair ran the built-in route first. Each route made one HTTP request. An earlier built-in-only call also ran; its result appears below. The experiment therefore made three live classifier calls in total.

Only the synthetic evidence and questions below reached TypeSafe. The experiment sent no source files, conversation history, or secrets in the model input.

## Evidence and questions

```text
Run B-417 used a Fedora Linux runner. The build command exited with status 0.
The unit-test summary reports 11 passed and 1 failed. The failed test is
expired-token.test.ts. This record contains no results from other platforms.
```

Each question used this instruction prefix: `Judge this claim using only the evidence in state:`

| Question | Claim | Expected label |
| --- | --- | --- |
| `build_success` | Build B-417 completed successfully. | `supported` |
| `clean_tests` | The unit-test suite in run B-417 passed without failures. | `contradicted` |
| `windows_success` | The change passed its tests on Windows. | `insufficient` |

All three Choice questions used the same criteria:

```json
{
  "supported": "The evidence directly supports the complete claim.",
  "contradicted": "The evidence explicitly conflicts with the claim.",
  "insufficient": "The evidence neither supports nor contradicts the claim; relevant information is missing."
}
```

The expected build label treats build-command success separately from test success. However, "Build B-417" can also mean the complete run. That wording limits any accuracy conclusion. The observed result is disagreement with our expected label, not proof of an unambiguous model error.

## Results

| Measurement | Built-in `codemode` | Dedicated `jev` |
| --- | ---: | ---: |
| Labels matching the expected labels | 2/3 | 2/3 |
| Classifier input tokens | 646 | 646 |
| Classifier output tokens | 138 | 138 |
| HTTP requests | 1 | 1 |
| Elapsed tool-execution time | 322 ms | 79 ms |
| Elapsed registry-call time | 152 ms | 77 ms |
| Tool-input characters | 1,779 | 1,492 |
| Model-facing result characters | 693 | 659 |

The registry-call time includes authentication, transport, and response handling. Tool time also includes route-specific execution overhead. Initial imports, credential setup, and offline checks ran before these measurements.

The character counts describe these particular arguments and returned text. They are not main-model token counts. The experiment did not measure tool-schema overhead, agent reasoning, or script-authoring cost.

Pi reported zero catalog cost for both requests. That does not establish free service usage or the actual billed amount.

### Returned judgments

| Question | Built-in label / confidence | Dedicated label / confidence |
| --- | --- | --- |
| `build_success` | `contradicted` / 0.52 | `contradicted` / 0.58 |
| `clean_tests` | `contradicted` / 1.00 | `contradicted` / 1.00 |
| `windows_success` | `insufficient` / 0.92 | `insufficient` / 0.91 |

For the build question, the built-in distribution was `supported: 0.26`, `contradicted: 0.68`, and `insufficient: 0.06`. The dedicated distribution was `supported: 0.21`, `contradicted: 0.72`, and `insufficient: 0.07`.

The dedicated tool accepted that answer because it was structurally valid. Its response checks cannot establish factual correctness.

The initial built-in-only call returned the same labels: `contradicted`, `contradicted`, and `insufficient`. The transient comparison script asserted semantic correctness and stopped before running the dedicated route. That assertion was a script error: unexpected judgments must remain comparison data. After correcting the script, the completed pair above ran. Timing and usage from the initial call were not saved. Its label disagreement remains part of these findings.

## What the comparison establishes

Both routes can perform the same batched evidence check. They return equivalent answer types and account for the same classifier tokens. The dedicated tool does not inherently make Jev more accurate or cheaper.

The dedicated route avoids a script sandbox and requires less calling code. Its fixed limits and response checks apply without a caller-written script. The built-in route can combine retrieval, classification, and filtering inside one script without another extension.

One completed pair cannot establish typical speed, accuracy, or reliability. Call order and connection reuse can affect timing. Three questions do not represent a broader workload.

The experiment also does not establish which route an agent discovers or uses more reliably. That needs separate agent-level testing.

## Recommendation

Use built-in `codemode` as the default for composed workflows. Treat `jev` as an optional convenience tool for direct calls and consistent response checks.

Keep judgment quality separate from interface quality. Define narrow claims, test representative examples, and preserve uncertainty. Neither route replaces test execution or human approval.
