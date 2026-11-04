import { describe, expect, it } from "vitest";
import { checkCommand, commandWords, parseAllowList, splitCommand } from "../../lib/bash-allow.ts";

describe("commandWords", () => {
  it("returns literal words with shell quoting and escapes removed", () => {
    expect(commandWords("cd '/some dir'")).toEqual(["cd", "/some dir"]);
    expect(commandWords("herdboard log t8kr 'literal $VAR; *'")).toEqual([
      "herdboard",
      "log",
      "t8kr",
      "literal $VAR; *",
    ]);
    expect(commandWords(String.raw`cd /some\ dir`)).toEqual(["cd", "/some dir"]);
    expect(commandWords('cd ""')).toEqual(["cd", ""]);
  });

  it.each([
    "",
    "a | b",
    "a && b",
    "a;",
    "a &&",
    "a $VAR",
    "a > out",
    "a *",
    "a # note",
    "a 'unfinished",
  ])("refuses unsafe or composed command %j", (command) => {
    expect(commandWords(command)).toBeUndefined();
  });
});

describe("parseAllowList", () => {
  it.each(["hunk session:*,gh pr view:*", "Bash(hunk session:*),Bash(gh pr view:*)"])(
    "parses %s",
    (value) => {
      expect(parseAllowList(value)).toEqual({
        rules: [
          { pattern: "hunk session:*", tokens: ["hunk", "session"], allowMore: true },
          { pattern: "gh pr view:*", tokens: ["gh", "pr", "view"], allowMore: true },
        ],
      });
    },
  );
  it("preserves quoted commas and exact rules", () => {
    expect(parseAllowList(`echo 'a,b',echo "c,d"`)).toEqual({
      rules: [
        { pattern: "echo 'a,b'", tokens: ["echo", "a,b"], allowMore: false },
        { pattern: 'echo "c,d"', tokens: ["echo", "c,d"], allowMore: false },
      ],
    });
  });
  it.each([
    "",
    " ",
    "a,,b",
    "a,",
    "gh * view",
    "a**",
    "*",
    "Bash()",
    "Bash(a",
    "echo 'a",
    "a && b",
    "tool?:*",
    "tool[ab]:*",
  ])("rejects malformed list %j", (value) => {
    expect(parseAllowList(value)).toEqual({ rules: [], error: expect.any(String) });
  });
});

describe("splitCommand", () => {
  it.each([
    ["a", ["a"]],
    ["a && b", ["a", "b"]],
    ["a || b", ["a", "b"]],
    ["a | b", ["a", "b"]],
    ["a; b", ["a", "b"]],
    ["a\nb", ["a", "b"]],
    ["a\n", ["a"]],
    ['echo "a; b"', ['echo "a; b"']],
    ["echo 'a; b'", ["echo 'a; b'"]],
    [String.raw`a \; b`, [String.raw`a \; b`]],
  ])("splits %j", (command, segments) => {
    expect(splitCommand(command as string)).toEqual({ segments });
  });
  it.each([
    ["(a)", "group"],
    ["{ a; }", "group"],
    ["a &", "&"],
    ["$(a)", "$"],
    ["`a`", "`"],
    ["$VAR", "$"],
    ['"$VAR"', "$"],
    ["a > f", ">"],
    ["a >> f", ">"],
    ["a < f", "<"],
    ["a <<< x", "<"],
    ["a 2> f", ">"],
    ["a &> f", "&>"],
    ["a |& b", "&"],
    ["echo 'unfinished", "quote"],
    ["echo \\", "escape"],
    ["echo\0x", "NUL"],
    ["gh pr diff 7 *", "glob (*)"],
    ["echo file?", "glob (?)"],
    ["echo [ab]", "glob ([)"],
    ["echo [", "glob ([)"],
  ])("refuses %j with an operator reason", (command, reason) => {
    expect(splitCommand(command).refusal).toContain(reason);
  });
  it.each([`echo '*' '?' '['`, 'echo "*" "?" "["', String.raw`echo \* \? \[`])(
    "allows literal glob characters in %j",
    (command) => {
      expect(checkCommand(command, parseAllowList("echo:*").rules)).toEqual({ allowed: true });
    },
  );
  it("allows literal operators inside quotes or after escapes", () => {
    expect(splitCommand(`echo '$VAR $(a) > & {}' "a > b" \\$VAR`).refusal).toBeUndefined();
  });
});

describe("checkCommand", () => {
  it("refuses comments that hide quote characters from the shell", () => {
    const rules = parseAllowList("echo:*").rules;
    expect(checkCommand("echo # '\nprintf bypass\n'", rules)).toEqual({
      allowed: false,
      reason: expect.stringContaining("comment (#)"),
    });
  });
  it("refuses escaped NUL characters", () => {
    expect(splitCommand("echo \\\0").refusal).toContain("NUL");
  });
  it("keeps literal hashes inside quoted or existing words", () => {
    const rules = parseAllowList("echo:*").rules;
    expect(checkCommand(String.raw`echo 'a#b' a#b \#`, rules)).toEqual({ allowed: true });
  });
  const rules = parseAllowList("hunk session:*,hunk skill:*,gh pr view:*,echo:*").rules;
  it.each([
    ["hunk session comment add s --file x", true],
    ["hunk skills", false],
    ["gh pr viewx", false],
    ["gh pr view 7 --repo a/b", true],
    ["hunk session list; rm -rf /", false],
    ["hunk session list && gh pr view 7", true],
    ["rm -rf / && hunk session list", false],
    ["echo x > /tmp/x", false],
    ['gh "pr" view 7', true],
    [String.raw`gh p\r view 7`, true],
    ["gh p\\\nr view 7", true],
    ["gh\u00a0pr view 7", false],
    ["gh pr view\r", false],
    ["", false],
    [";", false],
  ])("checks %j", (command, allowed) => {
    expect(checkCommand(command, rules).allowed).toBe(allowed);
  });
  it("names the denied segment and allow list", () => {
    expect(checkCommand("ls", rules)).toEqual({
      allowed: false,
      reason: expect.stringMatching(/ls.*Allowed: hunk session:\*/s),
    });
  });
  it("refuses glob expansion before any segment matches", () => {
    expect(checkCommand("unlisted && gh pr view *", rules)).toEqual({
      allowed: false,
      reason: expect.stringContaining("glob (*)"),
    });
  });
  it("checks the documented reviewer list and pipeline examples", () => {
    const reviewer = parseAllowList(
      "Bash(hunk session:*),Bash(hunk skill path:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr checks:*)",
    );
    expect(reviewer.error).toBeUndefined();
    expect(reviewer.rules).toHaveLength(5);
    expect(checkCommand("gh pr diff 7 | gh pr view 7", reviewer.rules)).toEqual({ allowed: true });
    expect(checkCommand("gh pr diff 7 | cat", reviewer.rules)).toEqual({
      allowed: false,
      reason: expect.stringContaining("cat"),
    });
    expect(checkCommand("gh pr diff 7 *", reviewer.rules)).toEqual({
      allowed: false,
      reason: expect.stringContaining("glob (*)"),
    });
  });
  it("refuses syntax before matching any segments", () => {
    expect(checkCommand("rm -rf / && echo $VAR", rules)).toEqual({
      allowed: false,
      reason: expect.stringContaining("$"),
    });
  });
  it("matches exact tokens without allowing extra arguments", () => {
    const exact = parseAllowList(`echo 'a b'`).rules;
    expect(checkCommand(`echo "a b"`, exact)).toEqual({ allowed: true });
    expect(checkCommand("echo a b", exact).allowed).toBe(false);
    expect(checkCommand(`echo 'a b' c`, exact).allowed).toBe(false);
  });
});
