import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ISSUE2490 (b1): after a reboot either LaunchAgent can be the one that creates the fleet's tmux server (the
// dashboard's worker session often wins), and a tmux server's global environment is its creator's. The channels
// plist carried TERM and LANG; the dashboard plist did not, so a dashboard-created server ran the whole fleet with
// neither (measured 2026-11-04 on the fleet host: dashboard plist env = HOME, PATH only from the template).
//
// The test renders the installer's two plist heredocs with bash (fixed inputs, the real template text) and reads
// each EnvironmentVariables dict; no plutil, so it runs on Linux CI too.

const ROOT = join(__dirname, '..', '..')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')

function heredoc(marker: string): string {
  const start = MACOS.indexOf(marker)
  expect(start, `${marker} in install-macos.sh`).toBeGreaterThan(-1)
  const bodyStart = MACOS.indexOf('\n', start) + 1
  const end = MACOS.indexOf('\nPLISTEOF\n', bodyStart)
  return MACOS.slice(bodyStart, end + 1)
}

/** The heredoc as bash expands it, with fixed inputs (LANG unset unless given). */
function render(body: string, lang?: string): string {
  const vars = ['DASHBOARD_PLIST=com.x.dashboard', 'CHANNELS_PLIST=com.x.channels', 'NODE_PATH=/n/node', 'NODE_BIN_DIR=/n',
    'INSTALL_DIR=/i', 'HOME=/h', 'USER=u']
  const script = `${vars.join('; ')}; ${lang === undefined ? 'unset LANG' : `LANG='${lang}'`}; cat <<PLISTEOF\n${body}PLISTEOF\n`
  return execFileSync('bash', ['-c', script], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
}

function envOf(plist: string): Record<string, string> {
  const m = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)
  expect(m, 'an EnvironmentVariables dict').not.toBeNull()
  const out: Record<string, string> = {}
  for (const kv of m![1].matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) out[kv[1]] = kv[2]
  return out
}

const DASH = heredoc('cat > "$PLIST_DIR/${DASHBOARD_PLIST}.plist" << PLISTEOF')
const CHAN = heredoc('cat > "$PLIST_DIR/${CHANNELS_PLIST}.plist" << PLISTEOF')

describe('ISSUE2490 (b1): the dashboard plist carries the channels plist TERM and LANG', () => {
  for (const lang of ['hu_HU.UTF-8', undefined]) {
    it(`same TERM and LANG in both plists (installer LANG ${lang ?? 'unset'})`, () => {
      const d = envOf(render(DASH, lang))
      const c = envOf(render(CHAN, lang))
      expect(d.TERM).toBe('xterm-256color')
      expect(d.LANG).toBe(lang ?? 'en_US.UTF-8')
      expect([d.TERM, d.LANG]).toEqual([c.TERM, c.LANG])
    })
  }

  it('the rest of the dashboard env is unchanged (PATH and HOME still there)', () => {
    const d = envOf(render(DASH, 'hu_HU.UTF-8'))
    expect(d.HOME).toBe('/h')
    expect(d.PATH.startsWith('/n:/h/.local/bin:')).toBe(true)
  })
})
