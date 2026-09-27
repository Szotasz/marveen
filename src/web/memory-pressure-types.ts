/**
 * Memory-pressure state file shared between the independent monitor (component A),
 * the global gate in startAgentProcess (component B), and the active pressure
 * relief logic (component C). Single source of truth, atomic write.
 *
 * P0 commit — Istvan-approved plan, single isolated commit.
 * Do NOT merge memGate logic from fleet-memory-gate.sh into this file.
 * That gate is deliberately fail-open; this one is fail-closed.
 */

export type MemoryPressureState = "normal" | "warning" | "critical" | "emergency" | "recovery";

/** Structured output from list-agent-rss.sh --json. ONE authoritative measurement
 *  consumed by both the monitor (telemetry) and the gate (eviction selector). */
export interface AgentRssMeasurement {
  source: "list-agent-rss.sh";
  status: "ok" | "partial" | "error";
  error?: string;            // present only on error
  measuredAgentCount: number;
  failedAgentCount: number;
  agents: { name: string; rssBytes: number }[];
  totalRssBytes: number | null;  // null on error — ZERO means genuinely zero agents
}

export interface MemoryPressureSample {
  timestamp: string; // ISO 8601
  memAvailableGiB: number;
  swapUsedGiB: number;
  psiMemorySome: number; // /proc/pressure/memory some avg10

  // Agent process-tree RSS from list-agent-rss.sh (ONE authoritative source).
  // Bytes, not GiB — no lossy conversion at the measurement layer.
  // null means the measurement FAILED (status=error). 0 means we measured
  // successfully and there are genuinely zero running agents.
  agentProcessTreeRssBytes: number | null;
  measuredAgentCount: number;
  // expectedAgentCount comes from the agent INVENTORY (agents-desired.json),
  // NOT from the measurement result. It represents how many agents SHOULD be
  // running. When expected != measured, status "partial" becomes actionable:
  // we know which agents are missing from the measurement.
  expectedAgentCount: number | null;
  agentRssMeasurementStatus: "ok" | "partial" | "error";
  agentRssMeasurementSource: "list-agent-rss.sh";
}

export interface MemoryPressureReliefAction {
  timestamp: string;
  action: "parked";
  agentName: string;
  pidTreeKilled: number[];
  rssFreedGiB: number;
  reason: string;
}

export interface MemoryPressureStateFile {
  state: MemoryPressureState;
  since: string; // ISO 8601 — when the current state was entered
  lastSample: MemoryPressureSample;
  thresholds: {
    warningMemAvailableGiB: number;
    criticalMemAvailableGiB: number;
    emergencyMemAvailableGiB: number;
    recoveryMinutes: number;
  };
  generation: number; // monotonically increasing, for change detection
  lastAction: MemoryPressureReliefAction | null;
  // ── Dead-guard detection fields (P0 phase 2, requirements C/D) ──────────
  // Health must NOT be inferred from "timer active + state file exists" alone.
  // These fields let the health check distinguish a working monitor from one
  // whose timer fires but whose execution crashes (Module not found, etc.).
  lastSuccessfulMeasurementTime: string; // ISO 8601 — last time a measurement succeeded
  lastMeasurementStatus: "ok" | "failed"; // whether the LAST measurement attempt succeeded
  monitorBuildCommit: string | null;       // source commit of the running monitor build
  releaseId: string | null;               // which release (monitor-<hash>) is running
}

export interface MemoryPressureConfig {
  coreAgents: string[];
  thresholds: {
    warningMemAvailableGiB: number;
    criticalMemAvailableGiB: number;
    emergencyMemAvailableGiB: number;
    recoveryMinutes: number;
  };
  monitor: {
    sampleIntervalSeconds: number;
  };
  relief: {
    maxPerCycle: number;
    cooldownSeconds: number;
  };
}

export const DEFAULT_CONFIG: MemoryPressureConfig = {
  coreAgents: ["marveen"],
  thresholds: {
    warningMemAvailableGiB: 2.5,
    criticalMemAvailableGiB: 1.5,
    emergencyMemAvailableGiB: 0.8,
    recoveryMinutes: 5,
  },
  monitor: {
    sampleIntervalSeconds: 20,
  },
  relief: {
    maxPerCycle: 1,
    cooldownSeconds: 60,
  },
};

// MARVEEN_MEM_PRESSURE_TEST_STATE overrides the state file path for hermetic
// testing. When set, tests read/write to an isolated temp file instead of the
// live monitor's state file — the tests neither depend on nor disturb the
// running daemon, and the daemon's timer cannot race a test assertion.
export const STATE_FILE = process.env.MARVEEN_MEM_PRESSURE_TEST_STATE ?? "store/runtime/memory-pressure-state.json";
export const CONFIG_FILE = "store/memory-pressure-config.json";
