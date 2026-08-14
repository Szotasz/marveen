#!/usr/bin/env python3
"""
Autonomy config gate -- fail-closed pre-action authorization check for agents.

Reads a JSON config of named categories (each with a `level` and an optional
`locked` flag) and tells a caller, BEFORE it acts autonomously, whether it is
allowed to: level 1/locked = no, level 2 = yes-with-approval, level 3 = yes,
report after. If the config is missing, unreadable, or the category is
unknown, the gate does NOT fall back to "allowed" -- it reports NEM-MERT
("unmeasured") and exits non-zero, exactly like a TILT (deny). The premise:
a caller that cannot measure its own authorization does not have it, so
silence must not read as permission.

This is a pattern we use in our own install (a Claude-Code-driven multi-agent
fleet) and are offering here as a portable, self-contained tool -- it has
NO dependency on our own runtime beyond the JSON config shape it reads.
It is NOT wired into anything in this repo; adopting it is your call, and it
needs your own default paths (this file's DEFAULT_CONFIG_PATH below is our
own install's path, kept only as a worked example) and -- if you want the
optional role dimension below -- your own decision about which roles map to
which category, since that is organizational data we don't have.

Exit codes:
  0 = allowed (level 2 with approval, or level 3 autonomous)
  1 = TILT / denied (level 1, or locked, or a role explicitly excluded)
  2 = NEM-MERT / unmeasured -- config missing/unreadable/malformed, or an
      unknown level value. Treated the SAME as denied: fail-closed.
  3 = unknown category name (caller error, not a system state -- kept
      separate from 2 so a typo doesn't look like a real unmeasured block)
  4 = unknown --agent/role name (caller error on the role argument, same
      reasoning as 3: never silently falls back to the role-independent
      level, since a typo would then look like "no override, base level
      applies")

Usage:
  autonomy-config-gate.py <category> [config-path] [--agent <role>]
  autonomy-config-gate.py --selftest

Optional role dimension: a category entry MAY carry a `roleLevels` dict
(e.g. {"dispatcher-a": 3, "dispatcher-b": 3}). If the caller passes --agent
and that name is a key in the category's roleLevels, THAT level applies
instead of the category's own `level` -- `locked` still applies regardless
(a role override cannot bypass a lock). A category with no `roleLevels` key
behaves exactly as if the dimension didn't exist -- no --agent, or --agent on
a plain category, is a no-op on the verdict.

Known-but-unlisted role: if a category HAS roleLevels but the given --agent
is not one of its keys, the verdict does NOT fall back to the category's own
`level` -- it is an unconditional deny. Reasoning: falling back is only safe
when the base level happens to be the stricter of the two; a category built
the other way around (permissive base level, `roleLevels` narrowing a few
names down) would silently allow an unlisted-but-known caller through. So the
rule is "the stricter of the two", not "fall back to the base" -- in practice
this is equivalent to unconditional deny, since the base level is never
stricter than deny.
"""
import json, os, subprocess, sys

# Worked example only -- point this at your own install's config location
# (or always pass an explicit config-path argument).
DEFAULT_CONFIG_PATH = os.path.expanduser("~/fleet/store/autonomy-config.json")
DEFAULT_AGENTS_DIR = os.path.expanduser("~/fleet/agents")


def is_known_role(name, agents_dir=None):
    """A --agent value is 'known' if it has its own directory under agents_dir.
    Adjust this to whatever your own install uses as the source of truth for
    known agent/role names -- this default assumes a directory-per-agent
    layout, which may not match yours."""
    agents_dir = agents_dir or DEFAULT_AGENTS_DIR
    return os.path.isdir(os.path.join(agents_dir, name))


def decide(category, path=None, role=None, agents_dir=None):
    """(code, label, reason, overridden) -- code is the process exit code.

    `role` and `agents_dir` are optional: the old call shape (category
    [+path] only) is unchanged, since role=None skips both the
    known-role check and the roleLevels override entirely.

    `overridden` is True EXACTLY when the verdict actually used a
    category's own roleLevels dict for the given role (i.e. the category
    carries roleLevels AND `role` is one of its keys). Every other path
    (no roleLevels on the category, or a role not in it, or an early
    return) is False -- callers should use this to decide whether to
    print a role-specific footer, rather than keying off whether --agent
    was merely PASSED.
    """
    path = path or DEFAULT_CONFIG_PATH
    if not os.path.exists(path):
        return 2, "NEM-MERT", f"config does not exist: {path}", False
    try:
        d = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError) as e:
        return 2, "NEM-MERT", f"config is not parseable ({type(e).__name__})", False
    cats = d.get("categories")
    if not isinstance(cats, list) or not cats:
        return 2, "NEM-MERT", "config has no usable `categories` list", False
    row = next((c for c in cats if c.get("key") == category), None)
    if row is None:
        # Unknown category: a caller typo, not an unmeasured system state --
        # kept as its own exit code so a typo can't be mistaken for a real
        # blocker.
        names = sorted(c.get("key") for c in cats if c.get("key"))
        return 3, "ISMERETLEN-KATEGORIA", (
            f"`{category}` is not in the config -- known categories: {', '.join(names)}"
        ), False
    if role is not None and not is_known_role(role, agents_dir):
        # Same reasoning as the unknown-category case: a caller typo, and it
        # must NOT silently fall back to the role-independent level, or a
        # mistyped --agent would look like "no override, base level applies".
        return 4, "ISMERETLEN-SZEREPKOR", (
            f"`{role}` is not a known agent/role -- no matching directory under agents/"
        ), False
    lvl, locked = row.get("level"), bool(row.get("locked"))
    role_levels = row.get("roleLevels")
    has_role_levels = isinstance(role_levels, dict)
    overridden = has_role_levels and role is not None and role in role_levels
    if overridden:
        lvl = role_levels[role]
    elif has_role_levels and role is not None:
        # See the "known-but-unlisted role" note in the module docstring:
        # this is an unconditional deny, not a fall-back to the category's
        # own level.
        return 1, "TILT", (
            f"role={role} is not in this category's roleLevels -- "
            "fail-closed, the category's base level does not apply (the stricter of the two)"
        ), False
    tag = f" role={role}" + (" (roleLevels override)" if overridden else " (base level)") if role is not None else ""
    if locked or lvl == 1:
        return 1, "TILT", f"level={lvl} locked={locked}{tag} -- report only, no autonomous action", overridden
    if lvl == 2:
        return 0, "OK-JOVAHAGYASSAL", f"level=2{tag} -- ASK for approval before acting", overridden
    if lvl == 3:
        return 0, "OK-AUTONOM", f"level=3{tag} -- may proceed, report afterward", overridden
    return 2, "NEM-MERT", f"unknown level value: {lvl!r}", overridden


def selftest():
    """Proves every branch, INCLUDING the red ones, in a disposable temp dir
    -- never against a real config."""
    import tempfile, pathlib
    ok = True

    def case(name, content, cat, want_code, want_label):
        nonlocal ok
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "autonomy-config.json")
            if content is not None:
                pathlib.Path(p).write_text(content, encoding="utf-8")
            code, label, reason, overridden = decide(cat, p)
            good = (code == want_code and label == want_label)
            ok &= good
            print(f"  {name:50} -> {label:20} rc={code}  {'OK' if good else f'FAIL (want {want_label}/{want_code})'}")

    J = json.dumps
    tilt = J({"categories": [{"key": "permission_change", "level": 1, "locked": True}]})
    l2 = J({"categories": [{"key": "x", "level": 2, "locked": False}]})
    l3 = J({"categories": [{"key": "x", "level": 3, "locked": False}]})
    unknown_level = J({"categories": [{"key": "x", "level": 99, "locked": False}]})
    case("missing config (the real-world case)", None, "permission_change", 2, "NEM-MERT")
    case("unreadable config", "{ not json", "permission_change", 2, "NEM-MERT")
    case("empty categories", J({"categories": []}), "permission_change", 2, "NEM-MERT")
    case("unknown level value in config", unknown_level, "x", 2, "NEM-MERT")
    case("unknown category name (caller typo)", tilt, "no-such-category", 3, "ISMERETLEN-KATEGORIA")
    case("locked category", tilt, "permission_change", 1, "TILT")
    case("level=2", l2, "x", 0, "OK-JOVAHAGYASSAL")
    case("level=3", l3, "x", 0, "OK-AUTONOM")

    with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
        a, b = os.path.join(d1, "c.json"), os.path.join(d2, "c.json")
        pathlib.Path(a).write_text(tilt, encoding="utf-8")
        pathlib.Path(b).write_text(J({"categories": [{"key": "permission_change", "level": 3}]}), encoding="utf-8")
        r1, r2 = decide("permission_change", a)[1], decide("permission_change", b)[1]
        good = r1 != r2
        ok &= good
        print(f"  {'argument probe (two files)':50} -> {r1} vs {r2}  {'OK, reads the path' if good else 'FAIL: PATH IS HARDCODED'}")

    # Role x category dimension. `roleLevels` is optional on a category entry
    # -- a category without it behaves exactly as before. A disposable
    # agents-dir fixture is used for the known-role check, not a real one.
    def case_role(name, content, cat, role, known_names, want_code, want_label, want_overridden=None):
        nonlocal ok
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as ad:
            p = os.path.join(d, "autonomy-config.json")
            pathlib.Path(p).write_text(content, encoding="utf-8")
            for n in known_names:
                os.makedirs(os.path.join(ad, n), exist_ok=True)
            code, label, reason, overridden = decide(cat, p, role, ad)
            good = (code == want_code and label == want_label)
            if want_overridden is not None:
                good = good and (overridden == want_overridden)
            ok &= good
            detail = f" overridden={overridden}" if want_overridden is not None else ""
            print(f"  {name:50} -> {label:20} rc={code}{detail}  {'OK' if good else 'FAIL'}")

    dispatcher_roles = ["dispatcher-a", "dispatcher-b", "assistant-c"]
    role_cat = J({"categories": [
        {"key": "kanban_restructure", "level": 1, "locked": False, "roleLevels": {"dispatcher-a": 3, "dispatcher-b": 3}},
    ]})
    locked_role_override = J({"categories": [
        {"key": "permission_change", "level": 1, "locked": True, "roleLevels": {"dispatcher-a": 3}},
    ]})
    old_entry_no_roles = J({"categories": [{"key": "y", "level": 1, "locked": False}]})

    case_role("role listed as dispatcher -> allowed", role_cat, "kanban_restructure", "dispatcher-a", dispatcher_roles, 0, "OK-AUTONOM", True)
    case_role("role known but not listed -> still TILT", role_cat, "kanban_restructure", "assistant-c", dispatcher_roles, 1, "TILT", False)
    case_role("backward-compat: old entry (no roleLevels) + --agent -> base level, overridden=False", old_entry_no_roles, "y", "dispatcher-a", dispatcher_roles, 1, "TILT", False)
    case_role("locked category: roleLevels override cannot bypass the lock", locked_role_override, "permission_change", "dispatcher-a", dispatcher_roles, 1, "TILT", True)
    case_role("unknown role name -- no silent fallback, its own exit code", role_cat, "kanban_restructure", "no-such-agent", dispatcher_roles, 4, "ISMERETLEN-SZEREPKOR", False)
    case("category HAS roleLevels, --agent NOT passed -> base level (old call shape)", role_cat, "kanban_restructure", 1, "TILT")

    # The dangerous direction: a PERMISSIVE base level (3) with a NARROWING
    # roleLevels (only "restricted-role" pinned down to 1). A known-but-unlisted
    # caller must NOT fall through to the permissive base.
    permissive_base_narrow_role = J({"categories": [
        {"key": "risky_permissive_base", "level": 3, "locked": False, "roleLevels": {"restricted-role": 1}},
    ]})
    case_role(
        "permissive base + narrowing roleLevels: unlisted known role -> TILT (not the base level=3)",
        permissive_base_narrow_role, "risky_permissive_base", "some-other-role",
        dispatcher_roles + ["some-other-role"], 1, "TILT", False,
    )
    case_role(
        "permissive base + narrowing roleLevels: the listed (stricter) role gets its own value",
        permissive_base_narrow_role, "risky_permissive_base", "restricted-role",
        dispatcher_roles + ["restricted-role"], 1, "TILT", True,
    )

    return 0 if ok else 1


def parse_argv(argv):
    """(role, positional-args). Pulls out `--agent NAME` / `--agent=NAME`
    before the remaining dash-free tokens are treated as positional
    (category, [config-path])."""
    role = None
    positional = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--agent" and i + 1 < len(argv):
            role = argv[i + 1]
            i += 2
            continue
        if a.startswith("--agent="):
            role = a.split("=", 1)[1]
            i += 1
            continue
        if not a.startswith("-"):
            positional.append(a)
        i += 1
    return role, positional


def main():
    ts = subprocess.run(['date', '+%F %H:%M:%S %Z'], capture_output=True, text=True).stdout.strip()
    if "--selftest" in sys.argv:
        print(f"=== autonomy-config-gate  {ts} ===")
        print("SELFTEST (the gate itself) -- in a disposable temp dir, the real config untouched:")
        return selftest()
    role, args = parse_argv(sys.argv[1:])
    if not args:
        print(f"=== autonomy-config-gate  {ts} ===")
        print(__doc__.strip().splitlines()[0])
        print("USAGE: autonomy-config-gate.py <category> [config-path] [--agent <role>]", file=sys.stderr)
        return 2
    path = args[1] if len(args) > 1 else None
    actual_path = os.path.abspath(path) if path else DEFAULT_CONFIG_PATH
    role_header = f"  [role: {role}]" if role else ""
    print(f"=== autonomy-config-gate  {ts}  [config: {actual_path}]{role_header} ===")
    code, label, reason, overridden = decide(args[0], path, role)
    print(f"{label}  [{args[0]}]  {reason}")
    if overridden:
        print(f"*** THE VERDICT applies to role `{role}`: the category's roleLevels")
        print("*** contains this name and overrode the category's own level. ***")
    elif role:
        print(f"*** THE VERDICT did NOT use a role-specific value for `{role}`: the")
        print("*** category has no roleLevels, OR it does but this name isn't in it. ***")
    else:
        print("*** THE VERDICT IS ROLE-INDEPENDENT: no --agent was given, so the category's")
        print("*** base level applies, regardless of whether a roleLevels override exists. ***")
    if code == 2:
        print("*** NEM-MERT is treated the SAME as TILT: a caller that cannot measure its own", file=sys.stderr)
        print("*** authorization does not have it. Report this and stop.", file=sys.stderr)
    elif code == 3:
        print("*** UNKNOWN CATEGORY NAME: this is a caller error, not an unmeasured system", file=sys.stderr)
        print("*** state -- fix the category name from the list above, then retry.", file=sys.stderr)
    elif code == 4:
        print("*** UNKNOWN ROLE NAME: this is a caller error on --agent -- no matching", file=sys.stderr)
        print("*** directory under agents/. Do not fall back to the role-independent value:", file=sys.stderr)
        print("*** fix the name, then retry.", file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
