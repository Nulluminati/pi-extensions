import { describe, expect, it, vi } from "vitest";
import { createFramedWidget } from "../../lib/framed-widget.ts";

const THEME = { fg: (_color: string, text: string) => text };

describe("framed-widget helper", () => {
  it("renders the body lines inside a frame with title and titleRight", () => {
    const factory = createFramedWidget({
      title: "Jobs",
      titleRight: () => "2 running",
      getBodyLines: () => ["#1 build", "#2 test"],
    });

    const lines = factory(undefined, THEME).render(40);

    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines[0]).toContain("Jobs");
    expect(lines[0]).toContain("2 running");
    expect(lines.at(-1)?.startsWith("╰")).toBe(true);
    expect(lines.join("\n")).toContain("#1 build");
    expect(lines.join("\n")).toContain("#2 test");
  });

  it("omits the right label when titleRight returns undefined", () => {
    const factory = createFramedWidget({
      title: "Jobs",
      titleRight: () => undefined,
      getBodyLines: () => ["body"],
    });

    const top = factory(undefined, THEME).render(40)[0] ?? "";

    expect(top).toContain("Jobs");
    expect(top).not.toContain("running");
  });

  it("caps the body with a ↓ N more indicator", () => {
    const factory = createFramedWidget({
      title: "T",
      maxBodyLines: 2,
      getBodyLines: () => ["one", "two", "three", "four"],
    });

    const text = factory(undefined, THEME).render(40).join("\n");

    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).not.toContain("three");
    expect(text).not.toContain("four");
    expect(text).toContain("↓ 2 more");
  });

  it("defaults the cap to eight body lines", () => {
    const factory = createFramedWidget({
      title: "T",
      getBodyLines: () => Array.from({ length: 10 }, (_, i) => `line ${i + 1}`),
    });

    const text = factory(undefined, THEME).render(60).join("\n");

    expect(text).toContain("line 8");
    expect(text).not.toContain("line 9");
    expect(text).toContain("↓ 2 more");
  });

  it("caches per width and only recomputes on a miss", () => {
    const getBodyLines = vi.fn(() => ["body"]);
    const factory = createFramedWidget({ title: "T", getBodyLines });
    const component = factory(undefined, THEME);

    const first = component.render(40);
    expect(component.render(40)).toBe(first);
    expect(getBodyLines).toHaveBeenCalledTimes(1);

    const wide = component.render(60);
    expect(wide).not.toBe(first);
    expect(getBodyLines).toHaveBeenCalledTimes(2);

    component.invalidate();
    expect(component.render(60)).not.toBe(wide);
    expect(getBodyLines).toHaveBeenCalledTimes(3);
  });

  it("evaluates titleRight at render time, not factory time", () => {
    let count = 0;
    const factory = createFramedWidget({
      title: "T",
      titleRight: () => `${++count} running`,
      getBodyLines: () => ["body"],
    });
    const component = factory(undefined, THEME);

    expect(component.render(40).join("\n")).toContain("1 running");
    component.invalidate();
    expect(component.render(40).join("\n")).toContain("2 running");
  });
});
