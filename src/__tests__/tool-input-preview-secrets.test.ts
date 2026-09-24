// #1533 review: the token-usage preview is a durable column the dashboard API
// returns, so every secret shape the redact misses lands in the DB. Each shape
// below (all made up) is checked on BOTH sides -- the TS port and the shipped
// Python hook -- because the parity test only proves the two agree, not that
// either of them redacts.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toolInputPreview } from '../web/tool-input-preview.js'

const PY_SCRIPT = join(__dirname, 'tool-input-preview-parity.py')

// [command, the secret that must not survive, a label that must survive]
const SHAPES: Array<[string, string, string]> = [
  ['export VALAMI_TOKEN="fakeTokenValue123456" && run', 'fakeTokenValue123456', 'VALAMI_TOKEN='],
  ["PGPASSWORD='fake pass 98765' psql -h db", 'fake pass', 'PGPASSWORD='],
  ['gh api --token fakeflagvalue12345 /user', 'fakeflagvalue12345', '--token'],
  ['deploy --github-token "fake quoted flag"', 'fake quoted flag', '--github-token'],
  ['SERVICE_KEY=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ ./deploy', 'eyJzdWIiOiJmYWtlIn0', 'SERVICE_KEY='],
  ['echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ', 'eyJzdWIiOiJmYWtlIn0', 'echo'],
  ['GH=gho_FAKEfakeFAKEfake1234 gh pr list', 'FAKEfakeFAKEfake1234', 'gh pr list'],
  ['X=ghs_FAKEfakeFAKEfake1234; Y=ghu_FAKEfakeFAKEfake5678', 'FAKEfakeFAKEfake', 'X='],
  ['echo github_pat_11FAKEFAKE_fakefakefakefake', 'fakefakefakefake', 'echo'],
  ['git clone https://x-access-token:fakeurlcred9876@github.com/o/r.git', 'fakeurlcred9876', '@github.com/o/r.git'],
  ['git clone https://fakeurltoken9876@github.com/o/r.git', 'fakeurltoken9876', 'https://'],
  ["curl -H 'Authorization: Basic ZmFrZTpmYWtlcGFzcw==' https://x.example.com", 'ZmFrZTpmYWtlcGFzcw', 'Authorization: Basic'],
  ['curl -d \'{"password": "fake json pw"}\' https://x.example.com', 'fake json pw', 'password'],
  ['supabase link --password fakepw123 && echo sbp_fakefakefakefake1234', 'fakepw123', '--password'],
  ['echo sbp_fakefakefakefake1234', 'fakefakefakefake1234', 'echo'],
  ['mysql -u root -pfakemysqlpw mydb', 'fakemysqlpw', 'mysql -u root'],
]

// Ordinary commands keep their useful parts (the preview exists to tell Bash
// calls apart; over-redaction would defeat it).
const KEEP: Array<[string, string]> = [
  ['mkdir -p /srv/app/logs', 'mkdir -p /srv/app/logs'],
  ['git log --author someone', 'git log --author someone'],
  ['ls -la /tmp', 'ls -la /tmp'],
]

function python(commands: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'preview-secrets-'))
  try {
    const fixture = join(dir, 'cases.json')
    writeFileSync(fixture, JSON.stringify(commands.map((command) => ({ toolName: 'Bash', input: { command } }))))
    const res = spawnSync('python3', [PY_SCRIPT], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, TOOL_INPUT_PREVIEW_FIXTURE: fixture },
    })
    if (res.status !== 0) throw new Error(`python3 failed: ${res.stderr}`)
    return JSON.parse(res.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('tool-input preview redacts every known secret shape (TS and Python)', () => {
  const py = python(SHAPES.map(([cmd]) => cmd))

  SHAPES.forEach(([cmd, secret, label], i) => {
    it(`redacts: ${label} (${i})`, () => {
      const ts = toolInputPreview('Bash', { command: cmd }) ?? ''
      for (const [side, out] of [['ts', ts], ['python', py[i]]] as const) {
        expect(out, side).not.toContain(secret)
        expect(out, side).toContain('[REDACTED]')
        expect(out, side).toContain(label)
      }
    })
  })

  it('leaves ordinary commands readable (no -p / --author over-redaction)', () => {
    const pyKeep = python(KEEP.map(([cmd]) => cmd))
    KEEP.forEach(([cmd, want], i) => {
      expect(toolInputPreview('Bash', { command: cmd })).toBe(want)
      expect(pyKeep[i]).toBe(want)
    })
  })
})
