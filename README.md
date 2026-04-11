# Marveen

> AI csapatod, ami fut amíg te alszol.

Marveen egy AI asszisztens keretrendszer, ami Claude Code-ra épül. Saját AI csapatot építhetsz, akik Telegramon kommunikálnak veled, önállóan dolgoznak, és egymással is együttműködnek.

## Funkciók

- **AI Csapat**: Több ágens, mindegyik saját Telegram bottal, személyiséggel és memóriával
- **Mission Control**: Web dashboard (http://localhost:3420) a csapat kezeléséhez
- **Inter-agent kommunikáció**: Az ágensek delegálhatnak egymásnak feladatokat
- **Ütemezések**: Cron-alapú feladatok automatikus futtatása
- **Heartbeat**: Csendes háttér-monitorozás, csak fontosnál szól (naptár, email, kanban)
- **Memória**: Hot/Warm/Cold tier rendszer, kulcsszavas kereséssel és gráf nézettel
- **MCP Connectorok**: Gmail, Calendar, Drive, Notion, Slack és más szolgáltatások
- **Skillek**: Újrahasználható képességek az ágenseknek

## Telepítés

### macOS / Linux

```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
./install.sh
```

### Windows (WSL)

```powershell
irm https://raw.githubusercontent.com/Szotasz/marveen/main/install-windows.ps1 | iex
```

Vagy manuálisan:
```powershell
git clone https://github.com/Szotasz/marveen.git
cd marveen
.\install-windows.ps1
```

A Windows telepítő automatikusan beállítja a WSL-t (Windows Subsystem for Linux) és azon belül telepíti a Marveen-t.

A telepítő végigvezet a beállításokon:
1. Függőségek ellenőrzése és telepítése
2. Claude Code bejelentkezés
3. Telegram bot létrehozása
4. Személyes beállítások
5. Szolgáltatások indítása

## Használat

### Dashboard
Nyisd meg: http://localhost:3420

### Telegram
Írj a botodnak Telegramon -- Marveen válaszol.

### Ágensek
A Csapat oldalon hozz létre új ágenseket. Mindegyik:
- Saját Telegram bot
- Saját személyiség (SOUL.md)
- Saját utasítások (CLAUDE.md)
- Saját memória és skillek

### Ütemezések
Időzített feladatok és heartbeat monitorok beállítása:
- Lista, napi idővonal és heti nézet
- Feladat: mindig szól az eredménnyel
- Heartbeat: csendes ellenőrzés, csak fontosnál értesít

### Frissítés
```bash
./update.sh
```

### Leállítás / Indítás
```bash
./scripts/stop.sh
./scripts/start.sh
```

## Követelmények

- macOS, Linux, vagy Windows 10/11 (WSL-lel)
- Node.js 20+
- Claude Code CLI (Claude Max/Pro előfizetés szükséges)
- Telegram fiók

## Közösség és támogatás

Kérdésed van? Csatlakozz az AI a mindennapokban közösséghez:

- **Skool közösség**: [skool.com/ai-a-mindennapokban](https://skool.com/ai-a-mindennapokban) -- oktatóanyagok, kérdések, tapasztalatcsere
- **YouTube**: [AI a mindennapokban](https://www.youtube.com/@aiamindennapokban) -- videók, tutorialok
- **Weboldal**: [aiamindennapokban.hu](https://aiamindennapokban.hu)

## Támogasd a projektet

Ha hasznos számodra a Marveen, támogasd a fejlesztést:

[![Támogatás](https://img.shields.io/badge/Támogatás-Donably-orange)](https://www.donably.com/ai-a-mindennapokban-szabolccsal)

## Készítette

**Szota Szabolcs** -- AI konzultáns, az "AI a mindennapokban" csatorna készítője

[![GitHub](https://img.shields.io/github/stars/Szotasz/marveen?style=social)](https://github.com/Szotasz/marveen)
