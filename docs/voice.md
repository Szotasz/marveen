# Hangüzenetek (per-agent voice)

> Az ügynök hangüzeneteket fogad és küld -- minden helyben fut, külső API és havidíj nélkül.

---

## 🎯 Mit tud / miért érdekes

Ha hangüzenetet küldesz egy ügynöknek Telegramon, vissza is kaphatsz hangot. Nem szöveg-választ egy hangra, hanem igazi oda-vissza hangkommunikációt.

Három dolog teszi ezt érdekessé:

1. **Teljesen helyi.** A szövegfelismerés (STT) és a hangszintézis (TTS) is a saját gépeden fut -- nincs külső API-hívás, nincs adatvédelmi aggály, nincs forgalmi díj.
2. **Agensenkénti beállítás.** Nem mindenkire egységesen: minden ügynöknek külön konfigurálható, hogy mikor és milyen hanggal válaszoljon. Egy ügynök maradhat szöveges, a másik mindig hangban válaszol.
3. **Átlátható működés.** Az átirat bekerül az ügynök kontextusába szövegként -- nem fekete doboz, hanem olvasható, naplózható, hibakeresésnél nem kell találgatni.

---

## 🛠 Hogyan működik

### A pipeline

```
Bejövő hangüzenet (Telegram)
  │
  ▼
Szerver-oldali STT (faster-whisper)
  ├─ átírja a hangot szöveggé
  └─ az átiratot injektálja az ügynök promptjába
        │
        ▼
Az ügynök szöveges választ készít
  │
  ▼
TTS (Piper) → OGG/Opus enkódolás → natív sendVoice
```

Az ügynök oldalán nincs külön lépés: a válasz szövege automatikusan hanggá alakul, és Telegram hangüzenetként megy ki.

Az ügynökök közötti belső üzenetek (nincs `chat_id`) kihagyják a hangpipeline-t -- nincs felesleges TTS a flotta belső forgalmára.

### Módok (agensenkénti beállítás)

| Mód | Viselkedés |
|-----|-----------|
| `text` | Mindig szöveg, soha nem hangol |
| `voice` | Mindig hang -- szöveges inputra is |
| `auto` | Csak akkor hangol, ha a bejövő üzenet is hang volt |

### Hangmodellek

A TTS Piper ONNX modelleket használ. A modellek helye: `~/.local/share/marveen-voice/voices/`.

Alapból elérhető magyar hangok:
- `hu_HU-imre-medium` -- férfi hang (default)
- `hu_HU-anna-medium` -- női hang

Más nyelv vagy hang behúzható ugyanebbe a könyvtárba -- a rendszer automatikusan felkínálja a dashboardon.

### Telepítés

Dashboard → ügynök részletei → **Voice** fül → **Telepítés** gomb. Egy kattintással feltelepíti a Whisper és Piper toolkitet. Egyszeri, helyi, nem igényel root jogot.

### Konfiguráció

A mód és a hangmodell a dashboardon agensenkénti beállítható (ügynök részletei → Voice fül), vagy REST API-n:

```
GET  /api/agents/:id/voice-config
PUT  /api/agents/:id/voice-config   { responseMode, voiceModel }
```

A beállítás az ügynök `agent-config.json`-jában perzisztál.

---

### Megjegyzés

A Piper modellek modellenkénti egynyelvűek. A magyar modellek (`hu_HU-*`) a szöveg minden szavát magyar betű-hang szabályokkal ejtik -- az angol szakszavak így rosszul hangozhatnak. Érdemes a TTS-be szánt szövegből kihagyni az angol terminusokat, vagy fonetikusan átírni őket.
