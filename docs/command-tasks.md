# Command-feladatok (shell-ütemezés LLM nélkül)

> Nem minden ütemezett munkához kell egy nyelvi modell. Egy HTTP-health-check vagy egy karbantartó-szkript csak fusson le, és szóljon ha elromlott.

---

## 🎯 Mit tud / miért érdekes

Az ütemezett feladatok alapból egy LLM-ügynököt ébresztenek a SKILL.md promptjával (`task` / `heartbeat` típus). Sok háttérmunkához viszont nincs szükség modellre: egy webhely elérhetőség-ellenőrzése, egy backup-integritás-próba, egy log-rotáció. Ezekre való a **`command`** típus: nyers shell-parancsot futtat (LLM és tmux nélkül), és Telegramon riaszt, ha N egymás utáni futás elhasal.

A nyereség: ezek a könnyű infra-ellenőrzések **ugyanabban a rendszerben** élnek, amit a dashboard kezel és a Marveen store ment, nem egy külön, felügyelet nélküli crontabban.

---

## 🛠 Hogyan működik

### Definíció

A `command` feladatnak **nincs SKILL.md-je** — kizárólag a `task-config.json` írja le:

```json
{
  "type": "command",
  "schedule": "*/5 * * * *",
  "command": "curl -fsS https://example.com/health",
  "timeoutMs": 10000,
  "failThreshold": 2,
  "description": "example.com health"
}
```

| Mező | Jelentés |
|------|----------|
| `command` | A `bash -lc`-en futtatott parancs. |
| `timeoutMs` | Kemény timeout ms-ban (default 10000). A timeout hibának számít. |
| `failThreshold` | Hány egymás utáni hiba után menjen riasztás (default 2). |

### Riasztás-logika

A hiba/helyreállás döntés **él-vezérelt** (`evaluateCommandResult`, tisztán unit-tesztelt):

- egy sikeres futás nullázza a hiba-sorozatot,
- **egy** riasztás megy, amikor a sorozat először eléri a `failThreshold`-ot,
- amíg hibás marad, nincs ismételt riasztás,
- **egy** helyreállás-üzenet megy, amikor egy korábban riasztott feladat újra sikeres.

Így egy hosszú kiesés vagy egy flapping szolgáltatás is pontosan egy riasztást + egy helyreállást ad, nem futásonkénti spamet. Az állapot a `store/command-task-health.json`-ban perzisztált, így egy dashboard-restart nem nullázza a sorozatot és nem riaszt újra egy már ismert kiesésre.

### Mikor érdemes

`command` típus: nyelvi modellt nem igénylő, gyakran futó, gép-ellenőrizhető munka (HTTP/SMTP-próba, integritás-check, szkript). Ha a feladat ítéletet, szöveg-értelmezést vagy cselekvést igényel, a `task` / `heartbeat` (LLM) típus való rá.
