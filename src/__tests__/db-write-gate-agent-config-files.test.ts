// GATEFILES1110: the owner-gated agent settings are write-protected on the file route too. The API gates them
// (customProvider and a provider's baseUrl: owner-only, APIAGENTWRITE1104; raising a context-guard value: an owner
// session, OWNERGATE3-1104), and before this a Write or a `sed -i` on the file underneath went around that gate.
//   store/custom-providers.json, store/context-guard.json -- COMMON list: no agent writes them, the main agent included
//                                                            (only the dashboard, through its routes)
//   agents/*/agent-config.json                            -- SUB-AGENT list: any agent's file; the main agent's skills
//                                                            write it directly (model switch, displayName, oauthTokenFile)
// A read passes, a worktree's own copy stays free. A text brake, not an OS boundary.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, PROTECTED_INSTALL_PATHS, SUBAGENT_PROTECTED_INSTALL_PATHS, TARGET_SEGMENT_NAMES } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const STORE_FILES = ['custom-providers.json', 'context-guard.json']

let base: string
let root: string
let wt: string
let agent: string
let other: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-config-files-')))
  root = join(base, 'Install')
  wt = join(base, 'install-wt')
  agent = join(root, 'agents', 'samu')
  other = join(root, 'agents', 'qwen')
  for (const d of [root, wt]) {
    mkdirSync(join(d, 'store'), { recursive: true })
    for (const f of STORE_FILES) writeFileSync(join(d, 'store', f), '{}')
  }
  for (const d of [agent, other, join(wt, 'agents', 'samu')]) {
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'agent-config.json'), '{"model":"x"}')
  }
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const DENY = { deny: true, reason: 'install-file' }
const SUB = { deny: true, reason: 'subagent-file' }
const bash = (command: string, cwd: string, subAgent: boolean) =>
  gateDecision('Bash', { command: command.replaceAll('@ROOT@', root).replaceAll('@WT@', wt) }, { cwd, root, subAgent })
const file = (tool: string, file_path: string, cwd: string, subAgent: boolean) =>
  gateDecision(tool, { file_path, content: '{"customProvider":"x"}' }, { cwd, root, subAgent })

it('the lists: the two store files on the COMMON list, agent-config.json as a one-segment pattern on the SUB-AGENT list', () => {
  const common = PROTECTED_INSTALL_PATHS.map((t: { rel?: string }) => t.rel)
  const subOnly = SUBAGENT_PROTECTED_INSTALL_PATHS.filter((t: { pattern?: boolean }) => t.pattern).map((t: { rel: string }) => t.rel)
  for (const f of STORE_FILES) {
    expect(common).toContain(`store/${f}`)
    expect(TARGET_SEGMENT_NAMES.has(f)).toBe(true)
  }
  expect(common).not.toContain('agents/*/agent-config.json')
  expect(subOnly).toContain('agents/*/agent-config.json')
  expect(TARGET_SEGMENT_NAMES.has('agent-config.json')).toBe(true)
})

for (const who of [{ label: 'a sub-agent', subAgent: true, cwd: () => agent }, { label: 'the main agent', subAgent: false, cwd: () => root }]) {
  describe(`${who.label}: the two store files, every write denied`, () => {
    for (const f of STORE_FILES) {
      it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(`%s on store/${f}`, (tool) => {
        expect(file(tool, join(root, 'store', f), who.cwd(), who.subAgent)).toEqual(DENY)
      })
      it(`${f}: a symlink under another name, upper case`, () => {
        symlinkSync(join(root, 'store', f), join(base, 'innocent'))
        expect(file('Write', join(base, 'innocent'), who.cwd(), who.subAgent)).toEqual(DENY)
        expect(file('Write', join(root, 'STORE', f.toUpperCase()), who.cwd(), who.subAgent)).toEqual(DENY)
      })
      it.each([
        `echo '{}' > @ROOT@/store/${f}`,
        `echo x >> @ROOT@/store/${f}`,
        `jq '.x=1' @ROOT@/store/${f} | tee @ROOT@/store/${f}`,
        `sed -i '' 's/a/b/' @ROOT@/store/${f}`,
        `cp /tmp/x @ROOT@/store/${f}`,
        `mv /tmp/x @ROOT@/store/${f}`,
        `rm @ROOT@/store/${f}`,
        `python3 -c "open('@ROOT@/store/${f}','w').write('{}')"`,
        `cd @ROOT@/store && sed -i '' 's/a/b/' ${f}`,
      ])('Bash: %s', (command) => {
        expect(bash(command, who.cwd(), who.subAgent)).toEqual(DENY)
      })
      it(`${f}: a read passes, and a worktree's own copy is free`, () => {
        expect(bash(`cat @ROOT@/store/${f}`, who.cwd(), who.subAgent)).toEqual({ deny: false })
        expect(bash(`jq . @ROOT@/store/${f}`, who.cwd(), who.subAgent)).toEqual({ deny: false })
        expect(bash(`grep -c baseUrl @ROOT@/store/${f}`, who.cwd(), who.subAgent)).toEqual({ deny: false })
        expect(bash(`echo '{}' > @WT@/store/${f}`, who.cwd(), who.subAgent)).toEqual({ deny: false })
        expect(file('Write', join(wt, 'store', f), who.cwd(), who.subAgent)).toEqual({ deny: false })
      })
    }
  })
}

describe('a sub-agent: any agent\'s agent-config.json, every write denied', () => {
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s: its own and another agent\'s', (tool) => {
    expect(file(tool, join(agent, 'agent-config.json'), agent, true)).toEqual(SUB)
    expect(file(tool, join(other, 'agent-config.json'), agent, true)).toEqual(SUB)
  })
  it('a relative path, a symlink under another name', () => {
    expect(file('Edit', 'agent-config.json', agent, true)).toEqual(SUB)
    expect(file('Edit', '../qwen/agent-config.json', agent, true)).toEqual(SUB)
    symlinkSync(join(other, 'agent-config.json'), join(base, 'innocent'))
    expect(file('Write', join(base, 'innocent'), agent, true)).toEqual(SUB)
  })
  it.each([
    `echo '{"customProvider":"x"}' > agent-config.json`,
    `jq '.model="y"' agent-config.json | tee agent-config.json`,
    `sed -i '' 's/x/y/' agent-config.json`,
    `sed -i '' 's/x/y/' ../qwen/agent-config.json`,
    `cp /tmp/x @ROOT@/agents/qwen/agent-config.json`,
    `mv /tmp/x agent-config.json`,
    `rm @ROOT@/agents/qwen/agent-config.json`,
    `python3 -c "open('agent-config.json','w').write('{}')"`,
    `cd ../qwen && sed -i '' 's/x/y/' agent-config.json`,
    `cp /tmp/x @ROOT@/agents/*/agent-config.json`,
  ])('Bash: %s', (command) => {
    expect(bash(command, agent, true)).toEqual(SUB)
  })
  it('a read passes, and a worktree\'s own copy is free', () => {
    expect(bash('cat agent-config.json', agent, true)).toEqual({ deny: false })
    expect(bash('jq -r .model @ROOT@/agents/qwen/agent-config.json', agent, true)).toEqual({ deny: false })
    expect(bash(`echo '{}' > @WT@/agents/samu/agent-config.json`, agent, true)).toEqual({ deny: false })
    expect(file('Write', join(wt, 'agents', 'samu', 'agent-config.json'), agent, true)).toEqual({ deny: false })
  })
})

describe('the main agent: agent-config.json stays writable (its skills write it directly)', () => {
  it('Write, Edit and the skills\' shell forms pass', () => {
    expect(file('Write', join(agent, 'agent-config.json'), root, false)).toEqual({ deny: false })
    expect(file('Edit', join(other, 'agent-config.json'), root, false)).toEqual({ deny: false })
    expect(bash(`jq '.model="y"' agents/samu/agent-config.json > /tmp/a && mv /tmp/a agents/samu/agent-config.json`, root, false)).toEqual({ deny: false })
    expect(bash(`sed -i '' 's/x/y/' agents/qwen/agent-config.json`, root, false)).toEqual({ deny: false })
  })
})
