import { describe, expect, it } from 'vitest'
import { listProfileTemplates, loadProfileTemplate, resolveProfilePlaceholders } from '../web/profiles.js'
import { PROJECT_ROOT } from '../config.js'

// TMPLPERM908: the permission-rule shapes below were MEASURED against Claude
// Code's engine on 2026-09-08 (strict launch, -p probes T1-T9):
//   - Read(/abs/path/**)  -> single leading '/' is project-relative, NEVER matches
//   - Read(//abs/path/**) -> matches (allow and deny)
//   - Read(~/path/**)     -> matches (allow and deny)
//   - Bash(/abs/**/x.sh:*) -> '**' has no glob meaning in Bash rules; only a
//                             literal command prefix matches
// These tests pin the normalization + template posture so a future edit cannot
// silently regress to the never-matching shapes.

// Every shipped profile template. Kept in one place so a new template cannot
// be added while quietly skipping the whole-fleet assertions below.
const PROFILE_IDS = [
  'marketer', 'researcher', 'developer-junior', 'developer-senior',
  'applier', 'sub-dev', 'default',
] as const

const ctx = { HOME: '/Users/testuser', AGENT_DIR: '/Users/testuser/ClaudeClaw/agents/tester' }

describe('resolveProfilePlaceholders rule normalization', () => {
  it('rewrites a single-slash absolute Read rule to the // absolute form', () => {
    expect(resolveProfilePlaceholders('Read(${HOME}/.ssh/**)', ctx))
      .toBe('Read(//Users/testuser/.ssh/**)')
  })

  it('rewrites Edit and Write rules the same way', () => {
    expect(resolveProfilePlaceholders('Edit(${AGENT_DIR}/**)', ctx))
      .toBe('Edit(//Users/testuser/ClaudeClaw/agents/tester/**)')
    expect(resolveProfilePlaceholders('Write(/tmp/**)', ctx)).toBe('Write(//tmp/**)')
  })

  it('leaves already-absolute (//), home (~) and relative (**) rules untouched', () => {
    expect(resolveProfilePlaceholders('Read(//tmp/**)', ctx)).toBe('Read(//tmp/**)')
    expect(resolveProfilePlaceholders('Read(~/.claude/skills/**)', ctx)).toBe('Read(~/.claude/skills/**)')
    expect(resolveProfilePlaceholders('Read(**/.env)', ctx)).toBe('Read(**/.env)')
  })

  it('never touches Bash rules (command-prefix matching, not paths)', () => {
    expect(resolveProfilePlaceholders('Bash(sudo:*)', ctx)).toBe('Bash(sudo:*)')
    expect(resolveProfilePlaceholders('Bash(${PROJECT_ROOT}/scripts/notify.sh:*)', ctx))
      .toBe(`Bash(${PROJECT_ROOT}/scripts/notify.sh:*)`)
  })

  it('resolves ${PROJECT_ROOT}', () => {
    expect(resolveProfilePlaceholders('${PROJECT_ROOT}/scripts/x.sh', ctx))
      .toBe(`${PROJECT_ROOT}/scripts/x.sh`)
  })
})

describe('web-reading profile posture (TMPLPERM908)', () => {
  // Both profiles read web content (prompt-injection surface), and strict is
  // what makes the deny list enforceable: permissive launches with
  // --dangerously-skip-permissions. The owner nevertheless chose permissive,
  // twice -- 2026-09-07 (TG 14764, card PROFILSTRICT904) and again 2026-09-08
  // (TG 15115, card PROFILREGRESS908) after this test's predecessor reverted
  // the first, uncommitted flip. Measured reason: under strict the agent stops
  // on a permission dialog at EVERY tool call, including read-only ones, and no
  // one answers it in a non-interactive agent -- orsi filed two session-stuck
  // alarms in 25 minutes and did zero work. The deny list still carries the
  // real posture (SSH/AWS/.env, sudo, rm, curl -X POST, git push); it is simply
  // advisory under permissive. Tightening the mode again is an OWNER decision,
  // not a template edit, and it must land with the agents' work rerouted first.
  // The messaging grant is asserted PER PROFILE, not as one shared literal.
  // `scripts/agent-post.sh` no longer exists in the repo (it was replaced by
  // agent-msg.sh, the CLAUDE.md-documented inter-agent helper), and researcher
  // was repointed at agent-msg.sh. Asserting the removed script for BOTH
  // profiles made this case fail on researcher while still passing on marketer,
  // which grants the stale path to this day -- that stale marketer grant is a
  // separate question for the profile owner and is deliberately not changed
  // here. What the case protects is unchanged: each profile must still carry a
  // messaging-helper grant, so a silent drop of it is caught.
  const MESSAGING_ALLOW: Record<string, string> = {
    marketer: 'Bash(${PROJECT_ROOT}/scripts/agent-post.sh:*)',
    researcher: 'Bash(bash ${PROJECT_ROOT}/scripts/agent-msg.sh:*)',
  }
  for (const id of ['marketer', 'researcher']) {
    it(`${id} stays permissive (owner decision) and carries the measured capability allows`, () => {
      const p = loadProfileTemplate(id)
      expect(p.id).toBe(id) // guard against the default-profile fallback
      expect(p.permissionMode).toBe('permissive')
      expect(p.filesystem.allow).toContain('Read(${HOME}/.claude/skills/**)')
      expect(p.filesystem.allow).toContain('Bash(${PROJECT_ROOT}/scripts/notify.sh:*)')
      expect(p.filesystem.allow).toContain(MESSAGING_ALLOW[id])
      expect(p.filesystem.deny).toContain('Read(${HOME}/.ssh/**)')
    })
  }

  // No template may hardcode THIS install's directory name. `${HOME}/marveen`
  // only resolves for an install that happens to live in ~/marveen; everywhere
  // else the rule silently matches nothing, which turns an allow into a missing
  // capability and a deny into no protection at all. `${PROJECT_ROOT}` is
  // substituted from the running install (profiles.ts), so it is correct by
  // construction. A bare `${HOME}` stays legal: ~/.ssh, ~/Downloads and
  // ~/.claude/skills really are home-relative, not install-relative.
  // The list above is the input to two whole-fleet assertions, so a template
  // added without touching it would be silently exempt from both.
  it('PROFILE_IDS covers every template on disk', () => {
    expect([...PROFILE_IDS].sort()).toEqual(listProfileTemplates().map(p => p.id).sort())
  })

  it('no template hardcodes an install directory under ${HOME}', () => {
    for (const id of PROFILE_IDS) {
      const p = loadProfileTemplate(id)
      for (const rule of [...p.filesystem.allow, ...p.filesystem.deny, ...(p.additionalDirectories ?? [])]) {
        expect(rule).not.toContain('${HOME}/marveen')
      }
    }
  })

  // Every entry in a permission list must be a rule, not a path. A bare path
  // ("/mnt/e/Library/**") is not a rule, Claude Code does not match it against
  // anything, so it silently grants nothing while reading like a grant.
  // (PR #1357 fleet review, 2026-09-25, item 1e.)
  it('every allow/deny entry carries a tool prefix', () => {
    for (const id of PROFILE_IDS) {
      const p = loadProfileTemplate(id)
      for (const rule of [...p.filesystem.allow, ...p.filesystem.deny]) {
        // Tool(...), a bare tool name (WebSearch), or an MCP tool (mcp__srv__tool)
        expect(rule, `${id}: ${rule}`).toMatch(/^(mcp__\w|[A-Z][A-Za-z]*(\(|$))/)
      }
    }
  })

  // researcher is the most prompt-injection-exposed profile (external content,
  // draft-only), and it ships to every install. It gets only what the product
  // needs. Each assertion pins one item of the PR #1357 fleet review
  // (2026-09-25): a general interpreter sidesteps the whole deny list; store/
  // holds the dashboard and fleet tokens; a raw dashboard POST is any write,
  // not only memory and messaging (the agent-msg.sh / agent-mem.sh helpers
  // cover those); /mnt/... paths are one machine's layout, not the product's.
  it('researcher ships without the injection-exposed grants', () => {
    const p = loadProfileTemplate('researcher')
    const rules = [...p.filesystem.allow, ...(p.additionalDirectories ?? [])]
    expect(p.filesystem.allow.filter(r => /^Bash\((python3?|node|perl|ruby|bash -c|sh -c)\b/.test(r))).toEqual([])
    expect((p.additionalDirectories ?? []).filter(d => /\/store(\/|$)/.test(d))).toEqual([])
    expect(p.filesystem.allow.filter(r => /^Bash\(curl\b.*-X\s*POST/i.test(r))).toEqual([])
    expect(rules.filter(r => r.includes('/mnt/'))).toEqual([])
    // the product-needed grants stay
    expect(p.filesystem.allow).toContain('Bash(bash ${PROJECT_ROOT}/scripts/agent-mem.sh:*)')
    expect(p.filesystem.allow).toContain('Bash(pdf2txt.py:*)')
    expect(p.filesystem.allow).toContain('Write(${PROJECT_ROOT}/research-inbox/**)')
  })

  it('no template carries a Bash rule with a ** glob (prefix matching cannot glob)', () => {
    for (const id of PROFILE_IDS) {
      const p = loadProfileTemplate(id)
      for (const rule of [...p.filesystem.allow, ...p.filesystem.deny]) {
        if (rule.startsWith('Bash(')) expect(rule).not.toContain('**')
      }
    }
  })
})

describe('file-path rules only for the tools Claude Code consults (PERMWRITERULE927)', () => {
  // Claude Code checks file permissions against Read(path) and Edit(path) only;
  // Edit rules cover every file-editing tool, Write included. A Write(path) rule
  // is accepted and never consulted. MEASURED 2026-09-27 on CLI 2.1.283, -p probes
  // with controls: deny Edit(//dir/x) blocked the Write tool, deny Write(//dir/x)
  // did not (the file was created); --allowedTools Edit(//dir/**) let the write
  // through, Write(//dir/**) did not (refused), and the bare tool name Write did.
  // The CLI's own startup warning says the same ("is not matched by file
  // permission checks -- only Edit(path) rules are"). So such a rule in a
  // template reads like a grant or a deny that does not exist.
  const INERT_PATH_RULE = /^(Write|NotebookEdit|Glob|MultiEdit)\(/

  it('no shipped profile carries a path rule for Write, NotebookEdit, Glob or MultiEdit', () => {
    const offenders: string[] = []
    for (const p of listProfileTemplates()) {
      for (const r of [...p.filesystem.allow, ...p.filesystem.deny]) {
        if (INERT_PATH_RULE.test(r)) offenders.push(`${p.id}: ${r}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the check itself sees such a rule (negative control)', () => {
    expect(INERT_PATH_RULE.test('Write(${AGENT_DIR}/**)')).toBe(true)
    expect(INERT_PATH_RULE.test('Edit(${AGENT_DIR}/**)')).toBe(false)
    expect(INERT_PATH_RULE.test('WebFetch(*)')).toBe(false)
  })
})
