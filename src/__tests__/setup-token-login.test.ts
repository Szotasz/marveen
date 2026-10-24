// SETUPTOKENWIZ1022: the setup-token login relay -- parsing and the session.
// The start output is a real CLI 2.1.308 capture (fixtures/setup-token-cli-2.1.308);
// the output after a code is built by hand, because capturing it takes a real
// login (the owner does that at the end). The relay process is faked here; the
// real python PTY relay has its own test (setup-token-pty-relay.test.ts).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractOauthUrl, extractSetupToken, isAllowedAuthUrl, isPlausibleLoginCode, buildRelayEnv,
  SetupTokenLogin, SUBMIT_ENTER_DELAY_MS, type LaunchResult, type RelayProcess, type LoginTimeouts,
} from '../web/setup-token-login.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const START = readFileSync(join(__dirname, 'fixtures/setup-token-cli-2.1.308/start.txt'), 'utf-8')

const TOKEN = 'sk-ant-oat01-' + 'Ab3_-x'.repeat(16)
const COLOURED_TOKEN_OUTPUT =
  '\r\r\n\x1b[2G\x1b[32m✓\x1b[39m Long-lived authentication token created successfully!\r\r\n\r\r\n' +
  `\x1b[2GYour OAuth token (valid for 1 year):\r\r\n\r\r\n\x1b[2G\x1b[33m${TOKEN}\x1b[39m\r\r\n\r\r\n` +
  '\x1b[2GStore this token securely.\r\r\n'

describe('extractOauthUrl', () => {
  it('finds the login URL in the real 2.1.308 start output', () => {
    const url = extractOauthUrl(START)
    expect(url).not.toBeNull()
    const u = new URL(url!)
    expect(u.hostname).toBe('claude.com')
    expect(u.pathname.endsWith('/oauth/authorize')).toBe(true)
    expect(u.searchParams.get('state')).toBe('FIXTURE' + 's'.repeat(36))
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('reads the OSC 8 target, so a wrapped visible URL still comes out whole', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&state=' + 'x'.repeat(60)
    const wrapped = `\x1b]8;;${url}\x07${url.slice(0, 40)}\r\r\n${url.slice(40)}\x1b]8;;\x07`
    expect(extractOauthUrl(wrapped)).toBe(url)
  })

  it('returns null until the URL is there', () => {
    expect(extractOauthUrl(START.slice(0, START.indexOf('https://')))).toBeNull()
  })

  it('refuses a URL on a host that is not Anthropic, in the OSC 8 target and in the text', () => {
    const bad = 'https://claude.com.evil.example/oauth/authorize?state=1'
    expect(extractOauthUrl(`\x1b]8;;${bad}\x07${bad}\x1b]8;;\x07`)).toBeNull()
    expect(isAllowedAuthUrl('http://claude.com/oauth/authorize')).toBe(false)
    expect(isAllowedAuthUrl('https://claude.com/oauth/token')).toBe(false)
    expect(isAllowedAuthUrl('https://platform.claude.com/oauth/authorize?x=1')).toBe(true)
  })
})

describe('extractSetupToken', () => {
  it('catches the coloured token and nothing of the line after it', () => {
    expect(extractSetupToken(COLOURED_TOKEN_OUTPUT)).toBe(TOKEN)
  })

  it('does not glue the next line onto an uncoloured token (2.1.308 ends lines in \\r\\r\\n)', () => {
    expect(extractSetupToken(`${TOKEN}\r\r\nStore this token securely.\r\r\n`)).toBe(TOKEN)
    expect(extractSetupToken(`${TOKEN}\r\nStore\r\n`)).toBe(TOKEN)
  })

  it('waits for the rest of a token cut at a chunk boundary', () => {
    const cut = COLOURED_TOKEN_OUTPUT.slice(0, COLOURED_TOKEN_OUTPUT.indexOf(TOKEN) + 60)
    expect(extractSetupToken(cut)).toBeNull()
    const cutInEscape = COLOURED_TOKEN_OUTPUT.slice(0, COLOURED_TOKEN_OUTPUT.indexOf(TOKEN) + TOKEN.length + 2)
    expect(extractSetupToken(cutInEscape)).toBeNull()
  })

  it('takes the end of the stream as the end of the token once the relay has exited', () => {
    expect(extractSetupToken(TOKEN)).toBeNull()
    expect(extractSetupToken(TOKEN, true)).toBe(TOKEN)
  })

  it('skips prose that names the prefix before the real token', () => {
    expect(extractSetupToken(`Tokens look like sk-ant-oat01-... :\r\n${TOKEN}\r\n`)).toBe(TOKEN)
  })

  it('refuses anything that is not the setup-token shape', () => {
    expect(extractSetupToken('sk-ant-api03-' + 'a'.repeat(80) + '\n')).toBeNull()
    expect(extractSetupToken('sk-ant-oat01-short\n')).toBeNull()
  })
})

describe('isPlausibleLoginCode', () => {
  it('takes the code shape and refuses control characters', () => {
    expect(isPlausibleLoginCode('AbCdEf123_-#XyZ.~45')).toBe(true)
    expect(isPlausibleLoginCode('abc')).toBe(false)
    expect(isPlausibleLoginCode('abcdefgh\rijkl')).toBe(false)
    expect(isPlausibleLoginCode('abcdefgh\x1b[A')).toBe(false)
    expect(isPlausibleLoginCode('abcd efgh')).toBe(false)
  })
})

describe('buildRelayEnv', () => {
  it('inherits nothing but the allowlisted keys: no token, no API key, no channel state dir', () => {
    const env = buildRelayEnv('/tmp/root', {
      PATH: '/usr/bin', LANG: 'hu_HU.UTF-8', USER: 'op',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-PARENT', ANTHROPIC_API_KEY: 'sk-ant-api', TELEGRAM_STATE_DIR: '/home/op/.claude/channels/telegram',
      CLAUDE_CONFIG_DIR: '/home/op/.claude',
    })
    expect(Object.keys(env).sort()).toEqual(['BROWSER', 'CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'PATH', 'TELEGRAM_STATE_DIR', 'TERM', 'USER'])
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/root/config')
    expect(env.TELEGRAM_STATE_DIR).toBe('/tmp/root/telegram')
    expect(env.BROWSER).toBe('/tmp/root/no-browser.sh')
  })
})

// ---------------------------------------------------------------------------
// The session, over a fake relay.
// ---------------------------------------------------------------------------

class FakeRelay implements RelayProcess {
  writes: string[] = []
  ended = 0
  killed = 0
  private dataCbs: Array<(s: string) => void> = []
  private exitCbs: Array<() => void> = []
  write(d: string) { this.writes.push(d) }
  end() { this.ended++ }
  kill() { this.killed++ }
  onData(cb: (s: string) => void) { this.dataCbs.push(cb) }
  onExit(cb: () => void) { this.exitCbs.push(cb) }
  emit(s: string) { for (const cb of this.dataCbs) cb(s) }
  exit() { for (const cb of this.exitCbs) cb() }
}

const T: LoginTimeouts = { urlMs: 1000, codeMs: 5000, tokenMs: 2000, killMs: 300 }

function setup() {
  const relay = new FakeRelay()
  const cleanup = vi.fn()
  const launch = vi.fn((): LaunchResult => ({ ok: true, relay, cleanup }))
  const login = new SetupTokenLogin(launch, T)
  return { relay, cleanup, launch, login }
}

async function toWaitingCode(s: ReturnType<typeof setup>) {
  const started = s.login.start()
  s.relay.emit(START)
  expect(await started).toEqual({ ok: true, url: extractOauthUrl(START) })
}

afterEach(() => { vi.useRealTimers() })

describe('SetupTokenLogin', () => {
  it('finds the URL even when the stream arrives one character at a time', async () => {
    const s = setup()
    const started = s.login.start()
    for (const ch of START) s.relay.emit(ch)
    const r = await started
    expect(r.ok && r.url).toBe(extractOauthUrl(START))
    expect(s.login.getPhase()).toBe('waiting-code')
    expect(s.login.getUrl()).toBe(extractOauthUrl(START))
  })

  it('types the code, then Enter on its own after the gap, and hands the token only to the sink', async () => {
    vi.useFakeTimers()
    const s = setup()
    await toWaitingCode(s)
    const sink = vi.fn(async (token: string) => ({ stored: token.length }))
    const done = s.login.submitCode('AbCdEf123#XyZ', sink)
    expect(s.relay.writes).toEqual(['AbCdEf123#XyZ'])
    vi.advanceTimersByTime(SUBMIT_ENTER_DELAY_MS)
    expect(s.relay.writes).toEqual(['AbCdEf123#XyZ', '\r'])
    for (const ch of COLOURED_TOKEN_OUTPUT) s.relay.emit(ch)
    const r = await done
    expect(r).toEqual({ ok: true, result: { stored: TOKEN.length } })
    expect(sink).toHaveBeenCalledWith(TOKEN)
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(s.login.getPhase()).toBe('done')
    expect(s.login.getUrl()).toBeNull()
    // the relay is told to close the PTY; its exit removes the temp root
    expect(s.relay.ended).toBe(1)
    s.relay.exit()
    expect(s.cleanup).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(T.killMs)
    expect(s.relay.killed).toBe(0)
  })

  it('a code of the wrong shape is refused and the login keeps waiting', async () => {
    const s = setup()
    await toWaitingCode(s)
    const sink = vi.fn(async () => 1)
    expect(await s.login.submitCode('abc\r', sink)).toEqual({ ok: false, code: 'bad-code' })
    expect(s.relay.writes).toEqual([])
    expect(s.login.getPhase()).toBe('waiting-code')
    expect(sink).not.toHaveBeenCalled()
  })

  it('a token the relay printed without an ending is caught when the relay exits', async () => {
    vi.useFakeTimers()
    const s = setup()
    await toWaitingCode(s)
    const sink = vi.fn(async () => 'ok')
    const done = s.login.submitCode('AbCdEf123#XyZ', sink)
    s.relay.emit(`\r\r\n${TOKEN}`)
    s.relay.exit()
    expect(await done).toEqual({ ok: true, result: 'ok' })
    expect(sink).toHaveBeenCalledWith(TOKEN)
  })

  it('url-timeout: ends the relay, kills it if it lingers, removes the temp root', async () => {
    vi.useFakeTimers()
    const s = setup()
    const started = s.login.start()
    vi.advanceTimersByTime(T.urlMs)
    expect(await started).toEqual({ ok: false, code: 'url-timeout' })
    expect(s.relay.ended).toBe(1)
    vi.advanceTimersByTime(T.killMs)
    expect(s.relay.killed).toBe(1)
    expect(s.cleanup).toHaveBeenCalledTimes(1)
  })

  it('code-timeout: the login closes and a late code is refused', async () => {
    vi.useFakeTimers()
    const s = setup()
    await toWaitingCode(s)
    vi.advanceTimersByTime(T.codeMs)
    expect(s.login.getPhase()).toBe('failed')
    expect(s.login.getError()).toBe('code-timeout')
    expect(await s.login.submitCode('AbCdEf123#XyZ', async () => 1)).toEqual({ ok: false, code: 'wrong-phase' })
  })

  it('token-timeout: the sink is never called', async () => {
    vi.useFakeTimers()
    const s = setup()
    await toWaitingCode(s)
    const sink = vi.fn(async () => 1)
    const done = s.login.submitCode('AbCdEf123#XyZ', sink)
    vi.advanceTimersByTime(T.tokenMs)
    expect(await done).toEqual({ ok: false, code: 'token-timeout' })
    expect(sink).not.toHaveBeenCalled()
    expect(s.relay.ended).toBe(1)
  })

  it('cancel while waiting for the token resolves the code call as cancelled', async () => {
    const s = setup()
    await toWaitingCode(s)
    const done = s.login.submitCode('AbCdEf123#XyZ', async () => 1)
    s.login.cancel()
    expect(await done).toEqual({ ok: false, code: 'cancelled' })
    expect(s.login.isActive()).toBe(false)
    expect(s.relay.ended).toBe(1)
  })

  it('a relay that dies before the URL fails the start as exited and is cleaned up', async () => {
    const s = setup()
    const started = s.login.start()
    s.relay.exit()
    expect(await started).toEqual({ ok: false, code: 'exited' })
    expect(s.cleanup).toHaveBeenCalledTimes(1)
  })

  it('a launch failure is reported by its code', async () => {
    const login = new SetupTokenLogin(() => ({ ok: false, code: 'claude-not-found' }), T)
    expect(await login.start()).toEqual({ ok: false, code: 'claude-not-found' })
    expect(login.isActive()).toBe(false)
  })

  it('a failing sink is store-failed, not a success', async () => {
    const s = setup()
    await toWaitingCode(s)
    const done = s.login.submitCode('AbCdEf123#XyZ', async () => { throw new Error('disk full') })
    s.relay.emit(COLOURED_TOKEN_OUTPUT)
    expect(await done).toEqual({ ok: false, code: 'store-failed' })
  })
})
