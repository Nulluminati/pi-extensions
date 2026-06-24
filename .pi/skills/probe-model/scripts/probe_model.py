#!/usr/bin/env python3
"""Probe a model's reasoning_effort behavior on an OpenAI-compatible API.

Sends a minimal request with each pi reasoning_effort value
(none, minimal, low, medium, high, xhigh, max) plus an omitted-effort baseline,
and reports for each:
  - HTTP status (accepted vs rejected)
  - reasoning_tokens from usage (when the provider returns it)
  - which reasoning field carried the thinking text (reasoning_content,
    reasoning, or reasoning_text) and its length

The result determines the thinkingLevelMap + reasoning config for a pi provider
extension. See SKILL.md for how to interpret the output into a config.

Usage:
  export SYNTHETIC_API_KEY=syn_...
  ./probe_model.py hf:zai-org/GLM-5.2
  ./probe_model.py hf:MiniMaxAI/MiniMax-M3 --base-url https://api.synthetic.new/openai/v1

Exit code is 0 if the probe completed, non-zero on setup errors (bad args,
missing key, unreachable catalog). Transient 5xx during the sweep are reported
in the table, not fatal.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

# The full pi thinking enum plus "max" as a sentinel that providers built on the
# OpenAI reasoning_effort field almost always reject (it is a provider-side
# value like Anthropic's, not part of the OpenAI enum). Omitted is the baseline.
EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

# A prompt that triggers reasoning on any model that can think. Used to tell the
# difference between "effort accepted but model doesn't think" and "model thinks
# at this level". The bat-and-ball problem is a good probe because models want
# to show work on it.
REASONING_PROMPT = (
    "A bat and a ball cost $1.10 together, and the bat costs $1.00 more than "
    "the ball. How much does the ball cost? Show your reasoning."
)
SIMPLE_PROMPT = "Reply with the single word: ok"

# Providers return thinking under different top-level message field names. This
# mirrors pi's openai-completions provider, which checks these in order and uses
# the first non-empty one. Inspecting only reasoning_content misses providers
# that return thinking under `reasoning` (e.g. Neuralwatt's vLLM gateway) and
# would report them as never thinking, producing a wrong thinkingLevelMap.
REASONING_FIELDS = ("reasoning_content", "reasoning", "reasoning_text")

# Short tags for the signals column so the table stays narrow.
REASONING_TAGS = {
    "reasoning_content": "rc",
    "reasoning": "r",
    "reasoning_text": "rtx",
}


def call(base_url: str, api_key: str, model: str, effort: str | None,
         prompt: str, max_tokens: int) -> tuple[int, str]:
    """POST a chat completion. Returns (http_code, raw_body)."""
    body: dict = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "stream": False,
    }
    if effort is not None:
        body["reasoning_effort"] = effort
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:  # noqa: BLE001 - surface any transport failure
        return -1, str(e)


def parse_response(raw: str) -> dict:
    """Pull the signals we care about out of a completion response."""
    try:
        d = json.loads(raw)
    except Exception:
        return {"parse_error": raw[:120]}
    if "error" in d:
        return {"error": json.dumps(d["error"])[:120]}
    choice = (d.get("choices") or [{}])[0]
    msg = choice.get("message", {}) or {}
    usage = d.get("usage") or {}
    # Providers return thinking under different top-level field names. Mirror
    # pi's openai-completions provider, which checks reasoning_content,
    # reasoning, and reasoning_text and uses the first non-empty one. Checking
    # only reasoning_content (the DeepSeek/llama.cpp convention) misses models
    # that think under `reasoning` (e.g. Neuralwatt's vLLM gateway) and would
    # read them as never thinking, producing a wrong thinkingLevelMap. Take the
    # first non-empty field rather than summing: some endpoints (e.g. chutes.ai)
    # return the same content under two fields.
    reasoning_field: str | None = None
    reasoning_len = 0
    for field in REASONING_FIELDS:
        value = msg.get(field)
        if isinstance(value, str) and len(value) > 0:
            reasoning_field = field
            reasoning_len = len(value)
            break
    return {
        "finish_reason": choice.get("finish_reason"),
        "reasoning_tokens": usage.get("reasoning_tokens"),
        "reasoning_field": reasoning_field,
        "reasoning_len": reasoning_len,
        "content_len": len(msg.get("content") or ""),
    }


def fetch_catalog(base_url: str, api_key: str, model: str) -> dict | None:
    """GET /models and return the entry for `model`, or None."""
    try:
        req = urllib.request.Request(
            f"{base_url}/models",
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:  # noqa: BLE001
        print(f"  (catalog fetch failed: {e})", file=sys.stderr)
        return None
    for m in data.get("data", []):
        if m.get("id") == model:
            return m
    return None


def fmt_tokens(r: dict) -> str:
    rt = r.get("reasoning_tokens")
    rt_s = "" if rt is None else str(rt)
    field = r.get("reasoning_field")
    rlen = r.get("reasoning_len") or 0
    # Show the thinking text length tagged with the field that carried it
    # (rc=reasoning_content, r=reasoning, rtx=reasoning_text). The tag makes it
    # visible which field this provider populates; the length (not mere key
    # presence) avoids false positives from empty fields some models emit.
    if field:
        tag = REASONING_TAGS.get(field, field)
        reasoning_s = f"{tag}={rlen}"
    else:
        reasoning_s = "none=0"
    return f"rt={rt_s:<4} {reasoning_s}"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("model", help="Model id as the provider expects it (e.g. hf:zai-org/GLM-5.2)")
    p.add_argument("--base-url", default="https://api.synthetic.new/openai/v1",
                   help="OpenAI-compatible base URL (default: synthetic)")
    p.add_argument("-k", "--api-key", default=os.environ.get("SYNTHETIC_API_KEY"),
                   help="API key (default: $SYNTHETIC_API_KEY)")
    p.add_argument("--max-tokens", type=int, default=48,
                   help="max_tokens for the enum sweep (default 48, keeps cost down)")
    args = p.parse_args()

    if not args.api_key:
        print("error: no API key. Set SYNTHETIC_API_KEY or pass -k.", file=sys.stderr)
        return 2

    print(f"model:    {args.model}")
    print(f"base_url: {args.base_url}")
    catalog = fetch_catalog(args.base_url, args.api_key, args.model)
    if catalog:
        print(f"catalog:  always_on={catalog.get('always_on')} "
              f"features={catalog.get('supported_features')} "
              f"ctx={catalog.get('context_length')} "
              f"max_out={catalog.get('max_output_length')}")
        pr = catalog.get("pricing") or {}
        if pr:
            print(f"          pricing prompt={pr.get('prompt')} completion={pr.get('completion')} "
                  f"cache_read={pr.get('input_cache_reads')}")
    else:
        print("catalog:  (model not found in /models, or /models unreachable)")

    # --- enum acceptance sweep (cheap prompt, small budget) ---
    print("\n=== reasoning_effort enum acceptance "
          f"(max_tokens={args.max_tokens}, simple prompt) ===")
    print(f"{'effort':<10} {'http':<6} {'signals':<16} detail")
    print("-" * 80)
    accepted: list[str] = []
    for effort in EFFORTS:
        code, raw = call(args.base_url, args.api_key, args.model, effort,
                         SIMPLE_PROMPT, args.max_tokens)
        r = parse_response(raw)
        if code == 200 and "error" not in r:
            accepted.append(effort)
            print(f"{effort:<10} {code!s:<6} {fmt_tokens(r):<16}")
        else:
            detail = (r.get("error") or r.get("parse_error") or "")[:60]
            print(f"{effort:<10} {code!s:<6} {'':<16} {detail}")
        time.sleep(0.4)
    # Baseline: no effort param
    code, raw = call(args.base_url, args.api_key, args.model, None,
                     SIMPLE_PROMPT, args.max_tokens)
    r = parse_response(raw)
    print(f"{'(omitted)':<10} {code!s:<6} {fmt_tokens(r):<16}")

    # --- does thinking actually engage, and can it be disabled? ---
    # Compare none vs high on a reasoning prompt. If none still produces
    # thinking output (any reasoning field or tokens), thinking cannot be
    # turned off (off -> null).
    print("\n=== disable + engagement check (reasoning prompt, max_tokens=300) ===")
    none_r = parse_response(
        call(args.base_url, args.api_key, args.model, "none",
             REASONING_PROMPT, 300)[1]
    )
    high_r = parse_response(
        call(args.base_url, args.api_key, args.model, "high",
             REASONING_PROMPT, 300)[1]
    )
    # A model "thinks" at a level only if it produced real reasoning output:
    # either billed reasoning tokens, or a non-empty thinking text block under
    # any of the reasoning fields. Mere presence of a reasoning field does not
    # count (some models include an empty one when not thinking).
    def thinks(r: dict) -> bool:
        return (r.get("reasoning_tokens") or 0) > 0 or (r.get("reasoning_len") or 0) > 0
    none_thinks = thinks(none_r)
    high_thinks = thinks(high_r)
    print(f"  none:  {fmt_tokens(none_r)}   -> thinks={none_thinks}")
    print(f"  high:  {fmt_tokens(high_r)}   -> thinks={high_thinks}")

    # --- suggested config ---
    print("\n=== suggested config ===")
    if not accepted:
        print("  (no efforts accepted; is this a reasoning model? set reasoning: false)")
        return 0
    # max is not part of pi's enum; drop it from the map suggestions
    pi_levels = [e for e in ["none", "minimal", "low", "medium", "high", "xhigh"]
                 if e in accepted]
    off_value = "null  # thinking cannot be disabled" if none_thinks else '"none"'
    print("  reasoning: true")
    print("  thinkingLevelMap:")
    # Map each accepted pi level to itself (identity) unless we have evidence
    # to remap. The model decides whether lower tiers engage thinking.
    for lvl in ["off", "minimal", "low", "medium", "high", "xhigh"]:
        if lvl == "off":
            print(f"    {lvl:<9}: {off_value}")
        elif lvl in pi_levels:
            print(f'    {lvl:<9}: "{lvl}"')
        else:
            print(f"    {lvl:<9}: null  # not accepted by provider")
    print("  compat:")
    print("    supportsReasoningEffort: true")
    if not high_thinks:
        print("  # WARNING: high produced no thinking output on a reasoning")
        print("  # prompt. The catalog may advertise reasoning that the backend does")
        print("  # not expose. See SKILL.md for the judgment call.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
