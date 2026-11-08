// APPROVALTAGEN1108 (EGM design B1): the words that decide the owner's consent widen ONLY on the explicit
// AGENT_TEXT_LANG=en. An install rendered English without the key (its main CLAUDE.md carries the English heading) is
// English for agentTextLang() -- the control below proves this install is one -- and still Hungarian for approvals.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  root.dir = mk(j(td(), 'marveen-approval-lang-'))
  return { ...actual, PROJECT_ROOT: root.dir }
})

const { approvalTextLang, agentTextLang } = await import('../web/agent-text-lang.js')

mkdirSync(join(root.dir, 'templates', 'en'), { recursive: true })
writeFileSync(join(root.dir, 'templates', 'en', 'CLAUDE.md.template'), '# x\n')
writeFileSync(join(root.dir, 'CLAUDE.md'), '# Bot\n\n## Inter-agent communication\n\ntext\n')
afterAll(() => rmSync(root.dir, { recursive: true, force: true }))

const noKey = (): Record<string, string> => ({})

describe('approvalTextLang on an English-rendered install without the key', () => {
  it('control: agentTextLang says en here (the fallback sees the English heading)', () => {
    expect(agentTextLang(noKey)).toBe('en')
  })
  it('approvalTextLang says hu: the heading does not widen the deciding words', () => {
    expect(approvalTextLang(noKey)).toBe('hu')
  })
  it('the explicit key still decides: en -> en, hu -> hu', () => {
    expect(approvalTextLang(() => ({ AGENT_TEXT_LANG: 'en' }))).toBe('en')
    expect(approvalTextLang(() => ({ AGENT_TEXT_LANG: 'hu' }))).toBe('hu')
  })
})
