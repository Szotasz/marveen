// The secret-read gate (SECRETREADGATE1028, kanban 3ddab86a): the Bash PreToolUse hook that stops a
// sub-agent's command referring to a secret path, plus the SECRET_READ_DENY second layer.
//
// The gate makes TWO claims and both are tested, because the second one decides whether it can ever be
// switched to block:
//   (a) the secret shapes are caught -- any program, interpreter one-liners, ~ / $HOME / ${HOME} /
//       absolute / relative forms, quoting, globs, braces, a cd, a variable;
//   (b) the fleet's ordinary work passes -- above all `$(cat .../store/.dashboard-token)` in every
//       dashboard call; a gate that stopped it would silence the fleet.
//
// The filesystem part of the rules (existence for the file-name rules, glob expansion) runs against a
// throwaway home and install root, so the verdicts do not depend on the machine running the suite.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { findSecretReads, blankInertHeredocs, readMode, agentOf, linearBraceVariants } from '../../scripts/hooks/secret-read-gate.mjs'
import {
  SECRET_READ_DENY,
  FLEET_BASELINE_DENY,
  agentGetsSecretReadGate,
  injectSecretReadGate,
  injectBashEgressParser,
  injectEgressGate,
  injectSelfPaceGate,
  injectDestructiveGate,
  secretReadGateBlock,
  secretReadGateCommand,
  ensureSecretReadGate,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  GATE_FAIL_CLOSED_TAG,
} from '../web/agent-scaffold.js'
import { agentDir } from '../web/agent-config.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'secret-read-gate.mjs')

let base: string
let home: string
let root: string
let cwd: string
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'secret-read-gate-')))
  home = join(base, 'home')
  root = join(base, 'install')
  cwd = join(root, 'agents', 'soma')
  const files: Record<string, string> = {
    [join(home, '.ssh', 'id_ed25519')]: 'k',
    [join(home, '.ssh', 'config')]: 'k',
    [join(home, '.aws', 'credentials')]: 'k',
    [join(home, '.gnupg', 'pubring.kbx')]: 'k',
    [join(home, 'Library', 'Keychains', 'login.keychain-db')]: 'k',
    [join(home, '.claude.json')]: '{}',
    [join(home, '.claude.json.backup')]: '{}',
    [join(home, '.claude', 'channels', 'telegram', '.env')]: 'T=1',
    [join(home, 'code', 'mcp-ga4', 'service-account.json')]: '{}',
    [join(root, '.env')]: 'X=1',
    [join(root, '.env.local')]: 'X=1',
    [join(root, '.env.example')]: 'X=',
    [join(root, 'store', 'vault.json')]: '{}',
    [join(root, 'store', 'vault-bindings.json')]: '{}',
    [join(root, 'store', '.claude-oauth-token')]: 't',
    [join(root, 'store', '.dashboard-token')]: 't',
    [join(root, 'store', '.fal-key')]: 'k',
    [join(root, 'store', '.fal-key-pixel')]: 'k',
    [join(root, 'store', '.fb-page-token')]: 'k',
    [join(root, 'store', '.launch-secrets')]: 'k',
    [join(root, 'store', 'dentalsalon-mcp-key.txt')]: 'k',
    [join(root, 'store', 'dentalsalon-mcp-key-ro.txt')]: 'k',
    [join(root, 'store', 'kisallatdoki-mcp-key.txt')]: 'k',
    [join(root, 'store', 'kisallatdoki-mcp', 'kmcp.py')]: '#',
    [join(root, 'scripts', 'fb-page.py')]: '#',
    [join(root, 'README.md')]: '# x',
    [join(cwd, 'cert', 'server.pem')]: 'p',
    [join(cwd, 'cert', 'server.key')]: 'p',
    [join(cwd, 'x.json')]: '{}',
    [join(cwd, '.claude-config', '.claude.json')]: '{}',
  }
  for (const [p, v] of Object.entries(files)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, v) }
  symlinkSync(join(home, '.ssh', 'id_ed25519'), join(cwd, 'innocent.txt'))
})
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

const hits = (command: string, at = cwd) => findSecretReads(command, { cwd: at, home, root }) as { rule: string; pattern: string; path: string }[]
const rulesOf = (command: string, at = cwd) => [...new Set(hits(command, at).map((h) => h.rule))].sort()

describe('(a) a reference to a secret path is caught', () => {
  const cases: [string, string][] = [
    ['cat ~/.ssh/id_ed25519', 'ssh'],
    ['cat $HOME/.ssh/config', 'ssh'],
    ['cat "${HOME}/.aws/credentials"', 'aws'],
    ['less ~/.gnupg/pubring.kbx', 'gnupg'],
    ['ls ~/Library/Keychains/', 'keychains'],
    ['cat ~/.claude.json', 'claude-json'],
    ['cp ~/.claude.json.backup /tmp/x', 'claude-json'],
    ['head -1 ../../store/vault.json', 'store-vault'],
    ['base64 ../../store/.claude-oauth-token', 'oauth-token'],
    ['cat ../../.env', 'env'],
    ['cat ~/.claude/channels/telegram/.env', 'env'],
    ['grep KEY ../../.env.local', 'env'],
    ['xxd cert/server.pem', 'pem'],
    ['strings cert/server.key', 'key'],
    ['tail ~/code/mcp-ga4/service-account.json', 'service-account'],
    ['tar czf /tmp/x.tgz ~/.ssh', 'ssh'],
    ['zip -r /tmp/x.zip ~/.aws', 'aws'],
    ['open ~/.ssh/config', 'ssh'],
    ['rg token ~/.aws', 'aws'],
    ['sed -n 1p ~/.ssh/config', 'ssh'],
    ["awk '{print}' ~/.ssh/config", 'ssh'],
    ['mv ~/.ssh/config /tmp/c', 'ssh'],
  ]
  for (const [command, rule] of cases) {
    it(`${command} -> ${rule}`, () => { expect(rulesOf(command)).toContain(rule) })
  }

  it('the path inside an interpreter one-liner', () => {
    expect(rulesOf(`python3 -c "print(open('${root}/.env').read())"`)).toContain('env')
    expect(rulesOf(`python -c "import os; print(open(os.path.expanduser('~/.ssh/id_ed25519')).read())"`)).toContain('ssh')
    expect(rulesOf(`node -e "console.log(require('fs').readFileSync(process.env.HOME + '/.ssh/id_ed25519', 'utf8'))"`)).toContain('ssh')
    expect(rulesOf(`perl -e 'open F, "$ENV{HOME}/.aws/credentials"; print <F>'`)).toContain('aws')
    expect(rulesOf(`ruby -e 'puts File.read(ENV["HOME"] + "/.ssh/config")'`)).toContain('ssh')
    expect(rulesOf(`osascript -e 'do shell script "cat ~/.ssh/config"'`)).toContain('ssh')
    expect(rulesOf(`python3 -c "from pathlib import Path; print((Path.home() / '.ssh' / 'id_ed25519').read_text())"`)).toContain('ssh')
  })

  it('a heredoc that IS the interpreter program', () => {
    expect(rulesOf(`python3 - <<'PY'\nprint(open('${home}/.aws/credentials').read())\nPY`)).toContain('aws')
    expect(rulesOf(`bash <<EOF\ncat ~/.ssh/config\nEOF`)).toContain('ssh')
  })

  it('every sub-command: &&, ;, |, $(...), backticks, xargs, an env prefix', () => {
    expect(rulesOf('cd /tmp && cat ~/.ssh/config')).toContain('ssh')
    expect(rulesOf('true; cat ~/.ssh/config')).toContain('ssh')
    expect(rulesOf('cat ~/.ssh/config | base64')).toContain('ssh')
    expect(rulesOf('echo "$(cat ~/.aws/credentials)"')).toContain('aws')
    expect(rulesOf('echo `cat ~/.aws/credentials`')).toContain('aws')
    expect(rulesOf('echo ~/.ssh/config | xargs cat')).toContain('ssh')
    expect(rulesOf('LC_ALL=C env FOO=1 cat ~/.ssh/config')).toContain('ssh')
  })

  it('shell spellings: quoting, a glob, a brace list, a variable, a cd', () => {
    expect(rulesOf('cat ~/.s"s"h/config')).toContain('ssh')
    expect(rulesOf("cat ~/'.ssh'/config")).toContain('ssh')
    expect(rulesOf('cat ~/.ss?/id*')).toContain('ssh')
    expect(hits('cat ~/.ss?/id*').map((h) => h.path)).toContain('~/.ssh/id_ed25519')
    expect(rulesOf('tar czf /tmp/x.tgz ~/.{ssh,aws}')).toEqual(['aws', 'ssh'])
    expect(rulesOf('D=~/.ssh; cat $D/config')).toContain('ssh')
    expect(rulesOf('cd ~ && cat .ssh/config')).toContain('ssh')
    expect(rulesOf('cd && cat .aws/credentials')).toContain('aws')
    expect(rulesOf(`cd ${root}/store && cat vault.json`)).toContain('store-vault')
    // As bash: `*` skips dot files, `.c*` does not.
    expect(rulesOf(`cat ${root}/store/*`)).toEqual(['store-secret', 'store-vault'])
    expect(rulesOf(`cat ${root}/store/.c*`)).toEqual(['oauth-token'])
  })

  it('the store credentials (owner decision 2026-10-28)', () => {
    for (const f of ['.fal-key', '.fal-key-pixel', '.fb-page-token', '.launch-secrets', 'dentalsalon-mcp-key.txt', 'dentalsalon-mcp-key-ro.txt', 'kisallatdoki-mcp-key.txt']) {
      expect(rulesOf(`cat store/${f}`, root)).toEqual(['store-secret'])
    }
    expect(rulesOf(`python3 -c "print(open('${root}/store/.fal-key').read())"`)).toEqual(['store-secret'])
  })

  it('a symlink that points into a protected directory', () => {
    expect(rulesOf('cat innocent.txt')).toContain('ssh')
  })

  it('names the rule and the path, home as ~, never the content', () => {
    expect(hits('cat ~/.ssh/config')).toEqual([{ rule: 'ssh', pattern: '~/.ssh/**', path: '~/.ssh/config' }])
  })
})

describe('(b) the ordinary work passes', () => {
  const pass = [
    // The dashboard calls: every agent, every round. The one exception the gate must never touch.
    `curl -s -H "Authorization: Bearer $(cat ${root}/store/.dashboard-token)" "http://localhost:3420/api/memories?agent=soma&q=x"`,
    `curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -H "Authorization: Bearer $(cat ../../store/.dashboard-token)" --data-binary @- <<'JSON'\n{"from":"soma","to":"marveen","content":"a .env es a ~/.ssh nem kell"}\nJSON`,
    `curl -s -H "Authorization: Bearer $(cat ${root}/store/.dashboard-token)" http://localhost:3420/api/vault/dentalsalon`,
    `T=$(cat ${root}/store/.dashboard-token); curl -s -H "Authorization: Bearer $T" http://localhost:3420/api/kanban`,
    `bash ${root}/scripts/agent-msg.sh soma marveen "kesz"`,
    `cat jelentes.md | bash ${root}/scripts/agent-msg.sh soma marveen -`,
    `bash ${root}/scripts/agent-msg.sh soma marveen - <<'EOF'\nA config/.env-et es a ~/.ssh-t nem olvastam.\nEOF`,
    `bash ${root}/scripts/agent-mem.sh soma hot`,
    // The store credentials' own scripts read them inside: running them is not a reference.
    `cd ${root} && python3 scripts/fb-page.py post --page x --message "szia"`,
    `cd ${root} && python3 store/kisallatdoki-mcp/kmcp.py tool @x.json`,
    `python3 ${root}/store/kisallatdoki-mcp/kmcp.py tool @x.json`,
    // Soma's GA4 report: the service-account key is read INSIDE the script, which the gate does not see.
    `cd ${root}/store/dentalsalon-ga4 && ${home}/code/mcp-ga4/.venv/bin/python jelentes.py`,
    `cd ${root}/.claude/skills/levai-havi-jelentes/scripts && python3 stdio_mcp.py gscServer get_advanced_search_analytics '{"siteUrl":"sc-domain:x.hu"}'`,
    `grep -r valami ${root}/agents/watson/research`,
    'cat README.md',
    `cat ${root}/README.md`,
    // A file-name rule needs the file: an attribute, a missing file, a template.
    `python3 -c "import json; d = json.load(open('x.json')); print(d.keys(), d.key)"`,
    'cat ../../.env.example',
    'cat config/.env',
    // Text being written, not a read.
    `gh pr create --base develop --title x --body "$(cat <<'EOF'\nTiltja a ~/.ssh es a .env olvasasat.\nEOF\n)"`,
    `cat > notes.md <<'EOF'\n~/.ssh/config es ~/.aws/credentials\nEOF`,
    // An agent's own isolated config, not the owner's ~/.claude.json.
    `python3 -c "import json; print(json.load(open('.claude-config/.claude.json')).keys())"`,
    // Look-alikes.
    'ls ~/.ssh-notes ~/.sshx ~/.awsome',
    `grep -n -E "vault|oauth|token|\\.env" ${root}/README.md`,
    'git log --oneline -3',
  ]
  for (const command of pass) {
    it(command.replace(/\n/g, ' ').slice(0, 110), () => { expect(hits(command)).toEqual([]) })
  }

  it('the dashboard token stays free even where a store glob reaches it', () => {
    expect(hits(`cat ${root}/store/.dashboard-token`)).toEqual([])
    expect(hits(`cat ${root}/store/.d*`).map((h) => h.path)).toEqual([])
  })
})

describe('heredoc reading', () => {
  it('blanks the body of a heredoc that is data, keeps the one that is a program, length-preserving', () => {
    const data = "cat > f <<'EOF'\n~/.ssh/x\nEOF"
    expect(blankInertHeredocs(data)).not.toContain('.ssh')
    expect(blankInertHeredocs(data)).toHaveLength(data.length)
    const prog = "python3 - <<'PY'\nopen('~/.ssh/x')\nPY"
    expect(blankInertHeredocs(prog)).toBe(prog)
    expect(blankInertHeredocs("bash scripts/x.sh - <<'EOF'\n~/.ssh/x\nEOF")).not.toContain('.ssh')
    expect(blankInertHeredocs('echo "$(cat <<\'EOF\'\n~/.ssh/x\nEOF\n)"')).not.toContain('.ssh')
  })
})

// The three gaps the commit review found (case, a data heredoc that is still run, the error path).
describe('review fixes', () => {
  it('case: on a case-insensitive filesystem a different case is the same file', () => {
    const ci = (command: string) => findSecretReads(command, { cwd, home, root, caseInsensitive: true }).map((h: { rule: string }) => h.rule)
    expect(ci('cat ~/.SSH/config')).toContain('ssh')
    expect(ci('cat ~/.Aws/Credentials')).toContain('aws')
    expect(ci('cat ~/.Claude.JSON')).toContain('claude-json')
    expect(ci(`cat ${root}/STORE/Vault.json`)).toContain('store-vault')
    expect(ci('cat ../../.ENV')).toContain('env')
    // ... and the dashboard token stays free in any case.
    expect(ci(`cat ${root}/store/.Dashboard-Token`)).toEqual([])
    // A case-sensitive filesystem (Linux) compares exactly: ~/.SSH is another directory there. (A file
    // that exists is still followed to its real path, so a missing one shows the comparison itself.)
    expect(findSecretReads('cat ~/.SSH/not-there', { cwd, home, root, caseInsensitive: false })).toEqual([])
    expect(ci('cat ~/.SSH/not-there')).toContain('ssh')
  })

  it('a data heredoc that the same command still runs or consumes is read', () => {
    expect(rulesOf("cat <<'EOF' | bash\ncat ~/.ssh/config\nEOF")).toContain('ssh')
    expect(rulesOf("cat <<'EOF' | env FOO=1 /bin/sh\ncat ~/.ssh/config\nEOF")).toContain('ssh')
    expect(rulesOf("tee /tmp/x <<'EOF' | python3\nprint(open('" + home + "/.aws/credentials').read())\nEOF")).toContain('aws')
    expect(rulesOf("eval \"$(cat <<'EOF'\ncat ~/.ssh/config\nEOF\n)\"")).toContain('ssh')
    expect(rulesOf("source /dev/stdin <<'EOF'\ncat ~/.ssh/config\nEOF")).toContain('ssh')
    expect(rulesOf(". /dev/stdin <<'EOF'\ncat ~/.ssh/config\nEOF")).toContain('ssh')
    expect(rulesOf("xargs cat <<'EOF'\n~/.ssh/config\nEOF")).toContain('ssh')
    expect(rulesOf("while read f; do cat \"$f\"; done <<'EOF'\n~/.ssh/config\nEOF")).toContain('ssh')
    expect(rulesOf("bash -s <<'EOF'\ncat ~/.ssh/config\nEOF")).toContain('ssh')
    // Without a sink the body is still data.
    expect(rulesOf(`bash ${root}/scripts/agent-msg.sh soma marveen - <<'EOF'\n~/.ssh/config\nEOF`)).toEqual([])
  })

  it('a command over the hard length cap is a finding before any expansion', () => {
    const long = 'echo ' + 'x'.repeat(64 * 1024)
    expect(rulesOf(long)).toEqual(['unreadable-braces'])
    expect(rulesOf('echo ' + 'x'.repeat(1000))).toEqual([])
  })

  it('a long word with many alternatives stays inside the linear cap and finishes fast', () => {
    // Over 4096 characters, so the linear fallback takes the word, and under the 64 KB command cap, so
    // the cap does not take it first: 5000 alternatives next to a 30 KB tail would be 5000 variants of
    // 30 KB each (150 MB) without the MAX_LINEAR cap.
    const word = '/x/{' + Array.from({ length: 5000 }, (_, n) => `a${n}`).join(',') + '}/' + 'y'.repeat(30 * 1024)
    expect(word.length).toBeLessThan(64 * 1024 - 10)
    // Deterministic: the fallback yields at most MAX_LINEAR (1024) variants; uncapped it is 5002.
    expect(linearBraceVariants(word).length).toBeLessThanOrEqual(1024)
    // And the whole judgement stays fast (about 1 s alone; under the 64 KB command cap even the
    // uncapped loop measured 3.8 s, so this bound alone could not tell the two apart).
    const t0 = performance.now()
    hits(`cat ${word}`)
    expect(performance.now() - t0).toBeLessThan(5000)
  })

  it('brace expansion is bounded, and a word over the budget is a finding, never a pass', () => {
    // ${HOME} and comma-less {x} are not brace lists, so padding with them changes nothing.
    expect(rulesOf('cat ~/.{ssh,x}/config' + '${HOME}'.repeat(40) + '{y}'.repeat(40))).toContain('ssh')
    // 2^5000 variants: neither a deep walk nor a blow-up, and the word is flagged.
    expect(() => hits(`cat ~/.{ssh,x}/config${'{a,b}'.repeat(5000)}`)).not.toThrow()
    expect(rulesOf(`cat ${'{a,b}'.repeat(40)}~/.{ssh,x}/config`)).toContain('unreadable-braces')
    // Unmatched braces cost one pass, not a rescan per brace, and a huge word is a finding.
    const t0 = Date.now()
    expect(rulesOf('echo ' + '{'.repeat(200000))).toContain('unreadable-braces')
    expect(rulesOf('echo ' + '{,'.repeat(2000))).toContain('unreadable-braces')
    expect(Date.now() - t0).toBeLessThan(2000)
    // A brace list in a body a shell runs, or pipes on, is expanded like any shell word.
    expect(rulesOf("bash <<'EOF'\ncat ~/.{ssh,x}/config\nEOF")).toContain('ssh')
    expect(rulesOf("sh -s <<'EOF'\ntar czf /tmp/x.tgz ~/.{ssh,aws}\nEOF")).toEqual(['aws', 'ssh'])
    expect(rulesOf("cat <<'EOF' | bash\ncat ~/.{ssh,x}/config\nEOF")).toContain('ssh')
    // A program body that shells out: the shell it calls expands the braces.
    expect(rulesOf("python3 - <<'PY'\nimport os\nos.system('cat ~/.{ssh,x}/config')\nPY")).toContain('ssh')
    expect(rulesOf("node - <<'JS'\nrequire('child_process').execSync('cat ~/.{ssh,x}/config')\nJS")).toContain('ssh')
    expect(rulesOf("php <<'PHP'\n<?php echo shell_exec('cat ~/.{ssh,x}/config');\nPHP")).toContain('ssh')
    // No list of shell-out forms is needed for the expansion itself: every program body is expanded.
    expect(rulesOf("python3 - <<'PY'\nimport os\ngetattr(os, 'sys' + 'tem')('cat ~/.{ssh,x}/config')\nPY")).toContain('ssh')
    expect(rulesOf("perl <<'PL'\nprint qx{cat ~/.{ssh,x}/config};\nPL")).toContain('ssh')
    expect(rulesOf("deno run - <<'TS'\nnew Deno.Command('sh', { args: ['-c', 'cat ~/.{ssh,x}/config'] })\nTS")).toContain('ssh')
    // Padding a program body past every budget does not hide a list either: the linear fallback.
    expect(rulesOf("python3 - <<'PY'\nimport os\ngetattr(os, 'sys' + 'tem')('cat ~/.{ssh,x}/config" + '{a,b}'.repeat(300) + "')\nPY")).toContain('ssh')
    expect(rulesOf("python3 - <<'PY'\nimport os\ngetattr(os, 'sys' + 'tem')('cat " + '{a,b}'.repeat(300) + "~/.{x,ssh}/config')\nPY")).toContain('ssh')
    expect(rulesOf("python3 - <<'PY'\n" + Array.from({ length: 600 }, (_, n) => `x${n}={${n},${n + 1}}`).join('\n') + "\ngetattr(os, 'sys' + 'tem')('cat ~/.{x,ssh}/config')\nPY")).toContain('ssh')
    // A path-shaped word over a budget is a finding in a program body too; so is a nested list in a
    // fallback word and a command past the total work budget.
    expect(rulesOf("python3 - <<'PY'\nimport os\ngetattr(os, 'sys' + 'tem')('cat " + '{a,b}'.repeat(300) + "~/.{x,{y,ssh}}/config')\nPY")).toContain('unreadable-braces')
    expect(rulesOf("python3 - <<'PY'\nimport os\ngetattr(os, 'sys' + 'tem')('cat ~/." + '{a,b}'.repeat(80) + "{x,s{s,y}h}/config')\nPY")).toContain('unreadable-braces')
    expect(rulesOf("python3 - <<'PY'\n" + Array.from({ length: 90 }, (_, n) => `v${n}='{' + '${'x,'.repeat(300)}y' + '}'`).join('\n') + "\nPY")).toEqual([])
    // ... but a DATA body that merely mentions a shell-out stays data.
    expect(rulesOf("cat > probe.mjs <<'EOF'\nexecSync('cat ~/.{ssh,aws}/config')\nEOF")).toEqual([])
    // A JSON or PHP body in a program heredoc is code, not a brace list.
    expect(rulesOf("python3 - <<'PY'\n" + "d = {'a': 1, 'b': 2}\n".repeat(200) + "print(json.dumps({'x':[1,2,3]}))\nPY")).toEqual([])
    // An ordinary brace list stays an ordinary list.
    expect(rulesOf('mkdir -p /tmp/x/{a,b,c}/{d,e}')).toEqual([])
  })
})

describe('mode and identity', () => {
  it('warn by default, block by the --block argument, env overrides both ways', () => {
    expect(readMode(['node', 'g.mjs'], {})).toBe('warn')
    expect(readMode(['node', 'g.mjs', '--block'], {})).toBe('block')
    expect(readMode(['node', 'g.mjs'], { SECRET_READ_GATE_MODE: 'block' })).toBe('block')
    expect(readMode(['node', 'g.mjs', '--block'], { SECRET_READ_GATE_MODE: 'warn' })).toBe('warn')
    expect(readMode(['node', 'g.mjs'], { SECRET_READ_GATE_MODE: 'nonsense' })).toBe('warn')
  })

  it('the agent comes from the config dir, else the cwd', () => {
    expect(agentOf({ CLAUDE_CONFIG_DIR: '/x/agents/soma/.claude-config' }, '/y')).toBe('soma')
    expect(agentOf({}, '/x/agents/watson/research')).toBe('watson')
    expect(agentOf({}, '/x/elsewhere')).toBeNull()
  })
})

describe('the hook process', () => {
  let dir: string
  let log: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'secret-read-gate-log-')); log = join(dir, 'gate.log') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const run = (payload: unknown, args: string[] = [], env: Record<string, string> = {}) => spawnSync(process.execPath, [HOOK, ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', HOME: home, SECRET_READ_GATE_LOG: log, ...env },
  })
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd })

  it('warn: the call goes through, the log has the rule and the path, never the command text', () => {
    const r = run(bash('cat ~/.ssh/config; echo S3CRET-VALUE-42'))
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: '' })
    const lines = readFileSync(log, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const e = JSON.parse(lines[0])
    expect(e).toMatchObject({ mode: 'warn', decision: 'allow', agent: 'soma', cwd, programs: ['cat', 'echo'] })
    expect(e.hits).toEqual([{ rule: 'ssh', pattern: '~/.ssh/**', path: '~/.ssh/config' }])
    expect(e.cmd_sha256).toMatch(/^[0-9a-f]{16}$/)
    expect(lines[0]).not.toContain('S3CRET-VALUE-42')
  })

  it('block: the call is denied, the reason names the rule and the path', () => {
    const r = run(bash('python3 -c "print(open(\'' + home + '/.aws/credentials\').read())"'), ['--block'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout).hookSpecificOutput
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toContain('aws')
    expect(out.permissionDecisionReason).toContain('~/.aws/credentials')
    expect(JSON.parse(readFileSync(log, 'utf-8')).decision).toBe('deny')
  })

  it('block: the dashboard-token call passes and leaves no log line', () => {
    const r = run(bash(`curl -s -H "Authorization: Bearer $(cat ${root}/store/.dashboard-token)" http://localhost:3420/api/kanban`), ['--block'])
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: '' })
    expect(existsSync(log)).toBe(false)
  })

  it('an internal error: block denies (fail-closed), warn allows and records it', () => {
    const blocked = run(bash('ls'), ['--block'], { SECRET_READ_GATE_FAULT: '1' })
    expect(blocked.status).toBe(0)
    const out = JSON.parse(blocked.stdout).hookSpecificOutput
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toContain('internal-error')
    rmSync(log, { force: true })
    const warned = run(bash('ls'), [], { SECRET_READ_GATE_FAULT: '1' })
    expect({ status: warned.status, stdout: warned.stdout }).toEqual({ status: 0, stdout: '' })
    expect(JSON.parse(readFileSync(log, 'utf-8'))).toMatchObject({ mode: 'warn', decision: 'allow', hits: [{ rule: 'internal-error' }] })
  })

  it('ignores other tools and exits 0 on garbage input', () => {
    expect(run({ tool_name: 'Read', tool_input: { file_path: `${home}/.ssh/config` } }, ['--block']).stdout).toBe('')
    const g = run('not json', ['--block'])
    expect({ status: g.status, stdout: g.stdout }).toEqual({ status: 0, stdout: '' })
  })
})

// The binding: a gate that passes its tests but is not wired runs nowhere.
describe('wiring', () => {
  const entries = (s: Record<string, unknown>, needle: string) =>
    (((s.hooks as Record<string, unknown>)?.PreToolUse ?? []) as Array<Record<string, unknown>>)
      .filter((e) => JSON.stringify(e).includes(needle))

  it('covers every sub-agent and exempts the main agent', () => {
    expect(agentGetsSecretReadGate(MAIN_AGENT_ID)).toBe(false)
    for (const n of ['soma', 'watson', 'heartbeat-worker']) expect(agentGetsSecretReadGate(n)).toBe(true)
  })

  it('wires the hook on the Bash matcher, once, with the fail-closed tail', () => {
    const s: Record<string, unknown> = {}
    injectSecretReadGate(s)
    injectSecretReadGate(s)
    const e = entries(s, 'secret-read-gate.mjs')
    expect(e).toHaveLength(1)
    expect(e[0].matcher).toBe('Bash')
    const command = (e[0].hooks as { command: string }[])[0].command
    expect(command).toContain(GATE_FAIL_CLOSED_TAG)
    expect(command.endsWith('exit "$rc"')).toBe(true)
  })

  it('neither drops nor is dropped by the other gate injectors', () => {
    const s: Record<string, unknown> = {}
    injectBashEgressParser(s)
    injectEgressGate(s)
    injectSelfPaceGate(s)
    injectDestructiveGate(s)
    injectSecretReadGate(s)
    injectBashEgressParser(s)
    injectEgressGate(s)
    injectSelfPaceGate(s)
    injectDestructiveGate(s)
    for (const needle of ['secret-read-gate.mjs', 'bash-egress-parser.mjs', 'hooks/egress-gate.mjs', 'self-pace-gate.mjs', 'destructive-gate.py']) {
      expect(entries(s, needle)).toHaveLength(1)
    }
  })

  it('the mode rides on the command: --block only when the setting is on', () => {
    expect(secretReadGateCommand(true)).toContain('secret-read-gate.mjs" --block;')
    expect(secretReadGateCommand(false)).not.toContain('--block')
    expect(secretReadGateBlock(() => '1')).toBe(true)
    expect(secretReadGateBlock(() => '0')).toBe(false)
    expect(secretReadGateBlock(() => { throw new Error('x') })).toBe(false)
  })

  it('is called from the spawn path and the startup migration', () => {
    const scaffold = readFileSync(join(ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    const spawn = scaffold.slice(scaffold.indexOf('export function writeAgentSettingsFromProfile'))
    const spawnBody = spawn.slice(0, spawn.indexOf('\n}\n'))
    expect(spawnBody).toContain('if (agentGetsSecretReadGate(name)) injectSecretReadGate(existing)')
    const web = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf-8')
    expect(web).toMatch(/if \(ensureSecretReadGate\(agentName\)\) secretGatePatched\.push\(agentName\)/)
  })
})

describe('the migration on an existing agent', () => {
  const NAME = 'secret-read-gate-test-agent'
  const DIR = agentDir(NAME)
  beforeEach(() => {
    if (existsSync(DIR)) throw new Error(`refusing: ${DIR} already exists`)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, 'agent-config.json'), JSON.stringify({}, null, 2))
  })
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }) })
  const read = () => JSON.parse(readFileSync(agentSettingsPath(NAME), 'utf-8'))
  const ptu = (s: Record<string, unknown>) => ((s.hooks as Record<string, unknown>).PreToolUse ?? []) as unknown[]

  it('adds the hook to a settings file that lacks it, keeps every other hook, and is idempotent', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    expect(ensureSecretReadGate(NAME)).toBe(false)
    const s = read()
    const others = ptu(s).filter((e) => !JSON.stringify(e).includes('secret-read-gate.mjs'))
    expect(others.length).toBeGreaterThan(0)
    s.hooks.PreToolUse = others
    s.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }]
    writeFileSync(agentSettingsPath(NAME), JSON.stringify(s, null, 2))
    expect(ensureSecretReadGate(NAME)).toBe(true)
    const after = read()
    expect(ptu(after).filter((e) => JSON.stringify(e).includes('secret-read-gate.mjs'))).toHaveLength(1)
    for (const e of others) expect(ptu(after)).toContainEqual(e)
    expect(after.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: 'echo keep-me' }] }])
    expect(ensureSecretReadGate(NAME)).toBe(false)
  })

  it('creates nothing for an agent without a settings file, and never touches the main agent', () => {
    expect(ensureSecretReadGate(NAME)).toBe(false)
    expect(existsSync(agentSettingsPath(NAME))).toBe(false)
    expect(ensureSecretReadGate(MAIN_AGENT_ID)).toBe(false)
  })

  it('the deny layer: every sub-agent profile gets SECRET_READ_DENY, resolved', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    const deny: string[] = read().permissions.deny
    for (const rule of ['Bash(cat ~/.ssh/*)', 'Bash(cat ~/.aws/*)']) expect(deny).toContain(rule)
    expect(deny).toContain(`Read(/${join(PROJECT_ROOT, 'store', 'vault*')})`)
    expect(deny).toContain(`Read(/${join(PROJECT_ROOT, 'store', '.claude-oauth-token')})`)
    for (const f of ['.fal-key*', '.fb-page-token', '.launch-secrets', '*-mcp-key*.txt']) expect(deny).toContain(`Read(/${join(PROJECT_ROOT, 'store', f)})`)
    expect(deny.some((r) => r.includes('.dashboard-token'))).toBe(false)
  })
})

// How Claude Code matches a Bash rule (measured, see bash-egress-deny.test.ts): an anchored full-match
// regex, `*` -> `.*`, evaluated per sub-command. A $(...) is modelled as one more sub-command, the
// strictest reading.
function ruleMatches(rule: string, command: string): boolean {
  const body = rule.replace(/^Bash\(/, '').replace(/\)$/, '')
  const re = new RegExp(`^${body.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's')
  return re.test(command)
}
function deniedBy(rules: string[], command: string): boolean {
  const inner = [...command.matchAll(/\$\(([^()]*)\)/g)].map((m) => m[1])
  const parts = [command, ...inner].flatMap((c) => [c, ...c.split(/\s*(?:&&|\|\||;|\||\n)\s*/)]).map((p) => p.trim()).filter(Boolean)
  const bashRules = rules.filter((r) => r.startsWith('Bash('))
  return parts.some((c) => bashRules.some((r) => ruleMatches(r, c)))
}

describe('SECRET_READ_DENY', () => {
  const resolved = (h: string) => SECRET_READ_DENY.map((r: string) => r.replace('${HOME}', h).replace('${PROJECT_ROOT}', PROJECT_ROOT))

  it('stays off the main agent: not in FLEET_BASELINE_DENY, not in the tracked project settings', () => {
    const tracked: string[] = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8')).permissions?.deny ?? []
    for (const rule of SECRET_READ_DENY) {
      expect(FLEET_BASELINE_DENY).not.toContain(rule)
      expect(tracked).not.toContain(rule.replace('${HOME}', '~'))
    }
  })

  it('no rule reaches the dashboard-token calls the fleet runs every round', () => {
    const rules = resolved('/Users/agent')
    for (const c of [
      'curl -s -H "Authorization: Bearer $(cat /srv/install/store/.dashboard-token)" http://localhost:3420/api/memories?agent=a',
      'curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" --data-binary @f.json',
      'cat /Users/agent/marveen/store/.dashboard-token',
      `cat ${PROJECT_ROOT}/store/.dashboard-token`,
      'bash /srv/install/scripts/agent-msg.sh a marveen "x"',
    ]) expect(deniedBy(rules, c)).toBe(false)
  })

  it('the Bash rules catch exactly their two cat shapes, typed and resolved (the hook does the rest)', () => {
    const rules = resolved('/Users/agent')
    expect(deniedBy(rules, 'cat ~/.ssh/id_rsa')).toBe(true)
    expect(deniedBy(rules, 'cat /Users/agent/.aws/credentials')).toBe(true)
    expect(deniedBy(rules, 'cd /tmp && cat ~/.ssh/config')).toBe(true)
    // Recorded, not wished away: an inserted flag or another program walks past a text rule.
    expect(deniedBy(rules, 'cat -v ~/.ssh/id_rsa')).toBe(false)
    expect(deniedBy(rules, 'head ~/.ssh/id_rsa')).toBe(false)
  })
})
