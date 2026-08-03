// OWNERCHAT803 -- end-to-end: what actually leaves for the Bot API on a
// fresh wizard install?
//
// The unit tests assert the DECISION. This one asserts the OUTCOME, at the
// boundary that matters: the outgoing sendMessage call. It reproduces the
// reported install shape -- no usable ALLOWED_CHAT_ID, channel access.json
// populated by a successful pairing -- and drives the REAL sendWelcomeMessage,
// the path a bootcamp participant hits within minutes of installing (create an
// agent, expect a greeting).
//
// Two separate claims, asserted separately because they are not the same:
//   1. the real chat id reaches the API, and
//   2. the placeholder "0" NEVER reaches the API.
// Only the second one rules out the silent 400s that made this bug invisible.
//
// SCOPE, stated because the first draft of this file overclaimed: config.ts
// reads ALLOWED_CHAT_ID from the .env FILE at import time (env.ts readEnvFile),
// NOT from process.env, so a test cannot put a literal `ALLOWED_CHAT_ID=0` in
// front of this code without writing to the checkout root -- which is exactly
// what corrupted a live install on 2026-07-27 and is why the suite has a
// live-install gate. So the split is: the "0 counts as unset" DECISION is
// proven in owner-chat.test.ts, where the configured value is passed in
// explicitly to the same function; this file proves the DELIVERY -- that with
// no usable configured value the real send path resolves the owner from the
// paired channel, and that nothing bogus goes out when there is no pairing.
// The earlier draft set process.env and claimed the .env case; it was not
// measuring that, and the third test failing is what exposed it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const REAL = '1268077055'

let home: string
let sent: Array<{ url: string; chatId: unknown }>
let originalHome: string | undefined
let originalChat: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'freshinstall-'))
  mkdirSync(join(home, '.claude', 'channels', 'telegram'), { recursive: true })
  // The wizard DID pair successfully: this is the file the plugin enforces.
  writeFileSync(
    join(home, '.claude', 'channels', 'telegram', 'access.json'),
    JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [REAL], groups: {}, pending: {} }),
  )
  originalHome = process.env['HOME']
  originalChat = process.env['ALLOWED_CHAT_ID']
  process.env['HOME'] = home

  sent = []
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    let chatId: unknown
    try {
      chatId = JSON.parse(init?.body ?? '{}').chat_id
    } catch {
      chatId = '<multipart>'
    }
    sent.push({ url: String(url), chatId })
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  if (originalChat === undefined) delete process.env['ALLOWED_CHAT_ID']
  else process.env['ALLOWED_CHAT_ID'] = originalChat
  rmSync(home, { recursive: true, force: true })
})

describe('fresh wizard install (no usable ALLOWED_CHAT_ID, channel paired)', () => {
  it('sends the new-agent welcome to the REAL chat, and never to the placeholder', async () => {
    vi.resetModules()
    const { sendWelcomeMessage } = await import('../web/telegram.js')

    await sendWelcomeMessage('probe-agent', 'fake-token')

    // Claim 1: something went out, and it went to the owner.
    const messages = sent.filter((s) => s.url.includes('/sendMessage'))
    expect(messages.length, 'the welcome message must actually be sent').toBeGreaterThan(0)
    expect(messages[0].chatId).toBe(REAL)

    // Claim 2: the placeholder never reached the API, on ANY call.
    for (const call of sent) {
      expect(call.chatId, `placeholder leaked to ${call.url}`).not.toBe('0')
      expect(call.chatId).not.toBe(0)
    }
  })

  it('with no pairing at all, it sends NOTHING rather than a doomed request', async () => {
    // Same install, pairing never completed: access.json empty. The old code
    // still called the API with "0" and collected a 400 nobody read. The fix
    // has to be silence, not a different bad request.
    writeFileSync(
      join(home, '.claude', 'channels', 'telegram', 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }),
    )
    vi.resetModules()
    const { sendWelcomeMessage } = await import('../web/telegram.js')

    await sendWelcomeMessage('probe-agent', 'fake-token')

    expect(sent, 'no outgoing call may be made without an owner chat').toHaveLength(0)
  })

  // NOT here: "a hand-configured .env still wins". Driving that end-to-end
  // would mean writing a .env into the checkout root. It is covered in
  // owner-chat.test.ts ('prefers an explicitly configured chat id'), which
  // calls the same resolver with the configured value supplied.
})
