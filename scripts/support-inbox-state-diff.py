#!/usr/bin/env python3
"""
Support-inbox state diff via the LOCAL router -- route point R1 (#132 P4a).

The support heartbeat runs every 15 minutes and, every single round, has to
work out what changed since the last one: same mailbox or not, how many
messages, is there a new external sender. That comparison is one shot of text
in, structured answer out -- no tools -- which is exactly the shape the local
router serves. The classification of a NEW MAIL is a different, rarer step and
is deliberately NOT this: a material-dependent step inherits the rarity of the
material, and what P4b needs is volume (docs/eco-mode-p4-router-scoring.md 6.3).

What comes back is FIELDS, not Hungarian prose. Hungarian is its own task class
on its own model (gemma4); asking qwen3-coder for a Hungarian sentence under the
`structured` class would repeat the very mistake that class split exists to
avoid. The run composes the `note` from these fields exactly as it does today.

Contract, inherited from scripts/napindito-router-draft.py:
  - ONE call, no retry loop. The measurement is the call, not delivery.
  - A refusal is DATA. rc=3 and the run carries on exactly as it did before
    this route point existed. Fail-open: this step must never be able to stop
    the heartbeat doing its real job.
  - The fallback decision belongs to the caller; local_router never calls a
    cloud model on its own.
  - The prompt lives here, not in the SKILL.md, so it is versioned and its
    changes show up in a diff.

New here, because the output is not user-facing (it lands in a state file, not
in a message to Viktor): there is no mandatory human review as in #290, so a
SHAPE CHECK takes its place. A malformed answer is treated as a refusal -- and
counted separately from one, because "the model returned the wrong shape" and
"the router gave us nothing" are different problems and neither is fixable once
they are added together.

Input:  the current `check-inbox.py` listing on stdin (plain text).
        The previous state is read from the state file directly.
Output: JSON on stdout.
Exit:   0 = fields on stdout, usable
        2 = no input
        3 = refusal, unreachable router, or a malformed answer -- carry on
            as before, do not retry
"""
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
# Absolute throughout: this runs from atlas's session, whose cwd is not ours.
STATE_PATH = os.path.join(_ROOT, "store", "support-inbox-state.json")
STATS_PATH = os.path.join(_ROOT, "store", "route-point-stats.json")
ROUTE_POINT = "support-inbox-state-diff"

sys.path.insert(0, os.path.join(_ROOT, "seed-skills", "fleet-helper", "scripts"))
from local_router import ask, is_ok  # noqa: E402

# The previous note is free text an earlier run wrote and can grow; the router
# refuses a long prompt on the fallback machine, and a route point that starts
# refusing as a side effect of its own history would be measuring itself.
MAX_PREV_NOTE = 1000
MAX_LISTING = 4000

PROMPT = """You compare two snapshots of a support mailbox and report the difference.

Answer with a single JSON object and NOTHING else. No prose, no code fence.

Keys, all required:
  "changed"             true or false -- did anything change since the previous snapshot
  "count_delta"         integer -- current total minus previous total (0 if unchanged)
  "unread"              integer -- unread count in the CURRENT snapshot
  "new_external_sender" string or null -- the bare EMAIL ADDRESS (not the
                        display name) of the newest message that was not in the
                        previous snapshot and is not from viktor.tolnai@* or a
                        zoho noreply address; null if none. Write it exactly as
                        it appears between the angle brackets, e.g.
                        "jane@example.com", never "Jane Doe <jane@example.com>"
  "reason"              one short English line stating what you based this on

Report only what the two snapshots show. Do not guess, do not invent senders,
and if the previous snapshot is missing, treat everything as unchanged=false
with count_delta 0 and say so in "reason".

PREVIOUS SNAPSHOT:
{previous}

CURRENT LISTING:
{current}
"""

# Exact types. A looser check (accepting "true", or an int for unread as a
# string) would hide how often the local model gets the shape right, which is
# one of the two numbers this route point exists to produce.
REQUIRED_TYPES = {
    "changed": bool,
    "count_delta": int,
    "unread": int,
    "reason": str,
}


def is_excluded_sender(address):
    """Own and automated addresses the support flow must never react to.

    Measured on the live router 2026-08-09: asked to skip `viktor.tolnai@*`,
    qwen3-coder returned viktor.tolnai@gmail.com as a new external sender --
    it had matched the peci.io address in the example and not the rule. A rule
    that decides whether a support draft gets written cannot depend on a model
    following an instruction, so it is enforced here, where every answer passes.

    Enforcing it in code cannot catch the opposite error (a genuinely new
    sender the model failed to report). That is why the field is advisory: the
    run's own UID/count comparison stays the authority on whether there is new
    mail, and this only spares it the reading.
    """
    addr = (address or "").strip().lower()
    if "@" not in addr:
        return False
    local, _, domain = addr.partition("@")
    if local == "viktor.tolnai":
        return True
    if ("noreply" in local or "no-reply" in local) and "zoho" in domain:
        return True
    return False


def _read_previous():
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            state = json.load(fh)
    except FileNotFoundError:
        return None, "state file absent"
    except Exception as e:  # noqa: BLE001 - a broken state file is not our failure
        return None, f"state file unreadable: {e}"
    if not isinstance(state, dict):
        return None, "state file is not an object"
    summary = {
        "last_seen_count": state.get("last_seen_count"),
        "last_seen_unread": state.get("last_seen_unread"),
        "note": str(state.get("note", ""))[:MAX_PREV_NOTE],
    }
    return summary, None


def _bump(**counts):
    """Record what happened. Never raises: the stats are the observation, and
    losing them must not cost the caller its run."""
    try:
        try:
            with open(STATS_PATH, encoding="utf-8") as fh:
                stats = json.load(fh)
            if not isinstance(stats, dict):
                stats = {}
        except FileNotFoundError:
            stats = {}
        entry = stats.get(ROUTE_POINT)
        if not isinstance(entry, dict):
            entry = {}
        for key, value in counts.items():
            if isinstance(value, dict):
                sub = entry.get(key)
                if not isinstance(sub, dict):
                    sub = {}
                for k, v in value.items():
                    sub[k] = int(sub.get(k, 0)) + v
                entry[key] = sub
            else:
                entry[key] = int(entry.get(key, 0)) + value
        now = int(time.time())
        entry.setdefault("first_ts", now)
        entry["last_ts"] = now
        stats[ROUTE_POINT] = entry
        tmp = STATS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(stats, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, STATS_PATH)
    except Exception:  # noqa: BLE001
        pass


def _strip_fence(text):
    """A code fence is a formatting habit, not a wrong answer -- so strip it,
    but count it, because a model that always fences is worth knowing about."""
    t = text.strip()
    if not t.startswith("```"):
        return t, False
    body = t.split("\n", 1)[1] if "\n" in t else ""
    if body.rstrip().endswith("```"):
        body = body.rstrip()[: -len("```")]
    return body.strip(), True


def check_shape(text):
    """(fields, shape_error, fenced). fields is None when the shape is wrong."""
    body, fenced = _strip_fence(text or "")
    if not body:
        return None, "empty", fenced
    try:
        obj = json.loads(body)
    except Exception:  # noqa: BLE001
        return None, "not-json", fenced
    if not isinstance(obj, dict):
        return None, "not-an-object", fenced
    for key, want in REQUIRED_TYPES.items():
        if key not in obj:
            return None, f"missing:{key}", fenced
        value = obj[key]
        # bool is a subclass of int in Python; an int where a bool belongs (and
        # the reverse) is exactly the confusion worth catching.
        if want is bool and not isinstance(value, bool):
            return None, f"type:{key}", fenced
        if want is int and (isinstance(value, bool) or not isinstance(value, int)):
            return None, f"type:{key}", fenced
        if want is str and not isinstance(value, str):
            return None, f"type:{key}", fenced
    if "new_external_sender" not in obj:
        return None, "missing:new_external_sender", fenced
    sender = obj["new_external_sender"]
    if sender is not None and not isinstance(sender, str):
        return None, "type:new_external_sender", fenced
    if not obj["reason"].strip():
        return None, "empty:reason", fenced
    # Not a shape error -- the answer is well formed, the model just ignored an
    # exclusion. Corrected here and counted by the caller, so the run gets a
    # usable answer AND the compliance rate stays visible.
    excluded = is_excluded_sender(sender)
    return {
        "changed": obj["changed"],
        "count_delta": obj["count_delta"],
        "unread": obj["unread"],
        "new_external_sender": None if excluded else sender,
        "reason": " ".join(obj["reason"].split()),
        "excluded_sender_dropped": excluded,
    }, None, fenced


def main():
    listing = sys.stdin.read().strip()
    if not listing:
        print(json.dumps({"ok": False, "refusal": "empty-input",
                          "detail": "no inbox listing on stdin"}))
        return 2

    previous, prev_problem = _read_previous()
    prompt = PROMPT.format(
        previous=json.dumps(previous, ensure_ascii=False, indent=1)
        if previous else f"(none -- {prev_problem})",
        current=listing[:MAX_LISTING],
    )

    result = ask(prompt, task_class="structured")
    if not is_ok(result):
        code = str(result.get("refusal", "unknown"))
        _bump(calls=1, refused=1, refusal_codes={code: 1})
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 3

    fields, shape_error, fenced = check_shape(result.get("text"))
    if shape_error:
        _bump(calls=1, shape_error=1, shape_reasons={shape_error: 1},
              fenced=1 if fenced else 0)
        print(json.dumps({
            "ok": False,
            "refusal": "bad-shape",
            "detail": shape_error,
            "fallback": "self",
            "raw": (result.get("text") or "")[:400],
            "host": result.get("host"),
            "model": result.get("model"),
        }, ensure_ascii=False, indent=2))
        return 3

    _bump(calls=1, ok=1, fenced=1 if fenced else 0,
          excluded_sender_dropped=1 if fields["excluded_sender_dropped"] else 0)
    print(json.dumps({
        "ok": True,
        "fields": fields,
        "host": result.get("host"),
        "model": result.get("model"),
        "usage": result.get("usage", {}),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
