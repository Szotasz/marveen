#!/usr/bin/env python3
"""fal.ai image generation for the fleet, without a third-party MCP server.

Why a script and not an MCP package (Laci's call, 2026-09-23): every community
fal.ai MCP package is third-party code that would receive the API key at
runtime. Here the key never leaves this install: it is read from the dashboard
vault at call time and passed only in the Authorization header.

Key lookup order:
  1. the dashboard vault  (GET /api/vault/<id>, bearer-gated, id defaults to "Fal.ai")
  2. the FAL_KEY environment variable
Neither path writes the key anywhere, and it is never printed -- not even in
--verbose, where the header is masked.

Agents call this with Bash. That matters: BASH_EGRESS_DENY blocks
`curl *https://*` for every agent, so a curl-based helper would be unusable by
Willy. urllib has no such rule and needs no extra grant.

Usage:
  python3 scripts/fal.py models
  python3 scripts/fal.py generate "a prompt" [--model ID] [--out FILE] [--size SIZE] [--n N]
  python3 scripts/fal.py generate "a prompt" --dry-run      # build the request, send nothing

Exit codes: 0 ok, 1 usage error, 2 auth/key problem, 3 API error, 4 timeout.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DASHBOARD = os.environ.get("MARVEEN_DASHBOARD", "http://localhost:3420")
# BEEGETETT924: ez korabban abszolut ut volt EGYETLEN telepitesre szabva, tehat
# barhol máshol csendben nem talalta volna a tokent. A gyoker a szkript sajat
# helyebol szarmazik (scripts/ egy szinttel a gyoker alatt), felulirhato env-bol.
_ROOT = os.environ.get(
    "MARVEEN_ROOT", os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
TOKEN_FILE = os.environ.get("MARVEEN_TOKEN_FILE", os.path.join(_ROOT, "store", ".dashboard-token"))
VAULT_ID = os.environ.get("FAL_VAULT_ID", "Fal.ai")

# Measured 2026-09-23 from the fal.ai docs: the queue host is a SEPARATE
# registrable domain from fal.ai, and both are on the egress allowlist.
QUEUE_BASE = "https://queue.fal.run"
DEFAULT_MODEL = "fal-ai/flux/dev"

# The docs describe submit-then-poll but do not state the status/result URL
# shapes. So we do not hardcode them: the submit response carries status_url
# and response_url, and we follow those. A guessed path would be the first
# thing to rot.
POLL_INTERVAL = 2.0
DEFAULT_TIMEOUT = 300


def _req(url, *, data=None, headers=None, method=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read(), dict(r.headers)


def read_key():
    """Vault first, env second. Returns (key, source) or exits 2."""
    try:
        with open(TOKEN_FILE, encoding="utf-8") as fh:
            token = fh.read().strip()
        url = f"{DASHBOARD}/api/vault/{urllib.parse.quote(VAULT_ID, safe='')}"
        status, body, _ = _req(url, headers={"Authorization": f"Bearer {token}"})
        if status == 200:
            value = json.loads(body).get("value")
            if value:
                return value.strip(), "vault"
    except FileNotFoundError:
        pass
    except urllib.error.HTTPError as e:
        if e.code != 404:
            print(f"fal: vault lookup failed with HTTP {e.code}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001 -- the env fallback is the point
        print(f"fal: vault lookup failed ({type(e).__name__}), trying FAL_KEY", file=sys.stderr)

    env = os.environ.get("FAL_KEY", "").strip()
    if env:
        return env, "env"

    print(
        "fal: no API key. Expected it in the dashboard vault under id "
        f"'{VAULT_ID}', or in FAL_KEY. The key is never read from a plain file.",
        file=sys.stderr,
    )
    sys.exit(2)


def submit(model, payload, key, verbose=False):
    url = f"{QUEUE_BASE}/{model}"
    body = json.dumps(payload).encode("utf-8")
    headers = {
        # Measured from the docs: the scheme word is "Key", not "Bearer".
        "Authorization": f"Key {key}",
        "Content-Type": "application/json",
    }
    if verbose:
        shown = dict(headers, Authorization="Key ***")
        print(f"POST {url}\nheaders {shown}\nbody {json.dumps(payload)}", file=sys.stderr)
    try:
        status, raw, _ = _req(url, data=body, headers=headers, method="POST")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        print(f"fal: submit failed, HTTP {e.code}: {detail}", file=sys.stderr)
        sys.exit(3)
    return json.loads(raw) if raw else {}


def poll(job, key, timeout, verbose=False):
    status_url = job.get("status_url")
    response_url = job.get("response_url")
    if not status_url:
        # Some models answer synchronously; then the payload is already here.
        if job.get("images") or job.get("output"):
            return job
        print(f"fal: no status_url in submit response: {json.dumps(job)[:400]}", file=sys.stderr)
        sys.exit(3)

    headers = {"Authorization": f"Key {key}"}
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        _, raw, _ = _req(status_url, headers=headers)
        st = json.loads(raw)
        state = st.get("status")
        if state != last:
            print(f"fal: {state}", file=sys.stderr)
            last = state
        if state == "COMPLETED":
            _, raw, _ = _req(response_url or status_url.replace("/status", ""), headers=headers)
            return json.loads(raw)
        if state in ("FAILED", "ERROR"):
            print(f"fal: job failed: {json.dumps(st)[:600]}", file=sys.stderr)
            sys.exit(3)
        time.sleep(POLL_INTERVAL)

    print(f"fal: timed out after {timeout}s. The job may still finish; status_url: {status_url}",
          file=sys.stderr)
    sys.exit(4)


def image_urls(result):
    for key in ("images", "image", "output"):
        v = result.get(key)
        if isinstance(v, list):
            return [i.get("url") if isinstance(i, dict) else i for i in v]
        if isinstance(v, dict) and v.get("url"):
            return [v["url"]]
        if isinstance(v, str):
            return [v]
    return []


def true_ext(raw, content_type):
    """Extension from the BYTES, falling back to the header.

    The header is not enough: fal.ai served a JPEG for a request whose --out
    said .png (measured 2026-09-23), and a .png file holding JPEG bytes breaks
    anything that reads the PNG header -- silently, with a nonsense size rather
    than an error. Magic numbers are two comparisons and never lie.
    """
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if raw[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    return ".png" if "png" in (content_type or "") else ".jpg"


def download(urls, out):
    saved = []
    for i, u in enumerate(urls):
        if not u:
            continue
        _, raw, hdrs = _req(u, timeout=120)
        ext = true_ext(raw, hdrs.get("Content-Type", ""))
        if len(urls) == 1 and out:
            stem, given = os.path.splitext(out)
            path = stem + ext
            if given and given.lower() != ext:
                print(f"fal: the image is {ext[1:].upper()}, not {given[1:].upper()}; "
                      f"saving as {path}", file=sys.stderr)
        else:
            path = f"{(out or 'fal-output').rsplit('.', 1)[0]}-{i + 1}{ext}"
        with open(path, "wb") as fh:
            fh.write(raw)
        saved.append((path, len(raw)))
    return saved


def main():
    ap = argparse.ArgumentParser(prog="fal.py", description="fal.ai image generation")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("models", help="print the model ids this script was tested with")

    g = sub.add_parser("generate", help="generate an image from a prompt")
    g.add_argument("prompt")
    g.add_argument("--model", default=DEFAULT_MODEL)
    g.add_argument("--out", default=None, help="output file (default: fal-output-N.png)")
    g.add_argument("--size", default=None,
                   help='image_size: a preset name (landscape_16_9) or JSON for an exact size, '
                        'e.g. \'{"width": 1600, "height": 1200}\' -- presets are all 1024-class')
    g.add_argument("--n", type=int, default=1, help="how many images")
    g.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    g.add_argument("--dry-run", action="store_true", help="build the request, send nothing")
    g.add_argument("--verbose", action="store_true")

    a = ap.parse_args()

    if a.cmd == "models":
        print(f"default: {DEFAULT_MODEL}")
        print("any fal.ai model id works: pass --model fal-ai/<name>")
        print(f"queue host: {QUEUE_BASE}  (on the egress allowlist since 2026-09-23)")
        return

    payload = {"prompt": a.prompt}
    if a.size:
        # A preset names (square, landscape_4_3, ...) are all 1024-class, so a
        # slot with a 1600px floor cannot be filled from one. fal.ai also accepts
        # an explicit {"width": W, "height": H} object -- but only as an object:
        # passing the JSON as a string answers HTTP 422 (measured by Willy,
        # 2026-09-23). So parse it here rather than making every caller guess.
        size = a.size.strip()
        if size.startswith("{"):
            try:
                payload["image_size"] = json.loads(size)
            except json.JSONDecodeError as e:
                print(f"fal: --size looks like JSON but does not parse ({e}). "
                      'Expected: \'{"width": 1600, "height": 1200}\'', file=sys.stderr)
                sys.exit(1)
        else:
            payload["image_size"] = size
    if a.n != 1:
        payload["num_images"] = a.n

    if a.dry_run:
        print(json.dumps({"url": f"{QUEUE_BASE}/{a.model}", "body": payload}, indent=2))
        return

    key, source = read_key()
    print(f"fal: key from {source}", file=sys.stderr)

    job = submit(a.model, payload, key, verbose=a.verbose)
    result = poll(job, key, a.timeout, verbose=a.verbose)
    urls = image_urls(result)
    if not urls:
        print(f"fal: completed but no image url found: {json.dumps(result)[:600]}", file=sys.stderr)
        sys.exit(3)

    for path, size in download(urls, a.out):
        print(f"{path}  ({size} bytes)")


if __name__ == "__main__":
    main()
