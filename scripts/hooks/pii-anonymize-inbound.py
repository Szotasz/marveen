"""
UserPromptSubmit hook: detect PII in inbound <channel> blocks and instruct the
model to use anonymized placeholders in its responses.

Architecture note: UserPromptSubmit hooks inject stdout as context -- they cannot
replace the original prompt. So the model still sees the raw PII in the channel
block, but receives an explicit instruction to use SZEMELY_1/CIM_1/etc. in all
responses. The outbound hook (pii-deanonymize-outbound.py via PreToolUse) then
substitutes placeholders back to real values before the reply leaves Claude.

Saves the marker->original mapping to ~/.pii-mapper/<session_id>/mapping.json
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
SESSION_ID = os.environ.get("CLAUDE_SESSION_ID", "default")
MAPPER_BASE = os.path.expanduser("~/.pii-mapper")
MAPPING_FILE = os.path.join(MAPPER_BASE, SESSION_ID, "mapping.json")
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


def save_mapping(new_mapping: dict) -> None:
    os.makedirs(os.path.dirname(MAPPING_FILE), mode=0o700, exist_ok=True)
    existing: dict = {}
    if os.path.exists(MAPPING_FILE):
        try:
            with open(MAPPING_FILE) as f:
                existing = json.load(f)
        except Exception:
            pass
    existing.update(new_mapping)
    tmp = MAPPING_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(existing, f, ensure_ascii=False)
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)  # 600
    os.replace(tmp, MAPPING_FILE)


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

    combined_mapping: dict = {}
    for m in matches:
        block_text = m.group(1)
        try:
            result = call_presidio(block_text)
        except Exception as e:
            sys.stderr.write(f"PII szűrő hiba: {e}\n")
            sys.exit(2)
        combined_mapping.update(result.get("mapping", {}))

    if not combined_mapping:
        sys.exit(0)

    save_mapping(combined_mapping)

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
