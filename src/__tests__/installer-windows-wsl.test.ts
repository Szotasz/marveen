import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Installer defects hit by a real Windows + WSL2 install (2026-08-21), each one
// pinned here so it cannot come back unnoticed.
const ps1 = readFileSync('install-windows.ps1', 'utf-8')
const linux = readFileSync('install-linux.sh', 'utf-8')

describe('install-windows.ps1 hands the install to install-linux.sh', () => {
  // Multi-line here-strings passed to `wsl bash -c` arrive broken three ways
  // (CR on every line, embedded double quotes stripped, bash `$VAR`s expanded
  // by PowerShell), and bash's exit code was never checked.
  it('passes no here-string to wsl', () => {
    expect(ps1).not.toMatch(/wsl[^\n]*@"/)
  })

  it('every wsl bash -c string has no $ and no embedded double quote', () => {
    const calls = [...ps1.matchAll(/^\s*wsl\b[^\n]*bash -c "([^"\n]*)"/gm)]
    expect(calls.length).toBeGreaterThan(0)
    for (const [, body] of calls) {
      expect(body).not.toContain('$')
    }
  })

  // The WEB_PORT line's `\"` made Windows PowerShell 5.1 refuse to PARSE the
  // file (9 parse errors, "The token '&&' is not a valid statement separator").
  it('contains no backslash-escaped double quote (not an escape in PowerShell)', () => {
    expect(ps1).not.toContain('\\"')
  })

  it('checks the exit code of the handoff', () => {
    expect(ps1).toMatch(/install-linux\.sh[^\n]*\r?\n\s*if \(\$LASTEXITCODE -eq 0\)/)
  })
})

describe('install-linux.sh on WSL', () => {
  // The token prompt accepted any paste -- typically the browser's one-time
  // code -- and wrote it into ~/.bashrc and .env as the token.
  it('shape-checks the OAuth token before it is written anywhere', () => {
    const prompt = linux.indexOf('read -p "  OAuth token: "')
    // SECSZIVEK1007: the token no longer goes into an rc file; its first write
    // is the .env line for the services.
    const rcWrite = linux.indexOf('CLAUDE_AUTH_ENV_LINE="CLAUDE_CODE_OAUTH_TOKEN=${OAUTH_TOKEN_INPUT}"')
    const check = linux.indexOf("grep -Eq '^sk-ant-oat01-", prompt)
    expect(prompt).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(prompt)
    expect(check).toBeLessThan(rcWrite)
  })

  it('the token loop keeps a real token and rejects a browser code', () => {
    const start = linux.indexOf('    OAUTH_TOKEN_INPUT=""\n    for _try in 1 2 3; do')
    const end = linux.indexOf('    unset _tok _try', start)
    expect(start).toBeGreaterThan(0)
    const loop = linux.slice(start, end)
    const run = (input: string) =>
      execFileSync('bash', ['-c', `warn(){ :; }\n${loop}\nprintf '%s' "$OAUTH_TOKEN_INPUT"`], {
        input,
        encoding: 'utf-8',
      })
    const tok = 'sk-ant-oat01-' + 'A'.repeat(60)
    expect(run(`abcDEF123#xyz\n${tok}  \n`)).toBe(tok)
    expect(run('x\ny\nz\n')).toBe('')
    expect(run('\n')).toBe('')
  })

  // SECSZIVEK1007: set_export_in_rc (which wrote the token into ~/.bashrc) is
  // gone; installer-no-secret-in-rc.test.ts covers the cleanup that replaced it.

  // WSLg exports DISPLAY, which made Enter mean "skip sign-in" on every WSL box.
  it('treats WSL as headless for the auth default', () => {
    expect(linux).toMatch(/if \[ "\$IS_WSL" = "true" \]; then\n\s*IS_HEADLESS=true/)
  })

  // The no-systemd branch had its own nohup lines with no running-instance
  // check: re-running the installer started a second poller on the same token.
  it('no-systemd launch goes through the idempotent start.sh', () => {
    const branch = linux.slice(linux.indexOf('systemd --user nem elerheto'))
    const end = branch.indexOf('Ujrainditas kesobb')
    const body = branch.slice(0, end)
    expect(body).toContain('scripts/start.sh')
    expect(body).not.toMatch(/nohup .*channels\.sh/)
  })

  it('does not claim a channel restart it did not do', () => {
    expect(linux).not.toMatch(/restart "\$\{CHAN_UNIT\}" 2>\/dev\/null \|\| true\n\s*ok /)
  })
})
