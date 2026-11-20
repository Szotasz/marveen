import { describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  pane: '› \n\n  default · 100% context left',
  calls: [] as string[][],
}))
vi.mock('node:child_process', async original => {
  const { execFileFromSync } = await import('./helpers/exec-file-from-sync.js')
  const mocked = {
    ...await original<typeof import('node:child_process')>(),
    execFileSync: vi.fn((_file: string, args: string[] = []) => {
      harness.calls.push(args)
      return args.includes('capture-pane') ? harness.pane : ''
    }),
  }
  return { ...mocked, execFile: execFileFromSync(mocked.execFileSync) }
})
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(), notifyTelegram: vi.fn() }))

const { sendPromptToSession, isSessionReadyForPrompt } = await import('../web/agent-process.js')
const { wrapTrustedPeer } = await import('../prompt-safety.js')
const { paneOneLine } = await import('../web/pane-text.js')

describe('shared terminal delivery', () => {
  it('recognizes a Codex pane and sends wrapped text with the standard Enter key', async () => {
    expect(await isSessionReadyForPrompt('agent-pilot')).toBe(true)
    const prompt = wrapTrustedPeer('agent:sender', 'Review the fixture')
    // Echo the current draft after literal writes, then an idle pane after Enter.
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementation((_file, args: readonly string[] = []) => {
      harness.calls.push([...args])
      if (args.includes('capture-pane')) return harness.pane
      if (args.includes('send-keys') && args.includes('-l')) {
        harness.pane = `› ${paneOneLine(prompt)}\n\n  default · 100% context left`
      }
      if (args.includes('send-keys') && args.at(-1) === 'Enter') {
        harness.pane = '› \n\n  default · 100% context left'
      }
      return ''
    })
    expect(await sendPromptToSession('agent-pilot', prompt)).toBe('sent')
    const writes = harness.calls.filter(args => args.includes('send-keys'))
    expect(writes.filter(args => args.includes('-l')).map(args => args.at(-1)).join('')).toBe(paneOneLine(prompt))
    expect(writes.some(args => args.at(-1) === 'Enter')).toBe(true)
    expect(writes.some(args => args.includes('Escape'))).toBe(false)
  })
})
