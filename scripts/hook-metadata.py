#!/usr/bin/env python3
"""Hook fingerprint-drift validator for a Claude Code settings.json (HOOKDRIFT926).

Claude Code's settings schema has no room for our own bookkeeping on a hook
(an unknown key is dropped with a warning at best), so a stable id, a one-line
purpose and a fingerprint live in a SIDECAR next to the settings file:
.claude/hooks.metadata.json, one entry per matcher group, keyed by event and
index. Concept adapted from affaan-m/ECC (MIT) hooks.metadata.json; no code
of theirs is used.

The fingerprint is sha256 over [event, matcher, [command of each handler]]
(a non-command handler contributes its prompt / url). Timeouts are NOT part of
it: raising a timeout is not a behaviour change worth a metadata edit.

Validation fails (exit 1) on:
  MISSING_METADATA  a matcher group in settings has no metadata entry
  ORPHAN_METADATA   a metadata entry points at a group that is not there
  DRIFT             command/matcher edited without updating the metadata
  REORDERED         a known fingerprint sits at a different event/index
  MISSING_SCRIPT    a hook command names a script file that does not exist
  FORBIDDEN_KEY     a key outside the Claude Code hook schema (id, description...)
  SCHEMA            structurally broken hooks block
  BAD_METADATA      malformed sidecar (bad index, duplicate id, ...)
  GATE_*            gate flag and the effective lock list disagree (the
                    built-in hook_switches.DEFAULT_NON_DISABLEABLE plus the
                    sidecar's own top-level "non_disableable" list)

Usage:
  python3 scripts/hook-metadata.py                         # validate the repo's .claude/settings.json
  python3 scripts/hook-metadata.py --settings /path/.claude/settings.json
  python3 scripts/hook-metadata.py --update                # rewrite the sidecar, print the diff
  python3 scripts/hook-metadata.py --metadata other.json --project-dir /x

stdlib only. Exit codes: 0 valid, 1 findings (a missing sidecar is the
MISSING_METADATA finding), 2 usage / unreadable input (missing settings, a
file that cannot be opened or is not valid JSON).

--update invariant: the sidecar is written only after BOTH inputs (the
settings it regenerates from and the existing sidecar) have been read and
checked by preflight() with zero settings SCHEMA / FORBIDDEN_KEY findings and
nothing it cannot carry over, and the new text has been built and encoded.
On anything else it exits 2 and the sidecar is byte-identical; every check
runs before the temp file is created. It writes back exactly what it read
except the fields it regenerates (version, _comment, hooks entries); the
install's non_disableable value and unknown top-level keys are carried over
verbatim. A failure while writing is also exit 2, with the temp file removed.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
import stat
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOKS_DIR = os.path.join(ROOT, "scripts", "hooks")
sys.path.insert(0, HOOKS_DIR)
import hook_switches  # noqa: E402

METADATA_VERSION = 1
METADATA_BASENAME = "hooks.metadata.json"

GROUP_KEYS = frozenset({"matcher", "hooks"})
# Handler keys Claude Code documents (command / prompt / agent / http handlers).
HANDLER_KEYS = frozenset({
    "type", "command", "timeout", "statusMessage", "async",
    "url", "headers", "allowedEnvVars", "prompt", "model",
})
SIDECAR_KEYS = frozenset({"id", "description", "purpose", "fingerprint", "gate", "hook"})
KNOWN_EVENTS = frozenset({
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
    "UserPromptSubmit", "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
    "PreCompact", "SessionStart", "SessionEnd",
})
ENTRY_KEYS = frozenset({"index", "id", "hook", "gate", "purpose", "fingerprint"})
FP_RE = re.compile(r"^[0-9a-f]{64}$")
GATE_NAME_RE = re.compile(r"[-_](gate|guard)$")

# Script references inside a command string: anything ending in a script
# extension, either anchored on a project-dir variable / absolute / home path,
# or a relative path with at least one directory component.
_SCRIPT_EXT = r"\.(?:py|mjs|cjs|js|sh|ts)"
_STOP = r"[^\s\"'`;|&<>()]"
SCRIPT_RE = re.compile(
    r"(?:\$\{?CLAUDE_PROJECT_DIR\}?|\{\{PROJECT_ROOT\}\}|~|/)" + _STOP + r"*?" + _SCRIPT_EXT + r"(?![\w.])"
    r"|(?<![\w/.$}~-])[\w.-]+(?:/[\w.-]+)+" + _SCRIPT_EXT + r"(?![\w.])"
)


class Finding:
    def __init__(self, code, where, message):
        self.code, self.where, self.message = code, where, message

    def __str__(self):
        return "%s %s: %s" % (self.code, self.where, self.message)


# ---------------------------------------------------------------- settings --

def handler_payload(handler):
    for key in ("command", "prompt", "url"):
        if isinstance(handler.get(key), str):
            return handler[key]
    return ""


def fingerprint(event, group):
    handlers = group.get("hooks") if isinstance(group.get("hooks"), list) else []
    body = [event, group.get("matcher") or "",
            [handler_payload(h) for h in handlers if isinstance(h, dict)]]
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    # surrogatepass: identical bytes for every valid string; a lone surrogate
    # (reported as SCHEMA by check_structure) must not crash the validator.
    return hashlib.sha256(raw.encode("utf-8", "surrogatepass")).hexdigest()


def script_refs(command, project_dir):
    """(token, resolved path or None) for every script a command names."""
    out = []
    for m in SCRIPT_RE.finditer(command or ""):
        token = m.group(0)
        path = (token.replace("${CLAUDE_PROJECT_DIR}", project_dir)
                .replace("$CLAUDE_PROJECT_DIR", project_dir)
                .replace("{{PROJECT_ROOT}}", project_dir))
        path = os.path.expanduser(os.path.expandvars(path))
        if "$" in path:
            out.append((token, None))
            continue
        if not os.path.isabs(path):
            path = os.path.join(project_dir, path)
        out.append((token, os.path.normpath(path)))
    return out


def hook_name(group, project_dir):
    """Stem of the first script a group runs (the MARVEEN_DISABLED_HOOKS name)."""
    for h in group.get("hooks") or []:
        if isinstance(h, dict):
            for token, _ in script_refs(handler_payload(h), project_dir):
                return hook_switches.normalize(token)
    return None


def load_json(path, label):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        msg = "error: %s not found: %s" % (label, path)
    except (OSError, ValueError, RecursionError) as e:
        msg = "error: cannot read %s %s: %s" % (label, path, e)
    print(msg, file=sys.stderr)
    raise SystemExit(2)


def events_of(settings, findings):
    hooks = settings.get("hooks", {}) if isinstance(settings, dict) else None
    if not isinstance(hooks, dict):
        findings.append(Finding("SCHEMA", "hooks", "must be an object"))
        return {}
    out = {}
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            findings.append(Finding("SCHEMA", event, "must be an array of matcher groups"))
            continue
        out[event] = groups
    return out


def check_structure(events, project_dir, findings, warnings):
    try:
        json.dumps(events, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError as e:
        findings.append(Finding("SCHEMA", "hooks", "contains text that is not valid UTF-8 (%s)" % e))
    except RecursionError:
        findings.append(Finding("SCHEMA", "hooks", "is nested too deeply to process"))
    for event, groups in events.items():
        if event not in KNOWN_EVENTS:
            warnings.append("unknown hook event %r (typo, or newer than this validator?)" % event)
        for i, group in enumerate(groups):
            where = "%s[%d]" % (event, i)
            if not isinstance(group, dict):
                findings.append(Finding("SCHEMA", where, "matcher group must be an object"))
                continue
            for key in group:
                if key not in GROUP_KEYS:
                    hint = " (belongs in %s)" % METADATA_BASENAME if key in SIDECAR_KEYS else ""
                    findings.append(Finding("FORBIDDEN_KEY", where, "group key %r is not in the hook schema%s" % (key, hint)))
            handlers = group.get("hooks")
            if not isinstance(handlers, list) or not handlers:
                findings.append(Finding("SCHEMA", where, "'hooks' must be a non-empty array"))
                continue
            for j, h in enumerate(handlers):
                hwhere = "%s.hooks[%d]" % (where, j)
                if not isinstance(h, dict):
                    findings.append(Finding("SCHEMA", hwhere, "handler must be an object"))
                    continue
                for key in h:
                    if key not in HANDLER_KEYS:
                        hint = " (belongs in %s)" % METADATA_BASENAME if key in SIDECAR_KEYS else ""
                        findings.append(Finding("FORBIDDEN_KEY", hwhere, "handler key %r is not in the hook schema%s" % (key, hint)))
                if h.get("type") == "command" and not isinstance(h.get("command"), str):
                    findings.append(Finding("SCHEMA", hwhere, "command handler without a 'command' string"))
                for token, path in script_refs(handler_payload(h), project_dir):
                    if path is None:
                        warnings.append("%s: cannot resolve %r (unknown variable), existence not checked" % (hwhere, token))
                    elif not os.path.isfile(path):
                        findings.append(Finding("MISSING_SCRIPT", hwhere, "%s -> %s does not exist" % (token, path)))


# ---------------------------------------------------------------- metadata --

def metadata_events(metadata, findings):
    if not isinstance(metadata, dict) or not isinstance(metadata.get("hooks"), dict):
        findings.append(Finding("BAD_METADATA", "hooks", "sidecar must be an object with a 'hooks' object"))
        return {}
    out = {}
    seen_ids = {}
    for event, entries in metadata["hooks"].items():
        if not isinstance(entries, list):
            findings.append(Finding("BAD_METADATA", event, "must be an array"))
            continue
        clean = []
        for i, e in enumerate(entries):
            where = "metadata %s[%d]" % (event, i)
            if not isinstance(e, dict):
                findings.append(Finding("BAD_METADATA", where, "entry must be an object"))
                clean.append({})
                continue
            extra = set(e) - ENTRY_KEYS
            if extra:
                findings.append(Finding("BAD_METADATA", where, "unknown keys %s" % sorted(extra)))
            if e.get("index") != i:
                findings.append(Finding("BAD_METADATA", where, "index field %r does not match its position %d" % (e.get("index"), i)))
            if not isinstance(e.get("id"), str) or not e["id"]:
                findings.append(Finding("BAD_METADATA", where, "missing id"))
            elif e["id"] in seen_ids:
                findings.append(Finding("BAD_METADATA", where, "duplicate id %r (also at %s)" % (e["id"], seen_ids[e["id"]])))
            else:
                seen_ids[e["id"]] = "%s[%d]" % (event, i)
            if not isinstance(e.get("fingerprint"), str) or not FP_RE.match(e["fingerprint"]):
                findings.append(Finding("BAD_METADATA", where, "fingerprint must be 64 hex chars"))
            if not isinstance(e.get("gate"), bool):
                findings.append(Finding("BAD_METADATA", where, "gate must be true or false"))
            clean.append(e)
        out[event] = clean
    return out


def compare(events, meta, findings):
    # Where each fingerprint is registered in the sidecar, and where it
    # actually sits in settings.
    known = {}
    for event, entries in meta.items():
        for i, e in enumerate(entries):
            if e.get("fingerprint"):
                known.setdefault(e["fingerprint"], []).append((event, i, e.get("id")))
    present = set()
    for event, groups in events.items():
        for group in groups:
            if isinstance(group, dict):
                present.add(fingerprint(event, group))

    drifted = set()  # (event, index) of sidecar entries explained as an in-place edit
    for event in sorted(events):
        entries = meta.get(event, [])
        for i, group in enumerate(events[event]):
            if not isinstance(group, dict):
                continue  # already a SCHEMA finding
            where = "%s[%d]" % (event, i)
            entry = entries[i] if i < len(entries) else None
            actual = fingerprint(event, group)
            if entry is not None and entry.get("fingerprint") == actual:
                continue
            elsewhere = [(ev, j, hid) for ev, j, hid in known.get(actual, []) if (ev, j) != (event, i)]
            if elsewhere:
                ev, j, hid = elsewhere[0]
                findings.append(Finding("REORDERED", where, "hook %r is registered in metadata at %s[%d]; it was moved without updating the sidecar" % (hid, ev, j)))
            elif entry is not None and entry.get("fingerprint") not in present:
                drifted.add((event, i))
                findings.append(Finding("DRIFT", where, "fingerprint changed for id %r: matcher/command edited without updating the sidecar (now: %s)" % (entry.get("id"), describe(group))))
            else:
                findings.append(Finding("MISSING_METADATA", where, "hook has no metadata entry (%s)" % describe(group)))

    for event in sorted(meta):
        for i, e in enumerate(meta[event]):
            if (event, i) in drifted or e.get("fingerprint") in present:
                continue
            findings.append(Finding("ORPHAN_METADATA", "metadata %s[%d]" % (event, i), "id %r describes a hook that is no longer in settings" % e.get("id")))


def check_gates(events, meta, project_dir, locked_set, findings):
    for event, groups in events.items():
        entries = meta.get(event, [])
        for i, group in enumerate(groups):
            if not isinstance(group, dict):
                continue
            where = "%s[%d]" % (event, i)
            name = hook_name(group, project_dir)
            locked = bool(name) and name in locked_set
            if name and GATE_NAME_RE.search(name) and not locked:
                findings.append(Finding("GATE_NOT_LOCKED", where, "%r looks like a gate but is not locked (add it to the sidecar's %r list, or to hook_switches.DEFAULT_NON_DISABLEABLE if it ships with the repo)" % (name, hook_switches.SIDECAR_LOCK_KEY)))
            entry = entries[i] if i < len(entries) else None
            if not entry or entry.get("fingerprint") != fingerprint(event, group):
                continue  # not this group's entry: compare() already reported it
            if entry.get("hook") != name:
                findings.append(Finding("BAD_METADATA", where, "hook field %r does not match the script this group runs (%r), so its gate flag cannot be checked" % (entry.get("hook"), name)))
                continue
            if not isinstance(entry.get("gate"), bool):
                continue  # already a BAD_METADATA finding
            if entry["gate"] and not locked:
                findings.append(Finding("GATE_NOT_LOCKED", where, "metadata marks %r as a gate but the lock list lacks it, so an env var could disable it" % name))
            if locked and not entry["gate"]:
                findings.append(Finding("GATE_UNFLAGGED", where, "%r is locked but its metadata says gate=false" % name))


def describe(group):
    cmds = [handler_payload(h) for h in group.get("hooks") or [] if isinstance(h, dict)]
    text = "matcher=%r cmd=%r" % (group.get("matcher") or "", cmds[0] if len(cmds) == 1 else cmds)
    return text if len(text) <= 200 else text[:197] + "..."


def purpose_from_script(group, project_dir):
    """First sentence of the script's docstring / header comment, as a draft purpose."""
    for h in group.get("hooks") or []:
        if not isinstance(h, dict):
            continue
        for _, path in script_refs(handler_payload(h), project_dir):
            if not path or not os.path.isfile(path):
                continue
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    lines = f.read(6000).splitlines()
            except OSError:
                continue
            para = []
            for line in lines:
                s = line.strip()
                if s.startswith("#!") or s.startswith("import ") or s.startswith("from ") or s.startswith("set -"):
                    if para:
                        break
                    continue
                s = s.lstrip("#/*").strip().strip('"').strip("'").strip()
                if not s or s in ("use strict", "use strict;"):
                    if para:
                        break
                    continue
                para.append(s)
            text = " ".join(para)
            m = re.search(r"^(.+?[.!?])(?:\s|$)", text)
            text = m.group(1) if m else text
            if text:
                return text if len(text) <= 160 else text[:157].rstrip() + "..."
    return "TODO: one-line purpose"


# ---------------------------------------------------------------- update ----

def slug(text, limit=40):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s[:limit].rstrip("-") or "any"


def matcher_slug(matcher):
    """Short readable tag for a matcher: 'mcp__x__reply|mcp__x__edit_message' -> 'reply+edit-message'."""
    text = re.sub(r"\[(\w)\w*\]", r"\1", matcher or "")
    parts = []
    for alt in text.split("|"):
        tail = alt.split("__")[-1] if slug(alt.split("__")[-1]) != "any" else alt
        parts.append(slug(tail, 20))
    return slug("+".join(parts).replace("+", "PLUS"), 40).replace("plus", "+")


def event_slug(event):
    return re.sub(r"(?<!^)(?=[A-Z])", "-", event).lower()


def match_old_entries(groups_info, old_meta):
    """{(event, index): old entry} -- which old entry each settings group inherits.

    An id / purpose follows its hook and never moves to a different group:
    1. every exact fingerprint match at the same slot, across ALL groups;
    2. every remaining exact fingerprint match anywhere (a moved hook);
    3. only for the leftovers (an edited command or matcher): per event and
       hook name, the leftover groups inherit the leftover entries in order,
       but ONLY when both counts are equal. Otherwise (an edit mixed with an
       insert or a delete of the same script) the pairing would be a guess,
       so those groups get a fresh id and a drafted purpose instead.
    """
    old = [(ev, j, e) for ev, entries in old_meta.items() for j, e in enumerate(entries) if isinstance(e, dict)]
    used, prev_of = set(), {}

    def take(pred):
        for gi in groups_info:
            key = (gi[0], gi[1])
            if key in prev_of:
                continue
            for k, (ev, j, e) in enumerate(old):
                if k not in used and pred(gi, ev, j, e):
                    used.add(k)
                    prev_of[key] = e
                    break

    take(lambda gi, ev, j, e: ev == gi[0] and j == gi[1] and e.get("fingerprint") == gi[3])
    take(lambda gi, ev, j, e: ev == gi[0] and e.get("fingerprint") == gi[3])
    left_groups, left_entries = {}, {}
    for gi in groups_info:
        if (gi[0], gi[1]) not in prev_of:
            left_groups.setdefault((gi[0], gi[4]), []).append((gi[0], gi[1]))
    for k, (ev, j, e) in enumerate(old):
        if k not in used:
            left_entries.setdefault((ev, e.get("hook")), []).append(e)
    for key, slots in left_groups.items():
        entries = left_entries.get(key, [])
        if len(entries) == len(slots):
            for slot, e in zip(slots, entries):
                prev_of[slot] = e
    return prev_of


def build_metadata(events, old_meta, project_dir, locked_set, carried=None, keep_old_gate=False):
    """A fresh sidecar for `events`.

    `carried`: top-level keys of the old sidecar that are written back
    verbatim (the install's non_disableable list, unknown keys), in their
    original order. `keep_old_gate`: the old lock list is unreadable, so the
    install's own locks are unknown; an entry keeps its old gate flag (the
    built-in floor still forces gate=true).
    """
    groups_info = []  # (event, index, group, fingerprint, hook name), settings order
    for event, groups in events.items():
        for i, group in enumerate(groups):
            if isinstance(group, dict):  # preflight refuses anything else
                groups_info.append((event, i, group, fingerprint(event, group), hook_name(group, project_dir)))
    prev_of = match_old_entries(groups_info, old_meta)

    new = {}
    # An old id that no group inherits is not handed out again in this run:
    # a fresh id must not look like the label of a different, older hook.
    inherited = {id(e) for e in prev_of.values()}
    taken = {e.get("id") for entries in old_meta.values() for e in entries
             if isinstance(e, dict) and id(e) not in inherited}
    pending = []  # entries that still need a fresh id
    for event, groups in events.items():
        out = []
        for i, group in enumerate(groups):
            if not isinstance(group, dict):
                continue
            fp = fingerprint(event, group)
            name = hook_name(group, project_dir)
            prev = prev_of.get((event, i))
            entry = {
                "index": len(out),
                "id": prev.get("id") if prev and prev.get("id") not in taken else None,
                "hook": name,
                "gate": bool(name) and (name in locked_set or (
                    keep_old_gate and prev is not None and prev.get("gate") is True)),
                "purpose": (prev or {}).get("purpose") or purpose_from_script(group, project_dir),
                "fingerprint": fp,
            }
            if entry["id"]:
                taken.add(entry["id"])
            else:
                pending.append((event, group, entry))
            out.append(entry)
        new[event] = out
    for event, group, entry in pending:
        base = "%s/%s" % (event_slug(event), entry["hook"] or slug(describe(group)))
        cand = base
        if cand in taken:
            cand = "%s/%s" % (base, matcher_slug(group.get("matcher")))
        n = 2
        while cand in taken:
            cand = "%s-%d" % (base, n)
            n += 1
        entry["id"] = cand
        taken.add(cand)
    out = {
        "version": METADATA_VERSION,
        "_comment": ("Sidecar for the hooks block of settings.json (HOOKDRIFT926). One entry per matcher "
                     "group, same event and index. After editing hooks run: python3 scripts/hook-metadata.py "
                     "--update, review the printed diff, fix any TODO purpose, commit both files. "
                     "Optional top-level %r: extra hook names (this install's own gates / audit "
                     "ledgers) that MARVEEN_DISABLED_HOOKS may never switch off; it can only add to "
                     "the built-in list in scripts/hooks/hook_switches.py." % hook_switches.SIDECAR_LOCK_KEY),
    }
    for key, value in (carried or {}).items():
        out[key] = value
    out["hooks"] = new
    return out


def dump(meta):
    return json.dumps(meta, ensure_ascii=False, indent=2) + "\n"


# ---------------------------------------------------------------- main ------

def default_project_dir(settings_path):
    d = os.path.dirname(os.path.abspath(settings_path))
    return os.path.dirname(d) if os.path.basename(d) == ".claude" else d


def effective_locks(metadata_path, findings=None):
    """Built-in lock floor plus the validated sidecar's own additions."""
    extra, ok = hook_switches.sidecar_locks(metadata_path)
    if not ok and findings is not None:
        findings.append(Finding("BAD_METADATA", hook_switches.SIDECAR_LOCK_KEY,
                                "must be an array of hook names; while it is unreadable no hook is env-disableable"))
    return hook_switches.DEFAULT_NON_DISABLEABLE | extra


def validate(settings_path, metadata_path, project_dir):
    findings, warnings = [], []
    settings = load_json(settings_path, "settings")
    events = events_of(settings, findings)
    check_structure(events, project_dir, findings, warnings)
    if not os.path.exists(metadata_path):
        findings.append(Finding("MISSING_METADATA", metadata_path, "sidecar file does not exist; create it with --update"))
        return findings, warnings
    meta = metadata_events(load_json(metadata_path, "metadata"), findings)
    locked_set = effective_locks(metadata_path, findings)
    compare(events, meta, findings)
    check_gates(events, meta, project_dir, locked_set, findings)
    for event, entries in meta.items():
        for i, e in enumerate(entries):
            if str(e.get("purpose") or "").startswith("TODO") or not e.get("purpose"):
                warnings.append("metadata %s[%d] (%s) has no real purpose yet" % (event, i, e.get("id")))
    return findings, warnings


REGENERATED_KEYS = frozenset({"version", "_comment", "hooks"})
# Settings findings that mean the hooks block cannot be mapped onto sidecar
# entries faithfully (an event or group would be skipped or renumbered).
# MISSING_SCRIPT is not one of them: it does not change what is written, and
# the validation after the write still reports it.
BLOCKING_SETTINGS_CODES = frozenset({"SCHEMA", "FORBIDDEN_KEY"})
ENTRY_TYPES = {
    "index": lambda v: type(v) is int,
    "id": lambda v: isinstance(v, str) and v != "",
    "hook": lambda v: v is None or isinstance(v, str),
    "gate": lambda v: type(v) is bool,
    "purpose": lambda v: isinstance(v, str),
    "fingerprint": lambda v: isinstance(v, str),
}


def read_input(path):
    """(text, parsed JSON, None) or (None, None, error text). Never exits."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        return text, json.loads(text), None
    except (OSError, ValueError, RecursionError) as e:
        return None, None, str(e)


def sidecar_reasons(raw):
    """Why --update could not carry this sidecar over faithfully ([] = it can).

    --update writes back exactly what it read except the fields it
    regenerates; anything it could not carry over makes it refuse.
    """
    if not isinstance(raw, dict):
        return ["its top level is %s, not an object" % type(raw).__name__]
    out = []
    if "version" in raw and not (type(raw["version"]) is int and raw["version"] == METADATA_VERSION):
        out.append("version %r is not %d, the version this tool writes" % (raw["version"], METADATA_VERSION))
    hooks = raw.get("hooks")
    if not isinstance(hooks, dict):
        out.append("'hooks' is %s, not an object" % ("missing" if "hooks" not in raw else type(hooks).__name__))
        return out
    ids = {}
    for event, entries in hooks.items():
        if not isinstance(entries, list):
            out.append("hooks.%s is %s, not an array" % (event, type(entries).__name__))
            continue
        for i, e in enumerate(entries):
            where = "hooks.%s[%d]" % (event, i)
            if not isinstance(e, dict):
                out.append("%s is %s, not an object" % (where, type(e).__name__))
                continue
            extra = set(e) - ENTRY_KEYS
            if extra:
                out.append("%s has keys this tool would drop: %s" % (where, sorted(extra)))
            for key, ok in sorted(ENTRY_TYPES.items()):
                if key not in e:
                    out.append("%s has no %r" % (where, key))
                elif not ok(e[key]):
                    out.append("%s %r is %r, not a valid %s" % (where, key, e[key], key))
            if isinstance(e.get("id"), str):
                if e["id"] in ids:
                    out.append("%s repeats id %r of %s" % (where, e["id"], ids[e["id"]]))
                ids.setdefault(e["id"], where)
    return out


def preflight(settings_path, metadata_path, project_dir):
    """The one gate in front of the sidecar write.

    Reads and checks BOTH inputs (the settings it regenerates from and the
    existing sidecar) and builds the new text. Returns (reasons, plan): any
    reason means --update must exit 2 without touching the file; plan holds
    what the write needs (old text, new text, file mode). Nothing here
    creates a file.
    """
    reasons = []
    _, settings, why = read_input(settings_path)
    if why:
        return ["cannot read the settings %s as JSON (%s)" % (settings_path, why)], None
    findings, scratch_warnings = [], []
    events = events_of(settings, findings)
    check_structure(events, project_dir, findings, scratch_warnings)
    for f in findings:
        if f.code in BLOCKING_SETTINGS_CODES:
            reasons.append("settings %s" % f)

    old_text, raw, exists = "", None, os.path.lexists(metadata_path)
    if exists:
        old_text, raw, why = read_input(metadata_path)
        if why:
            reasons.append("cannot read it as JSON (%s)" % why)
        else:
            reasons.extend(sidecar_reasons(raw))
            has_entries = isinstance(raw, dict) and isinstance(raw.get("hooks"), dict) and any(
                isinstance(v, list) and v for v in raw["hooks"].values())
            if has_entries and isinstance(settings, dict) and "hooks" not in settings:
                # Most likely a truncated or wrong settings file; regenerating
                # would silently empty every entry (ids, purposes).
                reasons.append("the settings have no 'hooks' key but the sidecar has entries; "
                               "if every hook was removed on purpose, delete the sidecar entries by hand")
    if reasons:
        return reasons, None

    old_meta, carried = {}, {}
    locked_set, keep_old_gate = hook_switches.DEFAULT_NON_DISABLEABLE, False
    if exists:
        old_meta = metadata_events(raw, [])
        # Written back verbatim: the install's lock list (a malformed one,
        # null included, stays visible to the validation after the write) and
        # any key this version does not know.
        carried = {k: v for k, v in raw.items() if k not in REGENERATED_KEYS}
        extra, ok = hook_switches.parse_locks(raw)
        locked_set = hook_switches.DEFAULT_NON_DISABLEABLE | extra
        keep_old_gate = not ok
    try:
        new_text = dump(build_metadata(events, old_meta, project_dir, locked_set, carried, keep_old_gate))
        data = new_text.encode("utf-8")
        if exists:
            mode = stat.S_IMODE(os.stat(metadata_path).st_mode)
        else:
            umask = os.umask(0)
            os.umask(umask)
            mode = 0o666 & ~umask
    except Exception as e:  # e.g. a lone surrogate that UTF-8 cannot encode
        return ["cannot build the new version (%s: %s)" % (type(e).__name__, e)], None
    return [], {"old_text": old_text, "new_text": new_text, "data": data, "mode": mode}


def write_sidecar(metadata_path, data, mode):
    """Atomic replace; returns None or the failure. The temp file never survives."""
    fd, tmp = None, None
    try:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(metadata_path),
                                   prefix=os.path.basename(metadata_path) + ".", suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            fd = None
            f.write(data)
        os.chmod(tmp, mode)  # mkstemp creates 0600; the sidecar is a tracked file
        os.replace(tmp, metadata_path)
        tmp = None
        return None
    except Exception as e:
        return "%s: %s" % (type(e).__name__, e)
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if tmp is not None:
            try:
                os.remove(tmp)
            except OSError:
                pass


def refuse_update(metadata_path, reasons):
    if isinstance(reasons, str):
        reasons = [reasons]
    print("error: refusing to rewrite %s: %s. Fix or restore the input first (e.g. resolve the merge "
          "conflict); the sidecar was left untouched." % (metadata_path, "; ".join(reasons)), file=sys.stderr)
    return 2


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--settings", default=os.path.join(ROOT, ".claude", "settings.json"))
    ap.add_argument("--metadata", help="sidecar path (default: hooks.metadata.json next to --settings)")
    ap.add_argument("--project-dir", help="value of $CLAUDE_PROJECT_DIR (default: parent of the .claude dir)")
    ap.add_argument("--update", action="store_true", help="rewrite the sidecar from settings, print the diff")
    args = ap.parse_args(argv)

    settings_path = os.path.abspath(args.settings)
    metadata_path = os.path.abspath(args.metadata or os.path.join(os.path.dirname(settings_path), METADATA_BASENAME))
    project_dir = os.path.abspath(args.project_dir or default_project_dir(settings_path))

    if args.update:
        reasons, plan = preflight(settings_path, metadata_path, project_dir)
        if reasons:
            return refuse_update(metadata_path, reasons)
        diff = list(difflib.unified_diff(plan["old_text"].splitlines(True), plan["new_text"].splitlines(True),
                                         metadata_path + " (old)", metadata_path + " (new)"))
        if diff:
            failure = write_sidecar(metadata_path, plan["data"], plan["mode"])
            if failure:
                return refuse_update(metadata_path, "writing the new version failed (%s)" % failure)
            sys.stdout.writelines(diff)
            print("updated %s" % metadata_path)
        else:
            print("no change: %s already matches %s" % (metadata_path, settings_path))

    findings, warnings = validate(settings_path, metadata_path, project_dir)
    for w in warnings:
        print("warning: %s" % w, file=sys.stderr)
    if findings:
        for f in findings:
            print("FAIL %s" % f, file=sys.stderr)
        print("hook-metadata: %d finding(s) in %s (sidecar %s). If the hook edit was intentional, run "
              "python3 scripts/hook-metadata.py --settings %s --update and review the diff."
              % (len(findings), settings_path, metadata_path, settings_path), file=sys.stderr)
        return 1
    total = sum(len(v) for v in load_json(metadata_path, "metadata")["hooks"].values())
    print("hook-metadata: OK, %d hook group(s) match %s" % (total, metadata_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
