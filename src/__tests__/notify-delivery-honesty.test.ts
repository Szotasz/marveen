import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// NOTIFYVAK826: notify.sh is the fleet's FALLBACK channel -- it fires exactly
// when the primary Telegram plugin is down. Until this fix it discarded curl's
// output and exit code and always printed success, so a dead fallback was
// indistinguishable from a delivered alert. These tests run the real script
// with a PATH-stubbed curl (nothing leaves the machine) and pin the contract:
// success ONLY on curl exit 0 + Bot API "ok":true; every failure mode exits
// non-zero, keeps the success line off stdout, and never leaks the bot token.
const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'notify.sh')
const FAKE_TOKEN = '1234567890:TESTTOKENTESTTOKEN'

let stage: string

// The script resolves .env relative to its own location, so stage a full copy
// of the script one level below a temp root that carries the fake .env.
function stageScript(): { scriptCopy: string } {
  const scriptsDir = join(stage, 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  const scriptCopy = join(scriptsDir, 'notify.sh')
  execFileSync('/bin/cp', [SCRIPT, scriptCopy])
  writeFileSync(join(stage, '.env'), `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\nALLOWED_CHAT_ID=42\nMAIN_AGENT_ID=mainbot\n`)
  return { scriptCopy }
}

// A curl stub controlled per-case via env: CURL_STUB_EXIT + CURL_STUB_BODY.
// Failure bodies quote the request URL (token included) on purpose, to prove
// the script redacts it before echoing.
function writeCurlStub(dir: string): void {
  const stub = join(dir, 'curl')
  writeFileSync(stub, '#!/bin/bash\nif [ "${CURL_STUB_EXIT:-0}" -ne 0 ]; then\n  echo "curl: (6) Could not resolve host for https://api.telegram.org/bot${CURL_STUB_TOKEN}/sendMessage" >&2\n  exit "${CURL_STUB_EXIT}"\nfi\nprintf \'%s\' "${CURL_STUB_BODY}"\n')
  chmodSync(stub, 0o755)
}

function runNotify(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const { scriptCopy } = stageScript()
  const binDir = join(stage, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeCurlStub(binDir)
  const r = spawnSync('/bin/bash', [scriptCopy, 'probe message'], {
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      CURL_STUB_TOKEN: FAKE_TOKEN,
      // Keep the [TESZT] marker deterministic: vitest exports VITEST anyway.
      VITEST: '1',
      ...env,
    },
    encoding: 'utf-8',
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeAll(() => {
  stage = mkdtempSync(join(tmpdir(), 'notify-honesty-'))
})

afterAll(() => {
  rmSync(stage, { recursive: true, force: true })
})

describe('notify.sh delivery honesty (NOTIFYVAK826)', () => {
  it('reports success only when the Bot API says ok:true', () => {
    const r = runNotify({ CURL_STUB_BODY: '{"ok":true,"result":{"message_id":7}}' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Ertesites elkuldve.')
  })

  it('POSITIVE CONTROL: a transport failure must NOT report success', () => {
    const r = runNotify({ CURL_STUB_EXIT: '6' })
    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('Ertesites elkuldve.')
    expect(r.stderr).toContain('curl exit 6')
  })

  it('an HTTP-200 API rejection (ok:false) must NOT report success', () => {
    const r = runNotify({ CURL_STUB_BODY: '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}' })
    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('Ertesites elkuldve.')
    expect(r.stderr).toContain('chat not found')
  })

  it('never leaks the bot token into its error output', () => {
    const r = runNotify({ CURL_STUB_EXIT: '6' })
    expect(r.stderr).not.toContain(FAKE_TOKEN)
    expect(r.stderr).toContain('<token>')
  })
})
