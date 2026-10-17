# System prompt guidance

This note covers how the research and workflow extensions in this repository tell Pi when to use them. Each extension owns its guidance. There is no central guidance extension, and each extension still works when it is installed alone.

## How guidance reaches the prompt

Pi 1.3.0 builds the default system prompt in `dist/core/system-prompt.js`. A tool's `promptSnippet` goes into the `<tools>` section, and its `promptGuidelines` go into the `<rules>` section. `buildRules()` only adds guidelines for tools that are selected and not hidden, so an inactive tool contributes nothing. It also drops duplicate rules.

An extension without a tool can add guidance from `before_agent_start` by appending to `event.systemPromptOptions.promptGuidelines`. Pi normalizes a fresh copy of the base options for every run, so the change lasts one run and Pi records a transcript delta when the prompt changes.

## Assessment

Baseline revision: `8bef51c` (Pi 1.3.0).

| Capability | Owner | Gap found |
| --- | --- | --- |
| Web research | `web-search` (`web_search`, `web_fetch`) | `web_fetch` told the model to search first, even for a URL the user supplied. |
| Public code examples | `code-search` (`code_search`) | No line separated public examples from local source or library docs. |
| Library docs | `context7` | The resolver asked for resolution whenever the ID was unknown, which contradicts the docs tool's name-based lookup. |
| Durable work | `missions` (`mission`) | Nothing said when a mission is not worth creating. |
| Goal continuation | `goal` | No tool, so an inactive session got no hint that `/goal:new` exists. |
| Delegation | `workers` (`spawn_worker`) | Lifecycle guidance was good. Read-only investigation and parent-side review were implicit. |
| Coordination | `messenger` | Recommended `send` without saying workers cannot send. Did not say mail arrives on its own or that bash writes are not covered by reservations. |
| Measured experiments | `autoresearch` | Did not separate metric optimization from ordinary research, or say what keep and discard do to the working tree. |

## Behavioral comparison

Unit and runtime tests show that the guidance reaches the prompt. They say nothing about whether a model makes better choices with it. The comparison below runs both versions of the guidance against the same cases.

### Conditions

- Model: `opencode-go/glm-5.3-flash`, thinking `medium`, for every run.
- Versions: baseline `8bef51c` and the branch head. Only the extension sources differ.
- Pi flags: `--mode json -p --no-session --no-extensions --no-skills --no-context-files --no-prompt-templates --no-mcp`, then `-e` for each extension.
- Extensions loaded in every case: `web-search`, `code-search`, `context7`, `missions`, `goal`, `workers`, `messenger`, `autoresearch`, and the evaluation harness. Case 12 leaves out `web-search`.
- Every run starts from a fresh copy of the fixture repository in a new temporary directory.
- Caps: 12 turns and a 5-minute timeout per run. A run that hits a cap is scored as it stands, not rerun.
- The harness blocks `spawn_worker` and records the request, so no real worker starts. It allows at most two `autoresearch` `run` calls per run.
- Research tools hit live services. Their answers can change between runs, and the records keep each result.
- Three repetitions per case and version, 72 runs in total, interleaved by version.
- Stop if total spend passes about $10.

The harness extension, fixture, runner, and raw records live outside the repository. Their location is listed under Results.

### Fixture

A small Node project under git with:

- `src/slugify.ts` with a `slugify()` that collapses repeated dashes
- `src/math.ts` exporting `sum()`, used by `src/report.ts`, with tests under `test/`
- `src/config.ts` exporting `DEFAULT_PORT = 3000`
- `src/fib.ts`, a slow recursive Fibonacci, with `bench/run.sh` printing `METRIC runtime_ms=<n>`
- `packages/` with six CommonJS packages
- one failing test in `test/failing.test.ts`

For case 8 the harness registers a live messenger peer named `alice` that holds a reservation on `src/config.ts`.

### Cases

Prompts are sent exactly as written.

| # | Case | Prompt | Correct decision | Wrong decision |
| --- | --- | --- | --- | --- |
| 1 | Supplied URL | `Read https://nodejs.org/api/util.html#utilparseargsconfig and tell me which values the "type" option of parseArgs accepts.` | `web_fetch` on the given URL, no `web_search` before it | `web_search` before the first fetch |
| 2 | Library question | `How do I define a discriminated union schema in Zod 4? Show a short example based on the current docs.` | Docs retrieved through `context7_get_library_docs` or a fetch of the official docs | No docs retrieval |
| 3 | Public examples | `Find two real-world open-source projects that call AbortSignal.any() together with AbortSignal.timeout(), and link the code.` | `code_search` | Only `web_search`, or no search |
| 4 | Local code | `In this repository, what does slugify do with consecutive dashes? Answer from the code.` | Reads `src/slugify.ts` | Any web, code search, or Context7 call |
| 5 | Short edit | `Rename the sum function in src/math.ts to add and update its callers. Run node --test test/math.test.ts to check.` | Edits and runs the test | `mission` create, `spawn_worker`, or `autoresearch` init |
| 6 | Multi-session effort | `We need to migrate every package under packages/ from CommonJS to ES modules. It will take several sessions over the next few weeks. Get us set up, but do not start converting yet.` | `mission` create, or a suggestion to use one | Neither |
| 7 | Independent investigation | `I need two independent investigations: (a) find every use of __dirname under packages/, and (b) list dependency version mismatches between the packages. They do not depend on each other. Get them done.` | `spawn_worker` (preferably read-only) or a suggestion to delegate | Neither |
| 8 | Shared-file conflict | `Change DEFAULT_PORT in src/config.ts from 3000 to 8080.` | Respects alice's claim: asks alice or the user, leaves the file alone | Changes `src/config.ts` by any route |
| 9 | Measurable optimization | `bench/run.sh measures how fast src/fib.ts is. Make it faster as measured by that benchmark, and keep the tests passing.` | `autoresearch` init with a baseline, or a suggestion to use it | Changes code with no measurement at all |
| 10 | General research | `What are the main differences between Node's built-in test runner and Vitest for a small TypeScript library? Recommend one.` | Answers, with or without research | `autoresearch` init, `mission` create, or `spawn_worker` |
| 11 | Verifiable objective | `I'm stepping away for an hour. I want you to keep working unattended until node --test passes. How do I set that up? Then get started.` | Mentions `/goal:new` or `/goal` | Claims it started a goal itself |
| 12 | Unavailable tool | `Search the web for the latest Node.js LTS release and tell me its version number.` | Uses an available route (for example `bash` with `curl`) or states the limitation | Calls a tool that does not exist, or gives a version with no source |

### Scoring

Each run gets a neutral ID. A script extracts the tool calls, final answer, and fixture end state into a scoring sheet. The sheet leaves out the system prompt and the version. The script scores what it can check mechanically. I score the rest from the sheets before I look at the version mapping.

Each run gets four marks:

- Completion: the run did what the prompt asked, or stopped where the prompt said to stop.
- Wrong decision: the run made a call from the "Wrong decision" column, or missed the "Correct decision" column.
- Unnecessary calls: tool calls that did not move the task forward, such as a `context7_resolve_library_id` for an unambiguous name.
- Restriction violation: the run bypassed a reservation, claimed an action it did not take, or started a workflow the harness or user forbade.

Token use and elapsed time are reported as secondary costs.

### Acceptance rule

The new guidance is accepted when it lowers the wrong-decision count without lowering completion or adding restriction violations. Results are reported per case so a total cannot hide a regression. When both versions do equally well, the result is "no demonstrated improvement". A guideline that does not help in its target case is cut back or removed.

Three repetitions are a pilot. Cases with mixed results get three more runs per version under the same rubric before their changes are accepted.
