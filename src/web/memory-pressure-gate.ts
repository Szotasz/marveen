/**
 * Memory-pressure gate (component B + C of P0 build).
 *
 * B: Global gate in startAgentProcess() — forbids non-core agent start/restart
 *    during warning/critical/emergency. Fail-closed. Core list from explicit config.
 * C: Active pressure relief — at critical, park the largest idle non-core agent,
 *    verify child tree is gone, audit-log every action.
 *
 * Istvan-approved plan, single isolated commit.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import type { MemoryPressureState, MemoryPressureStateFile, MemoryPressureConfig, MemoryPressureReliefAction } from "./memory-pressure-types.js";
import { DEFAULT_CONFIG, STATE_FILE, CONFIG_FILE } from "./memory-pressure-types.js";
import { checkMonitorHealth } from "./memory-pressure-health.js";

const DASHBOARD_PORT = 3420;
const DASHBOARD_TOKEN_PATH = "store/.dashboard-token";

const INSTALL_DIR = process.env.MARVEEN_HOME ?? process.cwd();

function resolvePath(relative: string): string {
  return `${INSTALL_DIR}/${relative}`;
}

/** Resolve the state file path. When MARVEEN_MEM_PRESSURE_TEST_STATE is set,
 *  use it directly (absolute temp path for hermetic testing). Otherwise
 *  resolve the default relative path against INSTALL_DIR. Checked at CALL
 *  time, not at module load — the env var may be set after import. */
function resolveStatePath(): string {
  const override = process.env.MARVEEN_MEM_PRESSURE_TEST_STATE;
  if (override) return override;
  return resolvePath(STATE_FILE);
}

// ── Gate (component B) ──────────────────────────────────────────────────────

export interface GateResult {
  allowed: boolean;
  reason: string;
}

/** Reads the current memory-pressure state. Returns null if the state file
 *  cannot be read or parsed — the caller treats this as FAIL-CLOSED for
 *  non-core agents (a broken gate must NOT fail-open). */
function readState(): MemoryPressureStateFile | null {
  try {
    const path = resolveStatePath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as MemoryPressureStateFile;
  } catch {
    return null;
  }
}

function loadConfig(): MemoryPressureConfig {
  const configPath = resolvePath(CONFIG_FILE);
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<MemoryPressureConfig>;
      return {
        coreAgents: raw.coreAgents ?? DEFAULT_CONFIG.coreAgents,
        thresholds: { ...DEFAULT_CONFIG.thresholds, ...raw.thresholds },
        monitor: { ...DEFAULT_CONFIG.monitor, ...raw.monitor },
        relief: { ...DEFAULT_CONFIG.relief, ...raw.relief },
      };
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_CONFIG;
}

function isCoreAgent(name: string, config: MemoryPressureConfig): boolean {
  return config.coreAgents.includes(name);
}

/**
 * Called at the top of startAgentProcess() to gate non-core agent starts
 * under memory pressure. FAIL-CLOSED: a gate error or missing state file
 * blocks non-core starts (opposite of the existing fail-open memGate).
 *
 * Core agents always pass, even in emergency (the operator's primary bot
 * must survive). Manual override via MARVEEN_MEM_PRESSURE_OVERRIDE env var.
 */
export function memoryPressureGate(agentName: string): GateResult {
  // Manual override for emergencies — operator explicitly allows a start.
  // Format: MARVEEN_MEM_PRESSURE_OVERRIDE=1 or MARVEEN_MEM_PRESSURE_OVERRIDE=agent1,agent2
  const override = process.env.MARVEEN_MEM_PRESSURE_OVERRIDE;
  if (override) {
    if (override === "1" || override.split(",").map(s => s.trim()).includes(agentName)) {
      return { allowed: true, reason: "manual-override" };
    }
  }

  const config = loadConfig();

  // Core agents always pass — the operator's primary bot must never be gated.
  // "Core status must come from EXPLICIT CONFIG. Do NOT infer it from the
  // process or agent name."
  if (isCoreAgent(agentName, config)) {
    return { allowed: true, reason: "core-agent" };
  }

  const state = readState();

  // FAIL-CLOSED: no state file → gate is active, block non-core.
  // "a gate error or timeout must NOT fail-open"
  if (!state) {
    return { allowed: false, reason: "gate-error: no state file (fail-closed)" };
  }

  const s = state.state;

  if (s === "normal" || s === "recovery") {
    // Before allowing non-core starts on a "normal"/"recovery" state, verify
    // the monitor itself is healthy. A stale state file from a broken monitor
    // (e.g. Module not found after branch switch) still reads as "normal" —
    // but the guard is dead and must fail-closed. Requirement D, P0 phase 2:
    // the 05:20-05:28 incident was missed because health was inferred from
    // "state file exists + says normal" while every run was failing.
    const health = checkMonitorHealth(state, undefined, 2);

    if (!health.healthy) {
      return {
        allowed: false,
        reason: `state=${s} but monitor unhealthy: ${health.failureMode} — ${health.details}`,
      };
    }

    return { allowed: true, reason: `state=${s} monitor=healthy` };
  }

  // warning, critical, emergency: block non-core starts.
  return {
    allowed: false,
    reason: `state=${s} memAvailable=${state.lastSample.memAvailableGiB.toFixed(1)}GiB threshold=${state.thresholds.warningMemAvailableGiB}GiB`,
  };
}

// ── Active pressure relief (component C) ────────────────────────────────────

/** List running agent tmux sessions with their total process-tree RSS.
 *  Calls the ONE authoritative measurement script (list-agent-rss.sh --json)
 *  — same source the monitor uses for telemetry. Returns agents sorted by
 *  RSS descending. RSS is in bytes for precision; convert to GiB for display. */
function listAgentRss(): { name: string; rssBytes: number }[] {
  try {
    // Release-local copy — NOT INSTALL_DIR, which is the shared checkout.
    const monitorDir = dirname(new URL(import.meta.url).pathname);
    const script = `${monitorDir}/list-agent-rss.sh`;
    const output = execSync(`bash "${script}" --json`, { timeout: 8000, encoding: "utf-8" });
    const parsed = JSON.parse(output.trim()) as import("./memory-pressure-types.js").AgentRssMeasurement;
    if (parsed.status === "error" || !parsed.agents) return [];
    // Sort by RSS descending (largest first — eviction targets the biggest)
    return parsed.agents
      .map(a => ({ name: a.name, rssBytes: a.rssBytes }))
      .sort((a, b) => b.rssBytes - a.rssBytes);
  } catch { return []; }
}

/** Check if an agent is idle (no active tool calls, no pending prompts).
 *  Best-effort heuristic via tmux capture-pane. BIASED TOWARD SAFETY:
 *  an ambiguous read (noise, connection loss, multi-line output, or any
 *  content that isn't clearly a settled prompt) is treated as NOT idle.
 *  A false idle → parks a busy agent and loses work. A false busy →
 *  skips this candidate and picks the next one (or does nothing). The
 *  cost asymmetry is large, so we default to "not idle" when uncertain. */
function isAgentIdle(name: string): boolean {
  try {
    const session = `agent-${name}`;
    // Capture last 8 lines (not 3) — a busy agent mid-response can have
    // a stray ">" in a code block or quoted text. More context reduces
    // false positives.
    const capture = execSync(
      `tmux capture-pane -t "${session}" -p 2>/dev/null | tail -8`,
      { timeout: 2000, encoding: "utf-8" },
    );
    const lines = capture.trim().split("\n").filter(l => l.trim());
    if (lines.length === 0) return false; // empty pane = can't tell → assume busy

    const lastLine = lines[lines.length - 1] ?? "";
    const secondLast = lines.length >= 2 ? lines[lines.length - 2] : "";

    // Spinner characters mean the model is streaming — definitely busy.
    for (const spinner of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]) {
      if (lastLine.includes(spinner)) return false;
    }

    // "Thinking..." or "API Error" — model is mid-turn or recovering.
    if (lastLine.includes("Thinking") || lastLine.includes("API Error")) return false;

    // A settled prompt typically ends with ">" followed by a space or end-of-line.
    // Require BOTH: ">" present AND no evidence of streaming/in-progress output.
    const hasPrompt = lastLine.includes(">");
    if (!hasPrompt) return false;

    // Additional guard: if the second-to-last line is non-empty and doesn't
    // look like completed output (ends with a prompt too, or is blank), the
    // agent might be mid-response with a ">" character in old output.
    // A truly idle agent has the cursor sitting at the prompt — the last line
    // is the ONLY line with a fresh ">".
    const secondHasPrompt = secondLast.includes(">");
    if (secondHasPrompt && !secondLast.endsWith(">")) {
      // ">" appears in both lines but not at end → likely code/output, not a prompt
      return false;
    }

    return true;
  } catch { return false; }
}

function readDashboardToken(): string | null {
  try {
    const tokenPath = resolvePath(DASHBOARD_TOKEN_PATH);
    if (!existsSync(tokenPath)) return null;
    return readFileSync(tokenPath, "utf-8").trim();
  } catch { return null; }
}

function writeAuditLog(entry: MemoryPressureReliefAction): void {
  const auditPath = resolvePath("store/runtime/memory-pressure-audit.jsonl");
  const line = JSON.stringify(entry) + "\n";
  try {
    const { appendFileSync, mkdirSync } = require("node:fs");
    const { dirname } = require("node:path");
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, line, "utf-8");
  } catch { /* best-effort audit; never crash the monitor */ }
}

/**
 * Verify the agent's process tree is truly gone after a park. ALL checks use
 * the ONE authoritative collector (list-agent-rss.sh) — no separate ps
 * invocations. One definition of the process tree, everywhere.
 */
function verifyProcessTreeGone(name: string): boolean {
  try {
    // Wait for processes to settle after the stop signal
    execSync("sleep 1", { timeout: 2000 });

    // Check 1: agent absent from the shared collector output.
    // The script walks from tmux pane PIDs — if the session is gone,
    // the agent will not appear in the output.
    const after = listAgentRss();
    const agent = after.find(a => a.name === name);
    if (!agent) return true;  // not in the tree → process tree is gone

    // Check 2: agent present but with negligible RSS. This can happen
    // when the agent is mid-exit — give it one more beat and re-check
    // against the same collector.
    if (agent.rssBytes <= 10 * 1024 * 1024) {  // <= 10 MiB = exiting
      execSync("sleep 0.5", { timeout: 1000 });
      const recheck = listAgentRss();
      const recheckAgent = recheck.find(a => a.name === name);
      if (!recheckAgent) return true;          // gone after the extra beat
      if (recheckAgent.rssBytes === 0) return true;  // fully drained
      return false;  // RSS is non-zero after two checks → park failed
    }

    // Agent present with significant RSS → park did NOT free memory.
    return false;
  } catch { return false; }
}

/**
 * Stop an agent via the dashboard's canonical stop API. This is the SAME path
 * the operator uses (POST /api/agents/:name/stop), which does:
 *   tmux kill-session + sleep 2 + reapChannelOrphans
 * and keeps run-state bookkeeping consistent.
 *
 * Falls back to direct tmux kill + orphan sweep if the dashboard is unreachable
 * (e.g. the dashboard itself is the OOM victim and its event loop is blocked).
 */
function stopAgentViaApi(name: string): boolean {
  const token = readDashboardToken();
  if (!token) return false;

  try {
    const stopUrl = `http://localhost:${DASHBOARD_PORT}/api/agents/${encodeURIComponent(name)}/stop`;
    const result = execSync(
      `curl -s --max-time 8 -X POST "${stopUrl}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json"`,
      { timeout: 10000, encoding: "utf-8" },
    );
    const parsed = JSON.parse(result.trim());
    return parsed.ok === true;
  } catch {
    return false; // dashboard unreachable or returned an error
  }
}

/**
 * Fallback stop: direct tmux kill-session + settle + orphan sweep.
 * Used when the dashboard stop API is unreachable. Less precise than the
 * canonical stopAgentProcess path (cannot call reapChannelOrphans because
 * that function lives inside the dashboard process), but still does a
 * best-effort cleanup of surviving processes.
 */
function stopAgentFallback(name: string): void {
  try {
    execSync(`tmux kill-session -t "agent-${name}" 2>/dev/null`, { timeout: 5000 });
  } catch { /* session may already be gone */ }

  // Let processes settle — tmux sends SIGHUP, children need time to exit
  try {
    execSync("sleep 2", { timeout: 4000 });
  } catch { /* timeout on sleep is harmless */ }

  // Sweep surviving processes. pkill -f matches the full command line;
  // this is intentionally broad under memory emergency — any process
  // carrying the agent name after its tmux session is gone is an orphan.
  try {
    execSync(`pkill -f "agent-${name}" 2>/dev/null || true`, { timeout: 3000 });
  } catch { /* pkill returns non-zero if no matches — that's fine */ }

  // Extra beat for pkill to take effect
  try {
    execSync("sleep 1", { timeout: 2000 });
  } catch { /* harmless */ }
}

/**
 * Active pressure relief. Called by the monitor when state transitions to
 * critical or emergency. At most ONE agent per cycle. NEVER touches core agents.
 * Returns the action taken, or null if nothing was parkable.
 */
export function relievePressure(state: MemoryPressureState): MemoryPressureReliefAction | null {
  const config = loadConfig();
  const agents = listAgentRss();

  // Filter: non-core only, idle only
  const candidates = agents.filter(a => {
    if (config.coreAgents.includes(a.name)) return false;
    return isAgentIdle(a.name);
  });

  if (candidates.length === 0) return null;

  // Pick the largest idle non-core agent
  const target = candidates[0];

  // Record pre-stop RSS for the audit log before we free it
  const rssBeforeBytes = target.rssBytes;
  const rssBeforeGiB = rssBeforeBytes / 1073741824;

  try {
    // Verify the agent session still exists before we try to stop it
    const existsBefore = execSync(
      `tmux ls 2>/dev/null | grep -c "^agent-${target.name}:" || echo 0`,
      { timeout: 2000, encoding: "utf-8" },
    );
    if (Number(existsBefore.trim()) === 0) return null; // already gone, race with manual stop

    // PRIMARY PATH: dashboard stop API (kill-session + settle + reapChannelOrphans).
    // This is the same mechanism the operator uses via the /api/agents/:name/stop
    // endpoint. The comment that was here before (calling tmux kill-session "the
    // same mechanism as the dashboard's stop API") was FALSE — the real stop path
    // has sleep + reapChannelOrphans AFTER kill-session precisely because tmux
    // alone leaves orphaned grandchildren. See agent-process.ts:1119-1147.
    const apiSuccess = stopAgentViaApi(target.name);

    if (!apiSuccess) {
      // FALLBACK: dashboard unreachable — direct stop with orphan sweep.
      // Less thorough (can't call reapChannelOrphans which needs the dashboard's
      // provider state), but still does kill-session + settle + pkill sweep.
      stopAgentFallback(target.name);
    }

    // VERIFY: the process tree is actually gone. Session absence is NOT
    // process-tree absence — orphaned MCP children survive tmux kill-session
    // and must be confirmed gone. If verification fails, log verified:false
    // so the audit trail does not claim success falsely.
    const verified = verifyProcessTreeGone(target.name);

    const action: MemoryPressureReliefAction = {
      timestamp: new Date().toISOString(),
      action: "parked",
      agentName: target.name,
      pidTreeKilled: [],
      rssFreedGiB: verified ? rssBeforeGiB : 0,
      reason: `memory-pressure-${state}: rssBefore=${rssBeforeGiB.toFixed(1)}GiB agent=${target.name} apiStop=${apiSuccess} verified=${verified}`,
    };

    writeAuditLog(action);
    return action;
  } catch (err) {
    // Failed to park — log and move on. Never crash the monitor.
    const action: MemoryPressureReliefAction = {
      timestamp: new Date().toISOString(),
      action: "parked",
      agentName: target.name,
      pidTreeKilled: [],
      rssFreedGiB: 0,
      reason: `relief-failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
    writeAuditLog(action);
    return action;
  }
}

/**
 * Update the state file's lastAction field after a successful park.
 * Called by the monitor so the gate can read which agent was last parked.
 */
export function updateStateAction(action: MemoryPressureReliefAction | null): void {
  if (!action) return;
  const statePath = resolveStatePath();
  try {
    if (!existsSync(statePath)) return;
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as MemoryPressureStateFile;
    state.lastAction = action;
    const tmp = statePath + ".tmp";
    const { writeFileSync, renameSync, mkdirSync } = require("node:fs");
    const { dirname } = require("node:path");
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, statePath);
  } catch { /* best-effort */ }
}
