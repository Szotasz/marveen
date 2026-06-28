# Voice messaging (per-agent voice)

> Agents receive and send voice messages — everything runs locally, no external API, no recurring cost.

---

## 🎯 What it does / why it matters

When you send a voice note to an agent on Telegram, you can get one back. Not a text reply to a voice message — actual back-and-forth voice communication.

Three things make this interesting:

1. **Fully local.** Both speech recognition (STT) and speech synthesis (TTS) run on your own machine — no external API calls, no privacy concerns, no usage fees.
2. **Per-agent configuration.** Not a fleet-wide toggle: each agent has its own mode and voice model. One agent can stay text-only while another always replies with audio.
3. **Transparent pipeline.** The transcript is injected into the agent's context as readable text — no black box, fully loggable, easy to debug.

---

## 🛠 How it works

### The pipeline

```
Inbound voice note (Telegram)
  │
  ▼
Server-side STT (faster-whisper)
  ├─ transcribes audio to text
  └─ injects transcript into the agent prompt
        │
        ▼
Agent produces a text reply
  │
  ▼
TTS (Piper) → OGG/Opus encoding → native sendVoice
```

No extra steps on the agent side: the text reply is automatically synthesised and sent as a native Telegram voice note.

Inter-agent messages (no `chat_id`) bypass the voice pipeline entirely — no TTS on internal fleet traffic.

### Modes (per-agent)

| Mode | Behaviour |
|------|-----------|
| `text` | Always reply as text, never produce audio |
| `voice` | Always reply as audio, even for text input |
| `auto` | Reply as audio only when the inbound message was a voice note |

### Voice models

TTS uses Piper ONNX models. Models are stored in `~/.local/share/marveen-voice/voices/`.

Included by default (Hungarian):
- `hu_HU-imre-medium` — male voice (default)
- `hu_HU-anna-medium` — female voice

Any other language or voice can be dropped into the same directory — the dashboard will pick it up automatically.

### Installation

Dashboard → agent detail → **Voice** tab → **Install** button. One click installs the Whisper and Piper toolkit locally. One-time setup, no root required.

### Configuration

Mode and voice model are configurable per agent from the dashboard (agent detail → Voice tab) or via REST API:

```
GET  /api/agents/:id/voice-config
PUT  /api/agents/:id/voice-config   { responseMode, voiceModel }
```

Settings persist in the agent's `agent-config.json`.

---

### Notes

Piper models are monolingual per model file. The Hungarian models (`hu_HU-*`) apply Hungarian letter-to-sound rules to all input — English technical terms will be pronounced using Hungarian phonemes and may sound incorrect. Keep English jargon out of TTS strings where possible, or substitute phonetic spellings before synthesis.
