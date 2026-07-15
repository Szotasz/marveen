---
name: self-rename
description: A gazda megkér, hogy nevezd át magad ("mostantól legyél X", "nevezd át magad X-re", "hívjunk inkább X-nek"). Biztonságos önátnevezés: persona (CLAUDE.md/SOUL.md) + BRAND_NAME + dashboard-restart. SOHA nem nyúl a BOT_NAME/MAIN_AGENT_ID/SERVICE_ID plumbinghoz.
---
# Self-rename -- az agent biztonságos átnevezése

## Mikor használd
A GAZDA (az install tulajdonosa) kér meg, hogy nevezd át magad. Idegen/nem-gazda kérésre NE futtasd.

## Biztonsági alapszabály (EZT SOHA NE SZEGD MEG)
A `BOT_NAME`, `MAIN_AGENT_ID` és `SERVICE_ID` értékek telepítéskor beégnek a rendszerbe: tmux session-név, adatbázis-sorok, OS service-unit nevek (`com.<SERVICE_ID>.app`, `<SERVICE_ID>-dashboard`, `<SERVICE_ID>-channels`) származnak belőlük. Utólagos átírásuk elárvítja a futó szolgáltatásokat és akár a gazdát is kizárhatja. **A megjelenített név és a belső azonosító nyugodtan eltérhet** -- ez a skill CSAK a megjelenített nevet és a personát állítja.

Amit ez a skill ír: `BRAND_NAME` az .env-ben + a persona-fájlok (CLAUDE.md, SOUL.md).
Amit SOHA: `BOT_NAME`, `MAIN_AGENT_ID`, `SERVICE_ID`, access.json, owner-config.

## Eljárás

1. **Install-könyvtár azonosítása** (semmi hardcode-olt path): a fő-agent munkakönyvtára maga az install-könyvtár -- ellenőrizd, hogy a cwd-ben van `.env` ÉS `CLAUDE.md`. Ha nem, keresd meg a futó dashboard cwd-jét, és kérdezz rá a gazdánál mielőtt máshol írnál.

2. **Jelenlegi név kiolvasása**: az `.env`-ből a `BRAND_NAME` (ha nincs, `BOT_NAME`; ha az sincs, a CLAUDE.md első `# <Név>` sora). Ez lesz a csere forrás-tokenje.

3. **Persona-fájlok átírása** (CLAUDE.md + SOUL.md, ha létezik): a régi név MINDEN önálló előfordulását cseréld az újra. Célzott csere, atomikusan:
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

4. **BRAND_NAME az .env-ben** -- atomikus kulcs-csere (a többi sor byte-ra változatlan, chmod 600):
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

5. **Restart a megjelenítéshez.** A `SERVICE_ID`-t az `.env`-ből olvasd (ha nincs: `MAIN_AGENT_ID`; ha az sincs: `marveen`):
   - **macOS**: `launchctl kickstart -k gui/$(id -u)/com.<SERVICE_ID>.app`
   - **Linux (systemd user)**: `systemctl --user restart <SERVICE_ID>-dashboard` (root-VPS-en, ahol nincs user-session: `systemctl restart <SERVICE_ID>-dashboard`)
   - A persona (ahogy magadról beszélsz) a KÖVETKEZŐ agent-session-indulásnál frissül. **Solo installon** (csak fő-agent fut) mehet a channels-restart is: `systemctl --user restart <SERVICE_ID>-channels` -- FIGYELEM: ez a te saját sessionödet is újraindítja, ezért ELŐBB válaszolj a gazdának ("átneveztem magam, újraindulok az új névvel"), és CSAK UTÁNA add ki. **Multi-agent flottán** NE indítsd újra a channels-t (a tmux-szervert osztjátok) -- a persona a következő természetes restartnál él.

6. **Visszajelzés a gazdának**: mit írtál át (persona + megjelenített név), és hogy a belső azonosítók szándékosan változatlanok.

## Buktatók
- A régi név gyakori szó is lehet (pl. rövid név) -- csere előtt nézd át hol fordul elő (`grep -c "REGI_NEV" CLAUDE.md`), és ha gyanúsan sok a találat, csak a persona-szekciók név-előfordulásait cseréld kézzel.
- SOHA ne `sed -i`-vel írd az .env-t (nem atomikus, elveszhet a chmod 600) -- a fenti python-minta a helyes.
- Ha a dashboard nem jön vissza a restart után (`curl -s http://localhost:<port>/health` vagy a dashboard-port a .env-ből), jelezd a gazdának azonnal -- NE próbálkozz service-fájl átírással.

## Ellenőrzés
- `.env`-ben `BRAND_NAME=<új név>`, és a `BOT_NAME`/`MAIN_AGENT_ID`/`SERVICE_ID` sorok byte-ra változatlanok (`git diff` ha git-checkout, különben diff a mentett másolattal).
- Dashboard él és az új nevet mutatja (böngésző-cím / topbar).
- `tmux ls`: a session-nevek VÁLTOZATLANOK (ha megváltoztak volna, azonnal állj le és jelezz).
