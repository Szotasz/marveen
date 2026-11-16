import { describe, it, expect, vi } from 'vitest'
import corpus from './fixtures/agent-send-exception-cases.json' with { type: 'json' }

const file = vi.hoisted(() => ({ content: '{invalid json', unreadable: false }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith('/store/agent-send-exceptions.json')) {
      if (file.unreadable) throw new Error('unreadable')
      return file.content
    }
    return fs.readFileSync(...args)
  } }
})
// @ts-expect-error -- plain .mjs hook script, no types
import { agentScriptException, gateDecision, readAgentSendExceptions } from '../../scripts/email-send-gate.mjs'

const { agentName, entry, cases } = corpus
const config = { agents: { [agentName]: entry } }
const command = cases[0].command
const verify = (address: string) => ['verified@example.invalid', 'copy@example.invalid'].includes(address)
const decide = (cmd = command, agent: string | null = agentName, cfg: unknown = config) =>
  gateDecision('Bash', { command: cmd }, verify, process.cwd(), agent, () => cfg)

describe('named-script exception', () => {
  it('preserves the script-send denial without an agent identity', () => {
    expect(decide(command, null)).toMatchObject({ deny: true, kind: 'script-send' })
  })
  it('allows the exact send with verified recipients', () => {
    expect(decide()).toEqual({ deny: false, kind: 'script-exception' })
    expect(agentScriptException(command, agentName, config)).toEqual({
      script: entry.scripts[0], mode: 'send', to: 'verified@example.invalid', cc: 'copy@example.invalid',
      subject: 'Example subject', bodyFile: '/absolute/path/to/body.txt', attach: ['/absolute/path/to/attachment.bin'],
    })
  })
  it('allows a draft with verified recipients', () => {
    expect(decide(command.replace(' send ', ' draft '))).toEqual({ deny: false, kind: 'script-exception' })
  })
  it('denies an unverified draft recipient', () => {
    expect(decide(command.replace(' send ', ' draft ').replace('verified@', 'unknown@')))
      .toMatchObject({ deny: true, kind: 'unverified-recipient' })
  })
  it('checks cc as well as to', () => {
    expect(decide(command.replace('copy@', 'unknown@'))).toMatchObject({ deny: true, kind: 'unverified-recipient' })
  })
  it('denies an unparseable recipient', () => {
    expect(decide(command.replace('verified@example.invalid', 'invalid@')))
      .toMatchObject({ deny: true, kind: 'unparseable-recipient' })
  })
  for (const c of cases.filter(c => !c.match && !c.name.startsWith('innocent'))) {
    it(`falls through to the existing deny: ${c.name}`, () => {
      expect(decide(c.command).deny).toBe(true)
    })
  }
  it('denies an identity with no entry', () => {
    expect(decide(command, '<other-agent>')).toMatchObject({ deny: true, kind: 'script-send' })
  })
  it('denies a send under a draft-only grant', () => {
    expect(decide(command, agentName, { agents: { [agentName]: { ...entry, modes: ['draft'] } } }))
      .toMatchObject({ deny: true, kind: 'script-send' })
  })
  it('denies an entry with a relative script path', () => {
    expect(decide(command, agentName, { agents: { [agentName]: { ...entry, scripts: ['runner.ext'] } } }))
      .toMatchObject({ deny: true, kind: 'script-send' })
  })
  it('treats invalid JSON and unreadable config as no exceptions', () => {
    file.content = '{invalid json'
    expect(readAgentSendExceptions()).toEqual({})
    expect(decide(command, agentName, readAgentSendExceptions())).toMatchObject({ deny: true, kind: 'script-send' })
    file.unreadable = true
    expect(readAgentSendExceptions()).toEqual({})
    file.unreadable = false
  })
  it('skips only invalid entries', () => {
    file.content = JSON.stringify({ agents: { [agentName]: entry, '<invalid-agent>': { ...entry, unexpected: true } } })
    expect(readAgentSendExceptions()).toEqual(config)
  })
})

describe('parser conformance (also read by email-approval-gate-script-exception.test.py)', () => {
  for (const c of cases) it(c.name, () => {
    expect(Boolean(agentScriptException(c.command, agentName, config))).toBe(c.match)
  })
})
