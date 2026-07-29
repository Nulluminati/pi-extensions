# Ask User

`ask_user` lets the model pause and collect up to four related decisions in one form. Each question can use a single choice, multiple choices, or free text. Answers are reviewed before they return to the model.

## Use

The model calls the tool when missing information would materially change the work. It should inspect the repository and available documentation first instead of asking for facts it can discover itself.

A request can mix question types:

```json
{
  "questions": [
    {
      "id": "storage",
      "header": "Storage",
      "question": "Where should session state be stored?",
      "context": "The state must follow Pi session branches.",
      "options": [
        {
          "value": "details",
          "label": "Tool result details",
          "description": "Stored on the active session branch.",
          "recommended": true
        },
        {
          "value": "file",
          "label": "Local file",
          "description": "Stored outside the session."
        }
      ]
    },
    {
      "id": "features",
      "header": "Features",
      "question": "Which controls should be included?",
      "multiSelect": true,
      "options": [
        { "value": "review", "label": "Review screen" },
        { "value": "shortcuts", "label": "Keyboard shortcuts" }
      ]
    },
    {
      "id": "name",
      "header": "Name",
      "question": "What should this feature be called?"
    }
  ]
}
```

Do not include an `Other` option. The form adds a custom-answer row to every question.

## Question behavior

- One tool call accepts one to four questions.
- `id` is the stable key returned with the answer.
- `header` is the short label in the question rail.
- Omitting `options` creates a freeform question.
- Omitting `multiSelect` creates a single-select question.
- Multi-select questions accept listed choices and custom text together.
- `recommended: true` moves an option to the front and marks it. It does not preselect the option.
- Every question must be answered before submission. Escape dismisses the whole form.

## Controls

| Key | Action |
|-----|--------|
| Up / Down | Move through options |
| Space | Toggle an option in a multi-select question |
| Enter | Select, confirm, save custom text, or submit the review |
| Tab / Shift+Tab | Move forward or backward, including while editing custom text |
| Left / Right | Move between questions when an option list or review is active |
| Escape | Leave custom input or dismiss the form |

The form uses Pi's configured selection keybindings for navigation, confirmation, and cancellation. Draft custom text is kept when you move to another question.

## Result

Submitted answers use stable option values:

```json
{
  "version": 1,
  "status": "submitted",
  "answers": [
    {
      "questionId": "storage",
      "selectedValues": ["details"]
    },
    {
      "questionId": "features",
      "selectedValues": ["review"],
      "customText": "CSV export"
    }
  ]
}
```

Other statuses are `dismissed`, `aborted`, `unavailable`, and `invalid`. Dismissed, aborted, and unavailable results end the current turn so the user regains control.

Tool result `details` hold the structured answers. Pi stores those details on the active session branch, so no extra state file or custom session entry is needed.

## Runtime modes

- TUI mode shows the tabbed form and review screen.
- RPC mode asks the questions through Pi's standard dialogs, then shows one review confirmation.
- Print and JSON modes return `unavailable` and disable the tool for the rest of that session.

## Pi integration

| API | Purpose |
|-----|---------|
| `pi.registerTool()` | Registers the model-callable `ask_user` tool |
| `executionMode: "sequential"` | Prevents sibling tools from running while the form waits for an answer |
| `ctx.ui.custom()` | Displays the TUI questionnaire |
| `ctx.ui.select()`, `input()`, `confirm()` | Provides the RPC fallback |
| `renderCall`, `renderResult` | Keeps the transcript compact |
