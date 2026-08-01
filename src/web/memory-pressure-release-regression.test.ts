/**
 * Compiled-artifact regression tests for the P0 monitor release.
 *
 * These tests assert over the COMPILED RELEASE BUNDLE, not the TypeScript
 * source. The source looked correct during review; only the built bytes
 * told the truth (card 5213e06c).
 *
 * Ported from commit bd36767 (branch p0-monitor-cd-clean, the more-evolved
 * "P0 C+D" line this PR consolidated from — PR #775 review comment 6) and
 * adapted to THIS PR's state-file schema. That source branch runs a v2
 * schema (pressureState, monitorHealth, measurementCapabilities,
 * healthReasonCode) which this PR does not implement — its scenarios 4, 5,
 * and 12-15 assert on those v2-only fields/behaviours and are intentionally
 * NOT ported here, since including them unmodified would fail on a schema
 * version mismatch rather than a real regression. Everything schema-agnostic
 * (release-local dependency closure, decoy immunity, branch-switch
 * isolation, manifest integrity, negative control) is kept.
 *
 * Run with: VITEST=1 npx vitest run src/web/memory-pressure-release-regression.test.ts
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.env.MARVEEN_HOME ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASES_DIR = join(REPO_ROOT, "releases");
const CURRENT_LINK = join(RELEASES_DIR, "monitor-current");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

async function run(): Promise<void> {
  let pass = 0, fail = 0;
  function ok(label: string, condition: boolean | undefined | null, detail?: unknown): void {
    if (condition) pass++;
    else { fail++; console.log(`FAIL ${label}`, detail); }
  }

  const releaseExists = existsSync(CURRENT_LINK);
  if (!releaseExists) {
    console.log("No release found — skipping compiled-artifact tests (run install-monitor.sh first)");
    console.log(`release-regression: PASS ${pass} / FAIL ${fail} (${fail > 0 ? "SOME FAILED" : "all skipped - no release"})`);
    return;
  }

  const MONITOR_JS = join(CURRENT_LINK, "memory-pressure-monitor.js");
  const GATE_JS = join(CURRENT_LINK, "memory-pressure-gate.js");
  const HEALTH_JS = join(CURRENT_LINK, "memory-pressure-health.js");
  const SCRIPT_SH = join(CURRENT_LINK, "list-agent-rss.sh");
  const MANIFEST = join(CURRENT_LINK, "release.json");

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 1: Release-local script exists and is executable
  // ═══════════════════════════════════════════════════════════════════════
  {
    ok("S1: list-agent-rss.sh exists in release", existsSync(SCRIPT_SH), SCRIPT_SH);
    if (existsSync(SCRIPT_SH)) {
      try {
        execSync(`test -x "${SCRIPT_SH}"`, { timeout: 1000 });
        ok("S1: list-agent-rss.sh is executable", true);
      } catch {
        ok("S1: list-agent-rss.sh is executable", false, "not executable");
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 2: Decoy script at checkout path — release IGNORES it
  // Plant a DIFFERENT, wrong script at scripts/list-agent-rss.sh (the old
  // INSTALL_DIR path) and prove the release does NOT use it. Absence can be
  // masked by a fallback; a decoy cannot.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const checkoutScript = join(SCRIPTS_DIR, "list-agent-rss.sh");
    const originalExists = existsSync(checkoutScript);
    let originalContent = "";
    if (originalExists) originalContent = readFileSync(checkoutScript, "utf-8");

    const decoyContent = `#!/usr/bin/env bash
# DECOY — if the release uses this, the test FAILS
echo '{"source":"list-agent-rss.sh","status":"ok","measuredAgentCount":999,"failedAgentCount":0,"agents":[{"name":"DECOY-WRONG","rssBytes":1}],"totalRssBytes":1}'
`;

    // This test overwrites the REAL, shared scripts/list-agent-rss.sh at its
    // actual checkout path — that's the whole point (proving the release
    // ignores it), so the write can't be redirected to an isolated temp
    // path. But vitest runs test FILES in parallel by default, and any other
    // suite invoking this same script concurrently (e.g.
    // memory-pressure-telemetry.test.ts) would transiently see the decoy
    // and fail for a reason that has nothing to do with its own logic —
    // confirmed empirically: running this file together with the telemetry
    // suite produced 25 spurious telemetry failures with DECOY-WRONG/999 in
    // the output, while each file alone passes cleanly. Serialize the
    // mutation with a filesystem lock (mkdirSync is atomic/exclusive on
    // POSIX) so this window is never visible to a concurrent test, present
    // or future, without slowing down the rest of the suite.
    const lockDir = join(tmpdir(), "list-agent-rss-sh-mutation.lock");
    const lockDeadline = Date.now() + 10000;
    while (true) {
      try {
        mkdirSync(lockDir);
        break;
      } catch {
        if (Date.now() > lockDeadline) throw new Error("S2: timed out waiting for list-agent-rss.sh mutation lock");
        execSync("sleep 0.05");
      }
    }

    try {
      writeFileSync(checkoutScript, decoyContent);
      chmodSync(checkoutScript, 0o755);

      try {
        if (existsSync(SCRIPT_SH)) {
          const result = execSync(`bash "${SCRIPT_SH}" --json`, { timeout: 8000, encoding: "utf-8" });
          const parsed = JSON.parse(result.trim());
          const hasDecoy = parsed.agents?.some((a: any) => a.name === "DECOY-WRONG");
          ok("S2: decoy at checkout path NOT used by release", !hasDecoy,
            hasDecoy ? "DECOY DETECTED — release reached through checkout!" : "release-local script used correctly");
          ok("S2: measuredAgentCount is NOT 999", parsed.measuredAgentCount !== 999, `got ${parsed.measuredAgentCount}`);
        } else {
          ok("S2: release script missing — cannot test decoy", false);
        }
      } finally {
        if (originalExists) {
          writeFileSync(checkoutScript, originalContent);
          chmodSync(checkoutScript, 0o755);
        } else {
          try { unlinkSync(checkoutScript); } catch { /* ok */ }
        }
      }
    } finally {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 3: Compiled monitor.js has no INSTALL_DIR fallback for the
  // release-local script — a silent fallback to the shared checkout would
  // reintroduce the exact branch-switch hazard the release model exists to
  // prevent.
  // ═══════════════════════════════════════════════════════════════════════
  {
    if (existsSync(MONITOR_JS)) {
      const content = readFileSync(MONITOR_JS, "utf-8");
      const hasInstallDirFallback = /INSTALL_DIR.*scripts.*list-agent-rss/.test(content);
      ok("S3: compiled JS has NO INSTALL_DIR fallback for list-agent-rss",
        !hasInstallDirFallback,
        "Compiled JS still references INSTALL_DIR/scripts/ — silent fallback exists");
    } else {
      ok("S3: monitor.js exists", false, MONITOR_JS);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 6: Different cwd doesn't affect measurement
  // ═══════════════════════════════════════════════════════════════════════
  {
    if (existsSync(SCRIPT_SH)) {
      const result = execSync(`bash "${SCRIPT_SH}" --json`, { timeout: 8000, encoding: "utf-8", cwd: tmpdir() });
      const parsed = JSON.parse(result.trim());
      ok("S6: script runs from different cwd", parsed.status !== undefined, `status=${parsed.status}`);
      ok("S6: script returns valid measurement from /tmp", parsed.source === "list-agent-rss.sh", parsed.source);
    } else {
      ok("S6: script missing — cannot test", false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 7: Branch switch — release has NO source dependency
  // ═══════════════════════════════════════════════════════════════════════
  {
    for (const [label, path] of [["monitor.js", MONITOR_JS], ["gate.js", GATE_JS], ["health.js", HEALTH_JS]] as const) {
      if (!existsSync(path)) {
        ok(`S7: ${label} exists`, false, path);
        continue;
      }
      const content = readFileSync(path, "utf-8");
      const srcRefs = content.match(/src\/web\/memory-pressure/g);
      ok(`S7: ${label} has NO src/web/ imports (release-self-contained)`, !srcRefs,
        srcRefs ? `FOUND: ${srcRefs.join("; ")}` : "clean");

      const absRefs = content.match(/\/home\/iszzu\/marveen\/src\//g);
      ok(`S7: ${label} has NO absolute checkout paths`, !absRefs,
        absRefs ? `FOUND: ${absRefs.join("; ")}` : "clean");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 8: Negative control — the test CAN go RED
  // ═══════════════════════════════════════════════════════════════════════
  {
    const definitelyFalse = existsSync(join(CURRENT_LINK, "this-file-does-not-exist-xyz.js"));
    ok("S8: negative control — nonexistent file IS absent", !definitelyFalse,
      "If this fails, test harness is broken");

    const tsInRelease = existsSync(join(CURRENT_LINK, "memory-pressure-monitor.ts"));
    ok("S8: release does NOT contain .ts source (only compiled JS)", !tsInRelease,
      "TypeScript source found in release — build is wrong");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 9: release.json manifest integrity
  // ═══════════════════════════════════════════════════════════════════════
  {
    if (existsSync(MANIFEST)) {
      const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
      ok("S9: manifest has commit field", !!manifest.commit, manifest.commit);
      ok("S9: manifest has releaseId field", !!manifest.releaseId, manifest.releaseId);
      ok("S9: releaseId starts with monitor-", manifest.releaseId?.startsWith("monitor-"), manifest.releaseId);
      ok("S9: manifest has installedAt", !!manifest.installedAt, manifest.installedAt);
      ok("S9: manifest has files list", Array.isArray(manifest.files) && manifest.files.length > 0, manifest.files);

      if (Array.isArray(manifest.files)) {
        for (const f of manifest.files) {
          ok(`S9: manifest file ${f} exists in release`, existsSync(join(CURRENT_LINK, f)), f);
        }
      }
    } else {
      ok("S9: manifest exists", false, MANIFEST);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 10: Compiled JS has NO shared-checkout code references
  // ═══════════════════════════════════════════════════════════════════════
  {
    const forbiddenPatterns = [
      { pattern: /INSTALL_DIR.*scripts/g, name: "INSTALL_DIR/scripts" },
      { pattern: /MARVEEN_HOME.*scripts/g, name: "MARVEEN_HOME/scripts" },
    ];
    for (const [label, path] of [["monitor.js", MONITOR_JS], ["gate.js", GATE_JS], ["health.js", HEALTH_JS]] as const) {
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf-8");
      for (const { pattern, name } of forbiddenPatterns) {
        const hits = content.match(pattern);
        ok(`S10: ${label} has NO ${name} references`, !hits, hits ? `FOUND: ${hits.join("; ")}` : "clean");
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 11: dependency-closure-check.sh (review comment 6) passes clean
  // ═══════════════════════════════════════════════════════════════════════
  {
    const worktreeChecker = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/dependency-closure-check.sh");
    const checkerPath = existsSync(worktreeChecker) ? worktreeChecker : join(SCRIPTS_DIR, "dependency-closure-check.sh");
    if (existsSync(checkerPath)) {
      try {
        const result = execSync(`bash "${checkerPath}" "${CURRENT_LINK}"`, { timeout: 15000, encoding: "utf-8" });
        const parsed = JSON.parse(result.trim());
        ok("S11: dependency-closure-check.sh exit 0 (clean)", parsed.status === "ok", JSON.stringify(parsed));
      } catch (e: any) {
        ok("S11: dependency-closure-check.sh ran", false, e.message?.slice(0, 500));
      }
    } else {
      ok("S11: dependency-closure-check.sh exists", false, checkerPath);
    }
  }

  console.log(`\nrelease-regression: PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) {
    console.log(`\n${fail} compiled-artifact regression test(s) FAILED.`);
    throw new Error(`${fail} test(s) failed`);
  } else {
    console.log("All compiled-artifact regression tests passed.");
  }
}

if (process.env.VITEST) {
  const { test } = await import("vitest");
  test("memory-pressure-release-regression", run);
} else {
  run();
}
