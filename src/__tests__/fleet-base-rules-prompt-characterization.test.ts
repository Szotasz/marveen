// The creation prompt of a sub-agent's CLAUDE.md, pinned byte for byte (MIOAGENTINSTALL1114, PR-I3; plan 4.3, N12).
//
// The two install-dependent rule texts of that prompt (the unknown-sender golden rule and the eight fleet rules) are
// lifted into one renderer, renderFleetBaseRules, so that a package agent gets the same text in its shell. The lift
// must not change the prompt a hand-made agent is created from: this file was written and run green on the code
// BEFORE the lift, and pins the sha256 of the whole prompt for every input the two texts depend on (plan 4.3,
// addendum (5)): the language, the helper recipes or the curl ones, an own token or the shared one, a configured
// Drive folder or none. The temp root is replaced by a fixed word before hashing, so the hash is the same on every
// machine.
//
// When a later change edits the creation prompt on purpose, these hashes change with it: update them in the same
// change, after reading the new prompt.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-fleet-base-rules-char-'))
// readEnvFile (src/env.ts) takes its folder from this at import time.
process.env.CLAUDECLAW_ENV_DIR = tmpRoot

const drive = { value: '' }
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    STORE_DIR: '/nonexistent/claudeclaw-test-store',
    PROJECT_ROOT: tmpRoot,
    OWNER_NAME: 'TestOwner',
    MAIN_AGENT_ID: 'agent-a',
    HEARTBEAT_AGENT_ID: 'heartbeat',
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
  return {
    ...real,
    getEffectiveSettingValue: (key: string) => {
      if (key === 'AGENT_TOKENS') return '1'
      if (key === 'OWNER_DRIVE_FOLDER') return drive.value
      return real.getEffectiveSettingValue(key)
    },
  }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    agentDir: (name: string) => join(tmpRoot, 'agents', name),
    agentConfigRoot: () => join(tmpRoot, 'agents'),
    listAgentNames: () => ['own-helper', 'own-curl', 'shared-helper', 'shared-curl'],
    readAgentCapabilities: () => [],
  }
})
const captured = { prompt: '' }
vi.mock('../agent.js', () => ({
  runAgent: async (prompt: string) => { captured.prompt = prompt; return { text: '# Generated\n' } },
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

mkdirSync(join(tmpRoot, 'templates', 'profiles'), { recursive: true })
for (const f of readdirSync(join(__dirname, '..', '..', 'templates', 'profiles'))) {
  copyFileSync(join(__dirname, '..', '..', 'templates', 'profiles', f), join(tmpRoot, 'templates', 'profiles', f))
}
for (const n of ['own-helper', 'own-curl', 'shared-helper', 'shared-curl']) mkdirSync(join(tmpRoot, 'agents', n, '.claude'), { recursive: true })
for (const n of ['own-helper', 'own-curl']) writeFileSync(join(tmpRoot, 'agents', n, '.dashboard-token'), 'c'.repeat(64), { mode: 0o600 })
for (const n of ['own-curl', 'shared-curl']) {
  writeFileSync(join(tmpRoot, 'agents', n, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(bash:*)'] } }), 'utf-8')
}

const sc = await import('../web/agent-scaffold.js')

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

function setLang(lang: 'hu' | 'en'): void {
  writeFileSync(join(tmpRoot, '.env'), `AGENT_TEXT_LANG=${lang}\n`, 'utf-8')
}

async function promptFor(lang: 'hu' | 'en', name: string, driveFolder: string): Promise<string> {
  setLang(lang)
  drive.value = driveFolder
  captured.prompt = ''
  await sc.generateClaudeMd(name, 'Keeps the books.', 'claude-sonnet-4-6')
  return captured.prompt.split(tmpRoot).join('<ROOT>')
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// Measured on develop c0951d76f, BEFORE renderFleetBaseRules was lifted out of the two prompts.
const EXPECTED: Record<string, string> = {
  'en:own-curl:drive=none': '1a78284d41338e86abedb9ff1c50c38264f35e2b31bbe670e19ca80abb0b6f61',
  'en:own-curl:drive=set': 'c661ac89f475a45b27ca137d2ac795414e6e7f86d8c6bc7cfe4ee87a3c232ed8',
  'en:own-helper:drive=none': '63ef0b360f324170625391f45f71f1b3bf285d98e472da2cdd694bf868474472',
  'en:own-helper:drive=set': 'a8c14161345eb4a7fc98c71d1029ba52a5d476efce99311bdc7008479ef6c09c',
  'en:shared-curl:drive=none': '74bdec347003f43ef8130fbe1a3e011a830f54324e22db853371df4891d0dace',
  'en:shared-curl:drive=set': 'f46f68f8c4517554d36a620da62d8a177384b0aa0210a25a40b33be3aec8fe1d',
  'en:shared-helper:drive=none': '088a2eb8302eeab017e3ed8e5b048835851470cf6b0cd16e5b097372e4209ee8',
  'en:shared-helper:drive=set': '8d0f615acaea005ccf7423a5af01e9111dcc20924c1ecc7f88909d719d316fb8',
  'hu:own-curl:drive=none': '54ca58b2b2923ed5188f12633b7ffa3ec34241d6a183210228499b1061d2a7d3',
  'hu:own-curl:drive=set': '1d5af3b6f56bc9f8956c495727ca1cebe30757c380593217c0ede10d05b02cd2',
  'hu:own-helper:drive=none': '8dec901f7ee67b8ccd69b8f737daa3b85c159a34dbc4111b395d5ef49e5435eb',
  'hu:own-helper:drive=set': 'caedee3fc29057f13865e78be67a782ac1d234e695cb278cbd6711460e85f2a6',
  'hu:shared-curl:drive=none': '8413bed4db284d27d510289679f5dd1096401bf164ce1a976d4dd0813e513fb2',
  'hu:shared-curl:drive=set': '41488e512305a5d7b7509838962a2f2b3cf57e53df23535fe1dbd6af234abeef',
  'hu:shared-helper:drive=none': 'e2b13c53a0d8cd2c966f6e99145d0bcc8c291156be1da096bb0cbf9945cd9f3b',
  'hu:shared-helper:drive=set': '073d1d1cf83c067baaea0b7fb71ebd374fa4c07a1f020452fc8d6b936f7e8531',
}

describe('the sub-agent creation prompt is byte-identical across the fleet base rules lift (N12)', () => {
  it('every variant of language, helper, own token and Drive folder hashes as before', async () => {
    const actual: Record<string, string> = {}
    for (const lang of ['hu', 'en'] as const) {
      for (const name of ['own-helper', 'own-curl', 'shared-helper', 'shared-curl']) {
        for (const d of ['', 'DRIVEFOLDER123']) {
          const p = await promptFor(lang, name, d)
          expect(p.length).toBeGreaterThan(1000)
          actual[`${lang}:${name}:drive=${d ? 'set' : 'none'}`] = sha(p)
        }
      }
    }
    expect(actual).toEqual(EXPECTED)
  })

  it('the prompt embeds fleetBaseRulesTemplate verbatim, in both languages (one source)', async () => {
    for (const lang of ['hu', 'en'] as const) {
      for (const name of ['own-helper', 'shared-curl']) {
        const p = await promptFor(lang, name, 'DRIVEFOLDER123')
        const tokenPath = name === 'own-helper' ? '<ROOT>/agents/own-helper/.dashboard-token' : '<ROOT>/store/.dashboard-token'
        setLang(lang)
        const t = sc.fleetBaseRulesTemplate({ agentName: name, lang, helper: name === 'own-helper', tokenPath, driveFolder: 'DRIVEFOLDER123' })
        expect(p).toContain(t.split(tmpRoot).join('<ROOT>') + '\n\nOutput ONLY the markdown content, no code fences.')
      }
    }
  })

  it('the variants differ where the inputs differ (the matrix is not degenerate)', async () => {
    const a = await promptFor('hu', 'own-helper', '')
    expect(await promptFor('hu', 'own-helper', 'DRIVEFOLDER123')).toContain('drive/folders/DRIVEFOLDER123')
    expect(a).not.toContain('drive/folders/')
    expect(await promptFor('hu', 'shared-curl', '')).toContain('curl -s -X POST')
    expect(a).toContain('marveen-api.sh message AGENT_NAME agent-a')
    expect(await promptFor('en', 'own-helper', '')).toContain('## Fleet rules (UNBREAKABLE')
    expect(await promptFor('hu', 'own-curl', '')).toContain('agents/own-curl/.dashboard-token')
    expect(await promptFor('hu', 'shared-curl', '')).not.toContain('agents/shared-curl/.dashboard-token')
  })
})
