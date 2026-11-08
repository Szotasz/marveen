---
name: self-rename
description: The owner asks you to rename yourself ("from now on be X", "rename yourself to X", "let's call you X instead"). Safe self-rename: persona (CLAUDE.md/SOUL.md) + BRAND_NAME + dashboard restart. It NEVER touches the BOT_NAME/MAIN_AGENT_ID/SERVICE_ID plumbing.
---
# Self-rename: renaming the agent safely

## When to use
The OWNER (the owner of the install) asks you to rename yourself. Do NOT run it at the request of a stranger or anyone who is not the owner.

## Basic safety rule (NEVER BREAK THIS)
The `BOT_NAME`, `MAIN_AGENT_ID` and `SERVICE_ID` values are burned into the system at install time: the tmux session name, database rows and OS service unit names (`com.<SERVICE_ID>.app`, `<SERVICE_ID>-dashboard`, `<SERVICE_ID>-channels`) are derived from them. Rewriting them later orphans the running services and can even lock the owner out. **The displayed name and the internal identifier can safely differ**: this skill sets ONLY the displayed name and the persona.

What this skill writes: `BRAND_NAME` in the .env + the persona files (CLAUDE.md, SOUL.md).
What it NEVER writes: `BOT_NAME`, `MAIN_AGENT_ID`, `SERVICE_ID`, access.json, owner-config.

## Procedure

1. **Identify the install directory** (no hardcoded path): the main agent's working directory is the install directory itself. Check that the cwd has a `.env` AND a `CLAUDE.md`. If not, find the cwd of the running dashboard, and ask the owner before you write anywhere else.

2. **Read the current name**: `BRAND_NAME` from the `.env` (if it is missing, `BOT_NAME`; if that is missing too, the first `# <Name>` line of CLAUDE.md). This becomes the source token of the replacement.

3. **Rewrite the persona files** (CLAUDE.md + SOUL.md, if it exists): replace EVERY standalone occurrence of the old name with the new one. A targeted replacement, atomically:
```bash
python3 - "$PWD" "REGI_NEV" "UJ_NEV" <<'PYEOF'
import os, sys
root, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
for name in ('CLAUDE.md', 'SOUL.md'):
    p = os.path.join(root, name)
    if not os.path.exists(p): continue
    s = open(p, encoding='utf-8').read()
    if old not in s: continue
    tmp = p + '.tmp'
    open(tmp, 'w', encoding='utf-8').write(s.replace(old, new))
    os.replace(tmp, p)
    print(name, 'renamed')
PYEOF
```

4. **BRAND_NAME in the .env**: an atomic key replacement (all other lines byte-for-byte unchanged, chmod 600):
```bash
python3 - "$PWD/.env" "UJ_NEV" <<'PYEOF'
import os, sys
envp, new = sys.argv[1], sys.argv[2]
lines = [l for l in open(envp, encoding='utf-8').read().split('\n') if l and not l.startswith('BRAND_NAME=')]
lines.append('BRAND_NAME=' + new)
tmp = envp + '.tmp'
open(tmp, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
os.chmod(tmp, 0o600)
os.replace(tmp, envp)
print('BRAND_NAME set')
PYEOF
```

5. **Restart so the change shows.** Read `SERVICE_ID` from the `.env` (if it is missing: `MAIN_AGENT_ID`; if that is missing too: `marveen`):
   - **macOS**: `launchctl kickstart -k gui/$(id -u)/com.<SERVICE_ID>.app`
   - **Linux (systemd user)**: `systemctl --user restart <SERVICE_ID>-dashboard` (on a root VPS, where there is no user session: `systemctl restart <SERVICE_ID>-dashboard`)
   - The persona (how you talk about yourself) updates at the NEXT agent session start. **On a solo install** (only the main agent runs) you may also restart channels: `systemctl --user restart <SERVICE_ID>-channels`. WARNING: this also restarts your own session, so FIRST reply to the owner ("I've renamed myself, restarting with the new name"), and ONLY THEN issue it. **On a multi-agent fleet** do NOT restart channels (you share the tmux server): the persona takes effect at the next natural restart.

6. **Report back to the owner**: what you rewrote (persona + displayed name), and that the internal identifiers are intentionally unchanged.

## Pitfalls
- The old name can also be a common word (e.g. a short name): before replacing, look at where it occurs (`grep -c "REGI_NEV" CLAUDE.md`), and if the number of hits is suspiciously high, replace only the name occurrences in the persona sections, by hand.
- NEVER write the .env with `sed -i` (it is not atomic, and the chmod 600 can be lost): the python pattern above is the right one.
- If the dashboard does not come back after the restart (`curl -s http://localhost:<port>/health`, or the dashboard port from the .env), tell the owner immediately. Do NOT try rewriting service files.

## Verification
- The `.env` has `BRAND_NAME=<new name>`, and the `BOT_NAME`/`MAIN_AGENT_ID`/`SERVICE_ID` lines are byte-for-byte unchanged (`git diff` on a git checkout, otherwise a diff against the saved copy).
- The dashboard is up and shows the new name (browser title / topbar).
- `tmux ls`: the session names are UNCHANGED (if they had changed, stop immediately and report it).
