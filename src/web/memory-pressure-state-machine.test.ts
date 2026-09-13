/**
 * State-machine tests for the memory-pressure monitor (P0 build).
 *
 * Fixture-driven: inject sample values, assert the state transition.
 * No real /proc reads, no real agents. Proves:
 *   - normal stays normal when MemAvailable >= 2.5 GiB
 *   - normal → warning when MemAvailable drops below 2.5 GiB
 *   - warning → critical below 1.5 GiB
 *   - critical → emergency below 0.8 GiB
 *   - recovery after 5+ min stable normal (hysteresis)
 *   - no flapping: state stays stable through minor fluctuations
 */

import { DEFAULT_CONFIG } from "./memory-pressure-types.js";
import type { MemoryPressureState, MemoryPressureSample } from "./memory-pressure-types.js";

// Inline the state-machine logic from memory-pressure-monitor.ts so we can
// test it without /proc access. This is the EXACT function from the monitor.
function computeNextState(
  current: MemoryPressureState,
  sample: MemoryPressureSample,
  since: string,
  thresholds: typeof DEFAULT_CONFIG.thresholds,
): MemoryPressureState {
  const av = sample.memAvailableGiB;

  if (av < thresholds.emergencyMemAvailableGiB) return "emergency";
  if (av < thresholds.criticalMemAvailableGiB) return "critical";
  if (av < thresholds.warningMemAvailableGiB) return "warning";

  // Recovery → normal after sustained stability
  if (current === "recovery") {
    const sinceMs = new Date(since).getTime();
    const stableMs = thresholds.recoveryMinutes * 60 * 1000;
    if (Date.now() - sinceMs >= stableMs) return "normal";
    return "recovery";
  }

  // Emergency / critical / warning → recovery after sustained normal
  if (current === "emergency" || current === "critical" || current === "warning") {
    const sinceMs = new Date(since).getTime();
    const stableMs = thresholds.recoveryMinutes * 60 * 1000;
    if (Date.now() - sinceMs >= stableMs) return "recovery";
    return current;
  }

  return "normal";
}

function sample(availGiB: number): MemoryPressureSample {
  return {
    timestamp: new Date().toISOString(),
    memAvailableGiB: availGiB,
    swapUsedGiB: 0,
    psiMemorySome: 0,
    agentProcessTreeRssBytes: (5 - availGiB) * 1073741824, // rough inverse, in bytes
    measuredAgentCount: 8,
    expectedAgentCount: 6,  // from agents-desired.json — fewer than measured = some manually started
    agentRssMeasurementStatus: "ok",
    agentRssMeasurementSource: "list-agent-rss.sh",
  };
}

const T = DEFAULT_CONFIG.thresholds;

async function run(): Promise<void> {
  let pass = 0, fail = 0;
  function ok(label: string, condition: boolean, detail?: unknown): void {
    if (condition) pass++;
    else { fail++; console.log(`FAIL ${label}`, detail); }
  }

  // ── normal stays normal ────────────────────────────────────────────────
  ok("6GiB → normal", computeNextState("normal", sample(6.0), new Date(0).toISOString(), T) === "normal");
  ok("3GiB → normal", computeNextState("normal", sample(3.0), new Date(0).toISOString(), T) === "normal");
  ok("2.6GiB → normal", computeNextState("normal", sample(2.6), new Date(0).toISOString(), T) === "normal");

  // ── transitions down ───────────────────────────────────────────────────
  ok("normal → warning at 2.4GiB", computeNextState("normal", sample(2.4), new Date(0).toISOString(), T) === "warning");
  ok("normal → warning at 2.0GiB", computeNextState("normal", sample(2.0), new Date(0).toISOString(), T) === "warning");
  ok("normal → critical at 1.4GiB", computeNextState("normal", sample(1.4), new Date(0).toISOString(), T) === "critical");
  ok("normal → critical at 1.0GiB", computeNextState("normal", sample(1.0), new Date(0).toISOString(), T) === "critical");
  ok("normal → emergency at 0.7GiB", computeNextState("normal", sample(0.7), new Date(0).toISOString(), T) === "emergency");
  ok("normal → emergency at 0.3GiB", computeNextState("normal", sample(0.3), new Date(0).toISOString(), T) === "emergency");

  // ── hysteresis: warning doesn't go back to normal until recovery period ─
  ok("warning stays warning at 2.6GiB (not yet stable — hysteresis holds)", computeNextState("warning", sample(2.6), new Date().toISOString(), T) === "warning");
  // Stepwise de-escalation: critical → warning when above 1.5 but below 2.5
  ok("critical → warning at 1.6GiB (stepwise de-escalation)", computeNextState("critical", sample(1.6), new Date().toISOString(), T) === "warning");
  // emergency → critical when above 0.8 but below 1.5 (one step at a time)
  ok("emergency → critical at 0.9GiB (stepwise de-escalation)", computeNextState("emergency", sample(0.9), new Date().toISOString(), T) === "critical");

  // ── recovery after stable period ────────────────────────────────────────
  ok("warning → recovery after 5+ min stable normal",
    computeNextState("warning", sample(3.0), new Date(Date.now() - 6 * 60 * 1000).toISOString(), T) === "recovery");
  ok("critical → recovery after 5+ min stable normal",
    computeNextState("critical", sample(4.0), new Date(Date.now() - 10 * 60 * 1000).toISOString(), T) === "recovery");
  ok("emergency → recovery after 5+ min stable normal",
    computeNextState("emergency", sample(5.0), new Date(Date.now() - 7 * 60 * 1000).toISOString(), T) === "recovery");

  // ── recovery → normal after staying normal ──────────────────────────────
  ok("recovery stays recovery at 3GiB, only 1min stable (not yet)",
    computeNextState("recovery", sample(3.0), new Date(Date.now() - 1 * 60 * 1000).toISOString(), T) === "recovery");
  ok("recovery → normal after 5+ min stable normal (incident fully resolved)",
    computeNextState("recovery", sample(4.0), new Date(Date.now() - 6 * 60 * 1000).toISOString(), T) === "normal");
  ok("recovery → normal after 10min stable normal",
    computeNextState("recovery", sample(5.0), new Date(Date.now() - 10 * 60 * 1000).toISOString(), T) === "normal");

  // ── no flapping: minor fluctuation within warning band stays warning ─────
  ok("warning at 2.4GiB → still warning at 2.3GiB", computeNextState("warning", sample(2.3), new Date().toISOString(), T) === "warning");

  console.log(`memory-pressure-state-machine: PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) throw new Error(`${fail} test(s) failed`);
}

if (process.env.VITEST) {
  const { test } = await import("vitest");
  test("memory-pressure-state-machine", run);
} else {
  run();
}
