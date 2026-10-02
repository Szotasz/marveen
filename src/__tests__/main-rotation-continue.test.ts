// 8c338dc4: the continue variant of the main agent's plan rotation -- the pure decision
// (can --continue find the same conversation after the switch?) and the restart runner
// (resume first, fresh as the fallback), both without tmux or a real config dir.
import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'
import { mainRotationContinueVerdict, runMainContinueRestart } from '../web/main-rotation-continue.js'

const ROOT = '/srv/marveen'
const SHARED = '/srv/marveen/.channels-config'
const transcriptsIn = (dir: string) => join(dir, 'projects', encodeClaudeProjectDir(ROOT))

function verdict(over: Partial<Parameters<typeof mainRotationContinueVerdict>[0]> = {}, present: string[] = [transcriptsIn(SHARED)]) {
  return mainRotationContinueVerdict({
    explicitDir: null,
    activeRotatedDir: null,
    targetConfigDir: null,
    sharedDir: SHARED,
    projectRoot: ROOT,
    exists: (p) => present.includes(p),
    ...over,
  })
}

describe('mainRotationContinueVerdict', () => {
  it('token plan to token plan: the shared dir stays, its transcripts are there -> ok', () => {
    expect(verdict()).toEqual({ ok: true })
  })

  it('no prior conversation in the dir -> no-prior-session (claude --continue would exit at once)', () => {
    expect(verdict({}, [])).toEqual({ ok: false, reason: 'no-prior-session' })
  })

  it('the transcript dir is the encoded PROJECT dir, not the project path itself', () => {
    expect(verdict({}, [join(SHARED, 'projects', ROOT)])).toEqual({ ok: false, reason: 'no-prior-session' })
  })

  it('to a plan with its own configDir -> config-dir-changes (that dir has other transcripts)', () => {
    expect(verdict({ targetConfigDir: '/opt/claude-team' })).toEqual({ ok: false, reason: 'config-dir-changes' })
  })

  it('from a plan with its own configDir to a token plan -> config-dir-changes', () => {
    expect(verdict({ activeRotatedDir: '/opt/claude-pro' })).toEqual({ ok: false, reason: 'config-dir-changes' })
  })

  it('between two plans on the same configDir: the transcripts of THAT dir are checked', () => {
    expect(verdict({ activeRotatedDir: '/opt/claude-pro', targetConfigDir: '/opt/claude-pro/' }, [transcriptsIn('/opt/claude-pro')]))
      .toEqual({ ok: true })
    expect(verdict({ activeRotatedDir: '/opt/claude-pro', targetConfigDir: '/opt/claude-pro' }))
      .toEqual({ ok: false, reason: 'no-prior-session' })
  })

  it('an explicit MAIN_AGENT_CONFIG_DIR wins before and after: the dir cannot change, its transcripts count', () => {
    expect(verdict({ explicitDir: '/opt/explicit', targetConfigDir: '/opt/claude-team' }, [transcriptsIn('/opt/explicit')]))
      .toEqual({ ok: true })
  })
})

describe('runMainContinueRestart', () => {
  function steps(resumeOk: boolean, freshResult: { ok: boolean; error?: string } = { ok: true }) {
    const order: string[] = []
    const s = {
      stampConsent: vi.fn(() => { order.push('stamp') }),
      resume: vi.fn(async () => { order.push('resume'); return resumeOk }),
      fresh: vi.fn(() => { order.push('fresh'); return freshResult }),
      warn: vi.fn((_m: string) => {}),
    }
    return { s, order }
  }

  it('resume succeeds: the consent stamp first, then the --continue resume; no fresh restart', async () => {
    const { s, order } = steps(true)
    expect(await runMainContinueRestart(s)).toEqual({ ok: true, mode: 'continue' })
    expect(order).toEqual(['stamp', 'resume'])
    expect(s.fresh).not.toHaveBeenCalled()
    expect(s.warn).not.toHaveBeenCalled()
  })

  it('resume fails: the fresh restart is the fallback, and the result says so', async () => {
    const { s, order } = steps(false)
    expect(await runMainContinueRestart(s)).toEqual({ ok: true, mode: 'fresh-fallback' })
    expect(order).toEqual(['stamp', 'resume', 'fresh'])
    expect(s.warn).toHaveBeenCalledTimes(1)
  })

  it('both fail: not ok, with the fresh restart error', async () => {
    const { s } = steps(false, { ok: false, error: 'respawn-pane boom' })
    expect(await runMainContinueRestart(s)).toEqual({ ok: false, mode: 'fresh-fallback', error: 'respawn-pane boom' })
  })

  it('both fail without an error text: a generic one, never an empty error', async () => {
    const { s } = steps(false, { ok: false })
    const r = await runMainContinueRestart(s)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toBe('Main agent restart failed')
  })

  it('a throwing consent stamp does not stop the restart', async () => {
    const { s, order } = steps(true)
    s.stampConsent.mockImplementation(() => { order.push('stamp'); throw new Error('stamp boom') })
    expect(await runMainContinueRestart(s)).toEqual({ ok: true, mode: 'continue' })
    expect(order).toEqual(['stamp', 'resume'])
  })
})
