/** Searchable selector composed from Pi's Input and SelectList primitives. */

import {
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { frameBorderLine, frameContentLine } from "./tui-frame.ts";
import { formatKeyHints } from "./ui-format.ts";

interface SearchableSelectTui {
  requestRender(): void;
}

interface SearchableSelectTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
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
  const selector = new SearchableSelect(options);
  const frameTheme = {
    fg: (_color: string, text: string) => options.theme.fg("accent", text),
  };

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
      const innerWidth = Math.max(0, frameWidth - 2);
      return [
        frameBorderLine(frameTheme, frameWidth, "top"),
        ...selector
          .render(innerWidth)
          .map((line) => frameContentLine(frameTheme, frameWidth, line)),
        frameBorderLine(frameTheme, frameWidth, "bottom"),
      ];
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

  constructor(options: SearchableSelectOptions) {
    this.options = options;
    this.filteredItems = options.items;
    this.selectList = this.createSelectList();
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
    return [
      truncateToWidth(
        this.options.theme.fg("accent", this.options.theme.bold(this.options.title)),
        safeWidth,
        "",
      ),
      truncateToWidth(`${searchPrefix}${inputLine}`, safeWidth, ""),
      ...this.selectList.render(safeWidth),
      truncateToWidth(
        this.options.theme.fg(
          "dim",
          this.options.hint ??
            formatKeyHints([
              ["type", "search"],
              ["↑↓", "navigate"],
              ["enter", "select"],
              ["esc", "cancel"],
            ]),
        ),
        safeWidth,
        "",
      ),
    ];
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
      this.input.handleInput(data);
      this.applyFilter();
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
        selectedText: (text) => this.options.theme.fg("accent", text),
        description: (text) => this.options.theme.fg("muted", text),
        scrollInfo: (text) => this.options.theme.fg("dim", text),
        noMatch: () => this.options.theme.fg("warning", `  ${this.options.noMatchText}`),
      },
    );
  }

  private applyFilter(): void {
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
