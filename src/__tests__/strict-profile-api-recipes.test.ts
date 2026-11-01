// #2232: a strict-profile agent runs under `defaultMode: dontAsk`, where a command
// substitution never matches the allow-list. Every `curl ... -H "Authorization: Bearer
// $(cat <token>)"` recipe in its CLAUDE.md was therefore auto-denied, and the five generated
// blocks are rewritten on every start, so a hand fix did not survive. A strict agent now gets
// its recipes through scripts/marveen-api.sh. Since VOICETOKENLEAK1101 PR-A1 every other agent does too in the
// generated blocks (the curl recipe put the token value on its argv), unless its settings deny the helper.
//
// What is pinned here, on the files the generator really writes:
//   1. a strict agent's CLAUDE.md (all generated blocks, and the creation prompt) carries no
//      command substitution, no token header and no curl recipe;
//   2. every helper command line in it is one the allow-list entry matches, and names a verb the
//      helper knows;
//   3. a non-strict agent gets the helper recipes in the generated blocks (curl only where its settings deny the
//      helper, with a WARN), and the strict-api block never touches it;
//   4. the strict-api block goes away when the profile stops being strict;
//   5. the allow-list entry and the start-path wiring exist;
//   6. the skill section's proposal recipe follows the same choice (ensureSkillSectionCurrent).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, cpSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-strictapi-test-'))
// The real profile files, so "strict" is what templates/profiles/developer-junior.json says.
cpSync(join(REPO, 'templates', 'profiles'), join(tmpRoot, 'templates', 'profiles'), { recursive: true })
const captured: string[] = []

vi.mock('../config.js', () => ({
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
    listAgentNames: () => ['strict-a', 'plain-b'],
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
vi.mock('../agent.js', () => ({
  runAgent: async (prompt: string) => {
    captured.push(prompt)
    return { text: '# generated body' }
  },
}))

const S = await import('../web/agent-scaffold.js')
const { resolveProfilePlaceholders } = await import('../web/profiles.js')

const HELPER_CMD = `bash ${join(tmpRoot, 'scripts', 'marveen-api.sh')}`

function stageAgent(name: string, profile: string | null, claudeMd = `# ${name}\n`): string {
  const dir = join(tmpRoot, 'agents', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(profile ? { securityProfile: profile } : {}), 'utf-8')
  writeFileSync(join(dir, 'CLAUDE.md'), claudeMd, 'utf-8')
  return join(dir, 'CLAUDE.md')
}

// The start-path sequence for the blocks that carry an API recipe (agent-process.ts).
function startBlocks(name: string): string {
  const path = join(tmpRoot, 'agents', name, 'CLAUDE.md')
  S.ensureAutonomySection(name)
  S.ensureSystemDirectiveAuthSection(name)
  S.ensureAgentIdHeaderSection(name)
  S.ensureMemorySearchLabelSection(name)
  S.ensureMessageCloseSection(name)
  S.ensureStrictApiSection(name)
  return readFileSync(path, 'utf-8')
}

async function creation(name: string): Promise<{ prompt: string; out: string }> {
  captured.length = 0
  const out = await S.generateClaudeMd(name, 'desc', 'model')
  return { prompt: captured[0], out }
}

const BLOCK_TITLES = [
  '## Autonómia és jóváhagyás',
  '## Rendszer-direktíva hitelesítés',
  '## Ki hívta az API-t',
  '## Memória-keresés: a FEJLÉCET is olvasd el',
  '## Üzenet lezárása',
]

const helperVerbs = (() => {
  const py = readFileSync(join(REPO, 'scripts', 'lib', 'marveen_api.py'), 'utf-8')
  const usage = py.slice(py.indexOf('USAGE = """'), py.indexOf('"""', py.indexOf('USAGE = """') + 11))
  return new Set([...usage.matchAll(/^ {2}([a-z-]+) /gm)].map((m) => m[1]))
})()

function helperLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('bash ') && l.includes('marveen-api.sh'))
}

describe('agentRunsStrict', () => {
  it('follows the profile file: developer-junior is strict, default and sub-dev are not', () => {
    stageAgent('strict-a', 'developer-junior')
    stageAgent('plain-b', null)
    stageAgent('subdev-c', 'sub-dev')
    expect(S.agentRunsStrict('strict-a')).toBe(true)
    expect(S.agentRunsStrict('plain-b')).toBe(false)
    expect(S.agentRunsStrict('subdev-c')).toBe(false)
  })

  it('the main agent is never strict, and an unknown profile falls back to not strict', () => {
    expect(S.agentRunsStrict('agent-a')).toBe(false)
    stageAgent('ghost-d', 'no-such-profile')
    expect(S.agentRunsStrict('ghost-d')).toBe(false)
  })
})

describe('a strict agent gets no recipe its dontAsk mode denies', () => {
  it('the generated blocks: no substitution, no token header, no curl, and the helper in each', () => {
    stageAgent('strict-a', 'developer-junior')
    const file = startBlocks('strict-a')
    for (const title of [...BLOCK_TITLES, '## Dashboard-hívások a strict profilodban']) {
      expect(file, `block missing: ${title}`).toContain(title)
    }
    expect(file).not.toContain('$(')
    expect(file).not.toContain('Authorization: Bearer')
    expect(file.split('\n').filter((l) => l.trimStart().startsWith('curl '))).toEqual([])
    // Not vacuous: every recipe block really carries a helper line.
    for (const part of file.split('<!-- BEGIN GENERATED: ').slice(1)) {
      if (/autonomy-wiring|system-directive-auth|agent-id-header|memory-search-label|message-close|strict-api/.test(part.slice(0, 40))) {
        expect(helperLines(part).length, part.slice(0, 60)).toBeGreaterThan(0)
      }
    }
  })

  it('the creation prompt and the file it returns', async () => {
    stageAgent('strict-a', 'developer-junior')
    const { prompt, out } = await creation('strict-a')
    for (const text of [prompt, out]) {
      expect(text).not.toContain('$(cat ')
      expect(text).not.toContain('Authorization: Bearer')
      expect(text.split('\n').filter((l) => l.trimStart().startsWith('curl '))).toEqual([])
    }
    // memory save, daily log, search, hot list, move, skill proposal, stranger ping
    expect(helperLines(prompt).map((l) => l.split(' ')[2])).toEqual(
      ['memory-save', 'daily-log', 'memory-search', 'memory-list', 'memory-move', 'skill-propose', 'message'],
    )
    expect(prompt).toContain('Listázni sem tudsz')
  })

  it('every helper line is matched by the profile allow-list entry and names a known verb', async () => {
    stageAgent('strict-a', 'developer-junior')
    const text = startBlocks('strict-a') + '\n' + (await creation('strict-a')).prompt
    const profile = JSON.parse(readFileSync(join(REPO, 'templates', 'profiles', 'developer-junior.json'), 'utf-8'))
    const rule = (profile.filesystem.allow as string[])
      .map((r) => resolveProfilePlaceholders(r, { HOME: '/home/x', AGENT_DIR: '/agent' }))
      .find((r) => r.includes('marveen-api.sh'))
    expect(rule).toBe(`Bash(${HELPER_CMD}:*)`)
    const lines = helperLines(text)
    expect(lines.length).toBeGreaterThanOrEqual(15)
    expect(helperVerbs.size).toBeGreaterThanOrEqual(12)
    for (const line of lines) {
      expect(line.startsWith(HELPER_CMD + ' '), line).toBe(true)
      expect(helperVerbs.has(line.slice(HELPER_CMD.length + 1).split(' ')[0]), line).toBe(true)
      // nothing the shell would chain, pipe, redirect or substitute, once the <placeholders>
      // (<id>, <N>, <fájl>) are filled in
      expect(line.replace(/<[^<>\s]+>/g, 'X'), line).not.toMatch(/\$\(|`|\||;|&&|<|>/)
    }
  })
})

// VOICETOKENLEAK1101 PR-A1 (#2080 review 5727304277, Samu 64933, Dani 64941): a curl recipe's `$(cat <token>)` puts
// the token VALUE on the curl argv, so every agent whose settings allow the helper gets the helper recipes in the
// generated blocks; the strict-api block and its pointer stay strict-only.
describe('a non-strict agent gets the helper recipes in the generated blocks', () => {
  it('no substitution, no token, no curl in any recipe block, and the helper in each', () => {
    stageAgent('plain-b', null)
    const file = startBlocks('plain-b')
    expect(file).not.toContain('strict-api')
    expect(file).not.toContain('strict profilodban')
    for (const title of BLOCK_TITLES) expect(file, `block missing: ${title}`).toContain(title)
    // Dani 64941/3: 0 hits for these four in the generated blocks (the creation-time body is PR-A2)
    for (const s of ['$(cat', '.dashboard-token', 'Authorization']) expect(file, s).not.toContain(s)
    expect(file).not.toMatch(/\bcurl\b/)
    for (const part of file.split('<!-- BEGIN GENERATED: ').slice(1)) {
      expect(helperLines(part).length, part.slice(0, 60)).toBeGreaterThan(0)
    }
    for (const line of helperLines(file)) {
      expect(line.startsWith(HELPER_CMD + ' '), line).toBe(true)
      expect(helperVerbs.has(line.slice(HELPER_CMD.length + 1).split(' ')[0]), line).toBe(true)
      expect(line.replace(/<[^<>\s]+>/g, 'X'), line).not.toMatch(/\$\(|`|\||;|&&|<|>/)
    }
  })

  it('the payload files: one fixed name per recipe, in the agent own dir (Dani 64941/2)', () => {
    stageAgent('plain-b', null)
    const file = startBlocks('plain-b')
    const own = join(tmpRoot, 'agents', 'plain-b')
    const files = [...new Set([...file.matchAll(/\S+\.txt\b/g)].map((m) => m[0]))].sort()
    expect(files).toEqual(['api-eredmeny', 'api-jovahagyas', 'api-memoria', 'api-uzenet'].map((k) => join(own, `${k}.txt`)))
  })

  it('the main agent too: its payload files in the project root, which git ignores', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# main\n', 'utf-8')
    S.ensureAutonomySection('agent-a')
    S.ensureMessageCloseSection('agent-a')
    const file = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(file).toContain(`${HELPER_CMD} message agent-a agent-a ${join(tmpRoot, 'api-uzenet.txt')}`)
    expect(file).toContain(`--result-file ${join(tmpRoot, 'api-eredmeny.txt')}`)
    expect(file).not.toContain('$(cat')
    expect(readFileSync(join(REPO, '.gitignore'), 'utf-8').split('\n')).toContain('/api-*.txt')
  })

  it('settings that deny the helper keep the curl recipes, and say so in the log (Dani 64941/1)', async () => {
    const { logger } = await import('../logger.js')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    try {
      stageAgent('denied-h', null)
      mkdirSync(join(tmpRoot, 'agents', 'denied-h', '.claude'), { recursive: true })
      writeFileSync(join(tmpRoot, 'agents', 'denied-h', '.claude', 'settings.json'),
        JSON.stringify({ permissions: { deny: [`Bash(${HELPER_CMD} memory-save:*)`] } }), 'utf-8')
      expect(S.agentUsesApiHelper('denied-h')).toBe(false)
      const file = startBlocks('denied-h')
      expect(file).not.toContain('marveen-api.sh')
      for (const part of file.split('<!-- BEGIN GENERATED: ').slice(1)) {
        expect(part, part.slice(0, 60)).toContain('Authorization: Bearer $(cat ')
      }
      const said = warn.mock.calls.filter((c) => String(c[1]).includes('deny scripts/marveen-api.sh'))
      expect(said).toHaveLength(1)
      expect(said[0][0]).toMatchObject({ name: 'denied-h' })
    } finally {
      warn.mockRestore()
    }
  })

  it('a strict agent keeps the helper even if a deny rule would hit it (its dontAsk mode denies curl anyway)', () => {
    stageAgent('strict-x', 'developer-junior')
    mkdirSync(join(tmpRoot, 'agents', 'strict-x', '.claude'), { recursive: true })
    writeFileSync(join(tmpRoot, 'agents', 'strict-x', '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(bash:*)'] } }), 'utf-8')
    expect(S.agentUsesApiHelper('strict-x')).toBe(true)
  })

  it('the creation prompt: the skill section is the helper one, the body keeps its curl recipes until PR-A2', async () => {
    stageAgent('plain-b', null)
    const { prompt } = await creation('plain-b')
    expect(helperLines(prompt).map((l) => l.split(' ')[2])).toEqual(['skill-propose'])
    // memory save, daily log, search, hot list, move, schedule listing, stranger ping
    expect(prompt.split('$(cat ').length - 1).toBe(7)
  })

  it('ensureStrictApiSection does not touch a non-strict file at all', () => {
    const path = stageAgent('plain-b', null, '# plain-b\n\nkézzel írt rész\n')
    const before = readFileSync(path, 'utf-8')
    S.ensureStrictApiSection('plain-b')
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })
})

describe('the strict-api block follows the profile', () => {
  it('is written once (idempotent) and removed when the profile stops being strict', () => {
    const original = '# strict-e\n\nkézzel írt rész\n'
    const path = stageAgent('strict-e', 'developer-junior', original)
    S.ensureStrictApiSection('strict-e')
    const withBlock = readFileSync(path, 'utf-8')
    expect(withBlock).toContain('<!-- BEGIN GENERATED: strict-api')
    S.ensureStrictApiSection('strict-e')
    expect(readFileSync(path, 'utf-8')).toBe(withBlock)

    writeFileSync(join(tmpRoot, 'agents', 'strict-e', 'agent-config.json'), JSON.stringify({ securityProfile: 'sub-dev' }))
    S.ensureStrictApiSection('strict-e')
    expect(readFileSync(path, 'utf-8')).toBe(original)
  })

  it('a block in the middle is removed without gluing its neighbours together', () => {
    const path = stageAgent('strict-f', 'developer-junior', '# strict-f\n')
    S.ensureStrictApiSection('strict-f')
    writeFileSync(path, readFileSync(path, 'utf-8') + '\n## Utána\n\nszöveg\n', 'utf-8')
    writeFileSync(join(tmpRoot, 'agents', 'strict-f', 'agent-config.json'), JSON.stringify({}))
    S.ensureStrictApiSection('strict-f')
    expect(readFileSync(path, 'utf-8')).toBe('# strict-f\n\n## Utána\n\nszöveg\n')
  })
})

describe('the skill section follows the profile', () => {
  const retiredPath = join(REPO, 'templates', 'retired-claude-md-sections.json')
  const [retired] = S.readRetiredSkillSections(retiredPath)
  const doc = (section: string) => `# Ágens\n\n${section}\n\n## Időkezelés\n\nx\n`

  it('an unedited old section: a strict and a non-strict agent both get the helper recipe (PR-A1)', () => {
    expect(retired).toContain('## Öntanulás és Skill rendszer')
    const strictPath = stageAgent('strict-a', 'developer-junior', doc(retired))
    const plainPath = stageAgent('plain-b', null, doc(retired))
    expect(S.ensureSkillSectionCurrent('strict-a', retiredPath)).toBe(true)
    expect(S.ensureSkillSectionCurrent('plain-b', retiredPath)).toBe(true)
    const strict = readFileSync(strictPath, 'utf-8')
    expect(strict).toBe(doc(S.buildSkillSection('strict-a')))
    expect(helperLines(strict)).toEqual([
      `${HELPER_CMD} skill-propose SKILL-NEV ${join(tmpRoot, 'agents', 'strict-a', 'skill-javaslat.md')} --reason-file ${join(tmpRoot, 'agents', 'strict-a', 'skill-javaslat-indok.txt')}`,
    ])
    expect(strict).not.toContain('$(')
    expect(strict).not.toContain('/api/skills/propose')
    const plain = readFileSync(plainPath, 'utf-8')
    expect(plain).toBe(doc(S.buildSkillSection('plain-b')))
    expect(plain).not.toContain('/api/skills/propose')
    expect(plain).not.toContain('$(')
  })

  it('an unedited curl section is upgraded, it follows a helper deny both ways, and a second start writes nothing', () => {
    const path = stageAgent('plain-g', null, doc(S.buildSkillSection()))
    expect(S.ensureSkillSectionCurrent('plain-g', retiredPath)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe(doc(S.buildSkillSection('plain-g')))
    expect(S.ensureSkillSectionCurrent('plain-g', retiredPath)).toBe(false)
    const settings = join(tmpRoot, 'agents', 'plain-g', '.claude', 'settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Bash(bash:*)'] } }))
    expect(S.ensureSkillSectionCurrent('plain-g', retiredPath)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe(doc(S.buildSkillSection()))
    writeFileSync(settings, JSON.stringify({}))
    expect(S.ensureSkillSectionCurrent('plain-g', retiredPath)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe(doc(S.buildSkillSection('plain-g')))
  })
})

describe('which settings deny the helper (VOICETOKENLEAK1101 PR-A1, Dani 64941/1)', () => {
  it('bashRuleMatches: prefix, glob, exact and the bare Bash rule', () => {
    const cmd = `${HELPER_CMD} memory-save x`
    expect(S.bashRuleMatches('Bash', cmd)).toBe(true)
    expect(S.bashRuleMatches('Bash(bash:*)', cmd)).toBe(true)
    expect(S.bashRuleMatches(`Bash(${HELPER_CMD} memory-save:*)`, cmd)).toBe(true)
    expect(S.bashRuleMatches(`Bash(${HELPER_CMD} daily-log:*)`, cmd)).toBe(false)
    expect(S.bashRuleMatches('Bash(*marveen-api.sh*)', cmd)).toBe(true)
    expect(S.bashRuleMatches(cmd.replace(/^/, 'Bash(') + ')', cmd)).toBe(true)
    for (const r of ['Bash(curl -X POST:*)', 'Bash(sudo:*)', 'Bash(rm:*)', 'Bash(*/sudo *)', 'Read(**/.env)', 'Bash(git push -f:*)']) {
      expect(S.bashRuleMatches(r, cmd), r).toBe(false)
    }
  })

  it('every shipped profile lets the helper run (none of their deny rules hits a helper verb)', () => {
    const profiles = readdirSync(join(REPO, 'templates', 'profiles')).filter((f) => f.endsWith('.json'))
    expect(profiles.length).toBeGreaterThanOrEqual(7)
    for (const f of profiles) {
      const p = JSON.parse(readFileSync(join(REPO, 'templates', 'profiles', f), 'utf-8'))
      // the profile's own rules plus the floor every agent's settings get (writeAgentSettingsFromProfile)
      const deny = [...(p.filesystem?.deny ?? []), ...S.FLEET_BASELINE_DENY, ...S.FLEET_SUDO_DENY, ...S.bashEgressDeny(true), ...S.bashEgressDeny(false), ...S.LEGACY_BASH_EGRESS_DENY]
        .map((r: string) => resolveProfilePlaceholders(r, { HOME: '/home/x', AGENT_DIR: '/agent' }))
      for (const verb of ['message', 'message-close', 'memory-search', 'memory-save', 'approval-consume', 'skill-propose']) {
        expect(deny.filter((r: string) => S.bashRuleMatches(r, `${HELPER_CMD} ${verb} x`)), `${f} ${verb}`).toEqual([])
      }
    }
  })

  it('the main agent reads its project settings: the shipped curl -X POST deny does not hit the helper', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true })
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(sudo:*)', 'Bash(curl -X POST:*)'] } }))
    expect(S.apiHelperDenyRule('agent-a')).toBeNull()
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(bash:*)'] } }))
    expect(S.apiHelperDenyRule('agent-a')).toBe('Bash(bash:*)')
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), '{}')
  })
})

describe('the wiring', () => {
  it('the strict profile allow-lists the helper and agent-msg.sh', () => {
    const profile = JSON.parse(readFileSync(join(REPO, 'templates', 'profiles', 'developer-junior.json'), 'utf-8'))
    expect(profile.permissionMode).toBe('strict')
    expect(profile.filesystem.allow).toContain('Bash(bash ${PROJECT_ROOT}/scripts/marveen-api.sh:*)')
    expect(profile.filesystem.allow).toContain('Bash(bash ${PROJECT_ROOT}/scripts/agent-msg.sh:*)')
  })

  it('the agent start writes the strict-api block, after the profile settings', () => {
    const src = readFileSync(join(REPO, 'src', 'web', 'agent-process.ts'), 'utf-8')
    const settingsAt = src.indexOf('writeAgentSettingsFromProfile(name, profile)')
    const strictAt = src.indexOf('ensureStrictApiSection(name)')
    expect(settingsAt).toBeGreaterThan(0)
    expect(strictAt).toBeGreaterThan(settingsAt)
  })
})
