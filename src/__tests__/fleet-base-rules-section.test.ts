// The fleet base rules block of a package agent's CLAUDE.md (MIOAGENTINSTALL1114, PR-I3; plan 4.3 addendum (4) and
// (6), mutant 46).
//
// A package cannot carry the unknown-sender rule and the eight fleet rules (they name this install's main agent, its
// owner and the agent's token path), so the installer writes them rendered between markers and
// ensureFleetBaseRulesSection keeps them current on every start. Pinned here:
//  - the rendered block has no placeholder left, and carries the agent's own name and its CURRENT token path;
//  - a hand-made agent's CLAUDE.md (no markers, no manifest) is byte for byte unchanged (mutant 46);
//  - a package agent that lost the block gets it back, right after the shell prefix;
//  - a block that stands is replaced in place, and a second run changes nothing.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-fleet-base-rules-section-'))
process.env.CLAUDECLAW_ENV_DIR = tmpRoot

const tokens = { on: '1' }
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    STORE_DIR: join(tmpRoot, 'store'),
    PROJECT_ROOT: tmpRoot,
    OWNER_NAME: 'TestOwner',
    MAIN_AGENT_ID: 'agent-a',
    BOT_NAME: 'Botty',
    CHANNEL_PROVIDER: 'telegram',
    WEB_PORT: 3420,
    OWNER_DRIVE_FOLDER: '',
    DASHBOARD_PUBLIC_URL: '',
    AGENT_API_ORIGIN: '',
    APP_TZ: 'Europe/Budapest',
    mainAgentRecipientLedgerEnabled: () => false,
  }
})
vi.mock('../settings-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../settings-store.js')>()
  return { ...real, getEffectiveSettingValue: (key: string) => (key === 'AGENT_TOKENS' ? tokens.on : real.getEffectiveSettingValue(key)) }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    agentDir: (name: string) => join(tmpRoot, 'agents', name),
    agentConfigRoot: () => join(tmpRoot, 'agents'),
    listAgentNames: () => ['pkg', 'hand'],
    readAgentCapabilities: () => [],
  }
})
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

mkdirSync(join(tmpRoot, 'templates', 'profiles'), { recursive: true })
for (const f of readdirSync(join(__dirname, '..', '..', 'templates', 'profiles'))) {
  copyFileSync(join(__dirname, '..', '..', 'templates', 'profiles', f), join(tmpRoot, 'templates', 'profiles', f))
}

const sc = await import('../web/agent-scaffold.js')
const { PACKAGE_SHELL_PREFIX_TEXT, startsWithPackageShell } = await import('../web/agent-package/marker.js')

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

const dir = (n: string) => join(tmpRoot, 'agents', n)
const claudeMd = (n: string) => join(dir(n), 'CLAUDE.md')
function stage(n: string, text: string, manifest: boolean, ownToken: boolean): void {
  rmSync(dir(n), { recursive: true, force: true })
  mkdirSync(join(dir(n), '.claude'), { recursive: true })
  writeFileSync(claudeMd(n), text, 'utf-8')
  if (manifest) {
    mkdirSync(join(dir(n), '.package'), { recursive: true })
    writeFileSync(join(dir(n), '.package', 'manifest.json'), '{"schema":1}\n', 'utf-8')
  }
  if (ownToken) writeFileSync(join(dir(n), '.dashboard-token'), 'c'.repeat(64), { mode: 0o600 })
  // The curl recipes (the settings deny the helper), so the token path is written into the rules.
  writeFileSync(join(dir(n), '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(bash:*)'] } }), 'utf-8')
}

describe('renderFleetBaseRules (plan 4.3 addendum (6))', () => {
  for (const lang of ['hu', 'en'] as const) {
    it(`${lang}: no placeholder left; the agent's own name and its current token path stand in it`, () => {
      stage('pkg', PACKAGE_SHELL_PREFIX_TEXT, true, true)
      const out = sc.renderFleetBaseRules({ agentName: 'pkg', lang, helper: false, tokenPath: join(dir('pkg'), '.dashboard-token'), driveFolder: '' })
      expect(out).not.toContain('AGENT_NAME')
      expect(out).toContain('"from":"pkg"')
      expect(out).toContain(join(dir('pkg'), '.dashboard-token'))
      expect(out).toContain('agent-a')
      expect(out).toContain('TestOwner')
      const helper = sc.renderFleetBaseRules({ agentName: 'pkg', lang, helper: true, tokenPath: join(dir('pkg'), '.dashboard-token'), driveFolder: 'D1' })
      expect(helper).not.toContain('AGENT_NAME')
      expect(helper).toContain('message pkg agent-a')
      expect(helper).toContain('drive/folders/D1')
    })
  }
})

describe('ensureFleetBaseRulesSection (plan 4.3 addendum (4), mutant 46)', () => {
  it('a hand-made agent (no markers, no manifest) is not touched, byte for byte', () => {
    const body = '# Hand\n\nA hand-written body.\n\n## Új ismeretlen sender első üzenete (ARANYSZABÁLY)\n\nThe LLM wrote it.\n'
    stage('hand', body, false, false)
    sc.ensureFleetBaseRulesSection('hand', '')
    expect(readFileSync(claudeMd('hand'), 'utf-8')).toBe(body)
  })

  it('a package agent that lost the block gets it back right after the shell prefix; the prefix stays first', () => {
    stage('pkg', PACKAGE_SHELL_PREFIX_TEXT + '\nOwner notes.\n', true, true)
    sc.ensureFleetBaseRulesSection('pkg', '')
    const text = readFileSync(claudeMd('pkg'), 'utf-8')
    expect(startsWithPackageShell(Buffer.from(text))).toBe(true)
    expect(text.startsWith(PACKAGE_SHELL_PREFIX_TEXT + '\n' + sc.FLEET_BASE_RULES_BEGIN + '\n')).toBe(true)
    expect(text).toContain(sc.FLEET_BASE_RULES_END + '\n\nOwner notes.\n')
    expect(text).toContain(join(dir('pkg'), '.dashboard-token'))
    expect(text).not.toContain('AGENT_NAME')
  })

  it('a standing block is re-rendered in place (the token path follows), and a second run changes nothing', () => {
    const stale = `${sc.FLEET_BASE_RULES_BEGIN}\nold text /old/token/path\n${sc.FLEET_BASE_RULES_END}`
    stage('pkg', PACKAGE_SHELL_PREFIX_TEXT + '\n' + stale + '\n\nTail.\n', true, true)
    sc.ensureFleetBaseRulesSection('pkg', '')
    const once = readFileSync(claudeMd('pkg'), 'utf-8')
    expect(once).not.toContain('/old/token/path')
    expect(once).toContain(join(dir('pkg'), '.dashboard-token'))
    expect(once.endsWith(sc.FLEET_BASE_RULES_END + '\n\nTail.\n')).toBe(true)
    expect(once.split(sc.FLEET_BASE_RULES_BEGIN).length).toBe(2)
    sc.ensureFleetBaseRulesSection('pkg', '')
    expect(readFileSync(claudeMd('pkg'), 'utf-8')).toBe(once)
  })

  it('markers in a hand-made agent are kept current too (the block is the generator\'s, wherever it stands)', () => {
    const body = `# Hand\n\n${sc.FLEET_BASE_RULES_BEGIN}\nx\n${sc.FLEET_BASE_RULES_END}\n`
    stage('hand', body, false, false)
    sc.ensureFleetBaseRulesSection('hand', '')
    const text = readFileSync(claudeMd('hand'), 'utf-8')
    expect(text.startsWith('# Hand\n\n' + sc.FLEET_BASE_RULES_BEGIN + '\n')).toBe(true)
    expect(text).not.toContain('\nx\n')
  })
})
