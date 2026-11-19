// QUOTAHDRROT1118: the entry usage-collect.py runs (`node dist/claude-ratelimit-reading.js`),
// run as the main module: under plan rotation it must not call the API with the host token it was
// handed, off rotation it calls once and prints the reading. Only the entry's public contract is used
// (CLAUDE_RATELIMIT_TOKEN in, one JSON line out), so this file runs unchanged against older code too.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'

const settings = new Map<string, string>()
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? (k === 'MAIN_AGENT_CONFIG_DIR' ? '' : '0'),
}))
let planCount = 0
vi.mock('../web/claude-plans.js', () => ({
  readClaudePlans: () => Array.from({ length: planCount }, (_, i) => ({ id: `p${i}`, label: `p${i}`, tokenSecretId: `claude-plan-token-p${i}` })),
}))
const probeMock = vi.fn(async (_token: string, _opts?: unknown) => ({
  ok: true as const, httpStatus: 200,
  usage: { fiveHour: { usedPercent: 35, resetsAt: Math.floor(Date.now() / 1000) + 3600, status: 'allowed' }, sevenDay: null, overallStatus: 'allowed', representativeClaim: null },
}))
vi.mock('../claude-plan-usage-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude-plan-usage-probe.js')>()),
  probePlanUsage: (token: string, opts?: unknown) => probeMock(token, opts),
}))

const ENTRY = join(__dirname, '..', 'claude-ratelimit-reading.ts')
let written: string[] = []
const argv1 = process.argv[1]

async function runEntry(): Promise<{ ok: boolean; reason?: string; windows?: unknown }> {
  vi.resetModules()
  process.argv[1] = ENTRY
  process.env.CLAUDE_RATELIMIT_TOKEN = 'host-login-token'
  await import('../claude-ratelimit-reading.js')
  const line = written.join('').trim().split('\n').pop() ?? ''
  return JSON.parse(line)
}

beforeEach(() => {
  settings.clear(); planCount = 0; probeMock.mockClear(); written = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { written.push(String(s)); return true }) as typeof process.stdout.write)
})
afterEach(() => {
  vi.restoreAllMocks()
  process.argv[1] = argv1
  delete process.env.CLAUDE_RATELIMIT_TOKEN
})

describe('the rate-limit reading entry, run as main', () => {
  it('under plan rotation (isolated, 2 plans) it makes no call and gives no reading', async () => {
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1'); planCount = 2
    const out = await runEntry()
    expect(probeMock).not.toHaveBeenCalled()
    expect(out.ok).toBe(false)
  })

  it('on a single-account install it calls once with the token and prints the reading', async () => {
    planCount = 1
    const out = await runEntry()
    expect(probeMock).toHaveBeenCalledTimes(1)
    expect(probeMock.mock.calls[0][0]).toBe('host-login-token')
    expect(out.ok).toBe(true)
    expect(process.env.CLAUDE_RATELIMIT_TOKEN).toBeUndefined()
  })
})
