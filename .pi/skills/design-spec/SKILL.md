---
name: design-spec
description: Produce a product-design specification for a Pi extension from its source. Reads the extension and extracts the user-facing features, behaviors, lifecycle, and experience — plus the Pi platform integration which Pi APIs it relies on and how they combine into the overall flow. Writes a self-contained spec to docs/specs/ that documents what the extension does as a product, why, and how it hooks into Pi — keeping the platform API vocabulary (the shared contract any reimplementation must use) while dropping the source's internal identifiers, field layouts, verbatim strings, and code structure, so the result guides rather than clones. Use whenever the user asks to spec, design-spec, document, or write up what a Pi extension does — even if they don't use the word "spec".
---

# Design Spec: Product Specification for a Pi Extension

Produce a **product-design specification** from an existing Pi extension: a document that captures what the extension does as a product, the experience it creates, and the reasoning behind it — written so a reader can understand it, redesign it, or build something inspired by it **without ever seeing, or being biased toward, the original source**.

## Core Principle

**Describe the product, not the code.** The spec captures purpose, features, behavior, and experience — the things a user or product designer cares about. It must not carry over anything that belongs to a particular implementation: no function names, no type names, no field names, no constants, no code, no verbatim strings.

The reason this matters: a spec that echoes the source's own vocabulary quietly locks the reader into the original author's choices. They'll re-derive the same functions, the same field layout, the same string wording — a clone in everything but syntax. A product spec frees the reader to find a better way to deliver the same experience, and lets a reviewer evaluate the *design* rather than transcribe it.

**One layer is kept, though: the Pi platform integration.** The spec also records which Pi APIs the extension leans on — the registration calls, lifecycle hooks, the state-persistence and session-reconstruction APIs, UI methods, and any direct model call — and how they chain together into the overall flow. These are not the original author's choices; they are the platform's contract. A reimplementation that delivers the same behavior will hang off the same hooks (there is essentially one way to persist state across reloads in Pi, one way to hand the agent a tool, one way to inject guidance before each turn). Naming that surface tells an implementer the integration contract without telling them how to organize the code beneath it. What stays out is everything *below* the platform surface: the extension's own function and variable names, its internal types and field layouts, its exact messages and thresholds. That lower layer is implementation, and the spec leaves it open.

## When to Use

- Documenting an extension's behavior and purpose for future reference or handoff
- Redesigning or refactoring an extension and wanting a design target before re-implementing
- Capturing what an extension does so someone unfamiliar with the code can understand or critique it
- Writing a forward-looking spec for an extension that will be built (the template works the same way)

## Procedure

### 1. Read the source to understand behavior

Use `read` to load the full extension file (path is usually `extensions/<name>/<name>.ts`; use offset/limit for long files). If it imports shared utilities from `lib/`, read those too — not to document them, but to understand what behaviors they enable (e.g., "it pulls context out of the session history" tells you the extension reasons over past turns).

You're reading to answer: *what is this product, what is it like to use, and which Pi APIs does it lean on to do it?* Not: *what are the internal moving parts?*

### 2. Analyze the product

Work through these lenses. For each, extract the **experience and intent**, not the mechanism:

- **Purpose**: What user problem does this solve? What's painful without it?
- **Concept**: What's the central idea the user holds in their head? (e.g., "a goal you hand the agent that it keeps grinding on until done")
- **User stories**: Who uses it, what do they want, why? The primary job and the secondary ones.
- **Capabilities**: What can the user do? What can the agent now do? What does the extension do on its own? Group by who's acting.
- **Flows**: Walk the primary journey step by step from the user's seat, plus the important alternate paths. What does the user do, and what do they observe at each step?
- **Lifecycle**: What observable states does the core concept move through (e.g., running → paused → done)? What triggers each move, and what's visible in each state?
- **Feedback & visibility**: Status indicators, notifications, confirmations, modal/inline views. What does each communicate, when, and in what tone?
- **Agent influence**: How does it change the agent's behavior — tools the LLM gains, how it steers the agent via system prompts, whether it auto-loops or stops?
- **Pi API surface & flow**: Which Pi platform APIs does this lean on — registration calls (`registerTool` / `registerCommand` / `registerMessageRenderer`), lifecycle hooks (`on`), state persistence (`appendEntry`, `sessionManager.getBranch()`), UI methods (`ui.notify` / `ui.setStatus` / `ui.custom`), or a direct model call (`complete` from pi-ai)? And how do they chain together for the primary flow? The API names are the platform contract — keep them; it's the internal code organization and the source's own identifiers you leave out. This becomes the *Pi API Usage & Flow* section.
- **Constraints & limits**: What guard-rails exist, and *why*? Capture intent and approximate magnitude (e.g., "objectives are capped to keep the prompt lean, roughly a few thousand characters"), never exact named constants.
- **Edge cases & failure modes**: What happens off the happy path — interruption, hitting limits, reloading mid-task, cancelling, unexpected ordering?
- **Design rationale**: Why is it shaped this way and not another way? What trade-offs were made?
- **Non-goals**: What does it deliberately *not* do?

### 3. Write the specification

Create `docs/specs/<name>.md` using the [template below](#specification-template). Create the directory if it doesn't exist. Scale each section to the extension — brief where there's little to say, fuller where the behavior is rich — but keep every section, writing "None" if one genuinely doesn't apply rather than omitting it.

### 4. Review for completeness and leaks

After writing, do two passes:

**Completeness** — walk the spec as a reader who's never seen the source:
- Does every user story have a flow that fulfills it?
- Does the lifecycle account for every way the core concept can start, change, and end?
- Are the failure modes from real situations (reload, cancel, budget hit, conflicting actions)?
- Could someone build a good version of this from the spec alone?
- Does the *Pi API Usage & Flow* section name the platform hooks and trace the primary path through them?

**Leak check** — scan the draft for implementation bleed-through and remove it (see [Leak Detector](#leak-detector)).

## Specification Template

```markdown
# <Extension Name> — Product Specification

> **Status**: Draft | Final
> **Source**: `extensions/<name>/<name>.ts` *(omit for forward-looking specs)*
> **Date**: <YYYY-MM-DD>

## 1. Problem & Motivation

What problem does this solve, and who has it? What's painful without it? One or two paragraphs grounded in the real situation a user faces. This is the "why we built this" — not a feature list.

## 2. Concept

A short, vivid description of the extension as a user would understand it: the one-sentence pitch, then a paragraph of color. Name the central idea — the noun the user holds in their head (e.g., "a side question that doesn't clutter the main conversation").

## 3. User Stories

Jobs-to-be-done from the user's seat: *as a <user>, I want <outcome>, so that <value>*. Lead with the primary job, then the important secondary ones. These drive everything below.

## 4. Capabilities

The feature set, grouped by who acts. Describe each as an ability and its outcome — never as an internal mechanism.

**The user can…**
- <e.g., start a goal with a one-line objective via a slash command>
- <e.g., optionally cap how much the agent spends on the goal with a budget>

**The agent can…** *(capabilities given to the LLM)*
- <e.g., declare the goal complete via a dedicated tool, which ends the auto-continue loop>

**The extension does, in the background…**
- <e.g., survives reloads by remembering the goal across sessions>

## 5. User Flows

Walk the journeys step by step from the user's perspective, like a script someone could follow. Cover the happy path and the most important alternates. At each step, say what the user does *and* what they observe.

**Primary flow: <name>**
1. …
2. …

**Alternate flow: <name>**
1. …

## 6. Lifecycle & States

The observable lifecycle of the core concept (e.g., a goal's journey from set → running → paused → done). Use plain-language state names a user would recognize, and describe what moves it between states and what's visible at each point.

| State | What the user sees | What's happening | What can happen next |
|-------|--------------------|------------------|----------------------|
| Running | a live indicator plus elapsed time | the agent works toward the goal, auto-continuing | paused; completed by the agent; or budget reached |

Keep states to user-visible modes, not internal bookkeeping.

## 7. Feedback & Visibility

Everything the user perceives: status indicators, notifications, confirmations, modal or inline views. Describe the experience and the tone of each — what it communicates and when. Paraphrase messages to convey intent; do not transcribe them.

- **Ongoing status**: <e.g., a persistent status line while a goal runs, showing it's active and how long it's been going>
- **Notifications**: <e.g., a short confirmation when a goal starts, naming the objective; a warning when the budget is reached>
- **Confirmations**: <e.g., starting a new goal when one is already running asks the user to confirm rather than silently replacing it>
- **Modals / inline views**: <e.g., side-question answers appear in a temporary overlay, then disappear without touching the main conversation>

## 8. Agent Influence

How the extension changes the agent's behavior — the part that's specific to AI-agent extensions rather than ordinary tools.

- **Tools gained**: what tools the agent gets, and what each lets it do.
- **System-prompt influence**: how the extension steers the agent — describe the intent and thrust (e.g., "reminds the agent to keep working toward the stated objective and to declare completion when done"), not the literal prompt.
- **Loop control**: e.g., auto-continues the agent after each turn until the goal is done or the budget is hit.

## 9. Pi API Usage & Flow

The platform integration surface this extension relies on: which Pi APIs it calls, what each is for, and how they combine into the overall flow. This tells an implementer the contract the behavior depends on — it is *not* a blueprint for the internal code, and it complements *Agent Influence* (the behavioral effect on the agent) by naming the platform hooks that realize it.

**APIs relied on** *(Pi platform vocabulary — keep these names; they're the shared contract, not the source's identifiers)*:
- **Registration**: e.g., `registerCommand` to expose the slash command the user types; `registerTool` to give the agent its completion/declaration action; `registerMessageRenderer` to hide internal bookkeeping entries from the conversation view.
- **Lifecycle hooks**: e.g., `on("session_start")` to rebuild state after a reload; `on("message_end")` to react to each assistant turn; `on("before_agent_start")` to inject the recurring guidance before each turn.
- **State**: e.g., `appendEntry` to persist the core state across reloads, and `sessionManager.getBranch()` on startup to reconstruct it.
- **UI**: e.g., `ui.notify` for confirmations and warnings; `ui.setStatus` for the persistent status line; `ui.custom` for the modal that collects the user's input.
- **Direct model call**: e.g., `complete` from pi-ai, used for a side query so the answer never enters the main conversation.

**Overall flow**: walk how a single user action — or a lifecycle trigger — moves through these APIs end to end: what fires, in roughly what order, what persistent state changes, and what the user then observes. Stay at the platform-integration level ("the handler persists state, sets a status indicator, then the pre-turn hook injects guidance each turn until the agent calls its completion tool, which clears the status") rather than descending into internal helpers, field mutations, or file organization.

## 10. Constraints & Limits

Behavioral guard-rails and the reasoning behind each. Give intent and approximate magnitude — never exact thresholds or named constants.

- <e.g., objective text is capped (roughly a few thousand characters) so the repeated guidance doesn't bloat context>
- <e.g., budgets are given in plain units like "50k" or "2m" and parsed flexibly>

## 11. Edge Cases & Failure Modes

What happens off the happy path, from the user's point of view: interruption, hitting limits, doing things in an unexpected order, reloading mid-task, cancelling.

- <e.g., if the user reloads mid-goal, the goal survives and resumes>
- <e.g., if a budget is reached mid-run, the agent is nudged to wrap up rather than hard-stopping>
- <e.g., starting a goal while one runs asks for confirmation rather than silently replacing it>

## 12. Design Rationale

The key decisions and the trade-offs behind them. Why this shape and not another? This is where a product spec earns its keep — it captures judgment, not just behavior.

- <e.g., auto-continuation is opt-in via a command rather than always-on, because silent infinite loops erode trust>
- <e.g., side questions bypass the main conversation deliberately, so context isn't polluted by throwaway clarifications>

## 13. Non-Goals & Open Questions

What this extension deliberately does *not* try to do, and questions worth revisiting. Stating non-goals is as important as stating goals — it prevents scope creep and clarifies intent.

- <e.g., does not coordinate multiple concurrent goals — one at a time, by design>
- <e.g., open question: should the agent be able to revise the objective mid-run?>
```

## Leak Detector

Run this against the draft before finishing. Each is a sign the spec has drifted from "product" back into "code in prose."

- **The extension's own identifiers.** Any function, variable, type, interface, field, or custom entry-type name that the source *itself* defines. These are the surest leak — they pull a future implementer toward the original structure. Rewrite that behavior in plain English. (This does **not** cover Pi platform API names like `registerTool`, `appendEntry`, or `on("session_start")` — those are the platform contract and are kept, but only in the *Pi API Usage & Flow* section.)
- **Code of any kind.** No code fences. No `interface`, `type`, `const`, `function`, `=>`, JSON, or schema blocks. If you can't say it in prose or a plain table, you're describing the wrong layer.
- **Exact string transcription.** Notification messages, error text, prompt wording quoted verbatim. These are artifacts of one implementation. Paraphrase to capture intent and tone instead.
- **Exact numeric thresholds presented as the spec.** "4000 character max" becomes "capped at a few thousand characters to keep the prompt lean." State the *why* and the *order of magnitude*, not the literal the code happens to use.
- **Internal state fields.** Bookkeeping like elapsed-milliseconds, baseline token counts, or iteration counters isn't a product fact. Describe what the user *observes* (elapsed time shown as "5m"), not how it's stored.

The one exception is **user-facing command vocabulary** — the words the user actually types, like `/goal pause`, are part of the product surface (like a button label) and belong in the spec. Inline backticks for short things the user types are fine. When in doubt, describe the capability rather than name the symbol.

A second exception is **Pi platform API names** in the *Pi API Usage & Flow* section. Names like `registerTool`, `appendEntry`, `on("session_start")`, `ui.custom`, and `complete` are the platform's shared contract — not the source's internal identifiers — so any reimplementation delivering the same behavior must use the same hooks. Naming them there guides rather than clones. Keep them in that section only, each attached to what it's used for; don't let them spill into the product/behavioral sections, where the platform-agnostic description should stand on its own.

## Rules

### MUST

1. **Read the full source first** (and any `lib/` it imports) so you understand the real behavior before writing. Use `read` with offset/limit for long files.
2. **Lead with purpose and experience.** Every spec opens with the problem and the concept. A reader who stops after section 2 should already know what this product is.
3. **Describe behaviors, flows, and states from the user's seat.** Write what the user does and what they observe — not what handlers execute or what fields mutate.
4. **Give the *why* for limits and decisions** (sections 10 and 12). The intent and the trade-off matter more than the exact value.
5. **Cover edge cases as user-facing failure modes** (section 11): reload, cancel, budget hit, conflicting actions, interruption.
6. **Paraphrase every user-facing message** to convey intent and tone. Never transcribe.
7. **Keep all thirteen sections**, writing "None" where one genuinely doesn't apply, so the structure stays scannable and complete.
8. **Document the Pi platform integration in *Pi API Usage & Flow*** — name the Pi APIs the extension relies on (registration, lifecycle hooks, state, UI, direct model calls) and narrate how they chain together for the primary flow. These names are the platform contract, not the source's identifiers, so keeping them is correct.
9. **Write to `docs/specs/<name>.md`**, creating the directory if needed.
10. **Run the Leak Detector** before finishing. If any leak remains, rewrite that part.

### MUST NOT

1. **No identifiers the source defines itself** — its internal function names, variable names, type names, interface names, field names, and custom entry-type strings. (Pi platform API names like `registerTool` and `appendEntry` are the exception: they're the platform contract, kept in the *Pi API Usage & Flow* section.) This is the whole point of the skill; everything else follows from it.
2. **No code.** No code fences, no TypeScript, no JSON schemas, no arrow functions. The spec is prose and tables.
3. **No verbatim strings** from the source — notifications, errors, prompts, system-prompt text. Paraphrase.
4. **No exact named constants or literal thresholds** (`MAX_OBJECTIVE_LENGTH`, `4000`, `8000`). Describe intent and rough magnitude with rationale.
5. **No internal state representation.** No field-by-field layouts, no "the state has an `elapsedMs` field." Describe observable modes and what the user perceives.
6. **No tool-result JSON shapes** (`content`/`details`/`terminate` layouts). Describe what the tool accomplishes for the user or agent.
7. **No internal implementation architecture or naming guidance** (which internal state strategy to use, which helpers to write, how to organize the file). Those are implementation choices the spec deliberately leaves open. (Documenting the Pi *platform* API surface in *Pi API Usage & Flow* is different — that's the contract the behavior depends on, not internal architecture.)
8. **No placeholders or "TODO" sections.** Every section gets real content or an explicit "None."
