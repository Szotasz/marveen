"""
UserPromptSubmit hook: detect PII in inbound <channel> blocks and instruct the
model to use anonymized placeholders in its responses.

Architecture note: UserPromptSubmit hooks inject stdout as context -- they cannot
replace the original prompt. So the model still sees the raw PII in the channel
block, but receives an explicit instruction to use SZEMELY_1/CIM_1/etc. in all
responses. The outbound hook (pii-deanonymize-outbound.py via PreToolUse) then
substitutes placeholders back to real values before the reply leaves Claude.

Saves the marker->original mapping to ~/.pii-mapper/<session_id>/mapping.json
(markers are stable for the whole session, see merge_mapping)
(mode 600, outside the project, not in git).

Fail-safe: if Presidio is unreachable and PII_ANONYMIZE=true, block (exit 2).
"""
import json
import os
import re
import sys
import stat
import urllib.request
import urllib.error

PROJECT_DIR = os.environ.get("CLAUDE_PROJECT_DIR", "")
MAPPER_BASE = os.path.expanduser("~/.pii-mapper")
SERVICE_URL = "http://127.0.0.1:5200"


def is_enabled() -> bool:
    env_file = os.path.join(PROJECT_DIR, ".env")
    if not os.path.exists(env_file):
        return False
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line.startswith("PII_ANONYMIZE="):
                val = line.split("=", 1)[1].strip().strip('"\'')
                return val.lower() in ("true", "1", "yes")
    return False


def call_presidio(text: str) -> dict:
    payload = json.dumps({"text": text}).encode()
    req = urllib.request.Request(
        f"{SERVICE_URL}/anonymize",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def mapping_file(session_id: str) -> str:
    # Claude Code passes session_id in the hook's stdin JSON, not in the env.
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session_id or "") or "default"
    return os.path.join(MAPPER_BASE, safe, "mapping.json")


def load_existing(path: str) -> dict:
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def merge_mapping(existing: dict, new_mapping: dict) -> dict:
    """Re-key Presidio's per-call markers (it numbers from _1 on every call)
    against the session mapping, so a marker never changes meaning mid-session:
    a known original reuses its marker, a new one gets the next free index.
    Returns the marker->original pairs for this message."""
    by_original = {v: k for k, v in existing.items()}
    result: dict = {}
    for marker, original in new_mapping.items():
        if original in by_original:
            result[by_original[original]] = original
            continue
        prefix = marker.rsplit("_", 1)[0]
        n = 1
        while f"{prefix}_{n}" in existing:
            n += 1
        new_marker = f"{prefix}_{n}"
        existing[new_marker] = original
        by_original[original] = new_marker
        result[new_marker] = original
    return result


def save_mapping(path: str, existing: dict) -> None:
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(existing, f, ensure_ascii=False)
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)  # 600
    os.replace(tmp, path)


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        sys.exit(0)

    if not is_enabled():
        sys.exit(0)

    prompt = data.get("prompt", "")
    if not prompt:
        sys.exit(0)

    channel_re = re.compile(r'<channel[^>]*>(.*?)</channel>', re.DOTALL)
    matches = list(channel_re.finditer(prompt))
    if not matches:
        sys.exit(0)

    # Check Presidio health
    try:
        urllib.request.urlopen(f"{SERVICE_URL}/health", timeout=3)
    except Exception:
        sys.stderr.write(
            "PII szűrő (Presidio) nem elérhető. "
            "Indítsd el: scripts/pii-service/start.sh\n"
        )
        sys.exit(2)

    path = mapping_file(data.get("session_id", ""))
    existing = load_existing(path)
    combined_mapping: dict = {}
    for m in matches:
        block_text = m.group(1)
        try:
            result = call_presidio(block_text)
        except Exception as e:
            sys.stderr.write(f"PII szűrő hiba: {e}\n")
            sys.exit(2)
        combined_mapping.update(merge_mapping(existing, result.get("mapping", {})))

    if not combined_mapping:
        sys.exit(0)

    save_mapping(path, existing)

    # Inject plain-text instruction into model context (the only working approach
    # for UserPromptSubmit hooks -- JSON stdout does NOT replace the prompt).
    lines = ["[PII-SZURO] Személyes adatot érzékeltem a bejövő üzenetben."]
    lines.append("A válaszodban KIZAROLAG az alábbi jelölőket használd (ne az eredetit):")
    for marker, original in sorted(combined_mapping.items()):
        lines.append(f"  {marker} = {original}")
    lines.append(
        "A kimenő üzenet (reply tool) automatikusan visszaállítja a valódi neveket."
    )
    sys.stdout.write("\n".join(lines) + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
