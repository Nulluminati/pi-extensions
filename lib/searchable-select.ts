/** Searchable selector composed from Pi's Input and SelectList primitives. */

import {
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { setInputValue } from "./input-value.ts";
import { modalContentWidth, renderModalFrame } from "./tui-frame.ts";
import { formatStyledKeyHints } from "./ui-format.ts";

interface SearchableSelectTui {
  requestRender(): void;
}

interface SearchableSelectTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  bg?(color: string, text: string): string;
}

interface SearchableSelectKeybindings {
  matches(data: string, keybinding: string): boolean;
}

export interface SearchableSelectOptions {
  tui: SearchableSelectTui;
  theme: SearchableSelectTheme;
  keybindings: SearchableSelectKeybindings;
  items: SelectItem[];
  activeValue?: string | undefined;
  title: string;
  maxVisible: number;
  noMatchText: string;
  searchText?: (item: SelectItem) => string;
  initialQuery?: string;
  /** Delegate search to the owner instead of filtering the supplied results locally. */
  onSearchChange?(query: string): void;
  hint?: string;
  onSelect(value: string): void;
  onCancel(): void;
}

export interface SearchableSelectModal {
  focused: boolean;
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

export function createSearchableSelectModal(
  options: SearchableSelectOptions,
): SearchableSelectModal {
  const selector = new SearchableSelect(options, false);

  return {
    get focused() {
      return selector.focused;
    },
    set focused(value: boolean) {
      selector.focused = value;
    },
    render: (width) => {
      const frameWidth = Math.max(0, Math.floor(width));
      if (frameWidth === 0) return [];
      return renderModalFrame(
        options.theme,
        frameWidth,
        selector.render(modalContentWidth(frameWidth)),
        { title: options.title },
      );
    },
    invalidate: () => selector.invalidate(),
    handleInput: (data) => selector.handleInput(data),
  };
}

export class SearchableSelect {
  private readonly input = new Input();
  private readonly options: SearchableSelectOptions;
  private filteredItems: SelectItem[];
  private selectedIndex = 0;
  private selectList: SelectList;
  private _focused = false;
  private readonly showTitle: boolean;

  constructor(options: SearchableSelectOptions, showTitle = true) {
    this.options = options;
    this.showTitle = showTitle;
    this.filteredItems = options.items;
    setInputValue(this.input, options.initialQuery ?? "");
    this.selectList = this.createSelectList();
    this.applyFilter();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const safeWidth = Math.max(1, Math.floor(width));
    const searchPrefix = this.options.theme.fg("muted", "Search: ");
    const inputWidth = Math.max(1, safeWidth - visibleWidth(searchPrefix));
    const inputLine = this.input.render(inputWidth)[0] ?? "";
    const lines = [truncateToWidth(`${searchPrefix}${inputLine}`, safeWidth, "")];
    if (this.showTitle) {
      lines.unshift(
        truncateToWidth(
          this.options.theme.fg("accent", this.options.theme.bold(this.options.title)),
          safeWidth,
          "",
        ),
      );
    }
    lines.push(
      ...this.selectList.render(safeWidth),
      truncateToWidth(
        this.options.hint ??
          formatStyledKeyHints(this.options.theme, [
            ["type", "search"],
            ["↑↓", "navigate"],
            ["enter", "select"],
            ["esc", "cancel"],
          ]),
        safeWidth,
        "",
      ),
    );
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
    this.selectList.invalidate();
  }

  handleInput(data: string): void {
    if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filteredItems[this.selectedIndex];
      if (selected) this.options.onSelect(selected.value);
    } else if (this.options.keybindings.matches(data, "tui.select.cancel")) {
      this.options.onCancel();
    } else {
      const previousQuery = this.input.getValue();
      this.input.handleInput(data);
      this.applyFilter();
      const query = this.input.getValue();
      if (query !== previousQuery) this.options.onSearchChange?.(query);
    }
    this.options.tui.requestRender();
  }

  private createSelectList(): SelectList {
    const displayItems = this.filteredItems.map((item) =>
      item.value === this.options.activeValue
        ? { ...item, label: this.options.theme.fg("accent", item.label) }
        : item,
    );
    return new SelectList(
      displayItems,
      Math.min(Math.max(this.filteredItems.length, 1), this.options.maxVisible),
      {
        selectedPrefix: (text) => this.options.theme.fg("accent", text),
        selectedText: (text) => {
          const selected = this.options.theme.fg("accent", text);
          return this.options.theme.bg?.("selectedBg", selected) ?? selected;
        },
        description: (text) => this.options.theme.fg("muted", text),
        scrollInfo: (text) => this.options.theme.fg("dim", text),
        noMatch: () => this.options.theme.fg("warning", `  ${this.options.noMatchText}`),
      },
    );
  }

  private applyFilter(): void {
    if (this.options.onSearchChange) return;
    const query = this.input.getValue().trim();
    const searchText =
      this.options.searchText ??
      ((item: SelectItem) => `${item.value} ${item.label} ${item.description ?? ""}`);
    this.filteredItems = query
      ? fuzzyFilter(this.options.items, query, searchText)
      : this.options.items;
    this.selectedIndex = 0;
    this.selectList = this.createSelectList();
  }

  private moveSelection(offset: number): void {
    if (this.filteredItems.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + offset + this.filteredItems.length) % this.filteredItems.length;
    this.selectList.setSelectedIndex(this.selectedIndex);
  }
}
