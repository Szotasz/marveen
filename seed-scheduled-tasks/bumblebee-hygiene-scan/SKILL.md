---
name: bumblebee-hygiene-scan
description: Weekly supply-chain hygiene scan (Perplexity Bumblebee). Monday 09:00. Inventories installed packages, MCP configs, and extensions, then matches against known supply-chain threat catalogs. Telegram alert ONLY if findings > 0.
---

# Bumblebee weekly supply-chain scan

## When / purpose
Monday 09:00. The fleet uses many third-party MCP servers, auto-installed CLIs, packages, and skills, creating supply-chain risk. This is a read-only inventory + known-threat match.

## Binary
- Path: `~/.local/bin/bumblebee` (Go build, PIN v0.1.1)
- Source: `github.com/perplexityai/bumblebee` (Apache 2.0)
- Build: `git clone https://github.com/perplexityai/bumblebee && cd bumblebee && go build -o ~/.local/bin/bumblebee ./cmd/bumblebee` (Go >= 1.25 required)

## Procedure

1. **Check binary exists**:
```bash
if [ ! -x "$HOME/.local/bin/bumblebee" ]; then
  echo "bumblebee binary not found, skipping scan (install Go>=1.25 and build from github.com/perplexityai/bumblebee)"
  exit 0
fi
```
If the binary is missing (fresh machine without Go), gracefully skip with an info-level log line. Do NOT error out or send alerts.

2. **Locate threat-intel catalogs**:
```bash
BB_CATALOG="$HOME/.claude/tools/bumblebee-threat-intel"
if [ ! -d "$BB_CATALOG" ] || [ -z "$(ls -A "$BB_CATALOG" 2>/dev/null)" ]; then
  # Try seeded catalogs from install dir
  SEED_CATALOG="{{INSTALL_DIR}}/seed-scheduled-tasks/bumblebee-hygiene-scan/threat-intel"
  if [ -d "$SEED_CATALOG" ] && [ -n "$(ls -A "$SEED_CATALOG" 2>/dev/null)" ]; then
    mkdir -p "$BB_CATALOG"
    cp "$SEED_CATALOG"/*.json "$BB_CATALOG/"
  else
    echo "No threat-intel catalogs found, skipping scan"
    exit 0
  fi
fi
```

3. **Run scan** (read-only, ~3 sec):
```bash
~/.local/bin/bumblebee scan --profile baseline --exposure-catalog "$BB_CATALOG" > /tmp/bb-weekly.ndjson 2>/tmp/bb-weekly.err
```

4. **Evaluate findings**:
```bash
FINDING_COUNT=$(grep -c '"record_type":"finding"' /tmp/bb-weekly.ndjson 2>/dev/null || echo 0)
```

5. **Telegram ONLY if finding > 0**: send alert with finding details (ecosystem, package, version, which threat catalog matched). If 0 findings: stay silent (heartbeat style, transcript line only).

6. **Monthly threat-intel refresh** (once per ~30 days): if the catalog files are older than 30 days, refresh from upstream:
```bash
OLDEST=$(find "$BB_CATALOG" -name "*.json" -mtime +30 | head -1)
if [ -n "$OLDEST" ]; then
  cd /tmp && rm -rf bb-ti-update
  git clone -q --depth 1 https://github.com/perplexityai/bumblebee.git bb-ti-update 2>/dev/null
  if [ -d bb-ti-update/threat_intel ]; then
    cp bb-ti-update/threat_intel/*.json "$BB_CATALOG/"
  fi
  rm -rf bb-ti-update
fi
```

## Pitfalls
- Findings ONLY appear with `--exposure-catalog` flag (otherwise always 0). The catalogs live in `~/.claude/tools/bumblebee-threat-intel/`.
- If Go is not available (< 1.25 or not installed), the binary cannot be built. The task must GRACEFULLY SKIP, not crash.
- 0 findings does NOT mean absolute safety, only that the 6 known catalog threats are not present. Keep catalogs fresh.
- Do NOT spam: 0 findings = no Telegram message.
- The vendored catalogs in seed-scheduled-tasks are a bootstrap fallback. The monthly refresh keeps them current.
- SILENT-SKIP BLIND SPOT (2026-08-10): on this machine the binary has NEVER existed -- Go is not installed at all (`go: command not found`), so step 1 exits 0 every single Monday while the catalogs sit there looking healthy. "Graceful skip + no Telegram" then means the coverage gap is permanently invisible: no alert, no transcript anyone reads, week after week. RULE: on a skip, before `exit 0`, check whether a `hot` memory about the gap already exists (`GET /api/memories?q=bumblebee`) and write one if not. That is what surfaces it in the Dream Engine / napindito Top-3 instead of it vanishing. The no-Telegram rule bans spam, NOT record-keeping.
- Do NOT run step 6 (catalog refresh) when the binary is missing. Refreshing threat intel for a scanner that cannot run is pure churn -- and a `git clone` + `cp` over the catalog dir is a mutation with zero payoff. Fix the binary first, refresh after.
- Building the binary means installing a whole Go toolchain (`brew install go`) on the user's machine. That is a user decision, not an autonomous one -- escalate and wait, do not self-install.


## Verification
- Scan exits 0, scan_summary record shows status=complete.
- Finding > 0 triggers Telegram alert; 0 findings = silence.
