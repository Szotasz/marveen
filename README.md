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

```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
./install.sh
```

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

- macOS
- Node.js 20+
- Claude Code CLI (Claude Max/Pro előfizetés szükséges)
- Telegram fiók

## Támogatás

Kérdésed van? Csatlakozz a közösséghez: [Skool](https://skool.com/ai-a-mindennapokban)
