# Vault & Encryption

> API keys don't sit in plaintext files. Encrypted safe, backed by the OS keychain.

---

## 🎯 What it does / why it matters

MCP server API keys, tokens, and passwords are managed by an **encrypted vault** (AES-256-GCM). Claude Code by default stores these in plaintext in `.mcp.json` — a security risk: any process can read them, prompt injection could extract them, and they might accidentally end up in git.

The vault solves this by storing only `vault:SECRET_ID` references in `.mcp.json`, with actual values encrypted, resolved only at startup in memory. Agents never write out secret values (to logs, messages) — they use the reference.

**Highlight:** when a secret is read, the system injects it into the running process without the value ever appearing in the transcript or a file — so a key can be used without the assistant ever "seeing" it.

---

## 🛠 How it works

### Master key storage

- **macOS**: the master key is in the Keychain (`com.<slug>.vault` service) — the OS's encrypted key store, part of disk encryption, tied to login, transparent. Old file-based keys (`store/.vault-key`) migrate into the Keychain automatically on first startup.
- **Linux**: Keychain unavailable → file-based master key (`store/.vault-key`, `chmod 600`). Encryption is still AES-256-GCM; key protection relies on OS file permissions + disk encryption (LUKS recommended for production).

### Scan & Import

On the dashboard Vault page, **Scan & Import** finds plaintext secrets in `.mcp.json` files and offers to import them. Afterwards, `.mcp.json` contains `vault:SECRET_ID` references instead of plaintext, and the MCP command is wrapped with `vault-env-wrapper.sh`, which resolves references at startup.

The scanner detects sensitive keys in the `.mcp.json` `env` section (`_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `API_*`, `AUTH_*`, `OAUTH_*` etc.). Secrets passed as `args` (e.g. `--api-key`) are not detected — those must be moved to env manually.

### Structure

```
store/vault.json               # encrypted secrets (AES-256-GCM)
store/vault-bindings.json      # secret ↔ MCP server mapping
scripts/vault-env-wrapper.sh   # runtime resolver wrapper
scripts/vault-resolve.mjs      # secret ID → plaintext resolution
```

### Agent usage

Agents can programmatically read secrets (e.g. for press-CLI auth setup) via the dist vault module — without printing the value. Secrets are identified by label. The API is Bearer-token protected, similar to `/api/autonomy`.
