# Marveen

> AI csapatod, ami fut amig te alszol.

Marveen egy nyilt forraskodu AI asszisztens keretrendszer, ami Claude Code-ra epul. Sajat AI csapatot epithetsz, akik Telegramon kommunikalnak veled, onalloan dolgoznak, es egymassal is egyuttmukodnek.

## Funkciok

- **AI Csapat**: Tobb agens, mindegyik sajat Telegram bottal, szemelyiseggel es memoriaval
- **Mission Control**: Web dashboard (http://localhost:3420) a csapat kezelesehez
- **Inter-agent kommunikacio**: Az agensek delegalhatnak egymasnak feladatokat
- **Utemezesek**: Cron-alapu feladatok automatikus futtatasa
- **Memoria**: Hot/Warm/Cold tier rendszer, kulcsszavas es szemantikus keresessel
- **MCP Connectorok**: Gmail, Calendar, Drive, Notion, Slack es mas szolgaltatasok
- **Skillek**: Ujrahasznalhato kepessegek az agenseknek

## Telepites

```bash
git clone https://github.com/your-username/marveen.git
cd marveen
./install.sh
```

A telepito vegigvezet a beallitasokon:
1. Fuggosegek ellenorzese es telepitese
2. Claude Code bejelentkezes
3. Telegram bot letrehozasa
4. Szemelyes beallitasok
5. Szolgaltatasok inditasa

## Hasznalat

### Dashboard
Nyisd meg: http://localhost:3420

### Telegram
Irj a botodnak Telegramon -- Marveen valaszol.

### Agensek
A Csapat oldalon hozz letre uj agenseket. Mindegyik:
- Sajat Telegram bot
- Sajat szemelyiseg (SOUL.md)
- Sajat utasitasok (CLAUDE.md)
- Sajat memoria es skillek

### Frissites
```bash
./update.sh
```

### Leallitas / Inditas
```bash
./scripts/stop.sh
./scripts/start.sh
```

## Kovetelmenyek

- macOS
- Node.js 20+
- Claude Code CLI (Claude Max/Pro elofizetes szukseges)
- Telegram fiok

## Tamogatas

Kerdesed van? Csatlakozz a kozosseghez: [Skool](https://skool.com/ai-a-mindennapokban)
