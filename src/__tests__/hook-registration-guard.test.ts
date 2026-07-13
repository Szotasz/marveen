import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isWorktreeRoot,
  isTemporaryRoot,
  shouldRegisterHooks,
  pruneStaleHookEntries,
  pruneStaleHooksFromSettingsFile,
  KNOWN_HOOK_SCRIPTS,
} from '../web/hook-registration-guard.js'

// 2026-07-11 incident: a WEB_ONLY smoke instance running from a git worktree
// registered UserPromptSubmit/SessionStart hooks into the user-global
// ~/.claude/settings.json with worktree-absolute paths. After the worktree was
// deleted, the hook exited 2 and BLOCKED every prompt (main agent deaf).
// These tests pin the guard (never register from a worktree / staging
// instance) and the self-heal (prune our stale entries, keep foreign ones).

const notAGitFile = () => false

describe('isWorktreeRoot', () => {
  it('detects a .claude/worktrees checkout by path', () => {
    expect(isWorktreeRoot('/home/user/app/.claude/worktrees/agent-abc123', { isGitFile: notAGitFile })).toBe(true)
  })
  it('detects a generic linked worktree via the .git-is-a-file signal', () => {
    expect(isWorktreeRoot('/tmp/some-linked-checkout', { isGitFile: () => true })).toBe(true)
  })
  it('treats a normal checkout (git dir, non-worktree path) as non-worktree', () => {
    expect(isWorktreeRoot('/opt/app', { isGitFile: notAGitFile })).toBe(false)
  })
})

describe('shouldRegisterHooks', () => {
  it('registers for a normal root in normal mode', () => {
    const d = shouldRegisterHooks({ projectRoot: '/opt/app', webOnly: false, isGitFile: notAGitFile })
    expect(d.register).toBe(true)
  })
  it('skips for a worktree root', () => {
    const d = shouldRegisterHooks({
      projectRoot: '/opt/app/.claude/worktrees/agent-xyz',
      webOnly: false,
      isGitFile: notAGitFile,
    })
    expect(d.register).toBe(false)
    expect(d.reason).toMatch(/worktree/)
  })
  it('skips in WEB_ONLY staging mode even from a normal root', () => {
    const d = shouldRegisterHooks({ projectRoot: '/opt/app', webOnly: true, isGitFile: notAGitFile })
    expect(d.register).toBe(false)
    expect(d.reason).toMatch(/WEB_ONLY/)
  })
  // 2026-07-13 canary incident: a plain `git clone` under /private/tmp is NOT a
  // worktree (.git is a dir) and not WEB_ONLY, yet it registered hooks into the
  // user-global settings.json -- the same deaf-agent trap, one class wider.
  it('skips a plain clone under /private/tmp (canary/second-instance)', () => {
    const d = shouldRegisterHooks({
      projectRoot: '/private/tmp/marveen-work',
      webOnly: false,
      isGitFile: notAGitFile,
    })
    expect(d.register).toBe(false)
    expect(d.reason).toMatch(/temp dir/)
  })
  it('skips a clone under /tmp', () => {
    const d = shouldRegisterHooks({ projectRoot: '/tmp/marveen-work', webOnly: false, isGitFile: notAGitFile })
    expect(d.register).toBe(false)
  })
  it('skips a clone under the injected OS tmpDir (e.g. macOS /var/folders/..)', () => {
    const d = shouldRegisterHooks({
      projectRoot: '/var/folders/xy/abc/T/marveen-clone',
      webOnly: false,
      isGitFile: notAGitFile,
      tmpDir: '/var/folders/xy/abc/T',
    })
    expect(d.register).toBe(false)
  })
  it('still registers for a real install path that merely contains "tmp" mid-path', () => {
    const d = shouldRegisterHooks({ projectRoot: '/home/user/mytmpapp', webOnly: false, isGitFile: notAGitFile })
    expect(d.register).toBe(true)
  })
})

describe('isTemporaryRoot', () => {
  it('true for /tmp and /private/tmp prefixes', () => {
    expect(isTemporaryRoot('/tmp/x')).toBe(true)
    expect(isTemporaryRoot('/private/tmp/x')).toBe(true)
    expect(isTemporaryRoot('/var/folders/a/b/T/x')).toBe(true)
  })
  it('false for a normal install root', () => {
    expect(isTemporaryRoot('/Users/marvin/ClaudeClaw')).toBe(false)
    expect(isTemporaryRoot('/opt/app')).toBe(false)
  })
  it('honours an injected OS tmpdir prefix (with or without trailing slash)', () => {
    expect(isTemporaryRoot('/custom/tmp/clone', { tmpDir: '/custom/tmp' })).toBe(true)
    expect(isTemporaryRoot('/custom/tmp/clone', { tmpDir: '/custom/tmp/' })).toBe(true)
  })
  it('does not match a path that merely contains a temp fragment mid-string', () => {
    expect(isTemporaryRoot('/home/tmpish/app')).toBe(false)
  })
})

function settingsFixture(): Record<string, unknown> {
  return {
    enabledPlugins: { 'telegram@claude-plugins-official': true },
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: 'python3 /opt/app/scripts/hooks/staleness-guard.py', timeout: 10 },
            { type: 'command', command: 'python3 /opt/app/.claude/worktrees/agent-dead/scripts/hooks/voice-reply-directive.py', timeout: 60 },
          ],
        },
        { hooks: [{ type: 'command', command: 'python3 /home/user/my-own-hook.py', timeout: 5 }] },
      ],
      SessionStart: [
        {
          matcher: 'compact|resume',
          hooks: [{ type: 'command', command: 'python3 /opt/app/.claude/worktrees/agent-dead/scripts/hooks/taskstate-replay.py', timeout: 15 }],
        },
      ],
      PreCompact: [
        { matcher: 'auto', hooks: [{ type: 'agent', prompt: 'save memories', timeout: 180 }] },
      ],
    },
  }
}

describe('pruneStaleHookEntries', () => {
  const liveFiles = new Set(['/opt/app/scripts/hooks/staleness-guard.py'])
  const fileExists = (p: string) => liveFiles.has(p)

  it('prunes stale worktree entries and keeps valid + foreign entries', () => {
    const settings = settingsFixture()
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists })
    expect(changed).toBe(true)
    expect(removed).toHaveLength(2)
    expect(removed.join(' ')).toContain('voice-reply-directive.py')
    expect(removed.join(' ')).toContain('taskstate-replay.py')

    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command?: string; prompt?: string }> }>>
    // Valid our-entry kept.
    expect(JSON.stringify(hooks.UserPromptSubmit)).toContain('staleness-guard.py')
    // Foreign entry kept even though its file does not exist.
    expect(JSON.stringify(hooks.UserPromptSubmit)).toContain('/home/user/my-own-hook.py')
    // SessionStart group emptied by pruning: the whole event key is dropped.
    expect(hooks.SessionStart).toBeUndefined()
    // Agent-type (non-command) hooks are never touched.
    expect(hooks.PreCompact[0].hooks[0].prompt).toBe('save memories')
  })

  it('prunes a missing-file NON-worktree entry when it matches our script names', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'python3 /old/install/scripts/hooks/voice-reply-directive.py', timeout: 60 }] },
        ],
      },
    }
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: () => false })
    expect(changed).toBe(true)
    expect(removed).toEqual(['python3 /old/install/scripts/hooks/voice-reply-directive.py'])
    expect((settings.hooks as Record<string, unknown>).UserPromptSubmit).toBeUndefined()
  })

  it('keeps our entry when the script file exists', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'python3 /opt/app/scripts/hooks/staleness-guard.py', timeout: 10 }] },
        ],
      },
    }
    const before = JSON.stringify(settings)
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists })
    expect(changed).toBe(false)
    expect(removed).toEqual([])
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('keeps a foreign hook whose file is missing (not ours, not worktree-pathed)', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /somewhere/else/custom-gate.mjs', timeout: 10 }] },
        ],
      },
    }
    const before = JSON.stringify(settings)
    const { changed } = pruneStaleHookEntries(settings, { fileExists: () => false })
    expect(changed).toBe(false)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('prunes an unknown-named script when its path lies inside .claude/worktrees/', () => {
    const settings = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'bash /x/.claude/worktrees/agent-1/scripts/some-future-hook.sh' }] },
        ],
      },
    }
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: () => false })
    expect(changed).toBe(true)
    expect(removed).toHaveLength(1)
  })

  it('is a no-op on settings without a hooks block', () => {
    const settings: Record<string, unknown> = { permissions: { allow: [] } }
    const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: () => false })
    expect(changed).toBe(false)
    expect(removed).toEqual([])
  })

  it('covers the incident hook script names in KNOWN_HOOK_SCRIPTS', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain('voice-reply-directive.py')
    expect(KNOWN_HOOK_SCRIPTS).toContain('taskstate-replay.py')
    expect(KNOWN_HOOK_SCRIPTS).toContain('staleness-guard.py')
  })
})

describe('pruneStaleHooksFromSettingsFile', () => {
  it('rewrites the file without stale entries and preserves the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-guard-test-'))
    try {
      // A real script file that must survive pruning.
      const liveScript = join(dir, 'staleness-guard.py')
      writeFileSync(liveScript, '# live')
      const settingsPath = join(dir, 'settings.json')
      writeFileSync(settingsPath, JSON.stringify({
        enabledPlugins: { x: true },
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: 'command', command: `python3 ${liveScript}`, timeout: 10 },
                { type: 'command', command: `python3 ${join(dir, '.claude', 'worktrees', 'agent-gone', 'voice-reply-directive.py')}`, timeout: 60 },
              ],
            },
          ],
        },
      }, null, 2))

      const removed = pruneStaleHooksFromSettingsFile(settingsPath)
      expect(removed).toHaveLength(1)
      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(JSON.stringify(after.hooks)).toContain(liveScript)
      expect(JSON.stringify(after.hooks)).not.toContain('agent-gone')
      expect(after.enabledPlugins).toEqual({ x: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a missing or unparseable file untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-guard-test-'))
    try {
      expect(pruneStaleHooksFromSettingsFile(join(dir, 'nope.json'))).toEqual([])
      const badPath = join(dir, 'settings.json')
      writeFileSync(badPath, '{ not json')
      expect(pruneStaleHooksFromSettingsFile(badPath)).toEqual([])
      expect(readFileSync(badPath, 'utf-8')).toBe('{ not json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
