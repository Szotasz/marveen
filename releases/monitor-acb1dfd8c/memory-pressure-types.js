/**
 * Memory-pressure state file shared between the independent monitor (component A),
 * the global gate in startAgentProcess (component B), and the active pressure
 * relief logic (component C). Single source of truth, atomic write.
 *
 * P0 commit — Istvan-approved plan, single isolated commit.
 * Do NOT merge memGate logic from fleet-memory-gate.sh into this file.
 * That gate is deliberately fail-open; this one is fail-closed.
 */
export const DEFAULT_CONFIG = {
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
