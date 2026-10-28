import { describe, expect, it } from "vitest";
import { isExcludedCommand } from "../../extensions/worker-sandbox/src/exclusions.mjs";

describe("sandbox excluded commands", () => {
  it("matches only an exact command or a command with literal arguments", () => {
    expect(
      isExcludedCommand("terminal-browser https://github.com/project", ["terminal-browser *"]),
    ).toBe(true);
    expect(isExcludedCommand("terminal-browser", ["terminal-browser *"])).toBe(true);
    expect(isExcludedCommand("terminal-browser-other open", ["terminal-browser *"])).toBe(false);
    expect(isExcludedCommand("/tmp/terminal-browser open", ["terminal-browser *"])).toBe(false);
    expect(isExcludedCommand("pwd", ["pwd"])).toBe(true);
    expect(isExcludedCommand("pwd -P", ["pwd"])).toBe(false);
  });

  it.each([
    "terminal-browser x; touch /tmp/escape",
    "terminal-browser x && touch /tmp/escape",
    "terminal-browser x | sh",
    "terminal-browser $(touch /tmp/escape)",
    "terminal-browser `touch /tmp/escape`",
    "terminal-browser x\ntouch /tmp/escape",
    "terminal-browser x\n",
    "terminal-browser x\r",
    "terminal-browser > /tmp/escape",
    "terminal-browser x &",
    "ENV=x terminal-browser x",
    "terminal-browser '$HOME'",
    "terminal-browser \\\n touch /tmp/escape",
  ])("keeps shell syntax sandboxed: %s", (command) => {
    expect(isExcludedCommand(command, ["terminal-browser *"])).toBe(false);
  });
});
