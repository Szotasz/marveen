// HOSTMOVE923: install-anchored absolute paths in generated recipes survive a
// host move.
//
// Background (measured 2026-09-23, book -> Mac mini): after the agents/ and
// store/ trees were copied to a machine with a different home, every
// sub-agent's CLAUDE.md curl recipes and PreCompact agent-hook prompt still
// named /Users/<old-user>/klaudia/store/.dashboard-token. `cat` of the missing
// file yields an empty Bearer, every memory save / daily log / inter-agent ping
// 401s, and nothing alerts. The boot-time hook backfill logged "backfilled"
// all day: it only ADDS a missing PreCompact entry, it never re-reads one.
//
// The relative-path alternative is the one measured 401 from agents/<name>/
// (2026-07-25, see `tokenPath` in agent-scaffold.ts), so the fix keeps the
// absolute form and re-anchors it on every boot instead.

import { describe, it, expect } from 'vitest'
import { rewriteForeignProjectRoot, upgradeForeignRootInHookPrompts } from '../web/agent-scaffold.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')
const WEB = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
const AGENT_PROCESS = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

const OLD = '/Users/peterszollos/klaudia'
const NEW = '/Users/pcha0s/klaudia'

describe('rewriteForeignProjectRoot', () => {
  it('re-anchors the dashboard-token path inside a $(cat …) curl recipe', () => {
    const line = `curl -s -H "Authorization: Bearer $(cat ${OLD}/store/.dashboard-token)" http://localhost:3420/api/memories`
    const r = rewriteForeignProjectRoot(line, NEW)
    expect(r.text).toBe(`curl -s -H "Authorization: Bearer $(cat ${NEW}/store/.dashboard-token)" http://localhost:3420/api/memories`)
    expect(r.replaced).toBe(1)
    expect(r.foreignRoots).toEqual([OLD])
  })

  it('re-anchors scripts/hooks/ and scripts/skill-index.sh references too', () => {
    const text = `bash ${OLD}/scripts/skill-index.sh\npython3 ${OLD}/scripts/hooks/staleness-guard.py`
    const r = rewriteForeignProjectRoot(text, NEW)
    expect(r.text).toBe(`bash ${NEW}/scripts/skill-index.sh\npython3 ${NEW}/scripts/hooks/staleness-guard.py`)
    expect(r.replaced).toBe(2)
  })

  it('is a byte-identical no-op when every path is already on the current root', () => {
    const text = `cat ${NEW}/store/.dashboard-token; bash ${NEW}/scripts/skill-index.sh`
    const r = rewriteForeignProjectRoot(text, NEW)
    expect(r.text).toBe(text)
    expect(r.replaced).toBe(0)
    expect(r.foreignRoots).toEqual([])
  })

  it('is idempotent: a second pass over its own output changes nothing', () => {
    const once = rewriteForeignProjectRoot(`$(cat ${OLD}/store/.dashboard-token)`, NEW)
    const twice = rewriteForeignProjectRoot(once.text, NEW)
    expect(twice.replaced).toBe(0)
    expect(twice.text).toBe(once.text)
  })

  it('leaves relative, tilde and template-placeholder forms alone', () => {
    const text = [
      'cat store/.dashboard-token',
      'cat ~/klaudia/store/.dashboard-token',
      'cat {{PROJECT_ROOT}}/store/.dashboard-token',
      '{{PROJECT_ROOT}}/scripts/hooks/provenance-gate.py',
    ].join('\n')
    const r = rewriteForeignProjectRoot(text, NEW)
    expect(r.text).toBe(text)
    expect(r.replaced).toBe(0)
  })

  it('does not touch absolute paths that are not install-anchored', () => {
    const text = `/Users/peterszollos/Documents/report.pdf and /opt/homebrew/bin/node`
    const r = rewriteForeignProjectRoot(text, NEW)
    expect(r.text).toBe(text)
    expect(r.replaced).toBe(0)
  })

  it('handles a worktree root (a sibling install on the same host) as foreign', () => {
    const r = rewriteForeignProjectRoot(`$(cat /Users/pcha0s/claw-test-kigyo/store/.dashboard-token)`, NEW)
    expect(r.text).toBe(`$(cat ${NEW}/store/.dashboard-token)`)
    expect(r.foreignRoots).toEqual(['/Users/pcha0s/claw-test-kigyo'])
  })

  it('tolerates a trailing slash on the current root', () => {
    const r = rewriteForeignProjectRoot(`$(cat ${OLD}/store/.dashboard-token)`, NEW + '/')
    expect(r.text).toBe(`$(cat ${NEW}/store/.dashboard-token)`)
  })

  it('rewrites every occurrence and reports each distinct foreign root once', () => {
    const text = `a $(cat ${OLD}/store/.dashboard-token) b $(cat ${OLD}/store/.dashboard-token) c $(cat /srv/x/store/.dashboard-token)`
    const r = rewriteForeignProjectRoot(text, NEW)
    expect(r.replaced).toBe(3)
    expect(r.foreignRoots).toEqual([OLD, '/srv/x'])
    expect(r.text).not.toContain(OLD)
    expect(r.text).not.toContain('/srv/x')
  })
})

describe('upgradeForeignRootInHookPrompts', () => {
  const stalePrompt = `A token: cat ${OLD}/store/.dashboard-token\n\ncurl -H "Authorization: Bearer $(cat ${OLD}/store/.dashboard-token)"\n\nbash ${OLD}/scripts/skill-index.sh`

  it('rewrites the prompt of an existing PreCompact agent-hook in place', () => {
    const hooks: Record<string, unknown> = {
      PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: stalePrompt, timeout: 300 }] }],
    }
    expect(upgradeForeignRootInHookPrompts(hooks, NEW)).toBe(true)
    const hook = (hooks.PreCompact as Array<{ hooks: Array<{ prompt: string; timeout: number }> }>)[0].hooks[0]
    expect(hook.prompt).not.toContain(OLD)
    expect(hook.prompt).toContain(`cat ${NEW}/store/.dashboard-token`)
    expect(hook.prompt).toContain(`bash ${NEW}/scripts/skill-index.sh`)
    expect(hook.timeout).toBe(300)
  })

  it('returns false and leaves the object untouched when nothing is foreign', () => {
    const fresh = stalePrompt.replaceAll(OLD, NEW)
    const hooks: Record<string, unknown> = {
      PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: fresh }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `python3 ${OLD}/scripts/hooks/x.py` }] }],
    }
    const before = JSON.stringify(hooks)
    expect(upgradeForeignRootInHookPrompts(hooks, NEW)).toBe(false)
    // Commands are owned by upgradeLegacyHookCommands, not by this pass.
    expect(JSON.stringify(hooks)).toBe(before)
  })

  it('skips non-array events and hooks without a prompt without throwing', () => {
    const hooks: Record<string, unknown> = {
      Stop: 'not-an-array',
      PostToolUse: [{ hooks: [{ type: 'command', command: 'echo ok' }] }, { matcher: 'x' }],
    }
    expect(upgradeForeignRootInHookPrompts(hooks, NEW)).toBe(false)
  })
})

describe('HOSTMOVE923 wiring (source-level)', () => {
  it('ensureAgentHooks runs the prompt pass before the exact-match add pass', () => {
    const body = SCAFFOLD.slice(SCAFFOLD.indexOf('export function ensureAgentHooks('))
    const legacy = body.indexOf('upgradeLegacyHookCommands(existingHooks, tplHooks)')
    const prompts = body.indexOf('upgradeForeignRootInHookPrompts(existingHooks, PROJECT_ROOT)')
    const addPass = body.indexOf('for (const [event, handlers] of Object.entries(tplHooks))')
    expect(legacy).toBeGreaterThan(-1)
    expect(prompts).toBeGreaterThan(legacy)
    expect(addPass).toBeGreaterThan(prompts)
  })

  it('web.ts re-anchors CLAUDE.md inside the same guarded loop as the hook writes', () => {
    const loop = WEB.slice(WEB.indexOf('if (!hookDecision.register)'))
    const hooksCall = loop.indexOf('if (ensureAgentHooks(agentName)) patched.push(agentName)')
    const rootCall = loop.indexOf('if (ensureProjectRootInClaudeMd(agentName)) rootPatched.push(agentName)')
    expect(hooksCall).toBeGreaterThan(-1)
    expect(rootCall).toBeGreaterThan(hooksCall)
    expect(WEB).toContain("'CLAUDE.md install-anchored paths re-anchored on the current PROJECT_ROOT (HOSTMOVE923)'")
  })

  it('agent-process.ts re-anchors CLAUDE.md on respawn next to the fleet-roster refresh', () => {
    expect(AGENT_PROCESS).toContain('    ensureFleetRosterSection(name)\n    ensureProjectRootInClaudeMd(name)\n')
  })

  it('keeps the absolute token path (the relative form is the measured 401)', () => {
    expect(SCAFFOLD).toContain("const tokenPath = join(PROJECT_ROOT, 'store', '.dashboard-token')")
    expect(SCAFFOLD).toContain("'/store/.dashboard-token', '/scripts/hooks/', '/scripts/skill-index.sh'")
  })
})
