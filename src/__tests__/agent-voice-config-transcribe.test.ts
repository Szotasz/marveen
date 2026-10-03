// voice.transcribeInbound through the real agent-config fs layer: it must be
// read only as a real boolean, survive a write that does not mention it, and
// never appear in a config that never set it (unset = install default).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS_BASE_DIR, readAgentVoiceConfig, writeAgentVoiceConfig } from '../web/agent-config.js'

const NAME = `voice-transcribe-test-${process.pid}`
const DIR = join(AGENTS_BASE_DIR, NAME)
const CFG = join(DIR, 'agent-config.json')
const put = (voice: unknown) => writeFileSync(CFG, JSON.stringify({ model: 'x', voice }))
const onDisk = () => JSON.parse(readFileSync(CFG, 'utf8')).voice

beforeAll(() => mkdirSync(DIR, { recursive: true }))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('agent voice config: transcribeInbound', () => {
  it('is absent when the config does not set it', () => {
    put({ responseMode: 'text' })
    expect(readAgentVoiceConfig(NAME).transcribeInbound).toBeUndefined()
  })

  it('reads true/false as given', () => {
    put({ responseMode: 'text', transcribeInbound: true })
    expect(readAgentVoiceConfig(NAME).transcribeInbound).toBe(true)
    put({ responseMode: 'text', transcribeInbound: false })
    expect(readAgentVoiceConfig(NAME).transcribeInbound).toBe(false)
  })

  it('treats a non-boolean as unset instead of guessing', () => {
    put({ responseMode: 'text', transcribeInbound: 'true' })
    expect(readAgentVoiceConfig(NAME).transcribeInbound).toBeUndefined()
  })

  it('survives a write that only changes another field', () => {
    put({ responseMode: 'text', transcribeInbound: true })
    writeAgentVoiceConfig(NAME, { responseMode: 'auto' })
    expect(onDisk()).toMatchObject({ responseMode: 'auto', transcribeInbound: true })
  })

  it('is not invented by a write on a config that never had it', () => {
    put({ responseMode: 'text' })
    writeAgentVoiceConfig(NAME, { responseMode: 'voice' })
    expect('transcribeInbound' in onDisk()).toBe(false)
  })

  it('rejects a non-boolean on write', () => {
    put({ responseMode: 'text' })
    expect(() => writeAgentVoiceConfig(NAME, { transcribeInbound: 'yes' as unknown as boolean })).toThrow(/transcribeInbound/)
  })
})
