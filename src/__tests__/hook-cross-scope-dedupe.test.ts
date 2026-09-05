// A hook present in BOTH settings scopes a session loads runs TWICE.
//
// Claude Code merges ~/.claude/settings.json with <cwd>/.claude/settings.json
// and does not dedupe. Measured 2026-09-04 on the main agent: one prompt
// produced two identical PROVENANCE-KAPU blocks -- a doubled process spawn and
// a doubled ~1.4KB context injection on every flagged prompt.
//
// The 2026-09-04 night fix guarded ensureAgentProvenanceHook, and did NOT hold:
// measured 07:50, removing the entry by hand gave 0, and one dashboard restart
// put it back at 1. The entry is re-added by ensureAgentHooks, which merges
// templates/settings.json.template into every agent's settings on every boot,
// and the main agent's settings path IS the shared user-scope file. These tests
// cover that second path.
//
// The two scopes spell the same gate differently (fail-open wrapper with an
// absolute path vs `python3 "$CLAUDE_PROJECT_DIR/..."`), so the guard matches on
// SCRIPT BASENAME. An exact-string check would never match and the duplicate
// would survive -- the assertion below uses the two real spellings.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hookScriptAlreadyEffectiveInOtherScope,
  ensureAgentHooks,
  agentSettingsPath,
} from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

const WRAPPED = "bash -c '[ -f /abs/scripts/hooks/provenance-gate.py ] && exec python3 /abs/scripts/hooks/provenance-gate.py; exit 0'"
const PROJECT_SPELLING = 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/provenance-gate.py"'

let root: string
let userScope: string
let projectScope: string

function writeScope(path: string, hooks: Record<string, unknown>): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ hooks }, null, 2))
}

describe('hookScriptAlreadyEffectiveInOtherScope', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xscope-'))
    userScope = join(root, 'home', '.claude', 'settings.json')
    projectScope = join(root, 'repo', '.claude', 'settings.json')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const scopes = () => ({ user: userScope, project: projectScope })

  it('matches the same script across the two different command spellings', () => {
    writeScope(projectScope, { UserPromptSubmit: [{ hooks: [{ command: PROJECT_SPELLING }] }] })
    expect(hookScriptAlreadyEffectiveInOtherScope(userScope, 'UserPromptSubmit', WRAPPED, scopes())).toBe(true)
  })

  it('does not match a different script', () => {
    writeScope(projectScope, { UserPromptSubmit: [{ hooks: [{ command: 'python3 /a/staleness-guard.py' }] }] })
    expect(hookScriptAlreadyEffectiveInOtherScope(userScope, 'UserPromptSubmit', WRAPPED, scopes())).toBe(false)
  })

  it('does not match the same script registered under a DIFFERENT event', () => {
    writeScope(projectScope, { PreToolUse: [{ hooks: [{ command: PROJECT_SPELLING }] }] })
    expect(hookScriptAlreadyEffectiveInOtherScope(userScope, 'UserPromptSubmit', WRAPPED, scopes())).toBe(false)
  })

  // One-way on purpose: an agent's project settings are authoritative, while the
  // user scope it reads may be a per-spawn COPY of ~/.claude/settings.json
  // (agent-process.ts clones it into each agent's isolated .claude-config).
  // Letting the derived file suppress the authoritative one would drop the hook
  // on the next re-provision.
  it('never suppresses a write into the PROJECT scope', () => {
    writeScope(userScope, { UserPromptSubmit: [{ hooks: [{ command: PROJECT_SPELLING }] }] })
    writeScope(projectScope, { UserPromptSubmit: [{ hooks: [{ command: PROJECT_SPELLING }] }] })
    expect(hookScriptAlreadyEffectiveInOtherScope(projectScope, 'UserPromptSubmit', WRAPPED, scopes())).toBe(false)
  })

  it('treats a missing other-scope file as not carrying it', () => {
    expect(hookScriptAlreadyEffectiveInOtherScope(userScope, 'UserPromptSubmit', WRAPPED, scopes())).toBe(false)
  })

  it('treats an unreadable other-scope file as not carrying it, rather than throwing', () => {
    mkdirSync(join(root, 'repo', '.claude'), { recursive: true })
    writeFileSync(projectScope, '{ not json')
    expect(hookScriptAlreadyEffectiveInOtherScope(userScope, 'UserPromptSubmit', WRAPPED, scopes())).toBe(false)
  })

  it('is inert when both scopes resolve to the same file', () => {
    writeScope(userScope, { UserPromptSubmit: [{ hooks: [{ command: PROJECT_SPELLING }] }] })
    expect(hookScriptAlreadyEffectiveInOtherScope(userScope, 'UserPromptSubmit', WRAPPED,
      { user: userScope, project: userScope })).toBe(false)
  })
})

// The wiring test: the guard has to be consulted by the code that ACTUALLY
// re-added the duplicate every boot. Night's fix was correct in isolation and
// still failed in production because it sat on the other function.
describe('ensureAgentHooks respects the cross-scope guard', () => {
  const NAME = 'xscope-probe'
  const dir = join(PROJECT_ROOT, 'agents', NAME)
  const settings = agentSettingsPath(NAME)

  beforeEach(() => {
    if (existsSync(join(dir, 'HANDOFF.md'))) {
      throw new Error(`refusing: agents/${NAME} looks like a live agent`)
    }
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, '.claude'), { recursive: true })
    root = mkdtempSync(join(tmpdir(), 'xscope-int-'))
    projectScope = join(root, 'repo', '.claude', 'settings.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  function upsScripts(): string[] {
    const parsed = JSON.parse(readFileSync(settings, 'utf-8')) as
      { hooks?: { UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }> } }
    return (parsed.hooks?.UserPromptSubmit ?? [])
      .flatMap((e) => e.hooks ?? [])
      .map((h) => h.command ?? '')
      .map((c) => c.match(/\/([^/\s'"]+\.py)\b/)?.[1] ?? '')
      .filter(Boolean)
  }

  it('skips a template hook whose script the other scope already runs', () => {
    // Treat the probe agent's own settings file as the "user" scope, so the
    // guard engages without touching the operator's real ~/.claude.
    writeScope(projectScope, { UserPromptSubmit: [{ hooks: [{ command: PROJECT_SPELLING }] }] })
    expect(ensureAgentHooks(NAME, { user: settings, project: projectScope })).toBe(true)
    const scripts = upsScripts()
    expect(scripts).not.toContain('provenance-gate.py')
    // The rest of the template still lands: the guard is surgical, not a veto.
    expect(scripts).toContain('staleness-guard.py')
  })

  it('adds the hook exactly once when the other scope does NOT have it', () => {
    writeScope(projectScope, { UserPromptSubmit: [] })
    ensureAgentHooks(NAME, { user: settings, project: projectScope })
    expect(upsScripts().filter((s) => s === 'provenance-gate.py')).toHaveLength(1)
  })

  it('does not re-add it on a second run (idempotent)', () => {
    writeScope(projectScope, { UserPromptSubmit: [{ hooks: [{ command: PROJECT_SPELLING }] }] })
    ensureAgentHooks(NAME, { user: settings, project: projectScope })
    ensureAgentHooks(NAME, { user: settings, project: projectScope })
    expect(upsScripts()).not.toContain('provenance-gate.py')
  })
})
