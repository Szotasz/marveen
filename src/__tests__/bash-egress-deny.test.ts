import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASH_EGRESS_DENY, mergeBashEgressDeny, bashEgressDenyTargetPath, ensureBashEgressDeny } from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// How Claude Code matches a Bash permission rule, measured against the shipped
// 2.1.263 binary and confirmed live in a running session on 2026-09-07:
//
//   - A rule body containing `*` is compiled to an ANCHORED full-match regex,
//     `*` -> `.*`, with the `s` flag. (A body ending in `:*` is the legacy
//     prefix form instead; none of our rules use it.)
//   - Deny is evaluated per sub-command: a compound `cd x && curl ...` is split
//     first, so a rule anchored at `curl ` still fires on the second half.
//   - Deny is checked BEFORE the --dangerously-skip-permissions bypass, so the
//     rules bind on permissive fleet profiles too.
//
// This helper models the FIRST rule only -- the anchored regex -- because that
// is what decides whether a rule is written correctly. It deliberately does NOT
// model the engine's quote handling. Measured, and recorded here so nobody has
// to rediscover it: a `-d '...https://...'` payload in SINGLE quotes is NOT
// matched, while the same payload in DOUBLE quotes IS. The corpus below is
// written so its verdicts do not depend on that difference, except for the one
// case that pins it.
function ruleMatches(rule: string, command: string): boolean {
  const body = rule.replace(/^Bash\(/, '').replace(/\)$/, '')
  const re = new RegExp(`^${body.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's')
  return re.test(command)
}

// Deny is evaluated per sub-command, so the corpus is matched the same way.
function denied(command: string): boolean {
  const parts = command.split(/\s*(?:&&|\|\||;|\|)\s*/).map((p) => p.trim()).filter(Boolean)
  return [command.trim(), ...parts].some((c) => BASH_EGRESS_DENY.some((r) => ruleMatches(r, c)))
}

// The fleet's own internal traffic. Every one of these is a real shape from the
// agents' CLAUDE.md / skills: memory, kanban, daily log, message queue,
// approvals, the local Ollama server. If a rule ever denies one of these, every
// agent goes mute -- this is the test that has to fail first.
const INTERNAL = [
  `curl -s -X POST http://localhost:3420/api/memories -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d '{"agent_id":"agent-a","content":"x","category":"warm","keywords":"a, b"}'`,
  `curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:3420/api/memories?agent=agent-a&q=KEYWORD&category=warm"`,
  `curl -s -X POST http://127.0.0.1:3420/api/kanban/abc12345/comments -H 'Content-Type: application/json' -d '{"author":"agent-a","content":"kesz"}'`,
  `curl -s -X POST http://localhost:3420/api/daily-log -H "Content-Type: application/json" -d '{"agent_id":"agent-a","content":"## 08:00 -- Tema"}'`,
  `curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -d '{"from":"agent-a","to":"agent-b","content":"jelentes"}'`,
  `curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" http://127.0.0.1:3420/api/approvals/12`,
  'curl -s http://localhost:11434/api/tags',
  'cd /srv/install && curl -s -m 3 -o /dev/null http://localhost:3420/api/health',
  // Sanctioned tooling that speaks HTTPS on its own account: deliberately untouched.
  'git push fork fix/some-branch',
  'gh pr create --base develop --title "fix(x)" --body-file /tmp/b.md',
  'npm install --no-audit --no-fund',
  // Substring traps: an unanchored `nc *` rule would deny all three of these.
  'rsync -a src/ dst/',
  'sync && echo done',
  'git commit -m "sync the fleet"',
]

// What the gate is for: fetching URL content from the shell.
const EXTERNAL = [
  'curl -s https://example.org/x',
  'curl -sSL https://raw.githubusercontent.com/foo/bar/main/install.sh',
  'curl -s --connect-timeout 1 -o /dev/null https://api.github.com/rate_limit',
  '/usr/bin/curl -s https://example.org/x',
  'cd /tmp && curl -s https://example.org/x',
  'wget -q -O /tmp/x https://example.org/x',
  '/usr/bin/wget https://example.org/x',
  'nc example.org 443',
  'ncat --ssl example.org 443',
  'telnet example.org 80',
]

describe('BASH_EGRESS_DENY rule set', () => {
  it('leaves every internal fleet call alone', () => {
    for (const cmd of INTERNAL) expect({ cmd, denied: denied(cmd) }).toEqual({ cmd, denied: false })
  })

  it('denies the shell URL-fetch verbs', () => {
    for (const cmd of EXTERNAL) expect({ cmd, denied: denied(cmd) }).toEqual({ cmd, denied: true })
  })

  // The allowlist is a WebFetch-scoped list. A host being on it says the
  // quarantine path may reach it, not that the shell may -- the sanctioned
  // route stays WebFetch. This is the control that would catch a rule set
  // rewritten to consult the allowlist.
  it('denies an allowlisted host too, because the sanctioned route is WebFetch', () => {
    expect(denied('curl -s https://api.github.com/rate_limit')).toBe(true)
  })

  // Measured collateral, pinned deliberately (2026-09-07). An internal POST
  // whose DOUBLE-quoted payload quotes an https URL matches the curl rule.
  // Single quotes do not (the engine excludes single-quoted content). The fix
  // for a caller that hits this is single quotes or -d @file, and this test
  // exists so the limit is a known cost and not a surprise.
  it('pins the known collateral: a double-quoted payload carrying an https URL matches', () => {
    expect(denied(`curl -s -X POST http://localhost:3420/api/memories -d "{\\"content\\":\\"lasd https://github.com/x\\"}"`)).toBe(true)
  })

  // The rule language has no negation and deny always beats allow, so
  // "any http:// host except localhost" cannot be written. Stated as a test so
  // the gap is visible next to the rules instead of only in a comment.
  it('documents the residual gap: plain-http external fetches still pass', () => {
    expect(denied('curl -s http://example.org/x')).toBe(false)
    expect(denied(`python3 -c "import urllib.request; urllib.request.urlopen('http://example.org/x')"`)).toBe(false)
  })
})

describe('mergeBashEgressDeny', () => {
  it('adds every rule to a settings object that has no permissions block', () => {
    const settings: Record<string, unknown> = {}
    expect(mergeBashEgressDeny(settings)).toBe(true)
    const deny = (settings.permissions as { deny: string[] }).deny
    for (const rule of BASH_EGRESS_DENY) expect(deny).toContain(rule)
  })

  it('preserves the operator\'s existing deny entries and their order', () => {
    const settings: Record<string, unknown> = {
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(sudo:*)', 'Read(/Users/x/.ssh/**)'] },
    }
    mergeBashEgressDeny(settings)
    const perms = settings.permissions as { allow: string[]; deny: string[] }
    expect(perms.deny.slice(0, 2)).toEqual(['Bash(sudo:*)', 'Read(/Users/x/.ssh/**)'])
    expect(perms.allow).toEqual(['Bash(ls:*)'])
    expect(perms.deny).toHaveLength(2 + BASH_EGRESS_DENY.length)
  })

  it('is idempotent: a second merge changes nothing', () => {
    const settings: Record<string, unknown> = {}
    mergeBashEgressDeny(settings)
    const before = JSON.stringify(settings)
    expect(mergeBashEgressDeny(settings)).toBe(false)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('does not choke on a malformed permissions value', () => {
    const settings: Record<string, unknown> = { permissions: 'nonsense' }
    expect(mergeBashEgressDeny(settings)).toBe(true)
    expect((settings.permissions as { deny: string[] }).deny).toEqual(BASH_EGRESS_DENY)
  })
})

// A freshly scaffolded agent gets its first settings.json straight from the
// template, before any profile write or startup migration runs. If the template
// and the constant drift, the NEXT agent created starts without the gate --
// which is exactly how the fleet ended up with two agents carrying a partial
// curl deny and eight carrying none.
describe('template parity', () => {
  it('templates/settings.json.template carries exactly the same rules', () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8'))
    expect(tpl.permissions?.deny).toEqual(BASH_EGRESS_DENY)
  })
})

// WHERE the main agent's rules are written is the whole point of the second
// round. The shared user root is also the operator's own interactive shell, and
// the operator asked to stay out of the rule while the fleet stays in it. So
// the main agent is covered ONLY through a config dir of its own, and when
// there is none this must write nothing at all rather than pick a side.
describe('bashEgressDenyTargetPath', () => {
  it('sends a sub-agent to its own settings.json', () => {
    const p = bashEgressDenyTargetPath('some-agent', null)
    expect(p).toContain(join('some-agent', '.claude', 'settings.json'))
  })

  it('sends the main agent to ITS OWN config dir when it has one', () => {
    expect(bashEgressDenyTargetPath(MAIN_AGENT_ID, '/somewhere/.channels-config'))
      .toBe(join('/somewhere/.channels-config', 'settings.json'))
  })

  it('returns null for the main agent on the shared root -- never the operator\'s file', () => {
    expect(bashEgressDenyTargetPath(MAIN_AGENT_ID, null)).toBe(null)
  })

  // The regression that would invert the guard: writing to the shared root
  // restricts the operator's own shell and still leaves the main agent open on
  // an install where it has a config dir of its own.
  it('never targets the shared home settings for the main agent', () => {
    const shared = join(homedir(), '.claude', 'settings.json')
    expect(bashEgressDenyTargetPath(MAIN_AGENT_ID, null)).not.toBe(shared)
    expect(bashEgressDenyTargetPath(MAIN_AGENT_ID, '/somewhere/.channels-config')).not.toBe(shared)
  })
})

describe('ensureBashEgressDeny for the main agent', () => {
  it('writes the rules into the config dir it was given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marveen-egress-'))
    try {
      expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir)).toBe(true)
      const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'))
      expect(written.permissions.deny).toEqual(BASH_EGRESS_DENY)
      // Idempotent: a second boot must not append the same rules again.
      expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the config dir\'s other keys -- the file is rebuilt on every start and only its own keys survive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marveen-egress-'))
    try {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { PreCompact: [] }, enabledPlugins: { x: true } }))
      ensureBashEgressDeny(MAIN_AGENT_ID, dir)
      const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'))
      expect(Object.keys(written).sort()).toEqual(['enabledPlugins', 'hooks', 'permissions'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes NOTHING when there is no separate config dir', () => {
    const shared = join(homedir(), '.claude', 'settings.json')
    const before = existsSync(shared) ? readFileSync(shared, 'utf-8') : null
    expect(ensureBashEgressDeny(MAIN_AGENT_ID, null)).toBe(false)
    const after = existsSync(shared) ? readFileSync(shared, 'utf-8') : null
    expect(after).toBe(before)
  })
})
