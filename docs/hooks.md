# Hooks (Eseménykezelők)

> Claude Code hook-ok teszik lehetővé, hogy az ügynök reagáljon a saját életciklus-eseményeire -- kontextus-tömörítés előtt emlékeket ment, munkamenet indításakor visszatölti a feladatállapotot, prompt érkezésekor mutatja a "gondolkozom" jelzőt.

---

## Hogyan működnek

A hook-ok a `settings.json` `hooks` blokkjában vannak definiálva. Minden hook-eseményhez egy tömb rendelődik; a tömbben lévő elemek tartalmazzák az opcionális `matcher`-t és a tényleges hook-parancsokat.

```json
{
  "hooks": {
    "<EsemenyNev>": [
      {
        "matcher": "opcionális-regex",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/script.py",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

### Két hook-típus

| `type` | Leírás |
|--------|--------|
| `command` | Shell-parancsot futtat. Exit 0 = siker; stdout (UserPromptSubmit esetén) az ügynök kontextusába kerül |
| `agent` | Sub-agenst indít a megadott `prompt`-tal. LLM-logikát igénylő feladatokra (pl. memória mentés, skill-reflexió) |

### `matcher` mező

- **PostToolUse / PreToolUse**: regex az eszköz nevére (`"Read"`, `"Bash"`, `"telegram.*reply"`)
- **SessionStart**: regex a session `source` mezőjére (`"compact|resume"`, `"startup"`)
- **PreCompact**: `"auto"` (mindig fut) vagy kihagyható
- Más eseményeknél általában nincs matcher -- a hook minden alkalommal lefut

---

## Elérhető hook-események

### PreCompact

Akkor fut, amikor Claude Code automatikusan tömöríteni készül a kontextust (a context window kb. 90%-os teltségénél).

**Típus:** `agent` (LLM-logikát igényel)
**Marveen alapkonfiguráció:** memória mentés + skill-reflexió + aktív feladatállapot mentése

```json
"PreCompact": [
  {
    "matcher": "auto",
    "hooks": [
      {
        "type": "agent",
        "prompt": "A kontextus hamarosan tömörítődik. Mentsd az emlékeket, vizsgáld meg a skill-generálási lehetőségeket, és mentsd az aktív feladatállapotot (ha van).",
        "timeout": 180
      }
    ]
  }
]
```

**Kapcsolódó dokumentum:** [Agent Task State](agent-taskstate.md), [Skill Factory](skill-factory.md)

---

### SessionStart

Akkor fut, amikor egy ügynök-session elindul. A `matcher` a `source` mezőre szűr.

| `source` érték | Mikor |
|---------------|-------|
| `startup` | Teljesen friss indulás (új chat) |
| `compact` | Automatikus kontextus-tömörítés utáni folytatás |
| `resume` | `claude --continue` miatti folytatás |

**Marveen alapkonfiguráció:** `compact|resume` esetén visszajátssza az aktív feladatállapotot.

```json
"SessionStart": [
  {
    "matcher": "compact|resume",
    "hooks": [
      {
        "type": "command",
        "command": "python3 /path/to/scripts/hooks/taskstate-replay.py",
        "timeout": 15
      }
    ]
  }
]
```

**Kapcsolódó dokumentum:** [Agent Task State](agent-taskstate.md)

---

### UserPromptSubmit

Akkor fut, amikor a felhasználó (vagy egy channel-plugin) elküld egy promptot -- az ügynök válaszolni kezdése ELŐTT.

**Fontos:** a hook stdout-ja **bekerül az ügynök kontextusába**. Ha a hook nem akar semmit injektálni, teljesen csendben kell maradnia (stderr-re naplózni, nem stdout-ra).

**Marveen alapkonfiguráció:** Telegram "✍️ Dolgozom rajta..." jelző megjelenítése, ✍️ reakció az üzenetre.

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "python3 ~/.claude/hooks/telegram_progress.py",
        "timeout": 15
      }
    ]
  }
]
```

**Kapcsolódó dokumentum:** [Telegram Progress Indicator](telegram-progress-indicator.md)

---

### Stop

Akkor fut, amikor az ügynök befejezi a válaszolást (a turn végén).

**Marveen alapkonfiguráció:** két feladatot lát el:
1. Törli a UserPromptSubmit által kihelyezett "Dolgozom rajta..." placeholder-t
2. Ha az ügynök Telegram-üzenetre válaszolt, de nem küldött `reply` tool-hívást, kikényszeríti a kézbesítést

```json
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "python3 ~/.claude/hooks/telegram_progress_clear.py",
        "timeout": 15
      }
    ]
  }
]
```

---

### PostToolUse

Minden eszközhívás UTÁN fut. A `matcher` regex az eszköz nevére illeszkedik.

**Marveen példák:**

```json
"PostToolUse": [
  {
    "matcher": "telegram.*reply",
    "hooks": [
      {
        "type": "command",
        "command": "python3 ~/.claude/hooks/telegram_progress_reply_clear.py",
        "timeout": 15
      }
    ]
  }
]
```

Használat: Telegram reply tool után törli a "Dolgozom rajta..." jelzőt; Activity Tool Log esetén minden tool hívás naplózása.

---

### PreToolUse

Minden eszközhívás ELŐTT fut. A `matcher` regex az eszköz nevére illeszkedik.

**Marveen példa:** Telegram-csatornán érkező képek automatikus átméretezése Read előtt.

```json
"PreToolUse": [
  {
    "matcher": "Read",
    "hooks": [
      {
        "type": "command",
        "command": "~/.claude/hooks/channel-image-resize.sh",
        "timeout": 15
      }
    ]
  }
]
```

---

## settings.json helye

A hook-ok a `settings.json` fájlban vannak -- de melyik fájlban?

| Hatókör | Fájl | Mire vonatkozik |
|---------|------|-----------------|
| Globális | `~/.claude/settings.json` | Minden Claude Code session |
| Ügynök-specifikus | `agents/<nev>/.claude/settings.json` | Csak az adott ügynök session-jei |
| Projekt-szintű | `<projekt>/.claude/settings.json` | Az adott projekt könyvtárában futó session-ök |

A Marveen fleet esetén az ügynökök indítási template-je (`templates/settings.json.template`) tartalmazza az alapértelmezett PreCompact és SessionStart hook-okat, amelyek minden új ügynöknél automatikusan bekerülnek.

---

## Teljes alap-konfiguráció (template)

Ez a `templates/settings.json.template` lényegi hook-blokja -- amit minden fleet-ügynök megkap induláskor:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "agent",
            "prompt": "Memória mentés + skill reflexió + aktív feladatállapot mentése (ha van).",
            "timeout": 180
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact|resume",
        "hooks": [
          {
            "type": "command",
            "command": "python3 {{PROJECT_ROOT}}/scripts/hooks/taskstate-replay.py",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

A `{{PROJECT_ROOT}}` placeholder az ügynök scaffolding során cserélődik be a tényleges telepítési útvonalra.

---

## Saját hook hozzáadása

1. Írd meg a hook-scriptet (bash vagy Python)
2. Add hozzá a megfelelő `settings.json`-hoz
3. Teszteld: indítsd el az ügynököt és nézd meg a hook log-ját (`~/.claude/hooks/*.log` ha van)

**Timeout:** mindig adj meg `timeout` értéket -- ha a hook lefagy, a session blokkolódik. Command hook-okra 10-30 másodperc általában elég; agent hook-okra (PreCompact) 120-180 másodperc.

---

## Kapcsolódó dokumentumok

- [Agent Task State](agent-taskstate.md) -- PreCompact + SessionStart részletek
- [Activity Tool Log](activity-tool-log.md) -- PostToolUse-alapú naplózás
- [Telegram Progress Indicator](telegram-progress-indicator.md) -- UserPromptSubmit + Stop + PostToolUse együttműködése
- [Skill Factory](skill-factory.md) -- PreCompact skill-reflexió
