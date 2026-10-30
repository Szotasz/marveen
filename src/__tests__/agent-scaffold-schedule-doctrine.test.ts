// SCHEDWRITE1023: the schedule paragraph of the sub-agent creation prompt is conditional on the
// schedule-writer grant, and it has to live INSIDE the upstream's strict-profile recipe structure (strictPromptRecipes /
// agentRunsStrict, #2232):
//   1. a plain (non-strict) agent that is NOT listed gets the upstream text, byte for byte;
//   2. a plain agent that IS listed gets the conditional text (the one allowed route, POST on the schedule API);
//   3. a strict agent never gets the conditional text, listed or not: its dontAsk mode denies the curl recipe that text
//      teaches, so it keeps the upstream strict wording (ask the main agent through the helper) and no curl recipe;
//   4. the main agent is never a writer.
// The prompt is the one generateClaudeMd() really hands to runAgent (captured, no LLM call).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-schedoctrine-test-'))
cpSync(join(REPO, 'templates', 'profiles'), join(tmpRoot, 'templates', 'profiles'), { recursive: true })
const captured: string[] = []
let writersSetting = ''

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-main',
  HEARTBEAT_AGENT_ID: 'heartbeat',
  BOT_NAME: 'agent-main',
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
    listAgentNames: () => ['plain-w', 'plain-n', 'strict-w', 'strict-n'],
    readAgentCapabilities: () => [],
    readAgentToolDeny: () => [],
    readAgentSenderRoleGatePolicy: () => null,
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
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => (key === 'SELF_PACE_SCHEDULE_WRITERS' ? writersSetting : ''),
}))
vi.mock('../agent.js', () => ({
  runAgent: async (prompt: string) => {
    captured.push(prompt)
    return { text: '# generated body' }
  },
}))

const S = await import('../web/agent-scaffold.js')

function stage(name: string, profile: string | null): void {
  const dir = join(tmpRoot, 'agents', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(profile ? { securityProfile: profile } : {}), 'utf-8')
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${name}\n`, 'utf-8')
}

async function promptFor(name: string): Promise<string> {
  captured.length = 0
  await S.generateClaudeMd(name, 'desc', 'model')
  return captured[0]
}

// The doctrine paragraph: from the "Ütemezés" paragraph start to the next blank line.
function doctrine(prompt: string): string {
  const i = prompt.indexOf('Ütemezést ')
  expect(i, 'the schedule paragraph is in the prompt').toBeGreaterThan(0)
  const j = prompt.indexOf('\n\n', i)
  return prompt.slice(i, j)
}

// The default paragraph, byte for byte as the unchanged develop renders it for the names mocked above; %s is the "how to ask" fragment.
const GOLDEN = 'Ütemezést NEM hozhatsz létre, NEM módosíthatsz, NEM kapcsolhatsz ki/be és NEM törölhetsz magad: se az API-n (semmilyen klienssel: curl, python, node, wget...), se a ~/.claude/scheduled-tasks/ mappa írásával, se az SQLite táblában. A governance-kapu (self-pace-gate) ezeket megtagadja. Ha ütemezés kell, kérd agent-main-t (agent-main) inter-agent üzenetben %s: név, leírás, prompt, cron, ágens (AGENT_NAME), típus. Ő hozza létre vagy módosítja.'
const WRITER_MARK = 'ütemezés-író ügynökök listáján van'
const DEFAULT_MARK = 'Ütemezést NEM hozhatsz létre'

stage('plain-w', null)
stage('plain-n', null)
stage('strict-w', 'developer-junior')
stage('strict-n', 'developer-junior')

describe('the schedule paragraph of the creation prompt (SCHEDWRITE1023 on the strict-recipe structure)', () => {
  it('the fixture agents are what the names say', () => {
    expect(S.agentRunsStrict('plain-w')).toBe(false)
    expect(S.agentRunsStrict('strict-w')).toBe(true)
  })

  it('a plain agent that is not listed gets the upstream paragraph: no conditional text, the heredoc wording', async () => {
    writersSetting = 'someone-else'
    const d = doctrine(await promptFor('plain-n'))
    expect(d).toContain(DEFAULT_MARK)
    expect(d).toContain('(a lenti, idézett heredoces alakban)')
    expect(d).not.toContain(WRITER_MARK)
    // the whole paragraph is the upstream one, word for word (a changed word in the moved text would stay green on the marks alone)
    expect(d).toBe(GOLDEN.replace('%s', '(a lenti, idézett heredoces alakban)'))
  })

  it('a plain agent that is listed gets the conditional paragraph: the one allowed route, the setting named', async () => {
    writersSetting = 'plain-w'
    const d = doctrine(await promptFor('plain-w'))
    expect(d).toContain(WRITER_MARK)
    expect(d).toContain('/api/schedules')
    expect(d).toContain('SELF_PACE_SCHEDULE_WRITERS')
    // the gate only passes the create POST with -q as the first curl argument: the doctrine says so
    expect(d).toContain('a -q legyen az ELSŐ argumentum')
    expect(d).not.toContain(DEFAULT_MARK)
  })

  it('a strict agent never gets the conditional paragraph, listed or not: the strict wording stays', async () => {
    writersSetting = 'strict-w'
    for (const n of ['strict-w', 'strict-n']) {
      const p = await promptFor(n)
      const d = doctrine(p)
      expect(d, n).toContain(DEFAULT_MARK)
      expect(d, n).not.toContain(WRITER_MARK)
      expect(d, n).not.toContain('(a lenti, idézett heredoces alakban)')
      // the strict wording is the upstream one, word for word: the helper recipe fragment, nothing else in its place
      expect(d, n).toBe(GOLDEN.replace('%s', '(a lenti message igével, a szöveg fájlban)'))
      expect(p, n).not.toContain('$(cat ')
    }
  })

  it("the develop's own-token sentence (AGENT_TOKENS) stays in the default paragraph, and only there", () => {
    const own = ', és a szerver is érvényesíti: a te tokeneddel minden nem-GET hívás 403-at ad'
    expect(S.scheduleDoctrineText(false, undefined, own)).toContain(`ezeket megtagadja${own}. Ha ütemezés kell`)
    expect(S.scheduleDoctrineText(false)).toContain('ezeket megtagadja. Ha ütemezés kell')
    // the conditional paragraph of a listed agent does not carry it
    expect(S.scheduleDoctrineText(true, undefined, own)).not.toContain(own)
  })

  it('the main agent is never a writer, even when the setting names it', async () => {
    writersSetting = 'agent-main'
    stage('agent-main', null)
    const d = doctrine(await promptFor('agent-main'))
    expect(d).toContain(DEFAULT_MARK)
    expect(d).not.toContain(WRITER_MARK)
  })
})
