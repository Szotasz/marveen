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
import { execFileSync } from 'node:child_process'

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
  S.ensureApiHelperSection(name)
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
  return new Set([...usage.matchAll(/^ {2}([a-z-]+)(?= |$)/gm)].map((m) => m[1]))
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
    // memory save, daily log, search, hot list, move, schedule list (PR-B: a strict agent can list now), skill
    // proposal, stranger ping
    expect(helperLines(prompt).map((l) => l.split(' ')[2])).toEqual(
      ['memory-save', 'daily-log', 'memory-search', 'memory-list', 'memory-move', 'schedules-list', 'skill-propose', 'message'],
    )
    expect(prompt).not.toContain('Listázni sem tudsz')
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
    // Dani 64941/3: 0 hits for these four in the generated blocks (the api-helper block names "curl" in prose only, as the old form it overrides)
    for (const s of ['$(cat', '.dashboard-token', 'Authorization']) expect(file, s).not.toContain(s)
    expect(file.split('\n').filter((l) => /^\s*curl\s/.test(l))).toEqual([])
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
    expect(files).toEqual(['api-eredmeny', 'api-jovahagyas', 'api-memoria', 'api-naplo', 'api-uzenet'].map((k) => join(own, `${k}.txt`)))
  })

  // Dani 65347, Samu 65350: every recipe kind names ITS OWN file, everywhere the recipes are generated (the creation
  // prompt and every block, for a permissive and a strict agent); a save and a log prepared in one round must never
  // share a file. (A daily log on api-memoria.txt in the creation recipes stayed green before this assert.)
  it('every recipe kind names its own payload file, in the creation prompt and in every block', async () => {
    const KIND: Record<string, string> = {
      'memory-save': 'memoria', 'memory-update': 'memoria', 'daily-log': 'naplo', message: 'uzenet',
      'approval-request': 'jovahagyas',
    }
    const seen = new Set<string>()
    for (const [name, profile] of [['plain-k', null], ['strict-k', 'developer-junior']] as const) {
      stageAgent(name, profile)
      const text = [(await creation(name)).prompt, startBlocks(name)].join('\n')
      // message-close names its result file in the sentence next to it
      const results = [...text.matchAll(/--result-file (\S+?)`/g)].map((m) => m[1]!)
      expect(results.length, name).toBeGreaterThan(0)
      for (const r of results) expect(r, name).toMatch(/\/api-eredmeny\.txt$/)
      for (const line of helperLines(text)) {
        const verb = line.slice(HELPER_CMD.length + 1).split(' ')[0]!
        const files = [...line.matchAll(/api-([a-z]+)\.txt/g)].map((m) => m[1])
        if (files.length === 0) continue
        expect(KIND[verb], `${name}: unexpected verb with a payload file: ${line}`).toBeDefined()
        for (const f of files) expect(f, `${name}: ${line}`).toBe(KIND[verb])
        seen.add(verb)
      }
    }
    // not vacuous: every kind was met
    expect([...seen].sort()).toEqual(Object.keys(KIND).sort())
  })

  it('every block that names a payload file says: one file, one send (Dani 65157/1, Samu 65160)', () => {
    stageAgent('plain-o', null)
    const file = startBlocks('plain-o')
    const parts = file.split('<!-- BEGIN GENERATED: ').slice(1).filter((p) => /api-[a-z]+\.txt/.test(p))
    expect(parts.length).toBe(4) // autonomy (message + approval), message-close, agent-id, api-helper (PR-A2)
    for (const p of parts) expect(p, p.slice(0, 40)).toContain(S.ONE_FILE_ONE_SEND)
    const autonomy = parts.find((p) => p.startsWith('autonomy-wiring'))!
    expect(autonomy.split(S.ONE_FILE_ONE_SEND).length - 1).toBe(2)
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

  // VOICETOKENLEAK1101 PR-A2/PR-B: the creation-time body goes through the helper, the schedules read too (PR-B,
  // schedules-list); the dontAsk sentence stays strict-only.
  it('the creation prompt: every recipe through the helper, the schedules read too (PR-B)', async () => {
    stageAgent('plain-b', null)
    const { prompt } = await creation('plain-b')
    expect(helperLines(prompt).map((l) => l.split(' ')[2])).toEqual(
      ['memory-save', 'daily-log', 'memory-search', 'memory-list', 'memory-move', 'schedules-list', 'skill-propose', 'message'],
    )
    expect(prompt.split('$(cat ').length - 1).toBe(0)
    expect(prompt).not.toContain('dontAsk')
    expect(prompt).toContain('Olvasni (listázni) szabad, a segéddel')
  })

  // Dani 64941/3, Samu 65434 "kész-jel" for the WHOLE generated CLAUDE.md: the creation prompt the model copies, the
  // file it returns and the blocks every start writes. No exception any more (PR-B moved the schedules read onto the
  // helper); "curl" may stay in prose (the self-pace rule names the clients it forbids), never as a recipe line.
  it('the whole generated CLAUDE.md: no token and no curl recipe at all (PR-B)', async () => {
    stageAgent('plain-w', null)
    const { prompt, out } = await creation('plain-w')
    writeFileSync(join(tmpRoot, 'agents', 'plain-w', 'CLAUDE.md'), out, 'utf-8')
    const text = [prompt, startBlocks('plain-w')].join('\n')
    expect(text.split('\n').filter((l) => /\$\(cat|\.dashboard-token|Authorization/.test(l))).toEqual([])
    expect(text.split('\n').filter((l) => /^\s*curl\s/.test(l))).toEqual([])
    expect(text).toContain('<!-- BEGIN GENERATED: api-helper')
    expect(text).toContain(`${HELPER_CMD} schedules-list`)
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

describe('the api-helper block (VOICETOKENLEAK1101 PR-A2): an existing agent body gets the helper recipes', () => {
  const block = (p: string) => readFileSync(p, 'utf-8').match(/<!-- BEGIN GENERATED: api-helper[\s\S]*?<!-- END GENERATED: api-helper -->/)?.[0] ?? ''

  it('a non-strict agent: written once (idempotent), saying it overrides the curl recipes, no token in it', () => {
    const path = stageAgent('plain-h', null, '# plain-h\n\nkézi törzs curl-lel\n')
    S.ensureApiHelperSection('plain-h')
    const once = readFileSync(path, 'utf-8')
    S.ensureApiHelperSection('plain-h')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    const b = block(path)
    expect(b).toContain('ÍRJA FELÜL')
    for (const s of ['$(cat', '.dashboard-token', 'Authorization']) expect(b, s).not.toContain(s)
    const own = join(tmpRoot, 'agents', 'plain-h')
    expect(helperLines(b)).toEqual([
      `${HELPER_CMD} memory-save plain-h warm "kulcsszo1, kulcsszo2" ${join(own, 'api-memoria.txt')}`,
      `${HELPER_CMD} memory-search plain-h KULCSSZO --category warm`,
      `${HELPER_CMD} memory-list plain-h hot`,
      `${HELPER_CMD} memory-move <ID> cold plain-h`,
      `${HELPER_CMD} daily-log plain-h ${join(own, 'api-naplo.txt')}`,
      `${HELPER_CMD} message plain-h agent-a ${join(own, 'api-uzenet.txt')}`,
      `${HELPER_CMD} schedules-list`,
    ])
    expect(once.startsWith('# plain-h\n\nkézi törzs curl-lel\n')).toBe(true)
  })

  // Dani 65448, Samu 65462: the override sentence must name EVERY kind of body recipe it overrides; it named no
  // inter-agent message, so an agent could follow the body's curl for a message to its lead (or the "task done" ping).
  it('the override sentence names every kind of body recipe, the inter-agent message to any recipient too', async () => {
    stageAgent('plain-n', null)
    const prompt = (await creation('plain-n')).prompt
    const block = S.buildApiHelperBody('plain-n').replace(/\s+/g, ' ')
    const sentence = block.slice(block.indexOf('Ha ennek a fájlnak egy MÁSIK része'), block.indexOf('Helyette ezeket használd'))
    const NAMED: Record<string, string> = {
      'memory-save': 'memória mentés', 'memory-search': 'keresés', 'memory-list': 'hot-lista', 'memory-move': 'átsorolás',
      'daily-log': 'napi napló', message: 'inter-agent üzenet BÁRMELY címzettnek', 'schedules-list': 'ütemezések listája',
    }
    const bodyVerbs = helperLines(prompt).map((l) => l.split(' ')[2]!).filter((v) => v !== 'skill-propose')
    expect(bodyVerbs.length).toBeGreaterThanOrEqual(7)
    for (const v of bodyVerbs) {
      expect(NAMED[v], `body verb without a name in the test: ${v}`).toBeDefined()
      expect(sentence, v).toContain(NAMED[v])
    }
    expect(sentence).toContain('a vezetődnek vagy a fő ágensnek, a feladat-kész jelzés is')
  })

  it('never for a strict agent (it has the strict-api block)', () => {
    const strictPath = stageAgent('strict-h', 'developer-junior')
    S.ensureApiHelperSection('strict-h')
    expect(block(strictPath)).toBe('')
  })

  // Samu 65192, Marveen 65196: the main agent gets the block too, ONLY as a marker block; the owner's body is byte for
  // byte what it was, and its payload files sit in the project root, which git ignores.
  it('the main agent: the block appended to the root CLAUDE.md, the owner body byte for byte unchanged, idempotent', () => {
    const body = '# Fő ágens\n\nA gazda szövege, curl-recepttel:\ncurl -s -X POST http://localhost:3420/api/memories -H "Authorization: Bearer $(cat store/.dashboard-token)"\n'
    const root = join(tmpRoot, 'CLAUDE.md')
    writeFileSync(root, body, 'utf-8')
    S.ensureApiHelperSection('agent-a')
    const once = readFileSync(root, 'utf-8')
    expect(once.startsWith(body.trimEnd())).toBe(true)
    expect(once.slice(0, once.indexOf('<!-- BEGIN GENERATED: api-helper')).trimEnd()).toBe(body.trimEnd())
    const b = block(root)
    expect(b).toContain('ÍRJA FELÜL')
    expect(b).toContain(`${HELPER_CMD} memory-save agent-a warm "kulcsszo1, kulcsszo2" ${join(tmpRoot, 'api-memoria.txt')}`)
    expect(b).toContain(`${HELPER_CMD} message agent-a agent-a ${join(tmpRoot, 'api-uzenet.txt')}`)
    S.ensureApiHelperSection('agent-a')
    expect(readFileSync(root, 'utf-8')).toBe(once)
  })

  it('the main agent payload files are ignored by git in the project root (git check-ignore on this repo)', () => {
    for (const k of ['memoria', 'naplo', 'uzenet', 'jovahagyas', 'eredmeny']) {
      const out = execFileSync('git', ['-C', REPO, 'check-ignore', '-v', `api-${k}.txt`], { encoding: 'utf-8' })
      expect(out, k).toMatch(/\.gitignore:\d+:\/api-\*\.txt\s/)
    }
  })

  it('the dashboard start writes it for the main agent, next to its other generated sections', () => {
    const src = readFileSync(join(REPO, 'src', 'web.ts'), 'utf-8')
    const close = src.indexOf('ensureMessageCloseSection(MAIN_AGENT_ID)')
    const helper = src.indexOf('ensureApiHelperSection(MAIN_AGENT_ID)')
    expect(close).toBeGreaterThan(0)
    expect(helper).toBeGreaterThan(close)
  })

  it('removed when the agent becomes strict or its settings deny the helper, back when allowed again', () => {
    const original = '# plain-r\n\nkézi törzs\n'
    const path = stageAgent('plain-r', null, original)
    S.ensureApiHelperSection('plain-r')
    expect(block(path)).not.toBe('')
    const settings = join(tmpRoot, 'agents', 'plain-r', '.claude', 'settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Bash(bash:*)'] } }))
    S.ensureApiHelperSection('plain-r')
    expect(readFileSync(path, 'utf-8')).toBe(original)
    writeFileSync(settings, '{}')
    S.ensureApiHelperSection('plain-r')
    expect(block(path)).not.toBe('')
    writeFileSync(join(tmpRoot, 'agents', 'plain-r', 'agent-config.json'), JSON.stringify({ securityProfile: 'developer-junior' }))
    S.ensureApiHelperSection('plain-r')
    expect(readFileSync(path, 'utf-8')).toBe(original)
  })

  it('the strict-api block carries the same per-kind payload files, no shared api-payload.txt', () => {
    const b = S.buildStrictApiBody('strict-p')
    const own = join(tmpRoot, 'agents', 'strict-p')
    for (const k of ['memoria', 'naplo', 'uzenet']) expect(b).toContain(join(own, `api-${k}.txt`))
    expect(b).not.toContain('api-payload.txt')
  })

  it('the agent start writes the api-helper block right after the strict-api block', () => {
    const src = readFileSync(join(REPO, 'src', 'web', 'agent-process.ts'), 'utf-8')
    const strictAt = src.indexOf('ensureStrictApiSection(name)')
    const helperAt = src.indexOf('ensureApiHelperSection(name)')
    expect(strictAt).toBeGreaterThan(0)
    expect(helperAt).toBeGreaterThan(strictAt)
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
