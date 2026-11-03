# `/mcp reconnect` pane captures (Claude Code CLI 2.1.291)

Real `tmux capture-pane -p` output, byte for byte, from a disposable probe on
2026-10-06: a private tmux socket, a fresh `CLAUDE_CONFIG_DIR`,
a fake API key, a 200x50 pane. Nothing was edited after capture.

The command under test was the TUI's initial prompt (`claude "/mcp reconnect X"`),
so the echo line `❯ /mcp reconnect X` is what a submitted command renders.

Probe MCP servers (names appear in the captures):
- `okserver`: a minimal stdio MCP server; `badserver`: `/bin/false`.
- `plugin:probeplug:okplug`: the same server loaded as a plugin (`--plugin-dir`).
- `plugin:probeflaky:flaky`: a plugin server that fails its first start and
  succeeds afterwards (the "plugin failed, reconnect brings it back" case).
- `plugin:probedead:dead`: a plugin server that always fails (`/bin/false`).

| file | what it shows | sampled |
|---|---|---|
| `idle.txt` | idle TUI, empty input box, no command | t+12 s |
| `reconnect-busy.txt` | after `/mcp reconnect okserver`: echo + spinner, `esc to interrupt` | t+2 s |
| `reconnect-progress.txt` | `Reconnecting to okserver` panel, NO input box | t+3 s |
| `reconnect-ok.txt` | `⎿  Successfully reconnected to okserver` | final |
| `reconnect-failed.txt` | `⎿  Failed to reconnect to badserver` | final |
| `reconnect-not-found.txt` | `⎿  MCP server "nosuchserver" not found` | final |
| `reconnect-plugin-ok.txt` | `⎿  Successfully reconnected to plugin:probeplug:okplug` | final |
| `reconnect-plugin-disabled.txt` | `⎿  "plugin:probeplug:okplug" is disabled — enable it in /mcp first` | final |
| `enable-plugin-ok.txt` | `⎿  MCP server "plugin:probeplug:okplug" enabled` | final |
| `reconnect-plugin-progress.txt` | `Reconnecting to plugin:probeflaky:flaky` panel, NO input box | t+3 s |
| `reconnect-plugin-recovered.txt` | `⎿  Successfully reconnected to plugin:probeflaky:flaky` | final |
| `reconnect-plugin-busy.txt` | after `/mcp reconnect plugin:probedead:dead`: echo + spinner | t+2 s |
| `reconnect-plugin-failed.txt` | `⎿  Failed to reconnect to plugin:probedead:dead` | final |
| `dialog-unknown-arg.txt` | `/mcp bogusarg` opens the "Manage MCP servers" dialog | final |
| `dialog-plugin-failed.txt` | the same dialog, `✘ plugin:probeflaky:flaky` (failed at start) | final |

Not captured (known only from the CLI bundle): `X requires authentication…`
and `Error reconnecting to X…`. Also not captured: typing the command into a
live session (literal text + Enter); these captures come from the initial prompt.
