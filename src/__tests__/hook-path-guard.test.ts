// Fleet-freeze prevention tests (2026-07-14 incident):
// A second marveen checkout in /tmp wrote hook paths into the shared
// ~/.claude/settings.json. On reboot /tmp was cleared, the scripts
// disappeared, python3 exited non-zero, and Claude Code blocked every
// UserPromptSubmit -- silently freezing the entire fleet for hours.
//
// These four tests lock the three mitigations:
//   (a) registration guard rejects /tmp and non-existent paths
//   (b) ensureAgentHooks / scaffold never emits /tmp-rooted commands
//   (c) boot-time prune detects and removes a planted /tmp hook
//   (d) fail-open wrapper: a missing hook script exits 0, not non-zero
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const PRUNE_SCRIPT = join(ROOT, 'scripts', 'boot-hook-prune.py')
const STALENESS_HOOK = join(ROOT, 'scripts', 'hooks', 'staleness-guard.py')

import { isUnsafeHookCommand, upgradeLegacyHookCommands } from '../web/agent-scaffold.js'

// ---------------------------------------------------------------------------
// (a) Registration guard rejects /tmp and non-existent paths
// ---------------------------------------------------------------------------
describe('isUnsafeHookCommand (registration guard)', () => {
  it('rejects a bare command with a /tmp path', () => {
    expect(isUnsafeHookCommand('python3 /tmp/scratchpad/mp-test/scripts/hooks/staleness-guard.py')).toBe(true)
  })

  it('rejects a fail-open wrapper whose script is under /tmp', () => {
    const cmd = "bash -c '[ -f /tmp/foo/staleness-guard.py ] && exec python3 /tmp/foo/staleness-guard.py; exit 0'"
    expect(isUnsafeHookCommand(cmd)).toBe(true)
  })

  it('rejects a non-existent script path', () => {
    expect(isUnsafeHookCommand('python3 /nonexistent/path/hook.py')).toBe(true)
  })

  it('accepts a valid existing script', () => {
    expect(existsSync(STALENESS_HOOK)).toBe(true)
    expect(isUnsafeHookCommand(`python3 ${STALENESS_HOOK}`)).toBe(false)
  })

  it('accepts the fail-open wrapper form pointing to an existing script', () => {
    const cmd = `bash -c '[ -f ${STALENESS_HOOK} ] && exec python3 ${STALENESS_HOOK}; exit 0'`
    expect(isUnsafeHookCommand(cmd)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (b) scaffold never emits /tmp-rooted commands
// ---------------------------------------------------------------------------
describe('scaffold never emits /tmp hook paths', () => {
  it('recognises /tmp-rooted staleness-hook commands as unsafe (guard catches them)', () => {
    const tmpCmd = 'python3 /tmp/claude-test/scratchpad/mp-test/scripts/hooks/staleness-guard.py'
    expect(isUnsafeHookCommand(tmpCmd)).toBe(true)
  })

  it('UserPromptSubmit commands in the template use fail-open wrappers', () => {
    const tpl = readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8')
    const resolved = JSON.parse(tpl.replace(/\{\{PROJECT_ROOT\}\}/g, '/stable/install'))
    const ups = resolved.hooks?.UserPromptSubmit ?? []
    const commands: string[] = ups.flatMap(
      (e: { hooks?: Array<{ command?: string }> }) =>
        (e.hooks ?? []).map((h) => h.command ?? '').filter(Boolean),
    )
    expect(commands.length).toBeGreaterThan(0)
    for (const cmd of commands) {
      // All UserPromptSubmit hooks must use the fail-open bash wrapper
      expect(cmd).toMatch(/^bash -c '/)
      expect(cmd).toContain('exit 0')
    }
  })
})

// ---------------------------------------------------------------------------
// (c) boot-time prune: detects and removes a planted /tmp hook
// ---------------------------------------------------------------------------
describe('boot-hook-prune.py', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'boot-prune-test-'))
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('prunes a /tmp-rooted command hook from settings.json', () => {
    const settingsDir = join(tmpHome, '.claude')
    mkdirSync(settingsDir, { recursive: true })
    const settingsPath = join(settingsDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          hooks: [
            { type: 'command', command: 'python3 /tmp/scratchpad/staleness-guard.py', timeout: 10 },
            { type: 'command', command: `python3 ${STALENESS_HOOK}`, timeout: 10 },
          ],
        }],
      },
    }, null, 2))

    execFileSync('python3', [PRUNE_SCRIPT], {
      env: { ...process.env, HOME: tmpHome, INSTALL_DIR: ROOT },
    })

    const result = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const hooks = result.hooks?.UserPromptSubmit?.[0]?.hooks ?? []
    const commands = hooks.map((h: { command?: string }) => h.command ?? '')
    // /tmp path pruned
    expect(commands.some((c: string) => c.includes('/tmp/'))).toBe(false)
    // valid existing hook kept
    expect(commands.some((c: string) => c.includes('staleness-guard.py'))).toBe(true)
    // backup created
    expect(existsSync(settingsPath + '.bak')).toBe(true)
  })

  it('prunes a hook whose script no longer exists on disk', () => {
    const settingsDir = join(tmpHome, '.claude')
    mkdirSync(settingsDir, { recursive: true })
    const settingsPath = join(settingsDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          hooks: [
            { type: 'command', command: 'python3 /opt/removed-checkout/scripts/hooks/staleness-guard.py', timeout: 10 },
          ],
        }],
      },
    }, null, 2))

    execFileSync('python3', [PRUNE_SCRIPT], {
      env: { ...process.env, HOME: tmpHome, INSTALL_DIR: ROOT },
    })

    const result = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const hooks = result.hooks?.UserPromptSubmit?.[0]?.hooks ?? []
    expect(hooks).toHaveLength(0)
  })

  it('leaves a settings file with no stale hooks untouched (no .bak)', () => {
    const settingsDir = join(tmpHome, '.claude')
    mkdirSync(settingsDir, { recursive: true })
    const settingsPath = join(settingsDir, 'settings.json')
    const original = JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          hooks: [{ type: 'command', command: `python3 ${STALENESS_HOOK}`, timeout: 10 }],
        }],
      },
    }, null, 2)
    writeFileSync(settingsPath, original)

    execFileSync('python3', [PRUNE_SCRIPT], {
      env: { ...process.env, HOME: tmpHome, INSTALL_DIR: ROOT },
    })

    expect(readFileSync(settingsPath, 'utf-8')).toBe(original)
    expect(existsSync(settingsPath + '.bak')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (d) fail-open: missing hook script exits 0, not non-zero
// ---------------------------------------------------------------------------
describe('fail-open wrapper (UserPromptSubmit)', () => {
  it('exits 0 when the target script is missing', () => {
    const missingPath = '/nonexistent/path/hook.py'
    const result = spawnSync('bash', [
      '-c',
      `[ -f ${missingPath} ] && exec python3 ${missingPath}; exit 0`,
    ])
    expect(result.status).toBe(0)
  })

  it('propagates non-zero exit when the script exists and intentionally blocks', () => {
    // Write a tiny python script that explicitly exits 2 (simulates a policy block)
    const tmp = mkdtempSync(join(tmpdir(), 'fail-open-test-'))
    try {
      const script = join(tmp, 'policy-block.py')
      writeFileSync(script, 'import sys; sys.exit(2)\n')
      const result = spawnSync('bash', [
        '-c',
        `[ -f ${script} ] && exec python3 ${script}; exit 0`,
      ])
      expect(result.status).toBe(2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('bare python3 on a missing file exits non-zero (proves the wrapper is necessary)', () => {
    const result = spawnSync('python3', ['/nonexistent/path/hook.py'])
    expect(result.status).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (e) upgradeLegacyHookCommands: automatic in-place migration
// ---------------------------------------------------------------------------
describe('upgradeLegacyHookCommands (automatic migration)', () => {
  const SCRIPT_DIR = join(ROOT, 'scripts', 'hooks')
  const VOICE_HOOK = join(SCRIPT_DIR, 'voice-reply-directive.py')
  const WRAPPER_STALENESS = `bash -c '[ -f ${STALENESS_HOOK} ] && exec python3 ${STALENESS_HOOK}; exit 0'`
  const WRAPPER_VOICE = `bash -c '[ -f ${VOICE_HOOK} ] && exec python3 ${VOICE_HOOK}; exit 0'`
  const OLD_STALENESS = `python3 ${STALENESS_HOOK}`
  const OLD_VOICE = `python3 ${VOICE_HOOK}`

  const makeTplHooks = () => ({
    UserPromptSubmit: [{
      hooks: [
        { type: 'command', command: WRAPPER_STALENESS, timeout: 10 },
        { type: 'command', command: WRAPPER_VOICE, timeout: 60 },
      ],
    }],
  })

  // (a) bare staleness command is replaced by wrapper, no duplicate entry
  it('replaces bare staleness-guard command with fail-open wrapper (no duplicate)', () => {
    const existingHooks: Record<string, unknown> = {
      UserPromptSubmit: [{
        hooks: [{ type: 'command', command: OLD_STALENESS, timeout: 10 }],
      }],
    }
    const changed = upgradeLegacyHookCommands(existingHooks, makeTplHooks())
    expect(changed).toBe(true)
    const cmds = (existingHooks.UserPromptSubmit as { hooks: { command: string }[] }[])
      .flatMap((e) => e.hooks.map((h) => h.command))
    expect(cmds).toContain(WRAPPER_STALENESS)
    expect(cmds).not.toContain(OLD_STALENESS)
    expect(cmds.filter((c) => c.includes('staleness-guard'))).toHaveLength(1)
  })

  // (b) idempotent: second run on already-upgraded settings returns false (no write)
  it('is idempotent: second run on already-wrapper settings returns false', () => {
    const existingHooks: Record<string, unknown> = {
      UserPromptSubmit: [{
        hooks: [
          { type: 'command', command: WRAPPER_STALENESS, timeout: 10 },
          { type: 'command', command: WRAPPER_VOICE, timeout: 60 },
        ],
      }],
    }
    const changed = upgradeLegacyHookCommands(existingHooks, makeTplHooks())
    expect(changed).toBe(false)
    const cmds = (existingHooks.UserPromptSubmit as { hooks: { command: string }[] }[])
      .flatMap((e) => e.hooks.map((h) => h.command))
    expect(cmds).toContain(WRAPPER_STALENESS)
    expect(cmds).toContain(WRAPPER_VOICE)
  })

  // (c) voice-reply-directive.py is also upgraded
  it('replaces bare voice-reply-directive command with fail-open wrapper', () => {
    const existingHooks: Record<string, unknown> = {
      UserPromptSubmit: [{
        hooks: [
          { type: 'command', command: OLD_STALENESS, timeout: 10 },
          { type: 'command', command: OLD_VOICE, timeout: 60 },
        ],
      }],
    }
    const changed = upgradeLegacyHookCommands(existingHooks, makeTplHooks())
    expect(changed).toBe(true)
    const cmds = (existingHooks.UserPromptSubmit as { hooks: { command: string }[] }[])
      .flatMap((e) => e.hooks.map((h) => h.command))
    expect(cmds).not.toContain(OLD_STALENESS)
    expect(cmds).not.toContain(OLD_VOICE)
    expect(cmds).toContain(WRAPPER_STALENESS)
    expect(cmds).toContain(WRAPPER_VOICE)
    expect(cmds.filter((c) => c.includes('staleness-guard'))).toHaveLength(1)
    expect(cmds.filter((c) => c.includes('voice-reply-directive'))).toHaveLength(1)
  })

  // (d) a settings with already-wrapper form is left untouched
  it('leaves a settings that already has the wrapper form unchanged', () => {
    const existingHooks: Record<string, unknown> = {
      UserPromptSubmit: [{
        hooks: [{ type: 'command', command: WRAPPER_STALENESS, timeout: 10 }],
      }],
    }
    const before = JSON.stringify(existingHooks)
    const changed = upgradeLegacyHookCommands(existingHooks, makeTplHooks())
    expect(changed).toBe(false)
    expect(JSON.stringify(existingHooks)).toBe(before)
  })

  // (e) unrelated hooks are preserved; timeout is updated alongside the command
  it('preserves unrelated hooks and updates timeout on upgrade', () => {
    const existingHooks: Record<string, unknown> = {
      UserPromptSubmit: [{
        hooks: [
          { type: 'command', command: OLD_STALENESS, timeout: 5 },
          { type: 'command', command: 'python3 /stable/custom-hook.py', timeout: 30 },
        ],
      }],
    }
    upgradeLegacyHookCommands(existingHooks, makeTplHooks())
    const hooks = (existingHooks.UserPromptSubmit as { hooks: { command: string; timeout: number }[] }[])[0].hooks
    // staleness upgraded
    expect(hooks.find((h) => h.command === WRAPPER_STALENESS)?.timeout).toBe(10)
    // custom hook untouched
    expect(hooks.find((h) => h.command === 'python3 /stable/custom-hook.py')?.timeout).toBe(30)
    // old bare gone
    expect(hooks.some((h) => h.command === OLD_STALENESS)).toBe(false)
  })
})
