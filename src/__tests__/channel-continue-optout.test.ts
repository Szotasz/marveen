import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideContinueFlag, readContinueOptOut, type ContinueDecisionInput } from '../web/channel-continue-policy.js'

// Per-agent `--continue` opt-out: agent-config.json
// `"continue": false` makes every launch of that agent fresh, channel-less
// agents included (today they ALWAYS resume). Only a literal JSON false counts;
// anything else keeps the current decision, byte for byte.

const ROOT = join(__dirname, '..', '..')
const PROCESS_SRC = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')

const measured: ContinueDecisionInput = {
  hasPriorSession: true, fresh: false, hasChannel: true, isMainAgent: false, provider: 'telegram',
  usesLaunchSecret: false, fleetTokenLaunch: true, useMcpJsonForChannel: false, installedCli: '2.1.280',
}
const channelLess: ContinueDecisionInput = { ...measured, hasChannel: false, installedCli: null }

describe('readContinueOptOut', () => {
  it('O1: a literal "continue": false opts the agent out', () => {
    expect(readContinueOptOut('{"continue":false}')).toBe(true)
    expect(readContinueOptOut('{"model":"claude-x","continue":false}')).toBe(true)
  })
  it('O2: anything that is not a literal false keeps today\'s behaviour (no opt-out)', () => {
    for (const raw of [
      '{}', '{"continue":true}', '{"continue":"false"}', '{"continue":0}', '{"continue":null}',
      '{"continue":[]}', '{"Continue":false}', 'null', '[]', '[false]', 'false', '', 'not json', '{"continue":false',
    ]) {
      expect(readContinueOptOut(raw), raw).toBe(false)
    }
  })
})

describe('decideContinueFlag with continueOptOut', () => {
  it('D1: an opted-out channel-less agent is launched fresh (today it always resumes)', () => {
    expect(decideContinueFlag({ ...channelLess, continueOptOut: true })).toEqual({
      useContinue: false, reason: 'per-agent opt-out (agent-config.json "continue": false)',
    })
  })
  it('D2: an opted-out agent on the measured telegram shape is launched fresh too', () => {
    expect(decideContinueFlag({ ...measured, continueOptOut: true })).toMatchObject({
      useContinue: false, reason: expect.stringContaining('per-agent opt-out'),
    })
  })
  it('D3: an opted-out co-listen-only agent (extras, no primary channel) is launched fresh', () => {
    expect(decideContinueFlag({ ...channelLess, extraProviders: ['telegram'], fleetTokenLaunch: true, installedCli: '2.1.280', continueOptOut: true }).useContinue).toBe(false)
  })
  it('D4 invariant: absent or false opt-out leaves every decision as it was', () => {
    expect(decideContinueFlag(measured).useContinue).toBe(true)
    expect(decideContinueFlag({ ...measured, continueOptOut: false }).useContinue).toBe(true)
    expect(decideContinueFlag(channelLess)).toEqual({ useContinue: true, reason: 'channel-less agent keeps its context' })
    expect(decideContinueFlag({ ...channelLess, continueOptOut: false }).useContinue).toBe(true)
  })
  it('D5 invariant: the earlier reasons keep priority (no prior session, fresh requested)', () => {
    expect(decideContinueFlag({ ...measured, hasPriorSession: false, continueOptOut: true }).reason).toBe('no prior session to continue')
    expect(decideContinueFlag({ ...measured, fresh: true, continueOptOut: true }).reason).toBe('fresh launch requested')
  })
})

describe('wiring in agent-process.ts', () => {
  const norm = (s: string) => s.replace(/\s+/g, ' ')
  const SRC = norm(PROCESS_SRC)
  it('W1: the local launch passes the agent\'s own agent-config.json to the decision', () => {
    const at = SRC.indexOf('const continueDecision = decideContinueFlag({')
    expect(at).toBeGreaterThan(-1)
    const call = SRC.slice(at, SRC.indexOf('})', at))
    expect(call).toContain("continueOptOut: readContinueOptOut(readFileOr(join(dir, 'agent-config.json'), '{}'))")
  })
  it('W2: the remote launch skips the --continue probe for an opted-out agent', () => {
    expect(SRC).toContain("if (!opts.fresh && !readContinueOptOut(readFileOr(join(agentDir(name), 'agent-config.json'), '{}'))) {")
    const at = SRC.indexOf("if (!opts.fresh && !readContinueOptOut(")
    expect(SRC.indexOf('const probe = buildSshExec(host, buildContinueProbeCommand(workdir))', at)).toBeGreaterThan(at)
  })
})
