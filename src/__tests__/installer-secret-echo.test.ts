// AUTHSHHIDDEN1122 (customer request, support #162): a token or key typed at an installer prompt was echoed, so it
// showed on the screen and in a screen recording. scripts/auth.sh now reads both with `read -rsp`. The installers keep
// their plain `read -rp` / `read -p` lines, because the Bridge's headless derive (marveen-bridge-installer,
// derive-headless.mjs) wraps exactly that shape and stops on a `read -rsp`; there the terminal echo is switched off
// around the read instead (_secret_echo_off / _secret_echo_on, the Teams app password's pattern, EE2392D3).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(__dirname, '..', '..')
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const between = (text: string, from: string, to: string): string => {
  const a = text.indexOf(from)
  const b = text.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`slice not found: ${from.slice(0, 60)}`)
  return text.slice(a, b + to.length)
}
const bash = (script: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })

const SECRET_READS: Record<string, string[]> = {
  'install-linux.sh': [
    'read -p "  ANTHROPIC_API_KEY (sk-ant-...): " ANTHROPIC_API_KEY_INPUT',
    'read -p "  OAuth token: " OAUTH_TOKEN_INPUT',
    'read -rp "$(_t prompt_telegram_token)" BOT_TOKEN',
    'read -rp "$(_t prompt_discord_bot_token)" DISCORD_BOT_TOKEN',
    'read -rp "$(_t prompt_slack_bot_token)" SLACK_BOT_TOKEN',
    'read -rp "$(_t prompt_slack_app_token)" SLACK_APP_TOKEN',
  ],
  'install-macos.sh': [
    'read -rp "  OAuth token: " MACOS_OAUTH_TOKEN_INPUT',
    'read -rp "$(_t prompt_telegram_token)" BOT_TOKEN',
    'read -rp "$(_t prompt_discord_bot_token)" DISCORD_BOT_TOKEN',
    'read -rp "$(_t prompt_slack_bot_token)" SLACK_BOT_TOKEN',
    'read -rp "$(_t prompt_slack_app_token)" SLACK_APP_TOKEN',
  ],
}

for (const [file, reads] of Object.entries(SECRET_READS)) {
  const SCRIPT = read(file)
  const LINES = SCRIPT.split('\n')
  const HELPERS = between(SCRIPT, '_secret_tty() {', '  echo ""\n}\n')

  describe(`${file}: secrets are typed without echo`, () => {
    it('every secret read keeps its plain shape and sits between _secret_echo_off and _secret_echo_on', () => {
      for (const r of reads) {
        const i = LINES.findIndex((l) => l.trim() === r)
        expect(i, r).toBeGreaterThan(0)
        // off right before the read, or before the `ni_answer ... ||` line that leads into it
        const off = LINES[i - 1].trim() === '_secret_echo_off' || (LINES[i - 1].trim().startsWith('ni_answer ') && LINES[i - 2].trim() === '_secret_echo_off')
        expect(off, `${r}: _secret_echo_off before`).toBe(true)
        expect(LINES[i + 1].trim(), `${r}: _secret_echo_on after`).toBe('_secret_echo_on')
        expect(r, 'no -s: the Bridge derive stops on it').not.toMatch(/read -\w*s\w* /)
      }
    })

    it('the assistant name is not a secret: its read is not wrapped', () => {
      const i = LINES.findIndex((l) => l.trim() === 'read -rp "$(_t prompt_bot_name)" BOT_NAME')
      expect(i).toBeGreaterThan(0)
      expect(LINES[i - 1].trim()).not.toBe('_secret_echo_off')
    })

    it('on a terminal: echo off, the read, echo on, a new line; the earlier EXIT trap is back afterwards', () => {
      const r = bash([
        'stty() { echo "stty $*"; }',
        'read() { local v="${@: -1}"; printf -v "$v" "%s" "sk-secret"; echo "asked: $v"; }',
        HELPERS,
        '_secret_tty() { return 0; }',
        "trap 'echo PREVIOUS-EXIT-TRAP' EXIT",
        '_secret_echo_off', 'read -rp "x" TOK', '_secret_echo_on',
        'echo "trap now: $(trap -p EXIT)"',
      ].join('\n'))
      const lines = r.stdout.split('\n')
      expect(lines.filter((l) => /^(asked|stty)/.test(l))).toEqual(['stty -echo', 'asked: TOK', 'stty echo'])
      expect(r.stdout).toContain("trap now: trap -- 'echo PREVIOUS-EXIT-TRAP' EXIT")
      expect(lines.filter((l) => l === 'PREVIOUS-EXIT-TRAP')).toHaveLength(1)
    })

    it('Ctrl+C during the read turns echo back on and stops with 130', () => {
      const r = bash([
        'stty() { echo "stty $*"; }',
        'read() { kill -INT $$; sleep 1; }',
        HELPERS,
        '_secret_tty() { return 0; }',
        "trap 'echo PREVIOUS-EXIT-TRAP' EXIT",
        '_secret_echo_off', 'read -rp "x" TOK', '_secret_echo_on', 'echo NOT-REACHED',
      ].join('\n'))
      expect(r.status).toBe(130)
      expect(r.stdout.split('\n').filter((l) => l.startsWith('stty'))).toEqual(['stty -echo', 'stty echo'])
      expect(r.stdout).toContain('PREVIOUS-EXIT-TRAP')
      expect(r.stdout).not.toContain('NOT-REACHED')
    })

    it('without a terminal (a headless or piped run) nothing touches stty or the traps', () => {
      const r = bash([
        'stty() { echo "stty $*"; }',
        HELPERS,
        '_secret_tty() { return 1; }',
        "trap 'echo PREVIOUS-EXIT-TRAP' EXIT",
        '_secret_echo_off', '_secret_echo_on', 'echo "trap now: $(trap -p EXIT)"',
      ].join('\n'))
      expect(r.stdout).not.toContain('stty')
      expect(r.stdout).toContain("trap now: trap -- 'echo PREVIOUS-EXIT-TRAP' EXIT")
    })
  })
}

describe('scripts/auth.sh: the key and the token are read without echo', () => {
  const AUTH = read('scripts/auth.sh')
  it('both secret prompts use read -rsp and end the line with an echo; the menu choice stays visible', () => {
    expect(AUTH).toContain('read -rsp "  ANTHROPIC_API_KEY (sk-ant-...): " AUTH_VAL\n  echo ""')
    expect(AUTH).toContain('read -rsp "  OAuth token (sk-ant-oat01-...): " AUTH_VAL\n  echo ""')
    expect(AUTH).not.toMatch(/read -rp "[^"]*(ANTHROPIC_API_KEY|OAuth token)/)
    expect(AUTH).toContain('read -rp "  Valasztas [1]: " MODE')
  })
})
