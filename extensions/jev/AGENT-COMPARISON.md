# Agent-level comparison

The dedicated `jev` tool reduced agent work for short Jev checks in fresh sessions. Both interfaces completed every task correctly. This sample found an efficiency benefit, not a reliability advantage.

For this use case, keeping the dedicated tool is reasonable. Pi's built-in route remains useful when a script combines retrieval, judgments, and filtering.

## Setup

The final batch finished on 2026-10-16 at 04:01 UTC. It used Pi 1.2.0, Node.js v26.9.0, and these models:

| Role | Model | Setting |
| --- | --- | --- |
| Agent | `openai-codex/gpt-6.1-sol` | High thinking |
| Classifier | `typesafe/jev-latest` | Native Pi classifier interface |

Each interface received three tasks, twice, for six attempts per interface. Every attempt used a fresh in-memory Pi agent session. Each task had three claims.

The user prompt, model, thinking level, task data, and limits stayed identical between interfaces. Each interface ran first in three of the six task pairs. Sessions ran sequentially.

The built-in sessions exposed `read` and the real `codemode` tool. Dedicated sessions exposed `read` and the registered `jev` tool. Both could read bundled Pi Markdown documentation. Neither could read source files or credentials through tools. Other extensions, skills, context files, file-write tools, and image generation stayed disabled.

Limits applied equally: six main-model requests, two classifier calls, and 120 seconds per session. Provider retries stayed disabled. Each classifier request had a ten-second timeout. The evaluator requested at most 3,072 output tokens per main-model turn. The largest observed output was 399 tokens. No final-batch attempt reached a limit.

The evaluator set a three-dollar catalog-estimated stopping point. Neither batch reached it. Only synthetic task evidence reached Jev. The main model also received ordinary tool definitions and any Pi documentation it chose to read.

## Shared user instructions

Each prompt contained the following instructions, followed by its evidence and claim map:

```text
Use Jev (typesafe/jev-latest) to check every claim below against only the supplied evidence.
Use each claim ID as its question ID. Classify each claim as supported, contradicted, or insufficient.
Supported means the evidence directly supports the complete claim. Contradicted means the evidence explicitly conflicts with the claim. Insufficient means relevant evidence is missing.
Batch the independent questions in one Jev request when possible. Do not make more than two classifier requests.
Report Jev's labels, not replacement labels from your own judgment. You may add notes about uncertainty.
Return only a JSON object with a verdicts map from each claim ID to its label, and an optional notes array. Do not return Markdown.
```

The agent wrote its own Jev questions or script. Expected labels stayed outside the agent's prompt and readable files.

## Tasks

### Build and tests

```text
Run B-418 used a Fedora Linux runner. The build command exited with status 0.
The unit-test summary reports 11 passed and 1 failed. The failed test is
expired-token.test.ts. The record contains no Windows test results.
```

| Claim ID | Claim | Expected label |
| --- | --- | --- |
| `build_exit_zero` | The build command in run B-418 returned exit status zero. | `supported` |
| `all_unit_tests_passed` | All unit tests in run B-418 passed. | `contradicted` |
| `windows_tests_passed` | The change passed its tests on Windows. | `insufficient` |

The build claim names the command's exit status. It avoids the whole-run ambiguity in the [API-path comparison](COMPARISON.md).

### Retry scope

```text
The release note says: GET requests retry temporary failures with exponential
backoff, with at most three attempts in total. POST requests are never retried.
The included tests cover timeouts and HTTP 503 responses. No latency measurements
are provided.
```

| Claim ID | Claim | Expected label |
| --- | --- | --- |
| `get_retries` | The change retries failed GET requests after a delay that increases between attempts. | `supported` |
| `post_retries` | The change automatically retries POST requests. | `contradicted` |
| `faster_p95` | The change reduced the 95th-percentile response time. | `insufficient` |

### Current version

```text
Two documents describe the same service. Version 1, dated January 1: response
caching is enabled by default. Version 2, dated February 1 and explicitly marked
CURRENT: response caching is disabled by default, and an administrator must
enable it. Neither document reports a security audit.
```

| Claim ID | Claim | Expected label |
| --- | --- | --- |
| `current_cache_disabled` | The current documentation says response caching starts disabled. | `supported` |
| `current_cache_enabled` | The current documentation says response caching is enabled by default. | `contradicted` |
| `audited` | The service passed an independent security audit. | `insufficient` |

## Scoring

A successful attempt needed valid final JSON, a successful Jev Choice answer for every claim, unchanged Jev labels, and all expected labels. Correct answers without a Jev call did not pass.

An attempt passed without recovery when it succeeded with one classifier call and no tool errors. This does not mean one main-model turn.

Offline checks exercised both real agent paths with fixture responses before live calls. They also checked usage accounting, missing Jev use, error recovery, and incorrect-label scoring. Live label mismatches remained result data rather than stopping the comparison.

## Final-batch results

| Measurement | Built-in `codemode` | Dedicated `jev` |
| --- | ---: | ---: |
| Completed tasks | 6/6 | 6/6 |
| Correct claim labels | 18/18 | 18/18 |
| Successful Jev use | 6/6 | 6/6 |
| Attempts without recovery | 6/6 | 6/6 |
| Tool errors | 0 | 0 |
| Main-model requests | 22 | 12 |
| Median main-model requests per task | 4 | 2 |
| Classifier calls | 6 | 6 |
| Median elapsed task time | 11.36 seconds | 8.55 seconds |

Elapsed task time starts at the user prompt and includes model requests and tool execution. It excludes session setup and offline checks.

### Every final-batch pair

Times are milliseconds. Both interfaces returned all three expected labels in every row.

| Task | Repeat | First interface | Built-in requests / time | Dedicated requests / time |
| --- | ---: | --- | ---: | ---: |
| Build and tests | 1 | Built-in | 4 / 9,470 | 2 / 8,001 |
| Retry scope | 1 | Dedicated | 4 / 18,137 | 2 / 8,726 |
| Current version | 1 | Built-in | 4 / 13,020 | 2 / 9,125 |
| Build and tests | 2 | Dedicated | 3 / 9,734 | 2 / 8,372 |
| Retry scope | 2 | Built-in | 3 / 11,009 | 2 / 9,127 |
| Current version | 2 | Dedicated | 4 / 11,704 | 2 / 7,597 |

### Tokens and estimated cost

These totals cover six attempts per interface. Uncached input and cache-read tokens are separate counts.

| Measurement | Built-in `codemode` | Dedicated `jev` |
| --- | ---: | ---: |
| Main-model uncached input tokens | 53,682 | 15,909 |
| Main-model cache-read tokens | 61,312 | 7,680 |
| Main-model output tokens | 2,509 | 2,355 |
| Main-model total tokens | 117,503 | 25,944 |
| Main-model catalog-estimated cost | $0.1385852 | $0.0561360 |
| Jev input tokens | 4,075 | 4,324 |
| Jev output tokens | 836 | 836 |

Pi calculated these costs from catalog prices. They do not establish actual subscription charges or billed amounts. Pi reported zero catalog cost for direct TypeSafe; that does not mean Jev was free.

Jev input counts differ because the agent wrote its own questions in each attempt. This was an agent-workflow comparison, not a replay of identical classifier payloads.

## What caused the extra work

Every built-in attempt read `codemode.md`. Four also read its linked `models.md` page. The agent then wrote a classifier script and returned the result.

Every dedicated attempt called `jev` directly and returned the result. None read documentation. This explains the extra model turns and larger input context through the built-in route.

This is the dedicated tool's concrete use case: short, explicitly requested Jev checks without documentation lookup or script construction in the agent workflow.

## Diagnostic batch and test correction

An earlier batch used the same twelve attempts but permitted reads of only `codemode.md`. Four built-in attempts followed its `models.md` link and hit that restriction. All four recovered. Both interfaces still completed six tasks and returned eighteen correct labels each.

Those four errors came from the evaluator, not Pi. They are not evidence of a built-in reliability defect.

The evaluator then allowed bundled Pi Markdown documentation and checked linked-page access and source-file denial. The entire balanced batch ran again without changing prompts or task data. A protocol check confirmed identical tasks, prompts, model settings, and limits across batches.

| Diagnostic-batch measurement | Built-in | Dedicated |
| --- | ---: | ---: |
| Completed tasks | 6/6 | 6/6 |
| Correct labels | 18/18 | 18/18 |
| Tool errors from documentation policy | 4 | 0 |
| Main-model requests | 22 | 12 |
| Median elapsed task time | 11.97 seconds | 8.12 seconds |
| Main-model catalog-estimated cost | $0.1159088 | $0.0603408 |

Twenty-four live agent attempts and twenty-four classifier calls ran across both batches. The final-batch table is the primary comparison. The diagnostic batch remains visible instead of counting its setup errors against the built-in interface.

## Limits and recommendation

This was a small test of three simple tasks with one agent model. It found no reliability difference and cannot prove equal reliability in other workloads.

The prompt explicitly requested Jev. The test does not establish spontaneous tool discovery or whether an agent chooses Jev appropriately without that instruction.

Fresh sessions had no earlier classifier documentation in context. An agent that already knows the built-in interface may need fewer turns. Provider timing, prompt caching, and connection reuse also affect measurements.

The study did not measure the dedicated tool's schema cost during unrelated work. An extra active tool can add context even when no task uses it.

Keep `jev` for frequent short judgment calls where direct access removes repeated agent work. Use built-in `codemode` for composed workflows or occasional checks when another active tool offers little benefit.

Neither interface improves Jev's judgment quality by itself. Keep uncertainty visible and use tests or human approval when the task requires them.
