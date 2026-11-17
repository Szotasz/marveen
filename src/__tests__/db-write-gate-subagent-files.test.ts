// ENVRELAXGATE1104 (Dani's plan v2, Samu 67732/67752/67763): files whose one write turns a gate off or gives an agent a
// right are write-protected for a SUB-AGENT, with the db-write-gate's real-path engine: the install root's .env (SUDO_AGENTS,
// MAIN_AGENT_ID, the hooks' relaxing switches) and five gate-rule files under store/. The main agent writes the .env
// legitimately and stays free. A read passes (the seed skills read the port with sed -n). A worktree's own copy is free.
// A text brake, not an OS boundary.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, isSubAgentCaller, SUBAGENT_PROTECTED_INSTALL_PATHS, INSTALL_ROOT } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

// CHANNELUNCONF1110 (Dani #2691 K1): channels.sh's .channel-unconfigured marker joins them (only channels.sh writes it).
// PLANSFILEGATE1111 (Samu 75712): claude-plans.json too (only the owner-gated /api/claude-plans writes it).
const STORE_FILES = ['provenance-gate-rules.json', 'outgoing-copy-gate-rules.json', 'credential-gate.json', 'egress-measure-hosts.json', '.fleet-memgate-observe', '.channel-unconfigured', 'claude-plans.json']
const MISSING_TODAY = ['provenance-gate-rules.json', 'credential-gate.json', '.fleet-memgate-observe', '.channel-unconfigured']

let base: string
let root: string
let wt: string
let agentDir: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-files-')))
  root = join(base, 'Install')
  wt = join(base, 'install-wt')
  agentDir = join(root, 'agents', 'samu')
  for (const d of [root, wt]) {
    mkdirSync(join(d, 'store'), { recursive: true })
    mkdirSync(join(d, '.claude'), { recursive: true })
    writeFileSync(join(d, '.env'), 'WEB_PORT=3420\n')
    writeFileSync(join(d, 'store', 'outgoing-copy-gate-rules.json'), '{}')
    writeFileSync(join(d, 'store', 'egress-measure-hosts.json'), '[]')
  }
  mkdirSync(agentDir, { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const SUB = { deny: true, reason: 'subagent-file' }
const sub = (command: string, cwd = root) => gateDecision('Bash', { command: command.replaceAll('@ROOT@', root).replaceAll('@WT@', wt) }, { cwd, root, subAgent: true })
const main = (command: string, cwd = root) => gateDecision('Bash', { command: command.replaceAll('@ROOT@', root) }, { cwd, root, subAgent: false })
const subFile = (tool: string, file_path: string, cwd = root) => gateDecision(tool, { file_path, content: 'x' }, { cwd, root, subAgent: true })
const mainFile = (tool: string, file_path: string, cwd = root) => gateDecision(tool, { file_path, content: 'x' }, { cwd, root, subAgent: false })

it('the sub-agent list is exactly the plan\'s: the root .env, five store files, the shared ~/.claude settings (Dani 67841), the main agent\'s isolated config dir (Samu 68210), the MCP server lists (ENVRELAXMCPCFG1104)', () => {
  // .channels-config/.claude.json is covered by the .channels-config directory entry (#2503), not listed twice.
  expect(SUBAGENT_PROTECTED_INSTALL_PATHS.map((t: { rel?: string; home?: string }) => t.rel ?? `~/${t.home}`))
    .toEqual(['.env', ...STORE_FILES.map((f) => `store/${f}`), '~/.claude/settings.json', '~/.claude/settings.local.json', '.channels-config',
      'agents/*/.mcp.json', 'agents/*/.claude-config/.claude.json', 'agents/*/.claude-config/.marveen-mcp-inherited.json',
      '.mcp.json', '~/.claude.json',
      // PLUGINCODEWRITE1104: the plugin trees and the shared user-level trees
      '~/.claude/plugins', 'plugins', '~/marveen-local-plugins', '~/.claude/agents', '~/.claude/skills', '~/.claude/hooks',
      'agents/*/.claude-config/plugins/installed_plugins.json', 'agents/*/.claude-config/plugins/known_marketplaces.json',
      // WORKERCFGDIR1104: the two workers' start-up files (the config dirs contain #2505's plugins entries)
      ...['.marveen-worker', '.marveen-worker-fast'].flatMap((w) => ['.claude-config', '.claude', '.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md'].map((f) => `~/${w}/${f}`)),
      // CHANSTATEWRITE1104: the channel trust files and dirs under the three state roots
      ...['~/.claude/channels', '.claude/channels', 'agents/*/.claude/channels'].flatMap((b) => [
        'access.json', '.env', 'invites.json', 'inbound-evidence.jsonl', 'inbound-evidence.jsonl.1', 'inbox-pending.jsonl',
        'inbox-draining-*.jsonl', 'allowlist.json', 'pending.json', 'audit.jsonl', 'own-threads.json', 'bot.pid', 'coordinator.pid',
        // SLACKOUTDM1007: the Slack plugin's persisted allowFrom DMs and their atomic-write temporary name
        'delivered-dms.json', 'delivered-dms.json.tmp.*',
        'progress', 'approved'].map((f) => `${b}/*/${f}`)),
      // TGINREPLAYGATE1104: the Telegram state directories above the evidence log, as targets only
      'agents/*/.claude/channels/telegram', 'agents/*/.claude/channels',
      // GATEFILES1110: any agent's agent-config.json
      'agents/*/agent-config.json',
      // SUBPLANTOKEN1110 follow-up: the token-plan launch outcomes the rotate endpoint reads back
      'store/plan-token-launch'])
})

describe('the install .env, as a sub-agent: every write denied', () => {
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s', (tool) => {
    expect(subFile(tool, join(root, '.env'))).toEqual(SUB)
  })
  it('a relative path from the agent directory, a symlink under another name, upper case', () => {
    expect(subFile('Edit', '../../.env', agentDir)).toEqual(SUB)
    symlinkSync(join(root, '.env'), join(base, 'innocent'))
    expect(subFile('Write', join(base, 'innocent'))).toEqual(SUB)
    expect(subFile('Write', join(root, '.ENV'))).toEqual(SUB)
  })
  it.each([
    'echo X=1 > .env',
    'echo X=1 >> .env',
    'echo X=1 >| .env',
    'echo X=1 | tee -a .env',
    'sed -i "" "s/=off/=on/" .env',
    'cp /tmp/x .env',
    'mv /tmp/x .env',
    'dd if=/tmp/x of=.env',
    'install -m 600 /tmp/x .env',
    'rm .env',
    'python3 -c "open(\'.env\',\'a\').write(\'X=1\')"',
    'echo X=1 >> @ROOT@/.env',
  ])('Bash: %s', (command) => {
    expect(sub(command)).toEqual(SUB)
  })
  it('Samu 67763: SUDO_AGENTS and MAIN_AGENT_ID lines are denied (sudo at the next respawn; the governance exemption)', () => {
    expect(sub('echo "SUDO_AGENTS=samu" >> .env')).toEqual(SUB)
    expect(sub('printf "MAIN_AGENT_ID=samu\\n" >> @ROOT@/.env', agentDir)).toEqual(SUB)
    expect(subFile('Edit', join(root, '.env'))).toEqual(SUB)
  })
  it('a cd trick and ../.. from the agent directory', () => {
    expect(sub('cd @ROOT@ && echo X=1 >> .env', agentDir)).toEqual(SUB)
    expect(sub('echo X=1 >> ../../.env', agentDir)).toEqual(SUB)
  })
  it('"$WT/.env" (an unresolved variable before the protected tail) is denied, and says so', () => {
    expect(sub('echo X=1 >> "$WT/.env"')).toEqual(SUB)
  })
})

describe('the five store files, as a sub-agent: create, write and delete denied', () => {
  for (const f of STORE_FILES) {
    it(`${f}: Write, a redirect, rm, mv away`, () => {
      expect(subFile('Write', join(root, 'store', f))).toEqual(SUB)
      expect(sub(`echo '{"enabled": false}' > store/${f}`)).toEqual(SUB)
      expect(sub(`rm -f store/${f}`)).toEqual(SUB)
      expect(sub(`mv store/${f} /tmp/`)).toEqual(SUB)
    })
  }
  for (const f of MISSING_TODAY) {
    it(`${f} does not exist yet: CREATING it is a write (touch, Write)`, () => {
      expect(sub(`touch store/${f}`)).toEqual(SUB)
      expect(subFile('Write', join(root, 'store', f))).toEqual(SUB)
    })
  }
})

// PLANSFILEGATE1111 (Samu 75712): store/claude-plans.json decides which Claude subscription each agent runs on, and the
// owner-gated POST /api/claude-plans (OWNERGATE2-1104) writes it. A sub-agent writing it directly went around that gate
// (measured on develop 6a268b71: Write and `echo >` both passed). The main agent and every read stay free.
describe('store/claude-plans.json: a sub-agent cannot write it, the main agent and a read can', () => {
  const plans = () => join(root, 'store', 'claude-plans.json')
  beforeEach(() => { writeFileSync(plans(), '[]\n') })
  it('a sub-agent: Write, Edit, sed -i, a redirect from the store dir, cp over it, rm from its parent', () => {
    expect(subFile('Write', plans(), agentDir)).toEqual(SUB)
    expect(subFile('Edit', plans(), agentDir)).toEqual(SUB)
    expect(sub(`sed -i '' 's/a/b/' @ROOT@/store/claude-plans.json`, agentDir)).toEqual(SUB)
    expect(sub(`cd @ROOT@/store && echo '[{"id":"x","label":"$(id)"}]' > claude-plans.json`, agentDir)).toEqual(SUB)
    expect(sub(`cp /tmp/p.json @ROOT@/store/claude-plans.json`, agentDir)).toEqual(SUB)
    expect(sub('rm -f claude-plans.json', join(root, 'store'))).toEqual(SUB)
  })
  it('a sub-agent may read it (the measuring probes do)', () => {
    expect(sub('cat @ROOT@/store/claude-plans.json', agentDir).deny).toBe(false)
    expect(sub(`jq '.[].id' @ROOT@/store/claude-plans.json`, agentDir).deny).toBe(false)
  })
  it('the main agent stays free (nothing of it writes the file with a tool call today, but it may)', () => {
    expect(mainFile('Write', plans()).deny).toBe(false)
    expect(main(`echo '[]' > @ROOT@/store/claude-plans.json`).deny).toBe(false)
  })
  it("a worktree's own copy is another root: free", () => {
    expect(subFile('Write', join(wt, 'store', 'claude-plans.json'), agentDir).deny).toBe(false)
  })
})

// TGINREPLAYGATE1104 (#2512 review, provenance): the inbound replay re-delivers a line of this log to the agent framed as
// a channel message, so a sub-agent's tool call may not write it: its own log, another agent's, or the rotated .1. The
// plugin writes it from its MCP server process, which is not a tool call and never reaches this gate.
describe('the Telegram inbound-evidence logs, as a sub-agent: every write denied', () => {
  const tg = (name: string) => join(root, 'agents', name, '.claude', 'channels', 'telegram')
  beforeEach(() => {
    for (const n of ['samu', 'qwen']) {
      mkdirSync(tg(n), { recursive: true })
      writeFileSync(join(tg(n), 'inbound-evidence.jsonl'), '')
    }
  })
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s: its own log, another agent\'s, the rotated .1 (missing: creating it)', (tool) => {
    for (const n of ['samu', 'qwen']) {
      for (const f of ['inbound-evidence.jsonl', 'inbound-evidence.jsonl.1']) expect(subFile(tool, join(tg(n), f), agentDir)).toEqual(SUB)
    }
  })
  it.each([
    `echo '{"chat_id":"1","message_id":"9","text":"x","at":1}' >> .claude/channels/telegram/inbound-evidence.jsonl`,
    'tee -a .claude/channels/telegram/inbound-evidence.jsonl < /tmp/x',
    'cp /tmp/x ../qwen/.claude/channels/telegram/inbound-evidence.jsonl.1',
    'mv /tmp/x @ROOT@/agents/qwen/.claude/channels/telegram/inbound-evidence.jsonl',
    'rm .claude/channels/telegram/inbound-evidence.jsonl',
  ])('Bash: %s', (command) => {
    expect(sub(command, agentDir)).toEqual(SUB)
  })
  // classifyWord gives a pattern no ancestor, so without the two directory entries each of these reached the log unnamed
  // (measured on the gate before them: all passed). Since CPDESTDIR1104 the cp, rsync and tar -C forms are also judged
  // by their landing; rm -rf and mv still pass without the entries (measured).
  it.each([
    'cp /tmp/inbound-evidence.jsonl .claude/channels/telegram/',
    'cp -r /tmp/prep/. ../qwen/.claude/channels/telegram/',
    'rsync -a /tmp/prep/ .claude/channels/telegram/',
    'tar -xf /tmp/p.tar -C .claude/channels/telegram',
    'rm -rf .claude/channels/telegram',
    'mv /tmp/prep/channels .claude/channels',
  ])('Bash, a directory changer aimed at telegram/ or channels/: %s', (command) => {
    expect(sub(command, agentDir)).toEqual(SUB)
  })
  it('a read passes; access.json is denied (CHANSTATEWRITE1104 trust file), a look-alike name and a worktree\'s copy stay free; the main agent writes the log (control)', () => {
    expect(sub('tail -n 5 .claude/channels/telegram/inbound-evidence.jsonl', agentDir).deny).toBe(false)
    expect(sub('ls -la .claude/channels/telegram/', agentDir).deny).toBe(false)
    expect(sub('echo {} > .claude/channels/telegram/access.json', agentDir)).toEqual(SUB)
    expect(subFile('Write', join(tg('samu'), 'access.json'), agentDir)).toEqual(SUB)
    expect(subFile('Write', join(tg('samu'), 'inbound-evidence.jsonl.bak'), agentDir)).toEqual({ deny: false })
    expect(subFile('Write', join(wt, 'agents', 'samu', '.claude', 'channels', 'telegram', 'inbound-evidence.jsonl'))).toEqual({ deny: false })
    expect(mainFile('Write', join(tg('samu'), 'inbound-evidence.jsonl'))).toEqual({ deny: false })
  })
})

describe('what stays free', () => {
  it.each([
    'cat .env',
    'grep WEB_PORT .env',
    "sed -n 's/^WEB_PORT=//p' .env",
    "sed -n '/^WEB_PORT=/p' .env",
    'cat store/outgoing-copy-gate-rules.json',
    'jq . store/egress-measure-hosts.json',
  ])('a read, as a sub-agent: %s', (command) => {
    expect(sub(command).deny).toBe(false)
  })
  it('the seed skills\' exact port read (handoff, retrospective) from where a sub-agent runs it: its own directory', () => {
    const seed = `PORT="$(sed -n 's/^WEB_PORT=//p' .env 2>/dev/null | head -1 | tr -d '"')"; PORT="\${PORT:-3420}"`
    expect(sub(seed, agentDir).deny).toBe(false)
    // from the install root itself the quoted substitution cannot be split, and it names the root .env: denied, as the
    // engine denies every unsplittable quoting that names a protected path (stated in the PR)
    expect(sub(seed, root)).toEqual(SUB)
  })
  it('a sed that WRITES (the w flag, -i) is not a read', () => {
    expect(sub("sed -n 's/a/b/w .env' /tmp/in")).toEqual(SUB)
    expect(sub("sed -n 's/a/b/w' .env")).toEqual(SUB) // the w flag alone makes it a writer, not a print
    expect(sub("sed -n 's/a/b/e' .env")).toEqual(SUB) // e runs a command
    expect(sub("sed -i '' 's/a/b/' .env")).toEqual(SUB)
  })
  it('a worktree\'s own .env and store files, as a sub-agent', () => {
    expect(subFile('Write', join(wt, '.env'))).toEqual({ deny: false })
    expect(sub('echo X=1 >> .env', wt).deny).toBe(false)
    expect(sub('echo {} > store/credential-gate.json', wt).deny).toBe(false)
  })
  it('the agent\'s own directory .env, and .env.example', () => {
    expect(subFile('Write', join(agentDir, '.env'))).toEqual({ deny: false })
    expect(subFile('Write', join(root, '.env.example'))).toEqual({ deny: false })
  })
})

describe('the main agent: the .env and the store files stay writable (control)', () => {
  it('Write, Edit and Bash on the root .env pass for the main agent', () => {
    expect(mainFile('Write', join(root, '.env'))).toEqual({ deny: false })
    expect(mainFile('Edit', join(root, '.env'))).toEqual({ deny: false })
    expect(main('echo X=1 >> .env').deny).toBe(false)
    expect(main('echo {} > store/credential-gate.json').deny).toBe(false)
  })
  it('the common list still holds for the main agent (unchanged): .claude/settings.json is denied', () => {
    expect(mainFile('Write', join(root, '.claude', 'settings.json'))).toEqual({ deny: true, reason: 'install-file' })
  })
  it('`>|` is a redirection, not a pipe: it was a live bypass of the COMMON list too (measured before the fix)', () => {
    expect(main('echo x >| .claude/settings.json')).toEqual({ deny: true, reason: 'install-file' })
    expect(main('echo x 2>| .claude/settings.json')).toEqual({ deny: true, reason: 'install-file' })
    expect(main('echo x >| /tmp/out | cat').deny).toBe(false)
  })
  it('isSubAgentCaller: the install root is the main agent; agents/<name>, any other dir and an unset dir are not', () => {
    expect(isSubAgentCaller(root, root)).toBe(false)
    expect(isSubAgentCaller(join(root, '.'), root)).toBe(false)
    expect(isSubAgentCaller(agentDir, root)).toBe(true)
    expect(isSubAgentCaller(wt, root)).toBe(true)
    expect(isSubAgentCaller(undefined, root)).toBe(true)
    expect(isSubAgentCaller('', root)).toBe(true)
  })
})

describe('the hook end to end (the caller from CLAUDE_PROJECT_DIR)', () => {
  const hook = join(__dirname, '..', '..', 'scripts', 'hooks', 'db-write-gate.mjs')
  const run = (projectDir: string | undefined, payload: unknown) => {
    const env = { ...process.env }
    delete env.CLAUDE_PROJECT_DIR
    if (projectDir !== undefined) env.CLAUDE_PROJECT_DIR = projectDir
    return spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf-8', env })
  }
  const envWrite = { tool_name: 'Bash', tool_input: { command: 'echo SUDO_AGENTS=x >> .env' }, cwd: INSTALL_ROOT }

  it('a sub-agent (agents/<name>) is denied with the sub-agent message', () => {
    const r = run(join(INSTALL_ROOT, 'agents', 'samu'), envWrite)
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain('ENVRELAXGATE1104')
    expect(reason).toContain('fo agenst')
  })
  it('an unset project dir is taken as a sub-agent (fail-closed)', () => {
    expect(JSON.parse(run(undefined, envWrite).stdout).hookSpecificOutput.permissionDecisionReason).toContain('ENVRELAXGATE1104')
  })
  it('POSITIVE CONTROL: the main agent (the install root) passes', () => {
    const r = run(INSTALL_ROOT, envWrite)
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })
  it('POSITIVE CONTROL: a sub-agent\'s read passes', () => {
    const r = run(join(INSTALL_ROOT, 'agents', 'samu'), { tool_name: 'Bash', tool_input: { command: "sed -n 's/^WEB_PORT=//p' .env" }, cwd: INSTALL_ROOT })
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })
})

// SUBPLANTOKEN1110 follow-up (Dani 75495 (2)): the token-plan launch outcomes the rotate endpoint reads back.
describe('store/plan-token-launch, as a sub-agent: a write is denied, a read and the main agent pass', () => {
  beforeEach(() => {
    for (const d of [root, wt]) {
      mkdirSync(join(d, 'store', 'plan-token-launch'), { recursive: true })
      writeFileSync(join(d, 'store', 'plan-token-launch', 'iris.json'), '{"state":"failed","secretId":"s","at":1}')
    }
  })
  it.each(['Write', 'Edit'])('%s of another agent\'s status, and of a new one', (tool) => {
    expect(subFile(tool, join(root, 'store', 'plan-token-launch', 'iris.json'))).toEqual(SUB)
    expect(subFile(tool, join(root, 'store', 'plan-token-launch', 'zara.json'))).toEqual(SUB)
  })
  it.each([
    'echo \'{"state":"plan-token","secretId":"s","at":9999999999999}\' > @ROOT@/store/plan-token-launch/iris.json',
    'cp /tmp/fake.json @ROOT@/store/plan-token-launch/iris.json',
    'rm @ROOT@/store/plan-token-launch/iris.json',
  ])('Bash: %s', (command) => {
    expect(sub(command)).toEqual(SUB)
  })
  it('a read passes, the main agent passes, and a worktree\'s own copy is free', () => {
    expect(sub('cat @ROOT@/store/plan-token-launch/iris.json').deny).toBe(false)
    expect(mainFile('Write', join(root, 'store', 'plan-token-launch', 'iris.json')).deny).toBe(false)
    expect(sub('echo x > @WT@/store/plan-token-launch/iris.json').deny).toBe(false)
  })
})

// SUBPLANTOKEN1110 (Dani 75621): the bare directory name from its parent, with no path-like word in the command.
describe('store/plan-token-launch by its bare name, from store/ (TARGET_SEGMENT_NAMES)', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'store', 'plan-token-launch'), { recursive: true })
    writeFileSync(join(root, 'store', 'plan-token-launch', 'iris.json'), '{"state":"failed","secretId":"s","at":1}')
  })
  it.each([
    'cd @ROOT@/store && rm -rf plan-token-launch',
    'rm -rf plan-token-launch',
    'mv plan-token-launch x',
  ])('%s, as a sub-agent in store/: denied', (command) => {
    expect(sub(command, join(root, 'store'))).toEqual(SUB)
  })
  it('the same from a worktree\'s own store is free, and a read passes', () => {
    mkdirSync(join(wt, 'store', 'plan-token-launch'), { recursive: true })
    expect(sub('rm -rf plan-token-launch', join(wt, 'store')).deny).toBe(false)
    expect(sub('ls plan-token-launch', join(root, 'store')).deny).toBe(false)
  })
})
