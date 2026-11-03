// The helper path in a recipe is ONE shell word. The sub-agent
// federation block and a strict agent's recipes name scripts/marveen-api.sh by its absolute path; with a
// space in PROJECT_ROOT the unquoted path split in two and `bash` was handed a path that does not exist.
// The path is quoted only when it needs it (shellWord), so on a usual root the recipe stays byte for byte
// what it was and the profile allow-list prefix `Bash(bash ${PROJECT_ROOT}/scripts/marveen-api.sh:*)`
// keeps matching (strict-profile-api-recipes.test.ts pins that side on a root without a space).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen helper root-'))
cpSync(join(REPO, 'templates', 'profiles'), join(tmpRoot, 'templates', 'profiles'), { recursive: true })

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  HEARTBEAT_AGENT_ID: 'heartbeat',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
  mainAgentRecipientLedgerEnabled: () => false,
}))
vi.mock('../web/agent-config.js', () => {
  const dir = (n: string) => join(tmpRoot, 'agents', n)
  const readFileOr = (p: string, d: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : d)
  return {
    agentDir: dir,
    agentConfigRoot: () => join(tmpRoot, 'agents'),
    listAgentNames: () => ['strict-a'],
    readAgentCapabilities: () => [],
    readAgentToolDeny: () => [],
    readFileOr,
    readJsonObjectForWrite: (p: string) => JSON.parse(readFileOr(p, '{}')),
    readAgentSecurityProfile: (n: string) => {
      try {
        return JSON.parse(readFileSync(join(dir(n), 'agent-config.json'), 'utf-8')).securityProfile || 'default'
      } catch {
        return 'default'
      }
    },
  }
})
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: () => '' }))
vi.mock('../agent.js', () => ({ runAgent: async () => ({ text: '# generated body' }) }))

const S = await import('../web/agent-scaffold.js')
const { renderSubAgentFederationBlock } = await import('../web/federation/onboarding.js')
const { shellWord } = await import('../web/sanitize.js')

const HELPER = join(tmpRoot, 'scripts', 'marveen-api.sh')

// The words a POSIX shell makes of one command line, for the forms a recipe uses: bare words,
// '...' and "..." (with \ escapes inside "..." and outside quotes). Enough to tell one word from two.
function words(line: string): string[] {
  const out: string[] = []
  let cur: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      cur = (cur ?? '') + line.slice(i + 1, end < 0 ? undefined : end)
      if (end < 0) break // an unclosed quote: the rest is one word, as far as this check goes
      i = end
    } else if (c === '"') {
      cur = cur ?? ''
      for (i++; i < line.length && line[i] !== '"'; i++) cur += line[i] === '\\' ? line[++i] : line[i]
    } else if (c === '\\') {
      cur = (cur ?? '') + line[++i]
    } else if (/\s/.test(c)) {
      if (cur !== null) out.push(cur)
      cur = null
    } else {
      cur = (cur ?? '') + c
    }
  }
  if (cur !== null) out.push(cur)
  return out
}

function helperLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('bash ') && l.includes('marveen-api.sh'))
}

describe('helper path as one shell word (F2)', () => {
  it('the test root really has a space', () => {
    expect(tmpRoot).toContain(' ')
  })

  it('shellWord leaves a plain path byte for byte and single-quotes one with a space or a quote', () => {
    expect(shellWord('/opt/marveen-1.2/scripts/marveen-api.sh')).toBe('/opt/marveen-1.2/scripts/marveen-api.sh')
    expect(shellWord('/a b/scripts/marveen-api.sh')).toBe("'/a b/scripts/marveen-api.sh'")
    expect(words(`bash ${shellWord("/it's here/x.sh")} message`)).toEqual(['bash', "/it's here/x.sh", 'message'])
  })

  it('shellWord leaves an accented path alone, composed (NFC) and decomposed (NFD), and a tilde inside it', () => {
    const nfc = '/home/j\u00f3zsi/marveen/scripts/marveen-api.sh'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc) // the combining accent really is a separate character
    expect(shellWord(nfc)).toBe(nfc)
    expect(shellWord(nfd)).toBe(nfd)
    expect(shellWord('/home/a~b/scripts/marveen-api.sh')).toBe('/home/a~b/scripts/marveen-api.sh')
    expect(shellWord('~/x.sh')).toBe("'~/x.sh'") // a LEADING tilde the shell would expand: quoted
  })

  for (const lang of ['hu', 'en'] as const) {
    it(`federation sub-agent block (${lang}): the message recipe runs the helper by its whole path`, () => {
      const block = renderSubAgentFederationBlock({ botName: 'Arthur', mainAgentId: 'arthur', webPort: 3420, lang })
      const lines = helperLines(block)
      expect(lines.length).toBeGreaterThanOrEqual(1)
      for (const l of lines) expect(words(l).slice(0, 3)).toEqual(['bash', HELPER, 'message'])
    })
  }

  it('strict agent: every helper recipe line runs the helper by its whole path', () => {
    const dir = join(tmpRoot, 'agents', 'strict-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ securityProfile: 'developer-junior' }), 'utf-8')
    writeFileSync(join(dir, 'CLAUDE.md'), '# strict-a\n', 'utf-8')
    S.ensureAutonomySection('strict-a')
    S.ensureStrictApiSection('strict-a')
    const lines = helperLines(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8'))
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const l of lines) expect(words(l).slice(0, 2)).toEqual(['bash', HELPER])
  })
})
