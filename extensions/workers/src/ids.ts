const WORKER_ID = /^w-[A-Za-z0-9-]+$/;

export function isWorkerId(value: unknown): value is string {
  // `$` can match before a final newline; require the match to cover the whole id.
  return typeof value === "string" && WORKER_ID.exec(value)?.[0] === value;
}

export function assertWorkerId(id: string): string {
  if (!isWorkerId(id)) throw new Error("Invalid worker id. Use action=list to see workers.");
  return id;
}
