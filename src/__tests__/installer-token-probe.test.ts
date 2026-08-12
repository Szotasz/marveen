// INSTTOKEN807: the installer's token prompt must probe the freshly entered
// Telegram bot token and SAY IT in human language when the token is invalid,
// webhook-bound, or owned by another running install -- instead of the
// customer meeting an opaque plugin "-32000" at first contact (measured live,
// Szabolcs's 2026-08-07 install with a reused test-bot token). Warn-only by
// design: the headless derive contract forbids new interactive reads, and a
// transient network error must not block an install.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')

function sliceProbeFn(src: string): string {
  const start = src.indexOf('probe_telegram_token() {')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

/**
 * Run the real probe function against a stubbed `curl`. The stub answers per
 * Telegram method from files the case writes, so each scenario drives the real
 * parsing, not a re-implementation of it.
 */
function runProbe(opts: { getMe: string; webhook?: string; updatesStatus?: string; curlFails?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tokenprobe-'))
  try {
    const stub = join(dir, 'curl')
    writeFileSync(
      stub,
      [
        '#!/bin/bash',
        opts.curlFails ? 'exit 7' : '',
        'url="${@: -1}"',
        'case "$url" in',
        `  *getMe*) printf '%s' '${opts.getMe}' ;;`,
        `  *getWebhookInfo*) printf '%s' '${opts.webhook ?? '{"ok":true,"result":{"url":""}}'}' ;;`,
        // -w %{http_code} form: emit the status code like curl would
        `  *getUpdates*) printf '%s' '${opts.updatesStatus ?? '200'}' ;;`,
        'esac',
        'exit 0',
      ].join('\n'),
    )
    chmodSync(stub, 0o755)
    const script = join(dir, 'probe.sh')
    writeFileSync(
      script,
      [
        '#!/bin/bash',
        'set -e',                                  // the installer runs under set -e
        'ORANGE=""; NC=""; DIM=""',
        'warn() { echo "WARN: $*"; }',
        sliceProbeFn(MACOS),
        'probe_telegram_token "123456:SECRETTOKENVALUE"',
        'echo "PROBE_DONE rc=$?"',
      ].join('\n'),
    )
    return execFileSync('bash', [script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf-8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('probe_telegram_token -- functional, through the real shell function', () => {
  it('says INVALID in human language when getMe rejects, and still completes', () => {
    const out = runProbe({ getMe: '{"ok":false,"error_code":401}' })
    expect(out).toContain('WARN:')
    expect(out).toContain('ERVENYTELEN')
    expect(out).toContain('BotFather')
    expect(out).toContain('PROBE_DONE rc=0')
    expect(out).not.toContain('SECRETTOKENVALUE')
  })

  it('names the webhook state with the deleteWebhook remedy', () => {
    const out = runProbe({
      getMe: '{"ok":true,"result":{"username":"x_bot"}}',
      webhook: '{"ok":true,"result":{"url":"https://old.example/hook"}}',
    })
    expect(out).toContain('WEBHOOK')
    expect(out).toContain('deleteWebhook')
    expect(out).toContain('PROBE_DONE rc=0')
    expect(out).not.toContain('SECRETTOKENVALUE')
  })

  it('names the competing-poller state on getUpdates 409 with the stop-or-new-bot remedy', () => {
    const out = runProbe({ getMe: '{"ok":true,"result":{"username":"x_bot"}}', updatesStatus: '409' })
    expect(out).toContain('409')
    expect(out).toContain('BotFather')
    expect(out).toContain('PROBE_DONE rc=0')
  })

  it('stays SILENT on a free token', () => {
    const out = runProbe({ getMe: '{"ok":true,"result":{"username":"x_bot"}}' })
    expect(out).not.toContain('WARN:')
    expect(out).toContain('PROBE_DONE rc=0')
  })

  it('is advisory: a failing curl neither warns nor aborts the set -e installer', () => {
    const out = runProbe({ getMe: '', curlFails: true })
    expect(out).not.toContain('WARN:')
    expect(out).toContain('PROBE_DONE rc=0')
  })
})

describe('both installers wire the probe after the telegram token prompt', () => {
  it.each([
    ['install-macos.sh', MACOS],
    ['install-linux.sh', LINUX],
  ])('%s defines the probe and calls it right after the prompt', (_name, src) => {
    expect(src).toContain('probe_telegram_token() {')
    const promptIdx = src.indexOf('prompt_telegram_token)" BOT_TOKEN')
    expect(promptIdx).toBeGreaterThan(-1)
    const after = src.slice(promptIdx, promptIdx + 200)
    expect(after).toContain('probe_telegram_token "$BOT_TOKEN"')
  })

  it.each([
    ['install-macos.sh', MACOS],
    ['install-linux.sh', LINUX],
  ])('%s never prints the token value in the probe messages', (_name, src) => {
    const fn = sliceProbeFn(src)
    // No echo/printf line inside the probe may interpolate the token variable.
    for (const line of fn.split('\n')) {
      if (/echo|printf/.test(line) && !/curl/.test(line)) {
        expect(line).not.toContain('$_ptt_t')
        expect(line).not.toContain('${_ptt_t}')
      }
    }
  })
})
