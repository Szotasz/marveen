import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWorkerPrompt, decidePoll, configDirKeychainService, workerHomeFor, workerStartAllowed } from '../web/agent-worker.js'

// Pure-logic tests for the interactive-tmux worker that backs runAgent on the
// subscription (jun.15 migration). The live-session orchestration is exercised
// by the heartbeat-path integration check; these cover the decision core.

describe('buildWorkerPrompt', () => {
  const out = '/w/scratch/abc.out'
  const done = '/w/scratch/abc.done'

  it('keeps the caller prompt verbatim and first (only content instruction)', () => {
    const caller = 'Summarize today in 5 sentences. Magyarul.'
    const p = buildWorkerPrompt(caller, out, done)
    expect(p.startsWith(caller)).toBe(true)
  })

  it('directs the answer to the .out file and a done marker to the .done file', () => {
    const p = buildWorkerPrompt('x', out, done)
    expect(p).toContain(out)
    expect(p).toContain(done)
    expect(p).toMatch(/Write tool/)
    expect(p).toMatch(/do not print the response|Do not print the response/i)
  })

  it('does not inject any persona / project voice', () => {
    const p = buildWorkerPrompt('TASK', out, done)
    expect(p).not.toMatch(/Marveen|Szabolcs|asszisztens/i)
  })
})

describe('decidePoll', () => {
  const base = { doneExists: false, sessionAlive: true, elapsedMs: 0, timeoutMs: 1000 }

  it('returns ready as soon as the done sentinel exists', () => {
    expect(decidePoll({ ...base, doneExists: true })).toBe('ready')
  })

  it('done takes priority even if the deadline passed and the session died', () => {
    // A request that completed in the same tick the session died must still
    // return its result, not be reported dead/timeout.
    expect(decidePoll({ doneExists: true, sessionAlive: false, elapsedMs: 9999, timeoutMs: 1000 })).toBe('ready')
  })

  it('times out once past the deadline (no done yet)', () => {
    expect(decidePoll({ ...base, elapsedMs: 1000 })).toBe('timeout')
    expect(decidePoll({ ...base, elapsedMs: 1500 })).toBe('timeout')
  })

  it('fails fast (dead) when the session vanishes mid-run, before the deadline', () => {
    expect(decidePoll({ ...base, sessionAlive: false, elapsedMs: 10 })).toBe('dead')
  })

  it('keeps waiting while alive, before the deadline, with no done yet', () => {
    expect(decidePoll({ ...base, elapsedMs: 500 })).toBe('wait')
  })
})

describe('configDirKeychainService', () => {
  // Locked vector: macOS Claude Code reads the OAuth token from a Keychain
  // service named "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>"
  // and it SHADOWS <CONFIG_DIR>/.credentials.json. The worker auth-recovery
  // deletes this exact entry so the freshly-seeded file becomes authoritative.
  // Verified live 2026-06-10 against the marveen-worker config dir.
  it('derives the sha256[0:8] service suffix (verified live vector)', () => {
    expect(configDirKeychainService('/Users/marvin/.marveen-worker/.claude-config'))
      .toBe('Claude Code-credentials-1d2e1367')
  })

  it('is path-specific: a different config dir hashes to a different service', () => {
    const a = configDirKeychainService('/Users/marvin/.marveen-worker/.claude-config')
    const b = configDirKeychainService('/tmp/some-other-config')
    expect(a).not.toBe(b)
    expect(b.startsWith('Claude Code-credentials-')).toBe(true)
  })
})

describe('workerHomeFor (WORKERHOME1: worker home derives from MAIN_AGENT_ID)', () => {
  it('default install keeps the historical paths -- zero migration, unchanged Keychain hash', () => {
    expect(workerHomeFor('marveen', 'slow').endsWith('/.marveen-worker')).toBe(true)
    expect(workerHomeFor('marveen', 'fast').endsWith('/.marveen-worker-fast')).toBe(true)
  })

  it('a non-default id derives its own isolated dirs (sandbox/renamed install)', () => {
    expect(workerHomeFor('jarvis', 'slow').endsWith('/.jarvis-worker')).toBe(true)
    expect(workerHomeFor('jarvis', 'fast').endsWith('/.jarvis-worker-fast')).toBe(true)
  })

  it('never collides with the default install dir for a different id', () => {
    expect(workerHomeFor('jarvis', 'slow')).not.toBe(workerHomeFor('marveen', 'slow'))
    expect(workerHomeFor('jarvis', 'fast')).not.toBe(workerHomeFor('marveen', 'fast'))
  })

  it('slow and fast variants of the same id never share a home', () => {
    expect(workerHomeFor('marveen', 'slow')).not.toBe(workerHomeFor('marveen', 'fast'))
  })
})

describe('workerStartAllowed (WORKERHOME1: WEB_ONLY must suppress every worker start)', () => {
  it('blocks in WEB_ONLY staging', () => {
    expect(workerStartAllowed({ WEB_ONLY: 'true' })).toBe(false)
  })

  it('allows on a normal install (unset or explicit false)', () => {
    expect(workerStartAllowed({})).toBe(true)
    expect(workerStartAllowed({ WEB_ONLY: 'false' })).toBe(true)
    expect(workerStartAllowed({ WEB_ONLY: '' })).toBe(true)
  })

  // String-contract wiring guard (house idiom: the pure predicate alone cannot
  // prove the choke points consult it). Every function that creates, kills or
  // configures a live worker session must check the gate: the lazy-start path
  // (startWorkerSessionFor covers ensureWorkerCwd + tmux new-session), the
  // readiness poll (ensureWorkerReady would otherwise spin 90s then page the
  // LIVE channel via alertWorkerStuck from a staging instance) and the restart
  // path (kill-session against a live worker). This is exactly how the
  // 2026-07-28 sandbox boot wrote into the live worker config dir.
  it('the three session-lifecycle choke points are wired to the gate', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(__dirname, '../web/agent-worker.ts'), 'utf-8')
    const gated = (fnName: string) => {
      const start = src.indexOf(`function ${fnName}(`)
      expect(start, `${fnName} not found`).toBeGreaterThan(-1)
      const body = src.slice(start, start + 700)
      return body.includes('workerStartAllowed()')
    }
    expect(gated('startWorkerSessionFor')).toBe(true)
    expect(gated('ensureWorkerReady')).toBe(true)
    expect(gated('restartWorkerSession')).toBe(true)
  })

  // The worker launch line must invoke claude by RESOLVED path, never by bare
  // name: `bash -lc` login shells on stock Debian/Ubuntu roots lack
  // ~/.local/bin (the native installer target), which killed the worker within
  // seconds of every boot on such installs (vps47 cold-start probe, WORKERHOME1).
  it('the tmux launch line resolves the claude binary instead of relying on login-shell PATH', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(__dirname, '../web/agent-worker.ts'), 'utf-8')
    expect(src).toContain("tryResolveFromPath('claude')")
    expect(src).not.toMatch(/`claude --dangerously-skip-permissions/)
  })
})
