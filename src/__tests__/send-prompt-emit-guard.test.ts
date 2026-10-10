import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card 71263d15 (C), the #1809 review: a STOP skips the idle wait, so its send takes one last
// look at the pane INSIDE the send lane, right before the first key (sendPromptToSession's
// emitGuard, the router passes urgentEmitRefusal). This drives the REAL sendPromptToSession
// over a mocked tmux (the send-prompt-chunk-binding.test.ts harness) and inspects every tmux
// argument: on a permission prompt the guarded send must press NOTHING -- no text, no Enter,
// and no Escape (an Escape denies the pending call).

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const IDLE = ['', SEP, '❯ ', SEP, FOOTER].join('\n')
  return { IDLE, pane: '' as string | null, calls: [] as string[][] }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) {
        if (h.pane == null) throw new Error('capture failed')
        return h.pane
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { sendPromptToSession } from '../web/agent-process.js'
import { __resetSessionSendLocks } from '../web/session-send-lock.js'
import { urgentEmitRefusal } from '../web/message-router.js'

const PERMISSION_PANE = readFileSync(join(__dirname, 'fixtures/pane/permission-prompt-bash-grep.txt'), 'utf8')
const WALL_PANE = readFileSync(join(__dirname, 'fixtures/pane/quota-wall-usage-limit.txt'), 'utf8')
const keyPresses = () => h.calls.filter((a) => a.includes('send-keys'))

beforeEach(() => {
  h.calls.length = 0
  __resetSessionSendLocks()
})

describe('sendPromptToSession emitGuard (71263d15 C)', () => {
  it('⛔ a permission prompt: aborted-guard, and not a single key is sent (no text, no Enter, no Escape)', async () => {
    h.pane = PERMISSION_PANE
    const out = await sendPromptToSession('emit-guard-test', '[STOP] ne kuldd ki', null, { waitForIdle: false, emitGuard: urgentEmitRefusal })
    expect(out).toBe('aborted-guard')
    expect(keyPresses()).toEqual([])
  })

  it('⛔ the quota wall and an unreadable pane refuse the same way', async () => {
    for (const pane of [WALL_PANE, null]) {
      h.calls.length = 0
      h.pane = pane
      const out = await sendPromptToSession('emit-guard-test', '[STOP] x', null, { waitForIdle: false, emitGuard: urgentEmitRefusal })
      expect(out, String(pane).slice(0, 20)).toBe('aborted-guard')
      expect(keyPresses()).toEqual([])
    }
  })

  it('control: on an idle pane the guarded send types the text and submits it', async () => {
    h.pane = h.IDLE
    const out = await sendPromptToSession('emit-guard-test', '[STOP] x', null, { waitForIdle: false, emitGuard: urgentEmitRefusal })
    expect(out).toBe('sent')
    expect(keyPresses().some((a) => a.includes('-l') && a.includes('[STOP] x'))).toBe(true)
    expect(keyPresses().some((a) => a[a.length - 1] === 'Enter')).toBe(true)
  })

  it('control: without a guard the same permission pane DOES get the keys (the hole the guard closes)', async () => {
    h.pane = PERMISSION_PANE
    const out = await sendPromptToSession('emit-guard-test', '[STOP] x', null, { waitForIdle: false })
    expect(out).toBe('sent')
    expect(keyPresses().some((a) => a[a.length - 1] === 'Enter')).toBe(true)
  }, 15_000)
})
