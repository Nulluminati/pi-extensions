import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { modalContentWidth, renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { type AskUserAnswer, type AskUserQuestion, normalizeCustomText } from "./schema.ts";

interface QuestionnaireTui {
  requestRender(): void;
}

interface QuestionnaireTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  bg?(color: string, text: string): string;
}

interface QuestionnaireKeybindings {
  matches(data: string, keybinding: string): boolean;
}

interface AnswerState {
  cursorIndex: number;
  selectedValues: string[];
  customText: string | undefined;
  confirmed: boolean;
}

export interface QuestionnaireState {
  currentIndex: number;
  answers: AnswerState[];
  editingQuestionIndex: number | undefined;
  canSubmit: boolean;
}

export type QuestionnaireAction =
  | { type: "move"; delta: -1 | 1 }
  | { type: "toggle"; optionIndex: number }
  | { type: "selectSingle"; optionIndex: number }
  | { type: "startCustom" }
  | { type: "saveCustom"; value: string }
  | { type: "saveDraft"; value: string }
  | { type: "cancelCustom" }
  | { type: "confirmMulti" }
  | { type: "goTo"; questionIndex: number };

export type QuestionnaireOutcome =
  | { status: "submitted"; answers: AskUserAnswer[] }
  | { status: "dismissed" }
  | { status: "aborted" };

export function createQuestionnaireState(questions: AskUserQuestion[]): QuestionnaireState {
  const answers = questions.map<AnswerState>(() => ({
    cursorIndex: 0,
    selectedValues: [],
    customText: undefined,
    confirmed: false,
  }));
  return {
    currentIndex: 0,
    answers,
    editingQuestionIndex: questions[0]?.options ? undefined : 0,
    canSubmit: false,
  };
}

export function reduceQuestionnaire(
  state: QuestionnaireState,
  action: QuestionnaireAction,
  questions: AskUserQuestion[],
): QuestionnaireState {
  const question = questions[state.currentIndex];
  const answer = state.answers[state.currentIndex];

  switch (action.type) {
    case "goTo":
      return withDerivedState(
        {
          ...state,
          currentIndex: clamp(action.questionIndex, 0, questions.length),
          editingQuestionIndex:
            action.questionIndex < questions.length && !questions[action.questionIndex]?.options
              ? action.questionIndex
              : undefined,
        },
        questions,
      );
    case "move": {
      if (!question || !answer) return state;
      const itemCount = (question.options?.length ?? 0) + 1;
      const cursorIndex = clamp(answer.cursorIndex + action.delta, 0, Math.max(0, itemCount - 1));
      return updateCurrentAnswer(state, questions, (current) => ({
        ...current,
        cursorIndex,
      }));
    }
    case "toggle": {
      const option = question?.options?.[action.optionIndex];
      if (!question?.multiSelect || !option) return state;
      return updateCurrentAnswer(state, questions, (current) => ({
        ...current,
        cursorIndex: action.optionIndex,
        selectedValues: current.selectedValues.includes(option.value)
          ? current.selectedValues.filter((value) => value !== option.value)
          : [...current.selectedValues, option.value],
        confirmed: false,
      }));
    }
    case "selectSingle": {
      const option = question?.options?.[action.optionIndex];
      if (!question || question.multiSelect || !option) return state;
      const selected = updateCurrentAnswer(state, questions, (current) => ({
        ...current,
        cursorIndex: action.optionIndex,
        selectedValues: [option.value],
        customText: undefined,
        confirmed: true,
      }));
      return advance(selected, questions);
    }
    case "startCustom":
      if (!question) return state;
      return { ...state, editingQuestionIndex: state.currentIndex };
    case "cancelCustom":
      return { ...state, editingQuestionIndex: undefined };
    case "saveDraft": {
      if (!question || !answer) return state;
      const drafted = updateCurrentAnswer(state, questions, (current) => ({
        ...current,
        selectedValues: question.multiSelect ? current.selectedValues : [],
        customText: normalizeCustomText(action.value),
        confirmed: false,
      }));
      return { ...drafted, editingQuestionIndex: undefined };
    }
    case "saveCustom": {
      if (!question || !answer) return state;
      const customText = normalizeCustomText(action.value);
      const saved = updateCurrentAnswer(state, questions, (current) => ({
        ...current,
        selectedValues: question.multiSelect ? current.selectedValues : [],
        customText,
        confirmed:
          Boolean(customText) ||
          (question.multiSelect === true && current.selectedValues.length > 0),
      }));
      const withoutEditor = { ...saved, editingQuestionIndex: undefined };
      return withoutEditor.answers[state.currentIndex]?.confirmed
        ? advance(withoutEditor, questions)
        : withoutEditor;
    }
    case "confirmMulti": {
      if (!question?.multiSelect || !answer) return state;
      if (answer.selectedValues.length === 0 && !answer.customText) return state;
      const confirmed = updateCurrentAnswer(state, questions, (current) => ({
        ...current,
        confirmed: true,
      }));
      return advance(confirmed, questions);
    }
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export function toSubmittedAnswers(
  questions: AskUserQuestion[],
  state: QuestionnaireState,
): AskUserAnswer[] {
  return questions.flatMap((question, index) => {
    const answer = state.answers[index];
    if (!answer?.confirmed) return [];
    return [
      {
        questionId: question.id,
        selectedValues: [...answer.selectedValues],
        ...(answer.customText ? { customText: answer.customText } : {}),
      },
    ];
  });
}

export class QuestionnaireComponent {
  private readonly questions: AskUserQuestion[];
  private readonly tui: QuestionnaireTui;
  private readonly theme: QuestionnaireTheme;
  private readonly keybindings: QuestionnaireKeybindings;
  private readonly done: (outcome: QuestionnaireOutcome) => void;
  private readonly input = new Input();
  private state: QuestionnaireState;
  private settled = false;
  private _focused = false;

  constructor(options: {
    questions: AskUserQuestion[];
    tui: QuestionnaireTui;
    theme: QuestionnaireTheme;
    keybindings: QuestionnaireKeybindings;
    done(outcome: QuestionnaireOutcome): void;
  }) {
    this.questions = options.questions;
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.done = options.done;
    this.state = createQuestionnaireState(options.questions);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.state.editingQuestionIndex !== undefined;
  }

  render(width: number): string[] {
    const frameWidth = Math.max(0, Math.floor(width));
    if (frameWidth === 0) return [];
    const contentWidth = modalContentWidth(frameWidth);
    const body = [this.renderProgress(contentWidth), ""];
    if (this.state.currentIndex === this.questions.length) {
      body.push(...this.renderReview(contentWidth));
    } else if (this.state.editingQuestionIndex !== undefined) {
      body.push(...this.renderCustomInput(contentWidth));
    } else {
      body.push(...this.renderQuestion(contentWidth));
    }
    return renderModalFrame(this.theme, frameWidth, body, {
      title: "Ask User",
      paddingY: 0,
    });
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled) return;

    if (this.state.editingQuestionIndex !== undefined) {
      this.handleCustomInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish({ status: "dismissed" });
      return;
    }

    if (this.state.currentIndex === this.questions.length) {
      this.handleReviewInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.handleTabNavigation(data)) {
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.state = reduceQuestionnaire(this.state, { type: "move", delta: -1 }, this.questions);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.state = reduceQuestionnaire(this.state, { type: "move", delta: 1 }, this.questions);
    } else if (data === " ") {
      const answer = this.state.answers[this.state.currentIndex];
      if (answer) {
        this.state = reduceQuestionnaire(
          this.state,
          { type: "toggle", optionIndex: answer.cursorIndex },
          this.questions,
        );
      }
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.confirmCurrentRow();
    }
    this.tui.requestRender();
  }

  dispose(): void {}

  private handleCustomInput(data: string): void {
    const question = this.questions[this.state.editingQuestionIndex ?? -1];
    const navigationDelta = this.getNavigationDelta(data, false);
    if (navigationDelta !== undefined) {
      this.state = reduceQuestionnaire(
        this.state,
        { type: "saveDraft", value: this.input.getValue() },
        this.questions,
      );
      this.navigate(navigationDelta);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (!question?.options) {
        this.finish({ status: "dismissed" });
        return;
      }
      this.state = reduceQuestionnaire(this.state, { type: "cancelCustom" }, this.questions);
      this.input.setValue("");
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.state = reduceQuestionnaire(
        this.state,
        { type: "saveCustom", value: this.input.getValue() },
        this.questions,
      );
      this.input.setValue("");
      return;
    }
    this.input.handleInput(data);
  }

  private handleReviewInput(data: string): void {
    if (this.handleTabNavigation(data)) return;
    if (this.keybindings.matches(data, "tui.select.confirm") && this.state.canSubmit) {
      this.finish({ status: "submitted", answers: toSubmittedAnswers(this.questions, this.state) });
    }
  }

  private handleTabNavigation(data: string): boolean {
    const delta = this.getNavigationDelta(data, true);
    if (delta === undefined) return false;
    this.navigate(delta);
    return true;
  }

  private getNavigationDelta(data: string, includeArrows: boolean): -1 | 1 | undefined {
    if (matchesKey(data, Key.shift("tab")) || (includeArrows && isLeft(data))) return -1;
    if (this.keybindings.matches(data, "tui.input.tab") || (includeArrows && isRight(data))) {
      return 1;
    }
    return undefined;
  }

  private navigate(delta: -1 | 1): void {
    const count = this.questions.length + 1;
    const target = (this.state.currentIndex + delta + count) % count;
    this.state = reduceQuestionnaire(
      this.state,
      { type: "goTo", questionIndex: target },
      this.questions,
    );
    const editingIndex = this.state.editingQuestionIndex;
    this.input.setValue(
      editingIndex === undefined ? "" : (this.state.answers[editingIndex]?.customText ?? ""),
    );
  }

  private confirmCurrentRow(): void {
    const question = this.questions[this.state.currentIndex];
    const answer = this.state.answers[this.state.currentIndex];
    if (!question || !answer) return;
    const customRow = question.options?.length ?? 0;
    if (answer.cursorIndex === customRow) {
      this.input.setValue(answer.customText ?? "");
      this.state = reduceQuestionnaire(this.state, { type: "startCustom" }, this.questions);
      return;
    }
    this.state = reduceQuestionnaire(
      this.state,
      question.multiSelect
        ? { type: "confirmMulti" }
        : { type: "selectSingle", optionIndex: answer.cursorIndex },
      this.questions,
    );
  }

  private renderProgress(width: number): string {
    const tabs = this.questions.map((question, index) => {
      const answer = this.state.answers[index];
      const marker = answer?.confirmed ? "●" : "○";
      const text = `${marker} ${question.header}`;
      return index === this.state.currentIndex
        ? this.theme.fg("accent", this.theme.bold(text))
        : this.theme.fg(answer?.confirmed ? "success" : "muted", text);
    });
    const review =
      this.state.currentIndex === this.questions.length
        ? this.theme.fg("accent", this.theme.bold("Review"))
        : this.theme.fg(this.state.canSubmit ? "success" : "muted", "Review");
    return truncateToWidth(
      `${tabs.join(this.theme.fg("dim", "  ›  "))}${this.theme.fg("dim", "  ›  ")}${review}`,
      width,
      "…",
    );
  }

  private renderQuestion(width: number): string[] {
    const question = this.questions[this.state.currentIndex];
    const answer = this.state.answers[this.state.currentIndex];
    if (!question || !answer) return [];
    const lines = [this.theme.fg("text", this.theme.bold(question.question))];
    if (question.context) {
      lines.push(
        "",
        ...wrapStyled(question.context, width, (text) => this.theme.fg("muted", text)),
      );
    }
    lines.push("");

    for (const [index, option] of (question.options ?? []).entries()) {
      const focused = answer.cursorIndex === index;
      const checked = answer.selectedValues.includes(option.value);
      const marker = question.multiSelect ? (checked ? "[✓]" : "[ ]") : checked ? "●" : "○";
      const pointer = focused ? this.theme.fg("accent", "›") : " ";
      const recommendation = option.recommended ? this.theme.fg("success", " (Recommended)") : "";
      const label = this.theme.fg(focused ? "accent" : "text", option.label);
      lines.push(truncateToWidth(`${pointer} ${marker} ${label}${recommendation}`, width, "…"));
      if (option.description) {
        lines.push(
          ...wrapStyled(option.description, Math.max(1, width - 4), (text) =>
            truncateToWidth(`    ${this.theme.fg("muted", text)}`, width, "…"),
          ),
        );
      }
    }

    const customIndex = question.options?.length ?? 0;
    const customFocused = answer.cursorIndex === customIndex;
    const customValue = answer.customText ? `: ${answer.customText}` : "";
    lines.push(
      truncateToWidth(
        `${customFocused ? this.theme.fg("accent", "›") : " "} ✎ ${this.theme.fg(customFocused ? "accent" : "text", `Write another answer${customValue}`)}`,
        width,
        "…",
      ),
    );
    lines.push(
      "",
      formatStyledKeyHints(this.theme, [
        ["↑↓", "navigate"],
        ...(question.multiSelect ? ([["space", "toggle"]] as const) : []),
        ["enter", question.multiSelect ? "confirm" : "select"],
        ["tab/←→", "questions"],
        ["esc", "dismiss"],
      ]),
    );
    return lines;
  }

  private renderCustomInput(width: number): string[] {
    const question = this.questions[this.state.editingQuestionIndex ?? -1];
    if (!question) return [];
    this.input.focused = this.focused;
    return [
      this.theme.fg("text", this.theme.bold(question.question)),
      "",
      this.theme.fg("accent", question.options ? "Add another answer" : "Your answer"),
      this.input.render(width)[0] ?? "",
      "",
      formatStyledKeyHints(this.theme, [
        ["enter", "save"],
        ["tab/shift+tab", "questions"],
        ["esc", question.options ? "back" : "dismiss"],
      ]),
    ];
  }

  private renderReview(width: number): string[] {
    const lines = [this.theme.fg("text", this.theme.bold("Review your answers")), ""];
    for (const [index, question] of this.questions.entries()) {
      const answer = this.state.answers[index];
      const parts: string[] = [];
      for (const selected of answer?.selectedValues ?? []) {
        const label =
          question.options?.find((option) => option.value === selected)?.label ?? selected;
        parts.push(label);
      }
      if (answer?.customText) parts.push(`wrote: ${answer.customText}`);
      const value = parts.length > 0 ? parts.join("; ") : "Unanswered";
      lines.push(...wrapStyled(`${question.header}: ${value}`, width, (text) => text));
    }
    lines.push(
      "",
      this.state.canSubmit
        ? this.theme.fg("success", "All questions answered.")
        : this.theme.fg("warning", "Answer every question before submitting."),
      "",
      formatStyledKeyHints(this.theme, [
        ["enter", "submit"],
        ["tab/←→", "edit answers"],
        ["esc", "dismiss"],
      ]),
    );
    return lines;
  }

  private finish(outcome: QuestionnaireOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.done(outcome);
  }
}

function updateCurrentAnswer(
  state: QuestionnaireState,
  questions: AskUserQuestion[],
  update: (answer: AnswerState) => AnswerState,
): QuestionnaireState {
  const answers = state.answers.map((answer, index) =>
    index === state.currentIndex ? update(answer) : answer,
  );
  return withDerivedState({ ...state, answers }, questions);
}

function advance(state: QuestionnaireState, questions: AskUserQuestion[]): QuestionnaireState {
  const currentIndex = Math.min(questions.length, state.currentIndex + 1);
  return withDerivedState(
    {
      ...state,
      currentIndex,
      editingQuestionIndex:
        currentIndex < questions.length && !questions[currentIndex]?.options
          ? currentIndex
          : undefined,
    },
    questions,
  );
}

function withDerivedState(
  state: QuestionnaireState,
  questions: AskUserQuestion[],
): QuestionnaireState {
  return {
    ...state,
    canSubmit: questions.every((_question, index) => state.answers[index]?.confirmed === true),
  };
}

function wrapStyled(text: string, width: number, style: (text: string) => string): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width)).map(style);
}

function isLeft(data: string): boolean {
  return data === "\u001b[D" || data === "\u001bOD";
}

function isRight(data: string): boolean {
  return data === "\u001b[C" || data === "\u001bOC";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
