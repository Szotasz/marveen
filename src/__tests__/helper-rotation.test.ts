// Rotation decision without an Opus turn (src/web/helper/rotation.ts): the
// dashboard carries out the rotate-check stdout contract the heartbeat prompt
// (buildRotationHeartbeatPrompt) used to hand to an LLM turn, in the same order.
import { describe, it, expect, vi } from 'vitest'
import { parseRotateCheckOutput, runRotationDecision, type RotationDeps } from '../web/helper/rotation.js'

const ROTATE = 'ROTATE agent=marveen target=plan-b targetLabel=Plan B (Team) currentLabel=Plan A currentPct=93 resetsInMin=140 trigger=5h sevenDayPct=40 sevenDayResetsInMin=3000'

function mk(stdout: string, over: Partial<RotationDeps> = {}) {
  const calls: string[] = []
  const deps: RotationDeps = {
    runCheck: async () => ({ ok: true, stdout, detail: 'exit 0' }),
    notifyOwner: vi.fn(async (t: string) => { calls.push(`notify:${t}`); return { sent: true } }),
    postRotate: vi.fn(async (id: string) => { calls.push(`post:${id}`); return { status: 200, body: { ok: true } } }),
    fallback: 'opus',
    fallbackRun: vi.fn(async () => { calls.push('fallback') }),
    ...over,
  }
  return { deps, calls }
}

describe('parseRotateCheckOutput', () => {
  it('parses labels with spaces and ignores diagnostics and unknown lines', () => {
    const lines = parseRotateCheckOutput(`claude-plan-rotate-check: probe skipped\n${ROTATE}\nrm -rf /\n`)
    expect(lines).toHaveLength(1)
    expect(lines[0].fields).toMatchObject({ target: 'plan-b', targetLabel: 'Plan B (Team)', currentLabel: 'Plan A', currentPct: '93', trigger: '5h' })
  })
})

describe('runRotationDecision', () => {
  it('empty output: quiet, nothing sent, nothing posted, no fallback turn', async () => {
    const { deps, calls } = mk('')
    expect(await runRotationDecision(deps)).toEqual({ kind: 'quiet' })
    expect(calls).toEqual([])
  })

  it('ROTATE: owner first, THEN the rotate call (the restart would cut the note off)', async () => {
    const { deps, calls } = mk(ROTATE + '\n')
    const r = await runRotationDecision(deps)
    expect(r).toMatchObject({ kind: 'acted', lines: ['ROTATE'], rotateStatus: 200 })
    expect(calls.map((c) => c.split(':')[0])).toEqual(['notify', 'post'])
    expect(calls[1]).toBe('post:plan-b')
    expect(calls[0]).toMatch(/Plan A \(93%, heti 40%, 5h, reset 140 perc múlva\) helyett Plan B \(Team\)/)
  })

  it('a refused rotate is relayed verbatim and not retried', async () => {
    const { deps, calls } = mk(ROTATE, { postRotate: vi.fn(async () => ({ status: 409, body: { error: 'Rotation is disabled' } })) })
    await runRotationDecision(deps)
    expect(deps.postRotate).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c.startsWith('notify')).pop()).toMatch(/HTTP 409.*Rotation is disabled/)
  })

  it('two ROTATE lines restart the main agent only once', async () => {
    const { deps } = mk(`${ROTATE}\n${ROTATE}`)
    await runRotationDecision(deps)
    expect(deps.postRotate).toHaveBeenCalledTimes(1)
  })

  it('NO_ALTERNATIVE: owner note, no rotate call', async () => {
    const { deps } = mk('NO_ALTERNATIVE agent=marveen currentLabel=Plan A currentPct=97 resetsInMin=30 trigger=5h')
    await runRotationDecision(deps)
    expect(deps.postRotate).not.toHaveBeenCalled()
    expect((deps.notifyOwner as any).mock.calls[0][0]).toMatch(/Plan A.*97%.*nincs olyan regisztrált plan/)
  })

  it('FLEET_ROTATE with failures calls the failed agents out', async () => {
    const { deps } = mk('FLEET_ROTATE plan=plan-b label=Plan B tokenChanged=yes restarted=a,b failed=c notRunning=-')
    await runRotationDecision(deps)
    expect((deps.notifyOwner as any).mock.calls[0][0]).toMatch(/NEM indult újra.*c/)
    const ok = mk('FLEET_ROTATE plan=plan-b label=Plan B tokenChanged=yes restarted=a failed=- notRunning=-')
    await runRotationDecision(ok.deps)
    expect((ok.deps.notifyOwner as any).mock.calls[0][0]).not.toMatch(/NEM indult/)
  })

  it('check failure: opus fallback fires the old heartbeat turn, skip does not', async () => {
    const failing = { runCheck: async () => ({ ok: false, stdout: '', detail: 'exit 1' }) }
    const a = mk('', { ...failing, fallback: 'opus' })
    expect(await runRotationDecision(a.deps)).toMatchObject({ kind: 'check-failed', fallback: 'opus' })
    expect(a.deps.fallbackRun).toHaveBeenCalledTimes(1)
    const b = mk('', { ...failing, fallback: 'skip' })
    await runRotationDecision(b.deps)
    expect(b.deps.fallbackRun).not.toHaveBeenCalled()
    expect(b.deps.notifyOwner).not.toHaveBeenCalled()
  })
})
