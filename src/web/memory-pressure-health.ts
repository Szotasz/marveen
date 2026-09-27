/**
 * Monitor health check (P0 phase 2, requirement D).
 *
 * Health must NOT be inferred from "timer active + state file exists" alone.
 * The incident at 05:20-05:28 proved this: the timer was active, the state
 * file existed, but every single run was failing (Module not found after a
 * branch switch).
 *
 * Required condition for healthy:
 *   1. State file exists AND is fresh (mtime age ≤ 2 monitor cycles)
 *   2. Last measurement status = "ok" (not "failed")
 *   3. Last successful measurement is fresh (age ≤ 2 monitor cycles)
 *
 * Failure modes surfaced explicitly:
 *   MONITOR_STATE_STALE       — state file missing or too old
 *   MONITOR_EXECUTION_FAILED  — state file fresh but last measurement failed
 *
 * Both produce fail-closed lifecycle behaviour for non-core agents.
 *
 * This module checks the STATE FILE only. Systemd timer/service health is
 * reported by the state file's freshness and lastMeasurementStatus — a
 * failing service cannot update the state file.
 */

import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import type { MemoryPressureStateFile } from "./memory-pressure-types.js";
import { DEFAULT_CONFIG, STATE_FILE } from "./memory-pressure-types.js";

export type MonitorFailureMode =
  | "MONITOR_STATE_STALE"
  | "MONITOR_EXECUTION_FAILED"
  | "MONITOR_RELEASE_MISMATCH";

export interface MonitorHealth {
  healthy: boolean;
  failureMode: MonitorFailureMode | null;
  /** Human-readable diagnostic for logs/notifications. */
  details: string;
  /** When the state file was last modified (epoch ms), or null if missing. */
  stateFileMtimeMs: number | null;
  /** How old the last successful measurement is (seconds), or null if unknown. */
  lastSuccessAgeSeconds: number | null;
  /** The state file's generation at time of check, or null. */
  stateGeneration: number | null;
}

const INSTALL_DIR = process.env.MARVEEN_HOME ?? process.cwd();

function resolveStatePath(): string {
  const override = process.env.MARVEEN_MEM_PRESSURE_TEST_STATE;
  if (override) return override;
  return `${INSTALL_DIR}/${STATE_FILE}`;
}

export function loadStateFile(): MemoryPressureStateFile | null {
  try {
    const path = resolveStatePath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as MemoryPressureStateFile;
  } catch {
    return null;
  }
}

/**
 * Check monitor health from the state file alone.
 *
 * The state file IS the monitor's heartbeat. If the timer fires but the
 * service crashes (import error, syntax error, missing dependency), the
 * state file is never updated — mtime ages, lastMeasurementStatus stays
 * "failed", and this function returns unhealthy.
 *
 * @param stateFile  Pre-loaded state file (for test injection), or null to load from disk.
 * @param nowMs      Current time in epoch ms (for test injection).
 * @param maxCycles  Max allowed age in monitor cycles (default 2).
 */

/**
 * The release the monitor SHOULD be running from: the target of the
 * releases/monitor-current symlink. Returns null when the symlink is absent
 * (e.g. a dev box that never ran install-monitor.sh) -- in that case we cannot
 * compare, so we do not fail the health check on it.
 */
function readInstalledReleaseId(): string | null {
  try {
    const override = process.env.MARVEEN_MEM_PRESSURE_TEST_RELEASE_LINK;
    const link = override ?? `${INSTALL_DIR}/releases/monitor-current`;
    // readlinkSync, NOT existsSync: existsSync FOLLOWS the symlink, so a
    // DANGLING monitor-current (release dir deleted, e.g. by git clean) would
    // return false and silently disable this whole check -- the one case where
    // it matters most. readlinkSync reads the link itself and throws only when
    // there is no link at all.
    const target = readlinkSync(link);
    return target.split("/").filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

export function checkMonitorHealth(
  stateFile?: MemoryPressureStateFile | null,
  nowMs?: number,
  maxCycles?: number,
): MonitorHealth {
  const now = nowMs ?? Date.now();
  const cycles = maxCycles ?? 2;
  const maxAgeMs = cycles * DEFAULT_CONFIG.monitor.sampleIntervalSeconds * 1000; // 2 × 20s = 40s

  const statePath = resolveStatePath();

  // ── State file existence + freshness ───────────────────────────────────
  let stateFileMtimeMs: number | null = null;

  try {
    if (existsSync(statePath)) {
      stateFileMtimeMs = statSync(statePath).mtimeMs;
    }
  } catch {
    // stat failed — treat as missing
  }

  if (stateFileMtimeMs === null) {
    return {
      healthy: false,
      failureMode: "MONITOR_STATE_STALE",
      details: "state file missing — monitor has never written or was deleted",
      stateFileMtimeMs: null,
      lastSuccessAgeSeconds: null,
      stateGeneration: null,
    };
  }

  const stateAgeMs = now - stateFileMtimeMs;

  if (stateAgeMs > maxAgeMs) {
    return {
      healthy: false,
      failureMode: "MONITOR_STATE_STALE",
      details: `state file age ${Math.round(stateAgeMs / 1000)}s exceeds max ${Math.round(maxAgeMs / 1000)}s (${cycles} cycles)`,
      stateFileMtimeMs,
      lastSuccessAgeSeconds: null,
      stateGeneration: null,
    };
  }

  // ── Load content ───────────────────────────────────────────────────────
  const state = stateFile ?? loadStateFile();

  if (!state) {
    return {
      healthy: false,
      failureMode: "MONITOR_STATE_STALE",
      details: "state file exists but cannot be parsed — corrupt or empty",
      stateFileMtimeMs,
      lastSuccessAgeSeconds: null,
      stateGeneration: null,
    };
  }

  // ── Last measurement status ────────────────────────────────────────────
  const lastStatus = state.lastMeasurementStatus ?? "ok"; // pre-D fields default ok
  const lastSuccessTime = state.lastSuccessfulMeasurementTime
    ? new Date(state.lastSuccessfulMeasurementTime).getTime()
    : null;

  if (lastStatus === "failed") {
    return {
      healthy: false,
      failureMode: "MONITOR_EXECUTION_FAILED",
      details: `last measurement status is "failed" — timer may be firing but service execution is broken`,
      stateFileMtimeMs,
      lastSuccessAgeSeconds: lastSuccessTime ? Math.round((now - lastSuccessTime) / 1000) : null,
      stateGeneration: state.generation,
    };
  }

  // ── Last successful measurement freshness ──────────────────────────────
  if (lastSuccessTime !== null) {
    const successAgeMs = now - lastSuccessTime;
    if (successAgeMs > maxAgeMs) {
      return {
        healthy: false,
        failureMode: "MONITOR_STATE_STALE",
        details: `last successful measurement age ${Math.round(successAgeMs / 1000)}s exceeds max ${Math.round(maxAgeMs / 1000)}s (${cycles} cycles)`,
        stateFileMtimeMs,
        lastSuccessAgeSeconds: Math.round(successAgeMs / 1000),
        stateGeneration: state.generation,
      };
    }
  }

  // -- Release match ------------------------------------------------------
  // A state file can be fresh, recent and status=ok and STILL be written by a
  // monitor from a superseded release: install a new release, fail to restart
  // the timer, and the old process keeps heartbeating. Every other check here
  // passes and the guard silently protects using stale logic. Compare what
  // wrote the state against what is installed.
  const installedRelease = readInstalledReleaseId();
  if (installedRelease !== null && state.releaseId && state.releaseId !== installedRelease) {
    return {
      healthy: false,
      failureMode: "MONITOR_RELEASE_MISMATCH",
      details: `state written by release ${state.releaseId} but ${installedRelease} is installed -- a superseded monitor is still running`,
      stateFileMtimeMs,
      lastSuccessAgeSeconds: lastSuccessTime ? Math.round((now - lastSuccessTime) / 1000) : null,
      stateGeneration: state.generation,
    };
  }

  // -- All checks passed ─────────────────────────────────────────────────
  return {
    healthy: true,
    failureMode: null,
    details: `monitor healthy — generation ${state.generation}, state=${state.state}, lastSuccessAge=${lastSuccessTime ? Math.round((now - lastSuccessTime) / 1000) : '?'}s`,
    stateFileMtimeMs,
    lastSuccessAgeSeconds: lastSuccessTime ? Math.round((now - lastSuccessTime) / 1000) : null,
    stateGeneration: state.generation,
  };
}
