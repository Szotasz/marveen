import { describe, it, expect, vi, afterAll } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_AGENT_DIR, FAKE_PHOTO_PATH } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ext-test-'))
  const fakeAgentDir = path.join(fakeHome, 'agents', 'my-agent')

  fs.mkdirSync(path.join(fakeAgentDir, '.claude', 'channels', 'telegram'), { recursive: true })
  fs.writeFileSync(
    path.join(fakeAgentDir, '.claude', 'channels', 'telegram', '.env'),
    'TELEGRAM_BOT_TOKEN=agent-token-123\n',
  )
  fs.writeFileSync(path.join(fakeAgentDir, 'SOUL.md'), '# My Agent\nA friendly assistant.')

  fs.mkdirSync(path.join(fakeHome, '.claude', 'channels', 'telegram'), { recursive: true })
  fs.writeFileSync(
    path.join(fakeHome, '.claude', 'channels', 'telegram', '.env'),
    'TELEGRAM_BOT_TOKEN=marveen-token-abc\n',
  )
  fs.writeFileSync(path.join(fakeHome, '.env'), 'TELEGRAM_BOT_TOKEN=marveen-alert-token\n')

  const fakePhotoPath = path.join(fakeHome, 'test-avatar.png')
  fs.writeFileSync(fakePhotoPath, Buffer.from([137, 80, 78, 71])) // PNG magic bytes

  return { FAKE_HOME: fakeHome, FAKE_AGENT_DIR: fakeAgentDir, FAKE_PHOTO_PATH: fakePhotoPath }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn().mockReturnValue(FAKE_HOME) }
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: FAKE_HOME,
  STORE_DIR: FAKE_HOME,
  ALLOWED_CHAT_ID: '999888',
  DEFAULT_AGENT_MODEL: 'claude-opus-4-8[1m]',
}))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: vi.fn().mockImplementation((name: string) => nodePath.join(FAKE_HOME, 'agents', name)),
    readFileOr: vi.fn().mockImplementation((filePath: string, def: string) => {
      try { return nodeFs.readFileSync(filePath, 'utf-8') } catch { return def }
    }),
    findAvatarForAgent: vi.fn().mockReturnValue(null),
  }
})

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('../tool-timeouts.js', () => ({
  TOOL_TIMEOUTS: { telegram: 100 },
}))

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }) } catch { /* best effort */ }
})

import {
  sendTelegramPhoto,
  sendWelcomeMessage,
  sendMarveenAvatarChange,
  sendAvatarChangeMessage,
  sendMarveenAlert,
} from '../web/telegram.js'

describe('sendTelegramPhoto', () => {
  it('sends multipart request to Telegram API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true }) as any
    global.fetch = mockFetch
    await sendTelegramPhoto('test-token', '12345', FAKE_PHOTO_PATH, 'Test caption')
    expect(mockFetch).toHaveBeenCalled()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain('sendPhoto')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toContain('multipart/form-data')
  })
})

describe('sendWelcomeMessage', () => {
  it('sends welcome message when agent has telegram token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true }) as any
    global.fetch = mockFetch
    await sendWelcomeMessage('my-agent', 'agent-token-123')
    expect(mockFetch).toHaveBeenCalled()
    const [, opts] = mockFetch.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.text).toContain('My-agent')
  })

  it('reads SOUL.md first line for greeting when present', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true }) as any
    global.fetch = mockFetch
    await sendWelcomeMessage('my-agent', 'agent-token-123')
    const [, opts] = mockFetch.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.text).toContain('A friendly assistant')
  })

  it('sends avatar photo when findAvatarForAgent returns a path', async () => {
    const { findAvatarForAgent } = await import('../web/agent-config.js')
    vi.mocked(findAvatarForAgent).mockReturnValueOnce(FAKE_PHOTO_PATH)
    const mockFetch = vi.fn().mockResolvedValue({ ok: true }) as any
    global.fetch = mockFetch
    await sendWelcomeMessage('my-agent', 'agent-token-123')
    // Two calls: one for text, one for photo
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('handles send error gracefully (does not throw)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as any
    await expect(sendWelcomeMessage('my-agent', 'agent-token-123')).resolves.toBeUndefined()
  })
})

describe('sendMarveenAvatarChange', () => {
  it('sends text and photo when token is present', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true }) as any
    global.fetch = mockFetch
    await sendMarveenAvatarChange(FAKE_PHOTO_PATH)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('handles send error gracefully (does not throw)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as any
    await expect(sendMarveenAvatarChange(FAKE_PHOTO_PATH)).resolves.toBeUndefined()
  })

  it('returns early when no token in .env', async () => {
    const { readFileOr } = await import('../web/agent-config.js')
    vi.mocked(readFileOr).mockReturnValueOnce('')
    const mockFetch = vi.fn() as any
    global.fetch = mockFetch
    await sendMarveenAvatarChange(FAKE_PHOTO_PATH)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('sendAvatarChangeMessage', () => {
  it('sends text and photo when agent has telegram token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true }) as any
    global.fetch = mockFetch
    await sendAvatarChangeMessage('my-agent', FAKE_PHOTO_PATH)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns early when agent has no token', async () => {
    const mockFetch = vi.fn() as any
    global.fetch = mockFetch
    await sendAvatarChangeMessage('no-token-agent', FAKE_PHOTO_PATH)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('handles send error gracefully (does not throw)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as any
    await expect(sendAvatarChangeMessage('my-agent', FAKE_PHOTO_PATH)).resolves.toBeUndefined()
  })
})

describe('sendMarveenAlert catch path', () => {
  it('handles sendTelegramMessage error silently', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request'),
    }) as any
    await expect(sendMarveenAlert('test alert')).resolves.toBeUndefined()
  })
})
