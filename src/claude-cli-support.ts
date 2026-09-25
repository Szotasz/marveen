// Which Claude model ids the INSTALLED Claude Code CLI can actually launch.
//
// Pure module, zero I/O: every decision is unit-testable without a binary.
// The measurement (running `claude --version`) lives in
// src/web/claude-cli-version.ts; this file only interprets its result.
//
// WHY THIS EXISTS (PICKERCLIKAPU923, measured 2026-09-23): the dashboard's
// model picker is a static list, and a customer install pins the CLI
// (install-linux.sh CLAUDE_PIN="2.1.110"). On that CLI, `claude-fable-5-1`
// and `claude-opus-5-5` answer HTTP 400 `unrecognized_model` on the FIRST
// prompt, while `claude-opus-5` and `claude-sonnet-5` run (positive control,
// same box, same run). Nothing in the launch path catches this: the session
// comes up, every prompt 400s in the pane, and the agent is silently deaf.
// The picker therefore has to know what the installed CLI can run.
//
// FAIL-OPEN BY DESIGN: when the installed version is NOT measurable (binary
// not on PATH, probe error, unexpected output), no option is filtered. A
// customer who cannot pick any model is worse off than today; the caller
// shows a visible "unmeasured" label instead.

export interface ClaudeModelCliRequirement {
  /** Lowest CLI version MEASURED to launch this model. */
  minCli: string
  /** Where the number comes from, so the next reader can re-measure. */
  measured: string
}

/**
 * Per model id (bracket suffix stripped): the lowest CLI version we have
 * measured to run it. Models absent from this table carry no known
 * constraint. The `minCli` is the lowest MEASURED-GOOD version, not the true
 * minimum: a version between the measured-bad and measured-good points is
 * treated as unsupported (conservative for the model, never for the picker
 * as a whole).
 */
export const CLAUDE_MODEL_MIN_CLI: Readonly<Record<string, ClaudeModelCliRequirement>> = {
  'claude-fable-5-1': {
    minCli: '2.1.278',
    measured: '2.1.110 -> 400 unrecognized_model (hermes, 2026-09-23); 2.1.278 and 2.1.280 -> OK (owner Mac, 2026-09-22)',
  },
  'claude-opus-5-5': {
    minCli: '2.1.280',
    measured: '2.1.110 and 2.1.278 -> 400 unrecognized_model; 2.1.280 -> OK for both claude-opus-5-5 and claude-opus-5-5[1m] (owner Mac, 2026-09-22)',
  },
}

/** `2.1.280 (Claude Code)` -> `2.1.280`; anything without a dotted number -> null. */
export function parseClaudeVersion(output: string | null | undefined): string | null {
  if (!output) return null
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/** Numeric dotted compare: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** `claude-opus-5-5[1m]` -> `claude-opus-5-5` (the table is keyed without the suffix). */
export function baseModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').trim()
}

/**
 * True only when the installed version IS measured AND the model has a
 * recorded minimum above it. An unmeasured version (null) never makes a model
 * unsupported (fail-open); a model with no recorded constraint is never
 * unsupported either.
 */
export function isModelUnsupportedByCli(model: string, installedVersion: string | null): boolean {
  if (!installedVersion) return false
  const req = CLAUDE_MODEL_MIN_CLI[baseModelId(model)]
  if (!req) return false
  return compareVersions(installedVersion, req.minCli) < 0
}

export interface ClaudeSupportSummary {
  /** Whether the installed version was measured at all. */
  measured: boolean
  installedVersion: string | null
  /** Model ids (WITHOUT bracket suffix) the installed CLI cannot launch. Empty when unmeasured. */
  unsupported: Array<{ id: string; minCli: string }>
}

export function claudeSupportForCli(installedVersion: string | null): ClaudeSupportSummary {
  if (!installedVersion) return { measured: false, installedVersion: null, unsupported: [] }
  const unsupported = Object.entries(CLAUDE_MODEL_MIN_CLI)
    .filter(([id]) => isModelUnsupportedByCli(id, installedVersion))
    .map(([id, req]) => ({ id, minCli: req.minCli }))
  return { measured: true, installedVersion, unsupported }
}
