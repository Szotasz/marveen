// GROMZONOPROVIDER1108 A2: the installers know CHANNEL_PROVIDER=gromzo. The REAL blocks of install-linux.sh and
// install-macos.sh are sliced and run: the channel choice (4 or the name `gromzo` -> gromzo; 1/2/3 and the default as
// before) and the bun-install step (Bun is fetched only for telegram/discord; a gromzo or slack install never calls the
// Bun installer). install-lang.sh's OLD prompt keys are pinned byte for byte: an already released Bridge's vendored
// installer fetches this file from main and still asks with them (Samu 73580).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(__dirname, '..', '..')
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const between = (text: string, from: string, to: string): string => {
  const a = text.indexOf(from)
  const b = text.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`slice not found: ${from.slice(0, 50)}`)
  return text.slice(a, b + to.length)
}
// Installer code never runs on the host for real (Samu 69664): a slice is EXECUTED here only after it is proven inert.
// It must end where intended and name no system-changing command except the ones the harness stubs (_install_bun,
// pkg_install_noninteractive, ensure_in_rc). The check runs BEFORE the spawn, so a non-inert slice never runs.
const SYSTEM_CHANGING = /\b(sudo|dscl|dseditgroup|launchctl|systemctl|useradd|chown|chmod|curl|wget|rm|mv|cp|ln|install|npm|claude|apt-get|brew|mkdir|touch|tee|eval|bash|sh|exec|source)\b/
// a redirection that writes somewhere (after dropping the harmless /dev/null and fd-duplication forms)
const WRITES = (code: string) => /[^<]>/.test(code.replace(/&?[0-9]?>>?\s*\/dev\/null/g, '').replace(/[0-9]?>&[0-9-]/g, ''))
// an echo/ok line is skipped only when it is ONE plain command: a `;`, `&&`, `||` or `|` after it is code (Dani 73629)
const PLAIN_MESSAGE = /^\s*(?:echo|ok)\b[^;&|]*$/
const STUBBED = /^\s*(_install_bun|pkg_install_noninteractive|ensure_in_rc)\b.*$/gm
const inertProblem = (slice: string, endsWith: string): string | null => {
  if (!slice.endsWith(endsWith)) return `the slice does not end at ${JSON.stringify(endsWith)}`
  const code = slice.replace(STUBBED, '').split('\n')
    .filter((l) => !l.trimStart().startsWith('#') && !PLAIN_MESSAGE.test(l) && !/^\s*INSTALL_STEP="[a-z-]+"$/.test(l)).join('\n')
  const m = code.match(SYSTEM_CHANGING)
  if (m) return `the slice names a system-changing command: ${m[0]}`
  return WRITES(code) ? 'the slice writes through a redirection' : null
}
// install-lang.sh is function definitions only at top level (no statement runs on source); _t is a pure echo.
const sourceLangOnly = (script: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
const runInert = (slice: string, endsWith: string, script: string) => {
  const problem = inertProblem(slice, endsWith)
  if (problem) throw new Error(`refusing to run an installer slice on the host: ${problem}`)
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
}
it('the inert check bites (positive controls), so nothing below runs an unchecked slice', () => {
  expect(inertProblem('x\n  ln -sf a b\nesac', '\nesac')).toMatch(/ln/)
  expect(inertProblem('x\n  echo hi; sudo true\nesac', '\nesac')).toMatch(/sudo/)
  expect(inertProblem('x\n  ok "x" && mkdir d\nesac', '\nesac')).toMatch(/mkdir/)
  expect(inertProblem('x\n  printf x >"$HOME/f"\nesac', '\nesac')).toMatch(/redirection/)
  expect(inertProblem('x\n  command -v bun &>/dev/null || y=1\nesac', '\nesac')).toBeNull()
  expect(inertProblem('x\nfi\nmore', '\nfi')).toMatch(/does not end/)
  expect(() => runInert('x\n  sudo true\nfi', '\nfi', 'true')).toThrow(/refusing/)
})

for (const file of ['install-linux.sh', 'install-macos.sh']) {
  describe(`${file}: the channel choice`, () => {
    const text = src(file)
    const MAP = between(text, 'PROVIDER_CHOICE=${PROVIDER_CHOICE:-1}\nif [ "$PROVIDER_CHOICE" = "2" ]; then', '\nfi')
    const choose = (v: string) => runInert(MAP, '\nfi', `PROVIDER_CHOICE='${v}'\n${MAP}\nprintf '%s' "$CHANNEL_PROVIDER"`).stdout
    it('the executed slice is inert (only variable assignments, ends at its own fi)', () => expect(inertProblem(MAP, '\nfi')).toBeNull())
    it('4 and the name "gromzo" give gromzo; 1/2/3, empty and an unknown value as before', () => {
      expect(choose('4')).toBe('gromzo')
      expect(choose('gromzo')).toBe('gromzo')
      expect(choose('1')).toBe('telegram')
      expect(choose('')).toBe('telegram')
      expect(choose('2')).toBe('slack')
      expect(choose('3')).toBe('discord')
      expect(choose('9')).toBe('telegram') // interactive default kept (the headless STOP is the Bridge derive's, A3)
    })
    it('the menu shows option 4 and asks with the NEW 4-option prompt key (5-option on Linux since EE2392D3)', () => {
      expect(text).toContain('echo -e "  ${BOLD}4.${NC} $(_t channel_option_gromzo)"')
      const key = file === 'install-linux.sh' ? 'prompt_channel_select5' : 'prompt_channel_select4'
      expect(text).toContain(`read -rp "$(_t ${key})" PROVIDER_CHOICE`)
    })
  })

  describe(`${file}: the bun-install step`, () => {
    const text = src(file)
    const STEP = between(text, 'INSTALL_STEP="bun-install"\n', '\nesac')
    const run = (provider: string) => runInert(STEP, '\nesac', [
      'ok() { echo "ok: $*"; }', 'ensure_in_rc() { :; }', 'pkg_install_noninteractive() { :; }', '_t() { echo "$1"; }',
      'ORANGE="" NC=""',
      '_install_bun() { echo "BUN-INSTALL-CALLED"; }',
      // no bun on this PATH, so a Bun channel must call the installer
      `CHANNEL_PROVIDER='${provider}'`,
      'command() { if [ "$1" = "-v" ] && [ "$2" = "bun" ]; then return 1; fi; builtin command "$@"; }',
      STEP,
    ].join('\n')).stdout
    it('the executed slice ends at its own esac and calls nothing system-changing the harness does not stub', () => {
      expect(inertProblem(STEP, '\nesac')).toBeNull()
    })
    it('telegram and discord fetch Bun; gromzo and slack never call the Bun installer', () => {
      expect(run('telegram')).toContain('BUN-INSTALL-CALLED')
      expect(run('discord')).toContain('BUN-INSTALL-CALLED')
      expect(run('gromzo')).not.toContain('BUN-INSTALL-CALLED')
      expect(run('gromzo')).toContain('ok: Bun nem kell (gromzo')
      expect(run('slack')).not.toContain('BUN-INSTALL-CALLED')
    })
  })

  describe(`${file}: gromzo never falls into the Slack branches`, () => {
    const text = src(file)
    it('no empty ~/.claude/channels/gromzo: the channel dir is made for every provider but gromzo (Dani 73629)', () => {
      expect(text).toContain('CHANNEL_DIR="$HOME/.claude/channels/$CHANNEL_PROVIDER"\n# GROMZONOPROVIDER1108: gromzo keeps no channel state here (no token, no access.json), so no empty dir for it.\n[ "$CHANNEL_PROVIDER" = "gromzo" ] || mkdir -p "$CHANNEL_DIR"\n')
      expect(text.match(/^mkdir -p "\$CHANNEL_DIR"$/gm)).toBeNull()
    })
    it('the token prompts, the .env keys, the plugin install and the plugin check each have a gromzo branch', () => {
      expect(text).toMatch(/elif \[ "\$CHANNEL_PROVIDER" = "gromzo" \]; then\n(?:\s*#[^\n]*\n)+  echo ""\n  echo -e "\$\{DIM\}  Az AI asszisztensed a Gromzo alkalmazason at/)
      expect(text).toContain('elif [ "$CHANNEL_PROVIDER" = "gromzo" ]; then\n  : # GROMZONOPROVIDER1108: no token keys')
      expect(text).toMatch(/if \[ "\$CHANNEL_PROVIDER" = "gromzo" \]; then\n  PLUGIN_ID=""\n/)
      expect(text).toMatch(/if \[ "\$CHANNEL_PROVIDER" = "gromzo" \]; then\n  ok "Gromzo: a csatorna-plugint a Bridge Gromzo-lepese ellenorzi"\nelif ! claude plugin list/)
    })
  })
}

describe('install-lang.sh: the old prompt keys are unchanged, byte for byte (released Bridges still use them)', () => {
  const lang = src('install-lang.sh')
  it('the 3-option prompts', () => {
    for (const line of [
      '    en:prompt_channel_select_macos) echo "  Choose (1/2/3) [1]: " ;;',
      '    hu:prompt_channel_select_macos) echo "  Válassz (1/2/3) [1]: " ;;',
      '    en:prompt_channel_select_linux) echo "  Choose (1/2/3) [1]: " ;;',
      '    hu:prompt_channel_select_linux) echo "  Válassz (1/2/3) [1]: " ;;',
    ]) expect(lang.split('\n')).toContain(line)
  })
  it('the new keys answer in both languages', () => {
    const t = (lng: string, key: string) => sourceLangOnly(`. '${join(ROOT, 'install-lang.sh')}' >/dev/null 2>&1; INSTALL_LANG=${lng}; MARVEEN_LANG=${lng}; _t ${key}`).stdout
    expect(t('en', 'prompt_channel_select4')).toContain('Choose (1/2/3/4) [1]:')
    expect(t('hu', 'prompt_channel_select4')).toContain('Válassz (1/2/3/4) [1]:')
    expect(t('hu', 'channel_option_gromzo')).toContain('Gromzo')
  })
})
