#!/usr/bin/env node
/**
 * Memory-pressure monitor (component A of P0 build).
 *
 * Runs INDEPENDENTLY of the dashboard — a systemd USER service triggered by a
 * systemd timer every 15-30s. If the dashboard dies or the channel-monitor
 * event loop blocks, this must keep running.
 *
 * ZERO LLM CALLS. Reads /proc/meminfo, /proc/pressure/memory, /proc/self/status
 * and `ps` outputs. Writes an atomic JSON state file on state-change only.
 * Identical state → no write, no repeat report.
 *
 * State machine with hysteresis:
 *   normal → warning (MemAvailable < 2.5 GiB)
 *   warning → critical (MemAvailable < 1.5 GiB)
 *   critical → emergency (MemAvailable < 0.8 GiB)
 *   any → recovery (>= 5 min stable normal)
 *
 * PSI and swap are SUPPLEMENTARY conditions — they can escalate but never
 * de-escalate alone. Hysteresis prevents flapping.
 */

import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import type {
  MemoryPressureState,
  MemoryPressureSample,
  MemoryPressureStateFile,
  MemoryPressureConfig,
} from "./memory-pressure-types.js";
import { DEFAULT_CONFIG, STATE_FILE, CONFIG_FILE } from "./memory-pressure-types.js";
import { relievePressure, updateStateAction } from "./memory-pressure-gate.js";

const INSTALL_DIR = process.env.MARVEEN_HOME ?? process.cwd();

function resolvePath(relative: string): string {
  return `${INSTALL_DIR}/${relative}`;
}

function resolveStatePath(): string {
  const override = process.env.MARVEEN_MEM_PRESSURE_TEST_STATE;
  if (override) return override;
  return resolvePath(STATE_FILE);
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

function readMemInfo(): { memAvailableKiB: number; swapUsedKiB: number } {
  let memAvailableKiB = 0;
  let memTotalKiB = 0;
  let swapFreeKiB = 0;
  let swapTotalKiB = 0;
  try {
    const raw = readFileSync("/proc/meminfo", "utf-8");
    for (const line of raw.split("\n")) {
      if (line.startsWith("MemAvailable:")) memAvailableKiB = Number(line.match(/\d+/)?.[0] ?? 0);
      if (line.startsWith("MemTotal:")) memTotalKiB = Number(line.match(/\d+/)?.[0] ?? 0);
      if (line.startsWith("SwapFree:")) swapFreeKiB = Number(line.match(/\d+/)?.[0] ?? 0);
      if (line.startsWith("SwapTotal:")) swapTotalKiB = Number(line.match(/\d+/)?.[0] ?? 0);
    }
  } catch { /* /proc not available; return zeros (non-Linux) */ }
  return {
    memAvailableKiB,
    swapUsedKiB: swapTotalKiB > 0 ? swapTotalKiB - swapFreeKiB : 0,
  };
}

function readPsiMemorySome(): number {
  try {
    const raw = readFileSync("/proc/pressure/memory", "utf-8");
    const someMatch = raw.match(/some avg10=(\d+\.\d+)/);
    return someMatch ? Number(someMatch[1]) : 0;
  } catch { return 0; }
}

/**
 * Call the ONE authoritative process-tree measurement script (list-agent-rss.sh).
 * This replaces the broken cmdline-regex approach that measured 0.012 GiB against
 * ~2.2 GiB real (commit a6b9743). The script walks from tmux pane PIDs — session
 * name IS the agent identity, not a cmdline heuristic.
 *
 * Returns the full measurement including per-agent RSS, status, and count.
 * On ANY failure (script crash, timeout, unparseable output), returns a synthetic
 * error result with totalRssBytes: null — never a false zero.
 */
function readAgentRss(): import("./memory-pressure-types.js").AgentRssMeasurement {
  // Release-local copy — NOT INSTALL_DIR, which is the shared checkout.
  // A branch switch by another agent must not blind the measurement (card 5213e06c).
  const monitorDir = dirname(new URL(import.meta.url).pathname);
  const script = `${monitorDir}/list-agent-rss.sh`;
  try {
    const output = execSync(
      `bash "${script}" --json`,
      { timeout: 8000, encoding: "utf-8" },
    );
    const parsed = JSON.parse(output.trim()) as import("./memory-pressure-types.js").AgentRssMeasurement;

    // Defensive: if the script returned status "ok" but totalRssBytes is missing
    // or null, treat as error — a measurement that reports success but provides
    // no value is corrupt.
    if (parsed.status === "ok" && (parsed.totalRssBytes === null || parsed.totalRssBytes === undefined)) {
      return {
        source: "list-agent-rss.sh",
        status: "error",
        error: "script returned ok but totalRssBytes is null",
        measuredAgentCount: 0,
        failedAgentCount: 0,
        agents: [],
        totalRssBytes: null,
      };
    }

    return parsed;
  } catch (err) {
    return {
      source: "list-agent-rss.sh",
      status: "error",
      error: err instanceof Error ? err.message : "script execution failed",
      measuredAgentCount: 0,
      failedAgentCount: 0,
      agents: [],
      totalRssBytes: null,
    };
  }
}

/** Read expected agent count from the agent inventory (agents-desired.json).
 *  This is the canonical list of agents that SHOULD be running, maintained by
 *  the dashboard. Returns null if the file is unreadable — a null
 *  expectedAgentCount means "we don't know how many to expect", which makes
 *  partial status less actionable but is honest about the uncertainty. */
function readExpectedAgentCount(): number | null {
  try {
    const path = resolvePath("store/agents-desired.json");
    if (!existsSync(path)) return null;
    const agents = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(agents)) return agents.length;
    return null;
  } catch { return null; }
}

function sample(config: MemoryPressureConfig): MemoryPressureSample {
  const mem = readMemInfo();
  const rss = readAgentRss();
  return {
    timestamp: new Date().toISOString(),
    memAvailableGiB: mem.memAvailableKiB / 1048576,
    swapUsedGiB: mem.swapUsedKiB / 1048576,
    psiMemorySome: readPsiMemorySome(),
    agentProcessTreeRssBytes: rss.totalRssBytes,
    measuredAgentCount: rss.measuredAgentCount,
    expectedAgentCount: readExpectedAgentCount(),
    agentRssMeasurementStatus: rss.status,
    agentRssMeasurementSource: "list-agent-rss.sh",
  };
}

function computeNextState(
  current: MemoryPressureState,
  sample: MemoryPressureSample,
  since: string,
  thresholds: MemoryPressureConfig["thresholds"],
): MemoryPressureState {
  const av = sample.memAvailableGiB;

  // Emergency: critically low memory
  if (av < thresholds.emergencyMemAvailableGiB) return "emergency";

  // Critical: severe memory pressure
  if (av < thresholds.criticalMemAvailableGiB) return "critical";

  // Warning: elevated memory pressure
  if (av < thresholds.warningMemAvailableGiB) return "warning";

  // Sample is in normal range (av >= warning threshold). What happens next
  // depends on where we are now (hysteresis).

  // Recovery → normal: lock has already been released (the gate allows
  // non-core starts in both recovery and normal). After recoveryMinutes of
  // stable normal samples, declare the incident fully resolved and return
  // to the baseline state. This is NOT terminal — see gate.ts which
  // already allows non-core starts during recovery.
  if (current === "recovery") {
    const sinceMs = new Date(since).getTime();
    const stableMs = thresholds.recoveryMinutes * 60 * 1000;
    if (Date.now() - sinceMs >= stableMs) return "normal";
    return "recovery";
  }

  // Emergency / critical / warning: stepwise de-escalation. Must stay at
  // normal thresholds for recoveryMinutes before entering recovery.
  if (current === "emergency" || current === "critical" || current === "warning") {
    const sinceMs = new Date(since).getTime();
    const stableMs = thresholds.recoveryMinutes * 60 * 1000;
    if (Date.now() - sinceMs >= stableMs) return "recovery";
    // Not yet stable — keep current state. This is the hysteresis that prevents flapping.
    return current;
  }

  return "normal";
}

function atomicWrite(path: string, content: string): void {
  const tmp = path + ".tmp";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

function loadStateFile(statePath: string): MemoryPressureStateFile | null {
  try {
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, "utf-8")) as MemoryPressureStateFile;
    }
  } catch { /* corrupt or missing; start fresh */ }
  return null;
}

/** Resolve the running monitor's release metadata. Returns null if not
 *  installed via install-monitor.sh (e.g. running from source tree). */
function readReleaseMetadata(): { commit: string | null; releaseId: string | null } {
  try {
    // When running from a release, the release.json is next to the JS file.
    // __dirname equivalent for ESM: import.meta.url → file URL → dirname.
    const monitorDir = dirname(new URL(import.meta.url).pathname);
    const manifestPath = `${monitorDir}/release.json`;
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      return {
        commit: manifest.commit ?? null,
        releaseId: manifest.releaseId ?? null,
      };
    }
  } catch { /* not installed via install-monitor.sh */ }
  return { commit: null, releaseId: null };
}

function main(): void {
  const config = loadConfig();
  const statePath = resolveStatePath();
  const prev = loadStateFile(statePath);
  const currentSample = sample(config);
  const prevState = prev?.state ?? "normal";
  const prevSince = prev?.since ?? currentSample.timestamp;

  const measurementOk = currentSample.agentRssMeasurementStatus !== "error";
  const now = new Date().toISOString();

  const nextState = computeNextState(prevState, currentSample, prevSince, config.thresholds);

  // No state change → write nothing. Zero repeat reports, zero LLM calls.
  if (nextState === prevState && prevState !== "normal") {
    // In non-normal states, we still update the sample every N samples for freshness,
    // but avoid writing every cycle. Write on generation % 3 === 0 (every ~60s at 20s interval).
    if ((prev?.generation ?? 0) % 3 !== 0) return;
  }

  // Active pressure relief on critical/emergency transitions (component C).
  // At most ONE agent per cycle. NEVER touches core agents.
  // reliefCooldown prevents re-parking within the cooldown window.
  let reliefAction = prev?.lastAction ?? null;
  if (
    (nextState === "critical" || nextState === "emergency") &&
    nextState !== prevState
  ) {
    reliefAction = relievePressure(nextState) ?? reliefAction;
  }

  // Release metadata — null if running from source tree (dev mode).
  const release = readReleaseMetadata();

  // First sample ever, or first normal after load — write it.
  const stateFile: MemoryPressureStateFile = {
    state: nextState,
    since: nextState !== prevState ? currentSample.timestamp : prevSince,
    lastSample: currentSample,
    thresholds: config.thresholds,
    generation: (prev?.generation ?? 0) + 1,
    lastAction: reliefAction,
    // Dead-guard detection fields:
    // If measurement succeeded, advance lastSuccessfulMeasurementTime.
    // If it failed, keep the PREVIOUS value — we need to know how long
    // it has been since the last GOOD measurement, not the last attempt.
    lastSuccessfulMeasurementTime: measurementOk
      ? now
      : (prev?.lastSuccessfulMeasurementTime ?? now),
    lastMeasurementStatus: measurementOk ? "ok" : "failed",
    monitorBuildCommit: release.commit ?? prev?.monitorBuildCommit ?? null,
    releaseId: release.releaseId ?? prev?.releaseId ?? null,
  };

  atomicWrite(statePath, JSON.stringify(stateFile, null, 2));
}

main();
