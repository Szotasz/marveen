#!/usr/bin/env python3
"""
Local LLM router client -- the cheap path for a single model call.

An agent that needs one summary, one classification or one JSON extraction can
send it to the local router instead of paying a cloud model for it. The router
(kanban #132, phase P1) picks the machine and the model from the task class and
enforces the per-model rules the #133 benchmarks measured; the caller only
names what KIND of work it is.

Two design rules make this safe to call from inside another task:

1. A refusal is DATA, never an exception. The router says no for good reasons
   -- every machine busy, the prompt too long for the fallback, the class not
   served locally -- and a caller in the middle of a bigger job must be able to
   read that and carry on, not catch an exception it did not expect. Network
   failures and timeouts are folded into the same shape, because from the
   caller's side "the router said no" and "the router did not answer" lead to
   the same decision.

2. The fallback decision belongs to the CALLER. This module never silently
   calls a cloud model: it returns what happened and a suggested next step, and
   the caller -- who knows whether the work is worth cloud money -- decides.

Stdlib only, like the rest of the fleet helper. No dashboard config is read:
this talks to the router and nothing else.

Config:
  ROUTER_URL - default http://192.168.2.122:11500

Usage:
    from local_router import ask, is_ok

    r = ask([{"role": "user", "content": "Summarise: ..."}], task_class="summary")
    if is_ok(r):
        text = r["text"]
    elif r["fallback"] == "cloud":
        text = my_cloud_call(...)     # the caller's decision, not ours
"""
import json
import os
import urllib.error
import urllib.request

DEFAULT_ROUTER_URL = "http://192.168.2.122:11500"

# Measured on 2026-08-07 through the router: a task that reuses the loaded
# model answers in about a second, one that forces a model swap costs 16-22.
# The default leaves room for a swap plus a long generation without leaving a
# caller hanging for minutes.
DEFAULT_TIMEOUT = 90

# What the caller should consider doing next. The router's refusal codes carry
# different remedies, and collapsing them into "it failed" throws that away.
_FALLBACK_BY_REFUSAL = {
    # The work is fine, the moment is not: retry shortly, or pay for the cloud.
    "all-busy": "retry",
    "no-healthy-host": "cloud",
    "no-local-capacity": "cloud",
    "unreachable": "cloud",
    "timeout": "cloud",
    # The request itself needs changing -- retrying it unchanged cannot help.
    "prompt-too-long-for-fallback": "fix-request",
    "bad-request": "fix-request",
    # Local models are not meant for this kind of work at all.
    "cloud-only": "cloud",
    "upstream_error": "cloud",
    "upstream_unreachable": "cloud",
}


def router_url():
    return os.environ.get("ROUTER_URL", DEFAULT_ROUTER_URL).rstrip("/")


def is_ok(result):
    """True when the router actually answered with text."""
    return bool(result.get("ok"))


def _refused(code, detail, status=None, retry_after=None):
    return {
        "ok": False,
        "refusal": code,
        "detail": detail,
        "status": status,
        "retry_after": retry_after,
        # A suggestion, not an action: this module never calls a cloud model.
        "fallback": _FALLBACK_BY_REFUSAL.get(code, "cloud"),
    }


def ask(messages, task_class=None, timeout=DEFAULT_TIMEOUT, url=None, options=None):
    """
    Send one chat request to the local router.

    messages    OpenAI-style [{"role": "...", "content": "..."}], or a bare
                string, which becomes a single user message.
    task_class  structured | summary | hungarian | code | long-context | general
                (omit and the router uses its default). The router picks the
                model; naming one here would be ignored on purpose.
    options     harmless extras (e.g. {"temperature": 0.2}). The router's own
                per-model rules always win, which is the point of having it.

    Always returns a dict; never raises for a refusal, a timeout or an
    unreachable router.
    """
    # A bare string is the natural way to call this mid-task, so accept it.
    # Anything else malformed is refused HERE as fix-request: sent onward it
    # would come back as an upstream 400 with a "cloud" suggestion, and a
    # caller typo must not turn into a recommendation to spend cloud money.
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    if not isinstance(messages, list) or not all(
        isinstance(m, dict) and isinstance(m.get("content"), str) for m in messages
    ):
        return _refused(
            "bad-request",
            'messages must be a string or a list of {"role", "content"} dicts',
        )
    base = (url or router_url()).rstrip("/")
    payload = {"messages": messages}
    if options:
        payload.update(options)
    if task_class:
        payload["task_class"] = task_class

    req = urllib.request.Request(
        f"{base}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if task_class:
        # Header as well as body: the router prefers the header, and a proxy in
        # between sets it deliberately.
        req.add_header("x-task-class", task_class)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            err = json.loads(raw).get("error", {})
        except Exception:
            err = {}
        return _refused(
            err.get("code", f"http_{e.code}"),
            err.get("message", raw[:200]),
            status=e.code,
            retry_after=_retry_after(e),
        )
    except urllib.error.URLError as e:
        # Includes timeouts: from here, "no answer" and "no" need the same
        # decision from the caller.
        reason = getattr(e, "reason", e)
        code = "timeout" if "timed out" in str(reason).lower() else "unreachable"
        return _refused(code, f"router at {base}: {reason}")
    except Exception as e:  # noqa: BLE001 - a helper must not take the caller down
        return _refused("unreachable", f"router at {base}: {e}")

    choice = (body.get("choices") or [{}])[0]
    return {
        "ok": True,
        "text": (choice.get("message") or {}).get("content", ""),
        # Which machine and model actually served it -- reported so a caller
        # can log or check it, rather than assuming what it asked for.
        "host": body.get("x_router_host"),
        "model": body.get("model"),
        "usage": body.get("usage") or {},
    }


def _retry_after(http_error):
    value = http_error.headers.get("Retry-After") if http_error.headers else None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def health(timeout=5, url=None):
    """
    What the router sees right now: which machines are up, what is busy.

    Same contract as ask(): a dict either way, never an exception.
    """
    base = (url or router_url()).rstrip("/")
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=timeout) as resp:
            return {"ok": True, **json.loads(resp.read().decode("utf-8"))}
    except Exception as e:  # noqa: BLE001
        return _refused("unreachable", f"router at {base}: {e}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "health":
        print(json.dumps(health(), indent=2, ensure_ascii=False))
    else:
        klass = sys.argv[1] if len(sys.argv) > 1 else None
        prompt = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
        print(json.dumps(ask([{"role": "user", "content": prompt}], task_class=klass), indent=2, ensure_ascii=False))
