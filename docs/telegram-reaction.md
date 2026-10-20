# telegram-reaction: Telegram turn progress as a reaction (opt-in)

The main agent shows the progress of a Telegram turn as a **reaction on the user's own message** instead of the
separate placeholder message:

👀 received → 🤔 working → ✍️ writing → 👨‍💻 after (the reply is out, the turn still runs) → cleared at the turn end

No new message is posted. There is no notification, nothing is read aloud during another conversation, and the chat
does not fill up with status lines.

The last step (**after**, 0.3.3) appears once the Telegram `reply` tool has succeeded, i.e. the answer is out, but the
turn is still running (the agent may still write to memory, update a card or call more tools). The reaction then no
longer looks like "nothing is happening" after the reply; it is cleared at the turn end. A failed reply does not move it:
✍️ stays until the turn end. With several reply messages the 👨‍💻 stays; it never steps back to ✍️.
`after=` (empty) switches the step off: then ✍️ stays to the turn end, with the same Bot API calls as in 0.3.2.

It is a Claude Code plugin (`plugins/telegram-reaction`) that runs next to the **unchanged** engine. No engine code
and no factory hook is modified. It is **off by default**: nothing changes until you enable it for the main agent.

## Enabling it (main agent)

The plugin folder is also a local marketplace (`.claude-plugin/marketplace.json`, name
`marveen-telegram-reaction`). As the user that runs the engine, without `CLAUDE_CONFIG_DIR`:

```bash
claude plugin marketplace add <engine>/plugins/telegram-reaction
claude plugin install telegram-reaction@marveen-telegram-reaction --scope user
claude plugin disable telegram-reaction@marveen-telegram-reaction --scope user   # not in every session
```

Then enable it for the main agent only, through the engine's existing switch in `<engine>/.env`:

```
CHANNEL_PLUGINS_EXTRA=telegram-reaction@marveen-telegram-reaction
```

- If the line already lists other ids, add this one separated by a space.
- Restart the main agent.
- `claude plugin list` shows the plugin installed. The main agent's process gets it through `CHANNEL_PLUGINS_EXTRA`:
  as `enabledPlugins` with an isolated config, or as a session-only `--settings` without one.
- **Side effect (measured, harmless):** `channels.sh` also adds the `CHANNEL_PLUGINS_EXTRA` ids to the `--channels`
  list, so this non-channel plugin is registered as a channel too. It neither receives nor sends messages as a channel.

**Scope.** The install is user-scope. It is recorded in the config dir the commands ran in (by default `~/.claude`).
So it applies to **every session that uses that config dir**, not only the main agent. The `disable` line under
**Enabling it (main agent)** keeps it off in those sessions; the main agent turns it on again through
`CHANNEL_PLUGINS_EXTRA`. The engine itself is not touched.

**Turning it off** (main agent): remove the id from `CHANNEL_PLUGINS_EXTRA` and restart, or set
`MARVEEN_TELEGRAM_REACTION=0` (see Settings).

**Removing it completely:**

```bash
claude plugin uninstall telegram-reaction@marveen-telegram-reaction --scope user
claude plugin marketplace remove marveen-telegram-reaction
```

Then drop the id from `CHANNEL_PLUGINS_EXTRA` in `<engine>/.env` and restart the main agent. The factory placeholder
comes back as before.

## Sub-agents

This PR enables the plugin for the main agent only. For a sub-agent:

- The engine has no per-agent switch for this plugin. The existing one, `"stateObserver": true` in
  `agents/<name>/agent-config.json`, exports `CLAUDE_CODE_PLUGIN_DIRS` for exactly one mod, `agent-state-observer`
  (`src/web/state-observer.ts`). The launcher skips the main agent. There is no generic per-agent field that
  names a plugin folder.
- A sub-agent whose sessions use the config dir of the user-scope install described under **Scope** sees the plugin installed. Whether it
  then loads there is **not measured**: the launcher decides which plugins a sub-agent session enables
  (`src/web/agent-process.ts`), and we have not run the plugin in a sub-agent session.
- Loading this plugin for a chosen sub-agent through the engine's existing per-agent route would be an engine change
  (a field that names the plugin folder, next to the version gate). It is not part of this PR; how a mod is loaded for
  an agent is the maintainers' decision.

## Settings (optional)

The plugin reads its switches from the main agent's **process environment** when the session starts. After a change,
restart the main agent.

| key | effect |
|---|---|
| `MARVEEN_TELEGRAM_REACTION` | `0` turns the plugin off; unset or `1` = on wherever the plugin is loaded |
| `MARVEEN_TELEGRAM_REACTION_EMOJIS` | `received=👀,working=🤔,writing=✍️,after=👨‍💻`. A step left out keeps its default; an empty value (`working=`) skips that step; the first three empty = off (`after` alone does not keep the plugin on); `after=` (empty) = the 0.3.2 behaviour |
| `MARVEEN_TELEGRAM_REACTION_KEEP_AGENT` | `1` keeps the agent's own reaction (see The agent's own reaction); default `0` |
| `MARVEEN_TELEGRAM_REACTION_FETCH_MS` | Bot API call timeout, 100..8000 ms, default 8000 |

**Where to put them (measured):**
- The engine's `.env` does **not** reach the main agent's process. `channels.sh` deliberately does not export it, so
  the bot token does not leak into tmux. A switch written into `.env` has no effect.
- The place that works is the `env` block of the shared `~/.claude/settings.json`. With an isolated main-agent config,
  the engine copies the shared settings into `.channels-config/settings.json` on every start.
  - Measured on Linux: the key reached the plugin, and a changed emoji showed up live.
  - These keys are read only by this plugin, and only the main agent loads it, so the shared file does not affect other
    agents.
- The main agent's own `.channels-config/settings.json` `env` is durable **only when the shared file has no `env`
  block**. The engine merges the two per top-level key, so a shared `env` replaces the whole own `env` on the next
  start (measured on Linux and macOS).

**Emojis.**
- Only the emojis Telegram accepts as reactions work (the Bot API `ReactionTypeEmoji` list; it is a constant in the
  plugin).
- An unknown emoji, an unknown step name, or a malformed item is never silent. It gives a dim warning line under the
  plugin's name in the main session (`$.ui.log`), and that step keeps its default; the other steps still apply.
- The variation selector (U+FE0F) does not matter: `✍` and `✍️` are the same.

**The agent's own reaction.**
- An emoji the agent itself put on a message with the react tool is cleared at the main turn end by default, because
  Telegram lists a message with a reaction left on it as unread.
- `MARVEEN_TELEGRAM_REACTION_KEEP_AGENT=1` keeps it.
- A value other than `0` or `1` gives a warning, and the default applies.

## How it works

- In `prompt.submit`, before the engine's own hooks run (`next(e)`), the plugin does two things for each Telegram
  message of the turn:
  1. It records a pending entry in the factory format (`progress/<session>.json`, `{chat_id, src_mid}`), written
     atomically: a tmp file renamed over the target. With `TELEGRAM_TOPICS_ENABLED`, a message from a topic also gets
     its `message_thread_id` in the entry (as the factory hook writes it), so the fallback reply goes back into that topic.
  2. Only then does it write the factory hook's documented dedup marker (`progress/seen-<session>-<src_mid>.marker`).
     The factory placeholder hook therefore exits with "dedup skip" and posts no placeholder.
  3. The classic `UserPromptSubmit` event, which runs inside `next(e)` ahead of the settings hooks, carries the
     session's `transcript_path` (`prompt.submit` itself does not). The plugin stamps it onto the pending entries it
     just wrote, as the factory submit hook does for its own entries. The factory watchdog finds the agent's transcript only
     through that field.
  The factory Stop enforcement and the watchdog keep working on the pending entry. If the pending write fails, no
  marker is written, so the factory hook posts its placeholder as before.
- **One writer, desired state.** Every message has a desired reaction: the plugin's current step, the agent's own
  emoji, or nothing. Every Bot API call goes through one serial chain and sends the desired value as it stands at call
  time.
- A request that times out may still land later. When it answers, the plugin rewrites the desired value.
- Uncertain messages (timeout, error answer, a failed agent react) go to a retry queue. The queue is replayed after the
  turn-end clearing and at session start, bounded: 20 attempts, 48 h, and a per-pass cap.
- A previous session's leftover reactions are cleared at session start, even when the plugin is switched off.

## Known limits

- **Claude Code minimum:** 2.1.287 (`plugin.json` `metadata.minClaudeCodeVersion`). Below it the plugin does not
  load, and the factory placeholder stays (safe degradation).
- **Main agent only.** Sub-agents keep the placeholder (see Sub-agents).
- **One extra Bot API call:** 👀 always goes out before 🤔, because `prompt.submit` waits for the claim.
- **Re-delivery after a restart:** a message re-delivered after a main-agent restart got no reaction. This was
  measured on an earlier version (0.1.0) and has not been re-measured on this one.
- **Watchdog recovery depends on the transcript path.** With the path stamped (How it works, 3), the factory watchdog
  recovers a round the Stop hook never closed (agent died, reply tool hung): it sends the agent's real final answer as
  a new message. The delete of a placeholder that never existed fails and is logged, which is harmless.
  **No answer recovery for a turn that dies** when the path is missing: the event carries an empty `transcript_path`,
  the stamp write fails, or the Claude Code build does not raise the classic event to a module. The entry then has no
  path, and the watchdog's last resort edits a message that does not exist: the user gets only the reaction and no text.
  A stuck turn whose reply never reaches the channel and whose transcript holds no answer ends the same way.
- **Shared pending file:** the read-modify-write of `progress/<session>.json` is not locked against the factory hooks,
  which write it without a lock too. In a short window a concurrent write can be lost.
- **Test guard:** with `FLEET_FORBID_LIVE=1` in the environment the plugin is inert (no Bot API call). It is a
  test-process safety switch; it does nothing otherwise.

## Deliberately not included

**A dashboard on/off switch.** This is on purpose: the engine's optional features should appear in one consistent way,
so we leave the place and form of such a switch to the maintainers. If asked, we fit it. Until then the plugin is
enabled through the existing `CHANNEL_PLUGINS_EXTRA` mechanism.

## Tests

```bash
claude plugin test plugins/telegram-reaction
```

109 tests on Claude Code 2.1.301. They include a seeded property test of the one-writer, desired-state invariant
(random timeouts, late answers, 500s, re-delivery, failing agent reacts). They run with the engine stand-ins of
`claude-code/testing`: no Bot API, disk, or timer is touched.
