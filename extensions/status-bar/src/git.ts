import type { GitStatus } from "./types.ts";

export function parseGitStatus(stdout: string, hasStash: boolean): GitStatus {
  const status: GitStatus = {
    ahead: 0,
    behind: 0,
    conflicted: 0,
    untracked: 0,
    stashed: hasStash,
    modified: 0,
    staged: 0,
    renamed: 0,
    deleted: 0,
    typechanged: 0,
  };

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;

    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        status.ahead = Number(match[1] ?? 0);
        status.behind = Number(match[2] ?? 0);
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    if (line.startsWith("? ")) {
      status.untracked++;
      continue;
    }
    if (line.startsWith("u ")) {
      status.conflicted++;
      continue;
    }
    if (!(line.startsWith("1 ") || line.startsWith("2 "))) continue;

    const xy = line.split(" ")[1] ?? "..";
    const x = xy[0] ?? ".";
    const y = xy[1] ?? ".";

    if (x === "R") status.renamed++;
    else if (x === "D") status.deleted++;
    else if (x === "T") status.typechanged++;
    else if (x !== "." && x !== " ") status.staged++;

    if (y === "M") status.modified++;
    else if (y === "D") status.deleted++;
    else if (y === "T") status.typechanged++;
  }

  return status;
}
