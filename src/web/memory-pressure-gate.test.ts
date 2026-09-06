/**
 * Fixture-based tests for the memory-pressure gate (P0 build).
 *
 * Istvan FORBIDS a real memory-pressure test. All assertions use injected
 * fixture state files — the monitor is NOT running during tests, no real
 * agents are parked, no real memory is consumed.
 *
 * Coverage:
 *   - normal → gate allows non-core start
 *   - warning → gate blocks non-core start AND restart
 *   - critical → gate blocks non-core start
 *   - emergency → gate blocks non-core start
 *   - core agent always allowed (even in emergency)
 *   - missing state file + guard NEVER installed (no unit) → UNKNOWN, allowed (review #4)
 *   - missing state file + unsupported platform → UNKNOWN, allowed (review #4)
 *   - missing state file + guard unit IS installed → TERMINAL, fail-closed (review #4)
 *   - guard-absence is logged ONCE per process, not per gated call (review #4)
 *   - manual override → allows even in emergency
 *   - recovery → allows non-core after stable period
 *   - gate does NOT affect core agents
 *   - zero LLM calls (proven by construction — no imports from llm modules)
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { memoryPressureGate, __resetGuardAbsenceLogForTest } from "./memory-pressure-gate.js";
import { DEFAULT_CONFIG } from "./memory-pressure-types.js";
import type { MemoryPressureStateFile, MemoryPressureSample } from "./memory-pressure-types.js";

// Hermetic isolation: auto-generate a temp state file so tests never touch the
// live monitor's state file. The env var is checked at CALL time by
// resolveStatePath() in gate.ts — this module-level set happens after import
// but before any test function runs, which is exactly when we need it.
if (!process.env.MARVEEN_MEM_PRESSURE_TEST_STATE) {
  process.env.MARVEEN_MEM_PRESSURE_TEST_STATE = `${tmpdir()}/mem-pressure-gate-test-${Date.now()}.json`;
}
const STATE_PATH: string = process.env.MARVEEN_MEM_PRESSURE_TEST_STATE!;

// Hermetic isolation for the guard-installed check too: without this, the
// three-state tests below would depend on whatever happens to be installed
// on the box running the tests (e.g. this fleet's own box has a real,
// enabled marveen-memory-monitor.timer) instead of the fixture each test
// sets up. Force "no unit anywhere" by default; individual tests override
// per-case. Platform likewise defaults to "linux" so tests are deterministic
// regardless of what OS actually runs them.
process.env.MARVEEN_MEM_PRESSURE_TEST_UNIT_PATH = "";
process.env.MARVEEN_MEM_PRESSURE_TEST_PLATFORM = "linux";
const FAKE_UNIT_PATH = `${tmpdir()}/mem-pressure-gate-test-unit-${Date.now()}.timer`;

function setGuardUnitPresent(present: boolean): void {
  if (present) {
    writeFileSync(FAKE_UNIT_PATH, "[Timer]\n");
    process.env.MARVEEN_MEM_PRESSURE_TEST_UNIT_PATH = FAKE_UNIT_PATH;
  } else {
    try { unlinkSync(FAKE_UNIT_PATH); } catch { /* ok */ }
    process.env.MARVEEN_MEM_PRESSURE_TEST_UNIT_PATH = "";
  }
}

// No save/restore needed — the temp file is isolated from the live monitor.
// Still clean up after ourselves so /tmp does not accumulate orphaned state files.
let savedState: string | null = null;

function setup(): void {
  // First run: no saved state. Subsequent runs: nothing to save (temp file only).
}

function teardown(): void {
  try { unlinkSync(STATE_PATH); } catch { /* ok */ }
}

// Fixture input allows partial lastSample for ergonomic test writing.
// The merge in writeFixture fills missing lastSample fields from defaults.
type FixtureState = Partial<Omit<MemoryPressureStateFile, "lastSample">> & { lastSample?: Partial<MemoryPressureSample> };

function writeFixture(state: FixtureState): void {
  const defaultSample: MemoryPressureSample = {
    timestamp: new Date().toISOString(),
    memAvailableGiB: 5.0,
    swapUsedGiB: 0.0,
    psiMemorySome: 0.0,
    agentProcessTreeRssBytes: 2 * 1073741824, // ~2 GiB
    measuredAgentCount: 8,
    expectedAgentCount: 6,
    agentRssMeasurementStatus: "ok",
    agentRssMeasurementSource: "list-agent-rss.sh",
  };
  // Build the base fixture, then spread state over it. The lastSample is
  // deep-merged: defaults from defaultSample, overridden by state.lastSample.
  const baseFixture: MemoryPressureStateFile = {
    state: "normal",
    since: new Date().toISOString(),
    lastSample: defaultSample,
    thresholds: DEFAULT_CONFIG.thresholds,
    generation: 1,
    lastAction: null,
    lastSuccessfulMeasurementTime: new Date().toISOString(),
    lastMeasurementStatus: "ok",
    monitorBuildCommit: null,
    releaseId: null,
  };
  const fixture: MemoryPressureStateFile = {
    ...baseFixture,
    ...state,
    lastSample: state.lastSample
      ? { ...defaultSample, ...state.lastSample } as MemoryPressureSample
      : baseFixture.lastSample,
  };
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(fixture, null, 2), "utf-8");
}

// Reset override between tests
function clearOverride(): void {
  delete process.env.MARVEEN_MEM_PRESSURE_OVERRIDE;
}

async function run(): Promise<void> {
  let pass = 0, fail = 0;
  function ok(label: string, condition: boolean, detail?: unknown): void {
    if (condition) pass++;
    else { fail++; console.log(`FAIL ${label}`, detail); }
  }

  setup();

  // ── normal: gate allows non-core start ─────────────────────────────────
  {
    writeFixture({ state: "normal" });
    const r = memoryPressureGate("test-agent");
    ok("normal → non-core allowed", r.allowed, r);
  }
  {
    // Missing state file is now ambiguous by itself (review #4) — the
    // outcome depends on whether the guard was ever installed. This case:
    // guard unit IS present (a real, installed monitor that just hasn't
    // written a state file, or lost it) → stays fail-closed, terminal.
    teardown();
    setGuardUnitPresent(true);
    const r = memoryPressureGate("test-agent");
    ok("no state file + guard installed → non-core blocked (fail-closed)", !r.allowed, r);
    setGuardUnitPresent(false);
  }

  // ── warning blocks non-core ────────────────────────────────────────────
  {
    writeFixture({
      state: "warning",
      lastSample: { timestamp: new Date().toISOString(), memAvailableGiB: 2.0, swapUsedGiB: 0.1, psiMemorySome: 2.5, agentProcessTreeRssBytes: 4.0 },
    });
    const r = memoryPressureGate("some-agent");
    ok("warning → non-core blocked", !r.allowed, r);
  }

  // ── critical blocks non-core ───────────────────────────────────────────
  {
    writeFixture({
      state: "critical",
      lastSample: { timestamp: new Date().toISOString(), memAvailableGiB: 1.2, swapUsedGiB: 0.5, psiMemorySome: 8.0, agentProcessTreeRssBytes: 5.5 },
    });
    const r = memoryPressureGate("buildfejleszto");
    ok("critical → non-core blocked", !r.allowed, r);
  }

  // ── emergency blocks non-core ──────────────────────────────────────────
  {
    writeFixture({
      state: "emergency",
      lastSample: { timestamp: new Date().toISOString(), memAvailableGiB: 0.5, swapUsedGiB: 2.0, psiMemorySome: 15.0, agentProcessTreeRssBytes: 6.5 },
    });
    const r = memoryPressureGate("frontendfejleszto");
    ok("emergency → non-core blocked", !r.allowed, r);
  }

  // ── core agent always allowed ──────────────────────────────────────────
  {
    writeFixture({ state: "warning" });
    let r = memoryPressureGate("marveen"); // default core
    ok("warning → core allowed", r.allowed, r);
  }
  {
    writeFixture({ state: "critical" });
    const r = memoryPressureGate("marveen");
    ok("critical → core allowed", r.allowed, r);
  }
  {
    writeFixture({ state: "emergency" });
    const r = memoryPressureGate("marveen");
    ok("emergency → core allowed", r.allowed, r);
  }

  // ── missing state file, guard installed → fail-closed for non-core ─────
  {
    teardown();
    setGuardUnitPresent(true);
    const r = memoryPressureGate("non-core-agent");
    ok("missing state + guard installed → non-core blocked (fail-closed)", !r.allowed, r);
    // core still works even without state file
    const r2 = memoryPressureGate("marveen");
    ok("missing state → core allowed", r2.allowed, r2);
    setGuardUnitPresent(false);
  }

  // ── three-state split (review #4): never-installed / unsupported-platform
  //    do NOT block; installed-but-not-reporting stays fail-closed ─────────
  {
    // 1. Never installed (no state file, no systemd unit, supported platform)
    //    → UNKNOWN, allowed. This is the review's core complaint: merging the
    //    old binary gate as-is would block the ENTIRE non-core fleet on any
    //    host that never set the monitor up.
    teardown();
    setGuardUnitPresent(false);
    process.env.MARVEEN_MEM_PRESSURE_TEST_PLATFORM = "linux";
    __resetGuardAbsenceLogForTest();
    const r1 = memoryPressureGate("never-installed-agent");
    ok("never installed (no unit) → non-core ALLOWED (unknown, not blocked)", r1.allowed, r1);
    ok("never-installed reason mentions gate-absent", r1.reason.includes("gate-absent"), r1.reason);
  }
  {
    // 2. Unsupported platform (e.g. upstream reviewer's own macOS/Darwin
    //    dev box) → UNKNOWN, allowed, regardless of unit-file state.
    teardown();
    setGuardUnitPresent(true); // even if a stray unit file exists, platform wins
    process.env.MARVEEN_MEM_PRESSURE_TEST_PLATFORM = "darwin";
    __resetGuardAbsenceLogForTest();
    const r2 = memoryPressureGate("mac-dev-agent");
    ok("unsupported platform → non-core ALLOWED (unknown, not blocked)", r2.allowed, r2);
    ok("unsupported-platform reason mentions platform", r2.reason.includes("platform"), r2.reason);
    process.env.MARVEEN_MEM_PRESSURE_TEST_PLATFORM = "linux";
    setGuardUnitPresent(false);
  }
  {
    // 3. Installed but broken/not-reporting (unit present, no state file,
    //    supported platform) → TERMINAL, stays fail-closed. This is the
    //    exact case fail-closed exists for and review #4 explicitly says
    //    NOT to weaken: "a guard that was working and then died must still
    //    block; a guard that was never there is a different claim."
    teardown();
    setGuardUnitPresent(true);
    process.env.MARVEEN_MEM_PRESSURE_TEST_PLATFORM = "linux";
    const r3 = memoryPressureGate("broken-guard-agent");
    ok("installed but not reporting → non-core BLOCKED (fail-closed, terminal)", !r3.allowed, r3);
    ok("terminal reason mentions guard installed", r3.reason.includes("guard installed"), r3.reason);
    setGuardUnitPresent(false);
  }
  {
    // 4. Guard-absence is logged ONCE per process, not once per gated call.
    //    We can't easily intercept the pino logger's output here without
    //    extra machinery, but we CAN assert the reset hook exists and that
    //    repeated allowed-by-absence calls don't change the gate's answer
    //    (i.e. the once-logged state doesn't affect the DECISION, only the
    //    logging) — the decision must be idempotent across repeated calls.
    teardown();
    setGuardUnitPresent(false);
    __resetGuardAbsenceLogForTest();
    const first = memoryPressureGate("agent-a");
    const second = memoryPressureGate("agent-b");
    ok("repeated never-installed calls both allowed (log-once doesn't gate)", first.allowed && second.allowed, { first, second });
  }

  // ── manual override ────────────────────────────────────────────────────
  {
    writeFixture({ state: "emergency" });
    process.env.MARVEEN_MEM_PRESSURE_OVERRIDE = "1";
    const r = memoryPressureGate("any-agent");
    ok("override=1 → allowed even in emergency", r.allowed, r);
    clearOverride();
  }
  {
    writeFixture({ state: "warning" });
    process.env.MARVEEN_MEM_PRESSURE_OVERRIDE = "marveen,specific-agent";
    const r = memoryPressureGate("specific-agent");
    ok("override=list → specific agent allowed", r.allowed, r);
    const r2 = memoryPressureGate("other-agent");
    ok("override=list → other agent still blocked", !r2.allowed, r2);
    clearOverride();
  }

  // ── recovery allows non-core ───────────────────────────────────────────
  {
    writeFixture({ state: "recovery" });
    const r = memoryPressureGate("some-agent");
    ok("recovery → non-core allowed", r.allowed, r);
  }

  // ── reason includes state + threshold in blocked case ───────────────────
  {
    writeFixture({
      state: "critical",
      lastSample: { timestamp: new Date().toISOString(), memAvailableGiB: 1.0, swapUsedGiB: 0.3, psiMemorySome: 5.0, agentProcessTreeRssBytes: 3.0 },
    });
    const r = memoryPressureGate("agent-x");
    ok("block reason includes state", r.reason.includes("state=critical"), r.reason);
    ok("block reason includes memAvailable", r.reason.includes("memAvailable=1.0GiB"), r.reason);
    ok("block reason includes threshold", r.reason.includes("threshold=2.5GiB"), r.reason);
  }

  teardown();
  setGuardUnitPresent(false);
  console.log(`memory-pressure-gate: PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) throw new Error(`${fail} test(s) failed`);
}

// Vitest integration: when running under vitest (VITEST env var set), import
// and register via vitest's test(). Standalone (tsx/node): call run() directly.
// Both paths are hermetic — the env var is set at module level above.
if (process.env.VITEST) {
  const { test } = await import("vitest");
  test("memory-pressure-gate", run);
} else {
  run();
}
