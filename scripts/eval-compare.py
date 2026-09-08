#!/usr/bin/env python3
"""Compare two harness-eval results.jsonl files (suite-on vs suite-off)."""

import json
import sys
from collections import defaultdict

def load(path):
    rows = defaultdict(list)
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            rows[r["taskId"]].append(r)
    return rows

def agg(rs):
    n = len(rs)
    passes = sum(1 for r in rs if r["pass"])
    dur = sum(r["durationMs"] for r in rs) / n / 1000
    tin = sum(r["inputTokens"] for r in rs) / n
    tout = sum(r["outputTokens"] for r in rs) / n
    return passes, n, dur, tin, tout

def main(with_path, without_path):
    on = load(with_path)
    off = load(without_path)
    task_ids = sorted(set(on) | set(off))

    print(f"{'task':<24} {'ON':>12} {'OFF':>12}  {'d_time':>8}  {'d_outTok':>9}")
    print("-" * 78)
    tot = {"on_p": 0, "on_n": 0, "off_p": 0, "off_n": 0, "on_dur": 0.0, "off_dur": 0.0}
    for tid in task_ids:
        op, onn, odur, otin, otout = agg(on.get(tid, [{"pass": False, "durationMs": 0, "inputTokens": 0, "outputTokens": 0}]))
        fp, fn, fdur, ftin, ftout = agg(off.get(tid, [{"pass": False, "durationMs": 0, "inputTokens": 0, "outputTokens": 0}]))
        tot["on_p"] += op; tot["on_n"] += onn; tot["off_p"] += fp; tot["off_n"] += fn
        tot["on_dur"] += odur; tot["off_dur"] += fdur
        on_s = f"{op}/{onn} {odur:5.0f}s"
        off_s = f"{fp}/{fn} {fdur:5.0f}s"
        dt = odur - fdur
        dtok = otout - ftout
        print(f"{tid:<24} {on_s:>12} {off_s:>12}  {dt:>+7.0f}s  {dtok:>+9.0f}")

    print("-" * 78)
    print(
        f"{'TOTAL':<24} {tot['on_p']}/{tot['on_n']} {tot['on_dur']/max(len(task_ids),1):5.0f}s   "
        f"{tot['off_p']}/{tot['off_n']} {tot['off_dur']/max(len(task_ids),1):5.0f}s"
    )
    # detail: failed runs
    for label, rows in (("ON", on), ("OFF", off)):
        for tid, rs in sorted(rows.items()):
            for i, r in enumerate(rs):
                if not r["pass"]:
                    chk = "; ".join(f"{c['name']}: {c['output'][:160]}" for c in r["checks"] if not c["ok"])
                    print(f"[FAIL {label} {tid} #{i+1}] {chk}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
