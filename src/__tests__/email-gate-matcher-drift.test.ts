import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMAIL_GATE_MATCHER } from '../web/agent-scaffold.js'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, classifyMailTool } from '../../scripts/email-send-gate.mjs'

// EMAILGATEDRIFT902: the repo exports ONE canonical email-gate matcher
// (EMAIL_GATE_MATCHER, agent-scaffold.ts) and the sub-agent scaffold uses it
// -- but the main agent's hooks in the tracked .claude/settings.json were a
// HAND-COPIED matcher list, and it drifted: the copy-gate list was missing
// .*manage_email.* even though the constant's own comment cites a REAL
// manage_email send that bypassed the gate (2026-08-10). A hand-maintained
// copy of a canonical value will drift again; this test closes the CLASS by
// checking the settings.json matcher coverage against the constant itself.
// If the constant grows a new alternative, this goes red until settings.json
// follows.
const ROOT = join(__dirname, '..', '..')
const SETTINGS = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf-8')) as {
  hooks?: { PreToolUse?: { matcher?: string; hooks?: { command?: string }[] }[] }
}

// Every '|'-alternative of the canonical matcher. Splitting is safe here: the
// constant is a flat alternation of full-match tokens by construction.
const CANONICAL = EMAIL_GATE_MATCHER.split('|')

// The email-send surfaces of the MAIN agent. The copy gate also audits the
// telegram reply tool -- that is an allowed EXTRA surface, not email drift,
// so the assertion is coverage (every canonical alternative present), not
// set-equality.
const EMAIL_HOOKS = ['outgoing-copy-gate.py', 'email-approval-gate.py']

function matcherAlternativesFor(script: string): string[] {
  const entries = SETTINGS.hooks?.PreToolUse ?? []
  return entries
    .filter((e) => (e.hooks ?? []).some((h) => (h.command ?? '').includes(script)))
    .flatMap((e) => (e.matcher ?? '').split('|'))
}

describe('main-agent email hook matchers cover the canonical EMAIL_GATE_MATCHER', () => {
  for (const script of EMAIL_HOOKS) {
    it(`${script} covers every alternative of EMAIL_GATE_MATCHER`, () => {
      const present = matcherAlternativesFor(script)
      expect(present.length, `${script} is not wired in .claude/settings.json PreToolUse at all`).toBeGreaterThan(0)
      const missing = CANONICAL.filter((alt) => !present.includes(alt))
      expect(missing, `${script} matcher list drifted from EMAIL_GATE_MATCHER -- missing: ${missing.join(', ')}`).toEqual([])
    })
  }

  it('the canonical matcher still names the manage_email bypass class (2026-08-10)', () => {
    // If someone narrows the constant itself, the settings coverage above
    // would pass vacuously -- pin the known bypass class in the constant.
    expect(CANONICAL).toContain('.*manage_email.*')
    expect(CANONICAL).toContain('.*send_email.*')
    expect(CANONICAL).toContain('Bash')
  })

  it('the canonical matcher reaches draft_email on the Gmail MCP the fleet runs (MATCHERGMAILSEG920)', () => {
    // The gate's DRAFT_TOOL_RE has always covered draft_email, but a hook that
    // never FIRES cannot deny anything: the old `.*[Gg]mail__.*` needed the
    // literal segment `gmail__`, and this server's segment is
    // `gmail-autoauth-mcp__`. The regression this pins is the whole chain --
    // matcher fires AND the gate denies -- not just the regex.
    const full = new RegExp(`^(${EMAIL_GATE_MATCHER})$`)
    const tool = 'mcp__server-gmail-autoauth-mcp__draft_email'
    expect(full.test(tool), 'matcher must fire for the tool the fleet actually has').toBe(true)
    const verified = (a: string) => a === 'known@example.com'
    expect(gateDecision(tool, { to: 'invented@example.com' }, verified).deny).toBe(true)
    expect(gateDecision(tool, { to: 'known@example.com' }, verified).deny).toBe(false)
    // A name-keyed matcher goes blind on the next new server name, so the draft
    // surface is pinned by the OPERATION too: a server with no gmail in its name.
    expect(full.test('mcp__whatever_mail_server__draft_email')).toBe(true)
    // Read tools on the same server stay out of the deny path (the hook may
    // fire for them; the gate is what decides, and it must say no-deny).
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__read_email', {}, verified).deny).toBe(false)
  })

  it('the canonical matcher reaches the claude.ai Gmail connector (GMAILCONNECTOR914)', () => {
    // Full-match regex against the qualified tool name, as the harness does.
    // The connector's segment is claude_ai_Gmail (one underscore before Gmail),
    // which neither .*send_email.* nor .*manage_email.* ever matched.
    const full = new RegExp(`^(${EMAIL_GATE_MATCHER})$`)
    for (const tool of ['send_message', 'reply', 'forward', 'create_draft', 'update_draft']) {
      expect(full.test(`mcp__claude_ai_Gmail__${tool}`), tool).toBe(true)
    }
    expect(full.test('mcp__gmail__send_email')).toBe(true)
    expect(full.test('mcp__plugin_telegram_telegram__reply')).toBe(false)
    expect(full.test('Read')).toBe(false)
  })

  it('the canonical matcher reaches the harder-mail draft and send tools (HARDERMAILGATES1019)', () => {
    // Measured 2026-10-19: no email hook fired for mcp__harder-mail__* at all, so
    // its drafts skipped the copy audit and a send would have skipped approval.
    const full = new RegExp(`^(${EMAIL_GATE_MATCHER})$`)
    for (const tool of ['create_draft', 'send_mail', 'send_mail_auto']) {
      expect(full.test(`mcp__harder-mail__${tool}`), tool).toBe(true)
    }
    // Reads and the local preview stay out of the matcher.
    for (const tool of ['search_mail', 'read_mail', 'list_accounts', 'preview_mail']) {
      expect(full.test(`mcp__harder-mail__${tool}`), tool).toBe(false)
    }
    // Sub-agents: a send is the governance block, a draft is ledger-checked.
    const verified = (a: string) => a === 'known@example.com'
    expect(gateDecision('mcp__harder-mail__send_mail', { to: ['known@example.com'] }, verified).deny).toBe(true)
    expect(gateDecision('mcp__harder-mail__send_mail_auto', { to: ['known@example.com'] }, verified).deny).toBe(true)
    expect(gateDecision('mcp__harder-mail__create_draft', { to: ['invented@example.com'] }, verified).deny).toBe(true)
    expect(gateDecision('mcp__harder-mail__create_draft', { to: ['known@example.com'] }, verified).deny).toBe(false)
    // A reply draft has no recipient field (the server resolves it from the original).
    expect(gateDecision('mcp__harder-mail__create_draft', { reply_to_uid: 7, body: 'x' }, verified).deny).toBe(false)
  })

  it('every name in the shared harder-mail fixture fires the hooks and gets its sub-agent verdict (PR #2075 review)', () => {
    // The outcome is pinned per NAME, not per regex: a classifier change that
    // moves one of these names to another kind goes red here.
    const fixture = JSON.parse(readFileSync(join(ROOT, 'scripts', '__tests__', 'fixtures', 'harder-mail-tool-names.json'), 'utf-8')) as {
      names: string[]
      cases: Record<string, { subagent: 'deny' | 'ledger' }>
    }
    expect(fixture.names).toEqual([
      'mcp__harder-mail__send_mail',
      'mcp__harder-mail__send_mail_auto',
      'mcp__harder-mail__create_draft',
    ])
    const full = new RegExp(`^(${EMAIL_GATE_MATCHER})$`)
    const settingsFire = (script: string, tool: string) =>
      (SETTINGS.hooks?.PreToolUse ?? []).some((e) =>
        (e.hooks ?? []).some((h) => (h.command ?? '').includes(script))
        && new RegExp(`^(${e.matcher ?? ''})$`).test(tool))
    const verified = (a: string) => a === 'known@example.com'
    for (const name of fixture.names) {
      expect(full.test(name), `EMAIL_GATE_MATCHER misses ${name}`).toBe(true)
      for (const script of EMAIL_HOOKS) {
        expect(settingsFire(script, name), `${script} is not wired for ${name}`).toBe(true)
      }
      const reply = gateDecision(name, { account: 'ceges', reply_to_uid: 7, reply_folder: 'INBOX', body: 'x' }, verified)
      const known = gateDecision(name, { account: 'ceges', to: ['known@example.com'], body: 'x' }, verified)
      const invented = gateDecision(name, { account: 'ceges', to: ['invented@example.com'], body: 'x' }, verified)
      if (fixture.cases[name].subagent === 'deny') {
        expect([reply.deny, known.deny, invented.deny], `${name}: a sub-agent send must be denied`).toEqual([true, true, true])
        expect(known.kind, name).toBe('connector-send')
      } else {
        expect([reply.deny, known.deny, invented.deny], `${name}: a sub-agent draft is ledger-checked`).toEqual([false, false, true])
      }
    }
  })

  it('a harder-mail create_draft does NOT ask for approval on the main agent; send_mail does', () => {
    // Owner decision (tg 6349): approval is for the actual send only.
    const td = mkdtempSync(join(tmpdir(), 'hm-gate-'))
    const store = join(td, 'store')
    mkdirSync(store)
    writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({
      version: 1, categories: [{ key: 'email_send', label: 'Email', level: 2, locked: false }],
    }))
    const run = (tool: string) => spawnSync('python3', [join(ROOT, 'scripts', 'hooks', 'email-approval-gate.py')], {
      input: JSON.stringify({ tool_name: `mcp__harder-mail__${tool}`,
        tool_input: { account: 'ceges', to: ['a@b.hu'], subject: 'Targy', body: 'Szia!' } }),
      encoding: 'utf-8',
      env: { ...process.env, EMAIL_APPROVAL_GATE_STORE: store },
    })
    expect(run('create_draft').status).toBe(0)
    const send = run('send_mail')
    expect(send.status).toBe(2)
    expect(send.stderr).toContain('EMAIL JOVAHAGYASI KAPU')
  })
})

// --- tool-name classification is by SUFFIX, identically in Python and JS -----
// vendor/gmail-mcp-fork prepends its tool prefix to every tool name verbatim,
// so a classifier that models what stands BEFORE the base name misses the
// next prefix shape. The classifiers key on the base-name suffix; this block
// binds the Python copy (email_extract.py, the main agent's gates) and the JS
// copy (email-send-gate.mjs, sub-agents) to one shared case list, fuzzes
// prefixes nobody listed, and checks the hook matcher reaches every gated name.
type Kind = string | null
const NAME_CASES = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'hooks', 'mail-tool-name-cases.json'), 'utf-8'),
) as {
  servers: string[]
  prefixes: string[]
  bases: Record<string, { kind: Kind; needs_gmail?: boolean }>
  matcher_must_not_fire: string[]
  cases: Array<{ name: string; expected: Kind; matcher_exempt?: string }>
}

function expectedFor(server: string, prefix: string, base: string): Kind {
  const b = NAME_CASES.bases[base]
  if (b.needs_gmail && !(server + prefix).toLowerCase().includes('gmail')) return null
  return b.kind
}

// Deterministic PRNG (mulberry32): the fuzz must be reproducible.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const FUZZ_CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.'
function fuzzPrefixes(n: number, seed = 927): string[] {
  const r = rng(seed)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const len = Math.floor(r() * 13)
    let p = ''
    for (let j = 0; j < len; j++) p += FUZZ_CHARSET[Math.floor(r() * FUZZ_CHARSET.length)]
    out.push(p)
  }
  return out
}

const EXTRACT_PY = join(ROOT, 'scripts', 'hooks', 'email_extract.py')

function pyClassify(names: string[]): Kind[] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("email_extract", ${JSON.stringify(EXTRACT_PY)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.classify_mail_tool(n) for n in json.load(sys.stdin)]))
`], { encoding: 'utf-8', input: JSON.stringify(names) })
  return JSON.parse(out.trim())
}

const APPROVAL_GATE_PY = join(ROOT, 'scripts', 'hooks', 'email-approval-gate.py')
function pyScopeKind(names: string[]): Kind[] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(APPROVAL_GATE_PY)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
print(json.dumps([g.scope_kind(n) for n in json.load(sys.stdin)]))
`], { encoding: 'utf-8', input: JSON.stringify(names) })
  return JSON.parse(out.trim())
}

describe('mail-tool names are classified by suffix, identically in Python and JS', () => {
  const matrix: Array<{ name: string; expected: Kind }> = []
  for (const server of NAME_CASES.servers) {
    for (const prefix of NAME_CASES.prefixes) {
      for (const base of Object.keys(NAME_CASES.bases)) {
        matrix.push({ name: server + prefix + base, expected: expectedFor(server, prefix, base) })
      }
    }
  }
  const all = [...matrix, ...NAME_CASES.cases]
  const py = pyClassify(all.map((c) => c.name))
  const fuzz: Array<{ name: string; expected: Kind }> = []
  for (const prefix of fuzzPrefixes(400)) {
    for (const base of Object.keys(NAME_CASES.bases)) {
      for (const server of ['mcp__gmail__', 'mcp__workmail__']) {
        fuzz.push({ name: server + prefix + base, expected: expectedFor(server, prefix, base) })
      }
    }
  }

  it('the shared matrix + hand cases: both copies return the expected kind', () => {
    const wrong = all
      .map((c, i) => ({ ...c, js: classifyMailTool(c.name) as Kind, py: py[i] }))
      .filter((c) => c.js !== c.expected || c.py !== c.expected)
    expect(wrong, JSON.stringify(wrong.slice(0, 10))).toEqual([])
  })

  it('the case list is non-trivial in both directions and names the required prefixes', () => {
    expect(all.length).toBeGreaterThan(1000)
    expect(all.some((c) => c.expected === null)).toBe(true)
    for (const k of ['send_email', 'connector_send', 'send_draft', 'draft', 'manage_email']) {
      expect(all.some((c) => c.expected === k), k).toBe(true)
    }
    for (const p of ['v2_', 'v2', 'work-', 'shared_inbox_', 'v-2_']) {
      expect(NAME_CASES.prefixes, p).toContain(p)
    }
  })

  it('the harder-mail tools are in the shared case list, by suffix (HARDERMAILGATES1019)', () => {
    // Deleting a row from mail-tool-name-cases.json would drop these names from
    // the parity matrix above without any test noticing; this pins them.
    expect(NAME_CASES.servers).toContain('mcp__harder-mail__')
    expect(NAME_CASES.bases.send_mail).toEqual({ kind: 'connector_send' })
    expect(NAME_CASES.bases.send_mail_auto).toEqual({ kind: 'connector_send' })
    expect(NAME_CASES.bases.create_draft).toEqual({ kind: 'draft' })
    for (const read of ['search_mail', 'read_mail', 'list_accounts', 'list_folders', 'get_attachment', 'preview_mail']) {
      expect(NAME_CASES.bases[read], read).toEqual({ kind: null })
    }
    const want: Record<string, Kind> = {}
    for (const [base, kind] of [['send_mail', 'connector_send'], ['send_mail_auto', 'connector_send'], ['create_draft', 'draft'], ['search_mail', null], ['read_mail', null]] as const) {
      for (const prefix of NAME_CASES.prefixes) want[`mcp__harder-mail__${prefix}${base}`] = kind
    }
    const names = Object.keys(want)
    const py = pyClassify(names)
    const wrong = names.filter((n, i) => classifyMailTool(n) !== want[n] || py[i] !== want[n])
    expect(wrong).toEqual([])
  })

  it('fuzzed random prefixes (seeded) never change the verdict, in either copy', () => {
    const pyFuzz = pyClassify(fuzz.map((c) => c.name))
    const wrong = fuzz
      .map((c, i) => ({ ...c, js: classifyMailTool(c.name) as Kind, py: pyFuzz[i] }))
      .filter((c) => c.js !== c.expected || c.py !== c.expected)
    expect(wrong, JSON.stringify(wrong.slice(0, 10))).toEqual([])
  })

  it('control: the name patterns the gates carried before FAIL this contract', () => {
    // Proves the matrix discriminates: the anchored patterns miss prefixed names.
    const oldDraft = (n: string): Kind => (/(^|__)(create_draft|draft_email|update_draft)$/i.test(n) ? 'draft' : null)
    const oldConnector = (n: string): Kind => (/gmail__(reply|reply_all|send_message|forward)$/i.test(n) ? 'connector_send' : null)
    expect(matrix.filter((c) => c.expected === 'draft').some((c) => oldDraft(c.name) !== c.expected)).toBe(true)
    expect(matrix.filter((c) => c.expected === 'connector_send').some((c) => oldConnector(c.name) !== c.expected)).toBe(true)
    expect(matrix.some((c) => c.expected === 'send_draft')).toBe(true)
  })

  it('never narrower: every name an old gate pattern matched is still in scope for that gate', () => {
    // The patterns each gate carried before the classifier, verbatim. A name
    // one of them matched must still land in a kind that gate acts on.
    const corpus = [...all, ...fuzz].map((c) => c.name)
    const pyAll = pyClassify(corpus)
    const pyApproval = pyScopeKind(corpus)
    const legacy: Array<[string, RegExp, Kind[]]> = [
      // email-approval-gate.py _SEND_TOOL: in scope = levelled
      // (judged by the gate's own scope_kind below, which keeps its substring manage_email)
      ['approval gate', /send_email|manage_email|gmail__(reply|reply_all|send_message|forward)$/i, ['send_email', 'connector_send', 'send_draft', 'manage_email']],
      // email-send-gate.mjs: send_email deny, connector deny, drafts ledger-checked, manage_email by op
      ['sub-agent gate send', /send_email/i, ['send_email']],
      ['sub-agent gate connector', /gmail__(reply|reply_all|send_message|forward)$/i, ['send_email', 'connector_send']],
      ['sub-agent gate draft', /(^|__)(create_draft|draft_email|update_draft)$/i, ['send_email', 'connector_send', 'send_draft', 'manage_email', 'draft']],
      ['sub-agent gate manage_email', /(^|__)manage_email$/i, ['manage_email']],
      // outgoing-copy-gate.py EMAIL_TOOL_RE: audited
      ['copy gate', /(send_email|create_draft|draft_email|update_draft|gmail__(reply|reply_all|send_message|forward)$)/i, ['send_email', 'connector_send', 'draft']],
      ['copy gate manage_email', /(^|__)manage_email$/i, ['manage_email']],
      // credential-gate.py _SEND_TOOL: read as a letter through the envelope
      ['credential gate', /send_email|gmail__(reply|reply_all|send_message|forward)$/i, ['send_email', 'connector_send']],
    ]
    const narrowed: string[] = []
    for (const [gate, re, kinds] of legacy) {
      corpus.forEach((name, i) => {
        if (!re.test(name)) return
        if (gate === 'approval gate') {
          if (!kinds.includes(pyApproval[i])) narrowed.push(`${gate}: ${name} -> py ${pyApproval[i]}`)
          return
        }
        const js = classifyMailTool(name) as Kind
        if (!kinds.includes(js) || !kinds.includes(pyAll[i])) narrowed.push(`${gate}: ${name} -> js ${js} / py ${pyAll[i]}`)
      })
    }
    expect(narrowed.slice(0, 10)).toEqual([])
  })

  // The hook only runs when the matcher fires, so the matcher must be a
  // superset of what the classifiers gate, on EVERY server name, not only on
  // one that carries "gmail".
  const outbound = [
    ...matrix,
    ...NAME_CASES.cases.filter((c) => !c.matcher_exempt),
    ...fuzzPrefixes(200, 4242).flatMap((p) => Object.keys(NAME_CASES.bases).flatMap((b) =>
      ['mcp__gmail__', 'mcp__workmail__', 'mcp__GMAIL__'].map((s) => ({ name: s + p + b, expected: expectedFor(s, p, b) })))),
  ].filter((c) => c.expected !== null)

  it('the email-gate matcher fires for every name either classifier gates, on any server', () => {
    const full = new RegExp(`^(?:${EMAIL_GATE_MATCHER})$`)
    expect(outbound.length).toBeGreaterThan(1000)
    // the class this closes: gated names on a server with no "gmail" in it
    expect(outbound.some((c) => c.name.startsWith('mcp__workmail__') && c.expected === 'send_draft')).toBe(true)
    expect(outbound.filter((c) => !full.test(c.name)).map((c) => c.name)).toEqual([])
    // ...and so do the MAIN agent's committed settings, for both email hooks.
    for (const script of EMAIL_HOOKS) {
      const alts = matcherAlternativesFor(script).map((a) => new RegExp(`^(?:${a})$`))
      const missed = outbound.filter((c) => !alts.some((re) => re.test(c.name))).map((c) => c.name)
      expect(missed, script).toEqual([])
    }
  })

  it('the email-gate matcher NEVER fires on the Telegram tools (or other non-mail tools)', () => {
    const full = new RegExp(`^(?:${EMAIL_GATE_MATCHER})$`)
    const approvalAlts = matcherAlternativesFor('email-approval-gate.py').map((a) => new RegExp(`^(?:${a})$`))
    expect(NAME_CASES.matcher_must_not_fire).toContain('mcp__plugin_telegram_telegram__reply')
    for (const name of NAME_CASES.matcher_must_not_fire) {
      expect(full.test(name), `EMAIL_GATE_MATCHER fires on ${name}`).toBe(false)
      expect(approvalAlts.some((re) => re.test(name)), `email-approval-gate.py fires on ${name}`).toBe(false)
      // belt and braces: even a hook that did fire classifies them as not-mail
      expect(classifyMailTool(name), name).toBe(null)
      expect(gateDecision(name, { text: 'x', to: ['invented@example.com'] }, () => false).deny, name).toBe(false)
    }
  })

  it('control: the previous matcher misses a send_draft on a server without "gmail" in its name', () => {
    const pre = new RegExp('^(?:Bash|.*send_email.*|.*manage_email.*|.*[Gg]mail.*__.*|.*draft_email.*)$')
    expect(pre.test('mcp__workmail__v2_send_draft')).toBe(false)
    expect(new RegExp(`^(?:${EMAIL_GATE_MATCHER})$`).test('mcp__workmail__v2_send_draft')).toBe(true)
  })

  it('sub-agent gate: every prefixed send / send_draft is denied, drafts are ledger-checked, reads pass', () => {
    const verified = (a: string) => a === 'known@example.com'
    for (const c of all) {
      if (c.name === 'Bash') continue
      const d = gateDecision(c.name, { to: ['invented@example.com'], operation: 'send' }, verified)
      expect(d.deny, c.name).toBe(c.expected !== null)
      if (c.expected === 'draft') {
        expect(d.kind, c.name).toBe('unverified-recipient')
        expect(gateDecision(c.name, { to: ['known@example.com'] }, verified).deny, c.name).toBe(false)
      }
      if (c.expected === 'send_draft') {
        expect(gateDecision(c.name, { draftId: 'r-1' }, verified).deny, c.name).toBe(true)
      }
    }
  })
})
