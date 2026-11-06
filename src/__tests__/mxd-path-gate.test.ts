// MXDAGENTSOCKID1106: the sub-agents' text brake on mxd's run dir (the agent token files, agent.sock, dash.sock),
// on the MXD env names and on the gromzo-channel entry points. Decisions only: nothing here connects to a socket or
// reads a token, and no row depends on a live mxd on the host (a symlink row points at the literal run dir, which
// pathKey resolves whether or not it exists).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-expect-error -- plain .mjs module, no types
import { gateDecision, DENY_MSG, RUN_DIRS } from '../../scripts/hooks/mxd-path-gate.mjs'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { injectMxdPathGate, MXD_PATH_GATE_MATCHER } from '../web/agent-scaffold.js'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(REPO, 'scripts', 'hooks', 'mxd-path-gate.mjs')
// Spelled in pieces so this file's own text does not read as a run-dir mention to anyone grepping for it.
const LINUX = '/run/marveen-' + 'mxd'
const MAC = '/Library/Application Support/Marveen/mxd-' + 'run'
const CWD = '/Users/someone/ClaudeClaw/agents/samu'

type V = { deny: boolean, reason?: string }
const bash = (command: string, cwd = CWD): V => gateDecision('Bash', { command }, { cwd })
const tool = (name: string, input: Record<string, unknown>, cwd = CWD): V => gateDecision(name, input, { cwd })
const q = (p: string) => `'${p}'`

describe('the run dirs', () => {
  it('both platforms and the Linux /var/run spelling', () => {
    expect(RUN_DIRS).toEqual([LINUX, '/var/run/marveen-' + 'mxd', MAC])
  })
})

describe('DENY: three targets in six forms', () => {
  const targets = {
    token: `${LINUX}/tokens/samu.token`,
    'agent.sock': `${MAC}/agent.sock`,
    'dash.sock': `${LINUX}/dash.sock`,
  }
  for (const [name, t] of Object.entries(targets)) {
    it(`${name}: cat, Read, Grep, Glob, rm, >`, () => {
      expect(bash(`cat ${q(t)}`)).toEqual({ deny: true, reason: 'run-dir' })
      expect(tool('Read', { file_path: t })).toEqual({ deny: true, reason: 'run-dir' })
      expect(tool('Grep', { pattern: 'x', path: dirname(t) }).deny).toBe(true)
      expect(tool('Grep', { pattern: 'x', path: t }).deny).toBe(true)
      expect(tool('Glob', { pattern: '*', path: dirname(t) }).deny).toBe(true)
      expect(tool('Glob', { pattern: t })).toEqual({ deny: true, reason: 'run-dir' })
      expect(bash(`rm -f ${q(t)}`)).toEqual({ deny: true, reason: 'run-dir' })
      expect(bash(`echo x > ${q(t)}`)).toEqual({ deny: true, reason: 'run-dir' })
      expect(tool('Write', { file_path: t, content: 'x' })).toEqual({ deny: true, reason: 'run-dir' })
      expect(tool('Edit', { file_path: t, old_string: 'a', new_string: 'b' }).deny).toBe(true)
    })
  }
})

describe('DENY: the forms measured in 5.1', () => {
  it.each([
    ['B1 python socket to agent.sock', `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.connect("${LINUX}/agent.sock")'`],
    ['B2 nc -U', `nc -U ${LINUX}/agent.sock`],
    ['B3 node net.connect', `node -e 'require("net").connect("${MAC}/agent.sock")'`],
    ['B4 python socket to dash.sock', `python3 - <<'PY'\nimport socket\ns=socket.socket(socket.AF_UNIX)\ns.connect('${MAC}/dash.sock')\nPY`],
    ['B5 cat a token', `cat ${LINUX}/tokens/marveen.token`],
    ['B6 cd && cat tokens/*', `cd ${LINUX} && cat tokens/*`],
    ['B7 rm a token', `rm ${LINUX}/tokens/a.token`],
    ['B8 > a token', `echo x > ${LINUX}/tokens/a.token`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd).deny).toBe(true)
  })
})

describe('DENY (a): a run-dir spelling as a SUBSTRING of a word, a heredoc, -c / -e code, $(...)', () => {
  it.each([
    ['inside python -c code', `python3 -c 'import os; print(os.listdir("${LINUX}/tokens"))'`],
    ['inside node -e code', `node -e "fs.readFileSync('${LINUX}/tokens/x')"`],
    ['a heredoc body', `cat <<'EOF' | sh\nls ${LINUX}\nEOF`],
    ['a command substitution', `echo $(cat ${LINUX}/tokens/a)`],
    ['backticks', 'echo `cat ' + LINUX + '/tokens/a`'],
    ['the Linux /var/run spelling', `cat /var/run/marveen-${'mxd'}/tokens/a`],
    ['split quoting', `cat '/run/marv''een-${'mxd'}/tokens/x'`],
    ['mixed quotes', `cat "/run/marv"'een-${'mxd'}'/tokens/x`],
    ['backslashes', `cat \\/run\\/marveen-${'mxd'}\\/tokens\\/x`],
    ['a doubled slash', `cat /run//marveen-${'mxd'}/tokens/x`],
    ['the macOS path, escaped space', `cat /Library/Application\\ Support/Marveen/mxd-${'run'}/agent.sock`],
    ['an assignment value', `D=${LINUX}; ls $D`],
    ['an option value', `tool --socket=${LINUX}/agent.sock`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: true, reason: 'run-dir' })
  })
})

describe('DENY (b): glob and brace patterns that could match a run dir', () => {
  it.each([
    ['* in the last segment', `cat /run/marveen-m*/tokens/*`],
    ['? in a macOS segment, escaped space', `ls -l /Library/Application\\ Support/Marveen/mxd-r?n/agent.sock`],
    ['a brace group', `cat /Library/Application\\ Support/Marveen/{mxd-run,x}/dash.sock`],
    ['a bracket class', `cat /run/marveen-mx[d]/tokens/a`],
    ['a * segment before the name', `cat /*/marveen-${'mxd'}x/../marveen-m?d/tokens/a`],
    ['a ** segment', `ls /**/agent.sock`],
    ['the run dir itself by glob', `ls -la /Library/Application\\ Support/Marveen/mxd*`],
    ['a brace sequence', `cat /run/marveen-mx{a..z}/tokens/a`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: true, reason: 'run-dir' })
  })
  it('the Glob tool with a pattern that could match', () => {
    expect(tool('Glob', { pattern: '/run/marveen-m*/tokens/*' }).deny).toBe(true)
    expect(tool('Glob', { pattern: 'marveen-m*/tokens/*', path: '/run' }).deny).toBe(true)
    expect(tool('Glob', { pattern: '**/agent.sock', path: '/' }).deny).toBe(true)
  })
})

describe('DENY (c): case on macOS (APFS reads it as the same file)', () => {
  it('lower-cased and upper-cased spellings', () => {
    expect(bash(`cat '/library/application support/marveen/MXD-RUN/agent.sock'`).deny).toBe(true)
    expect(bash(`cat /RUN/MARVEEN-MXD/tokens/a`).deny).toBe(true)
    expect(tool('Read', { file_path: '/LIBRARY/Application Support/marveen/Mxd-Run/tokens/a.token' }).deny).toBe(true)
  })
})

describe('DENY (d): a gromzo-channel entry point, after a cd too', () => {
  const PLUGIN = '/Users/someone/.claude/plugins/cache/gromzo-local/gromzo-channel/0.3.2'
  it.each([
    ['absolute, node', `node ${PLUGIN}/dist/server.js`],
    ['after cd, node', `cd ${PLUGIN} && node dist/server.js`],
    ['after cd, npx tsx', `cd /x/plugin/gromzo-channel && npx tsx server.ts`],
    ['after cd, bun', `cd /x/plugin/gromzo-channel && bun dist/server.js`],
    ['after cd, tsx e2e-probe', `cd /x/plugin/gromzo-channel && tsx e2e-probe.ts`],
    ['two relative cds', `cd /x/plugin && cd gromzo-channel && node dist/server.js`],
    ['the cwd is the plugin dir', `node dist/server.js`, '/x/gromzo-channel'],
    ['python spawning node', `python3 -c 'import subprocess; subprocess.run(["node", "/x/gromzo-channel/dist/server.js"])'`],
    ['xargs node', `echo /x/gromzo-channel/dist/server.js | xargs node`],
  ])('%s', (_n, cmd, cwd = CWD) => {
    expect(bash(cmd, cwd)).toEqual({ deny: true, reason: 'entry' })
  })
})

describe('DENY (e): setting MXD_AGENT / MXD_AGENT_TOKEN_FILE', () => {
  it.each([
    ['a prefix assignment (B9)', 'MXD_AGENT=marveen MXD_AGENT_TOKEN_FILE=/x node /p/server.js'],
    ['export ... && (B9b)', 'export MXD_AGENT=marveen && node a.js'],
    ['env NAME= (B9c)', 'env MXD_AGENT_TOKEN_FILE=/x node a.js'],
    ['declare -x', 'declare -x MXD_AGENT=main'],
    ['typeset -x', 'typeset -x MXD_AGENT_TOKEN_FILE=/x'],
    ['env -S', `env -S 'MXD_AGENT=x node s.js'`],
    ['printf -v (the launcher exports the name: an assignment reaches the children)', 'printf -v MXD_AGENT x'],
    ['printf -vNAME', 'printf -vMXD_AGENT x'],
    ['export without a value', 'export MXD_AGENT'],
    ['read', 'read MXD_AGENT <<< main'],
    ['a nameref', 'declare -n r=MXD_AGENT; r=main'],
    ['a standalone assignment', 'MXD_AGENT=main; node a.js'],
    ['+=', 'MXD_AGENT+=x node a.js'],
    ['python environ with a spawn', `python3 -c 'import os, subprocess; os.environ["MXD_AGENT"]="main"; subprocess.run(["node","a.js"])'`],
    ['python env dict with a spawn', `python3 -c 'import subprocess; subprocess.run(["node","a.js"], env={"MXD_AGENT": "main"})'`],
    ['node process.env', `node -e 'process.env.MXD_AGENT="main"; require("./a")'`],
    ['inside bash -c', `bash -c 'MXD_AGENT=main node a.js'`],
    ['python heredoc environ with a spawn', `python3 - <<'PY'\nimport os, subprocess\nos.environ["MXD_AGENT"] = "main"\nsubprocess.run(["node", "a.js"])\nPY`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: true, reason: 'env' })
  })
})

describe('DENY: symlink, .., the cd chain, the hook cwd, function and shell bodies', () => {
  let tmp: string
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mxdgate-'))
    symlinkSync(LINUX, join(tmp, 'link'))
    mkdirSync(join(tmp, 'sub'))
    symlinkSync('/run', join(tmp, 'sub', 'up'))
  })
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  it('a symlink to the run dir (dangling or not)', () => {
    expect(bash(`cat ${tmp}/link/tokens/a`)).toEqual({ deny: true, reason: 'run-dir' })
    expect(tool('Read', { file_path: `${tmp}/link/tokens/a.token` }).deny).toBe(true)
    expect(bash(`cat ${tmp}/sub/up/marveen-${'mxd'}x/../marveen-m?d/agent.sock`).deny).toBe(true)
    expect(bash(`cd ${tmp} && cat link/agent.sock`)).toEqual({ deny: true, reason: 'run-dir' })
  })
  it('a .. path', () => {
    expect(bash(`cat /run/x/../marveen-${'mxd'}/tokens/a`)).toEqual({ deny: true, reason: 'run-dir' })
    expect(tool('Read', { file_path: `/run/a/b/../../marveen-${'mxd'}/dash.sock` }).deny).toBe(true)
  })
  it('the cd chain: relative words and relative cds', () => {
    expect(bash(`cd /run && cat marveen-${'mxd'}/tokens/a`)).toEqual({ deny: true, reason: 'run-dir' })
    expect(bash(`cd /run; cd marveen-${'mxd'}; cat tokens/a`)).toEqual({ deny: true, reason: 'run-dir' })
    expect(bash(`cd '/Library/Application Support/Marveen' && ls mxd-${'run'}`)).toEqual({ deny: true, reason: 'run-dir' })
    expect(bash('cat tokens/a', '/run/marveen-' + 'mxd')).toEqual({ deny: true, reason: 'cwd' })
    expect(bash(`tar -C /run -cf - marveen-${'mxd'}`)).toEqual({ deny: true, reason: 'run-dir' })
    expect(bash(`git -C /run diff --no-index marveen-${'mxd'}/tokens/a /dev/null`).deny).toBe(true)
    expect(bash(`tar --directory=/run -cf - marveen-${'mxd'}`).deny).toBe(true)
  })
  it('a function body, bash -c, a piped shell', () => {
    expect(bash(`f(){ cd /run; cat marveen-${'mxd'}/x; }; f`).deny).toBe(true)
    expect(bash(`bash -c 'cd /run && cat marveen-${'mxd'}/tokens/a'`).deny).toBe(true)
    expect(bash(`echo 'cd /run; cat marveen-${'mxd'}/tokens/a' | sh`).deny).toBe(true)
    expect(bash(`sh <<'EOF'\ncd /run\ncat marveen-${'mxd'}/tokens/a\nEOF`).deny).toBe(true)
  })
})

describe('DENY (Dani 71760): a path the command assembles from its own literal assignments', () => {
  const MACP = '/Library/Application Support/Marveen'
  it.each([
    ['a quoted prefix, braces', `D='${MACP}/mxd-'; cat "\${D}run/tokens/marveen"`],
    ['a prefix, braces, a suffix', `D=/run/marveen; cat \${D}-mxd/tokens/samu`],
    ['two variables', `A=/run; B=marveen-mx; cat $A/\${B}d/tokens/samu`],
    ['the parent in a variable', `P='${MACP}'; cat "$P/mxd-${'run'}/tokens/marveen"`],
    ['export', `export P='${MACP}' && cat "$P/mxd-${'run'}/tokens/x"`],
    ['a value built from an earlier one', `A=/run; B=$A/marveen-${'mxd'}; cat $B/tokens/x`],
    ['an unknown variable inside the path', `cat /run/\${X}-${'mxd'}/tokens/x`],
    ['inside interpreter code', `D=/run/marveen; python3 -c "print(open('\${D}-${'mxd'}/tokens/a').read())"`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: true, reason: 'run-dir' })
  })
})

describe('DENY (Dani 71789): a default expansion and a literal array', () => {
  const R = '/run/marveen'
  const IFSX = 'IF' + 'S='
  it.each([
    [':- default', `cat \${D:-${R}}-mxd/tokens/samu`],
    ['- default', `cat \${D-${R}}-mxd/tokens/samu`],
    [':= default', `cat \${D:=${R}}-mxd/tokens/samu`],
    ['= default', `cat \${D=${R}}-mxd/tokens/samu`],
    [':+ alternate', `D=1; cat \${D:+${R}}-mxd/tokens/samu`],
    ['an array element', `a=(${R}); cat \${a[0]}-mxd/tokens/samu`],
    ['two array elements', `a=(/run marveen-${'mxd'}); cat \${a[0]}/\${a[1]}/tokens/samu`],
    ['an array by its bare name (element 0)', `a=(${R}); cat $a-${'mxd'}/tokens/x`],
    ['an array joined with an empty IFS', `a=(${R} -${'mxd'}); ${IFSX}; cat "\${a[*]}/tokens/x"`],
    ['an appended array', `a=(/tmp); a+=(/run); cat \${a[1]}/marveen-${'mxd'}/tokens/x`],
    ['an appended scalar', `D=/run; D+=/marveen-${'mxd'}; cat $D/tokens/x`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: true, reason: 'run-dir' })
  })
  it.each([
    ['a default elsewhere', 'cat ${D:-/tmp}/x'],
    ['an array elsewhere', 'b=(/Users/someone/src); ls ${b[0]}'],
    ['"${a[@]}" gives separate words', `a=(/run marveen-${'mxd'}); ls "\${a[@]}"`],
  ])('ALLOW: %s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: false })
  })
})

describe('DENY (Dani 71760): ~+, ~- and ~N are cwds', () => {
  it.each([
    ['~+ after cd (macOS)', `cd '/Library/Application Support/Marveen' && cat ~+/mxd-${'run'}/tokens/marveen`],
    ['~+ after cd (Linux)', `cd /run && cat ~+/marveen-${'mxd'}/tokens/samu`],
    ['~- after two cds', `cd /run; cd /tmp; cat ~-/marveen-${'mxd'}/tokens/a`],
    ['~1 (dirs stack)', `pushd /run; pushd /tmp; cat ~1/marveen-${'mxd'}/tokens/a`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: true, reason: 'run-dir' })
  })
})

describe('DENY (Dani 71760): a relative cd through CDPATH', () => {
  it.each([
    ['a prefix CDPATH', `CDPATH='/Library/Application Support/Marveen' cd mxd-${'run'} && cat tokens/marveen`],
    ['an exported CDPATH', `export CDPATH=/run; cd marveen-${'mxd'}; cat tokens/samu`],
    ['a CDPATH with several entries', `CDPATH=/tmp:/run; cd marveen-${'mxd'}; cat tokens/a`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd).deny).toBe(true)
  })
})

describe('DENY (Dani 71760): find / fd from an ancestor feeding a reader', () => {
  it.each([
    ['| xargs cat', `find '/Library/Application Support/Marveen' -type f | xargs cat`],
    ['-print0 | xargs -0 cat', `find /run -type f -print0 | xargs -0 cat`],
    ['| while read', `find /run -type f | while read f; do cat "$f"; done`],
    ['fd | xargs', `fd . /run | xargs cat`],
    ['| parallel', `find /run -name '*.token' | parallel cat`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: true, reason: 'ancestor' })
  })
})

describe('ALLOW controls for the 71760 rules', () => {
  it.each([
    ['a variable path elsewhere', 'D=/Users/someone/work; cat "$D/notes.txt"'],
    ['a variable to a run dir PARENT, not walked', 'P=/run; ls $P'],
    ['a leading unknown variable', 'cat "$WORK/tokens/a"'],
    ['find elsewhere into xargs', 'find /Users/someone/src -name "*.ts" | xargs wc -l'],
    ['find / -name with no reader', 'find / -name foo 2>/dev/null | head'],
    ['a CDPATH elsewhere', 'CDPATH=/Users/someone cd src && ls'],
    ['~+ elsewhere', 'cd /Users/someone && cat ~+/notes.txt'],
    ['tar -x in the root cwd reads only its archive', 'cd / && tar -xf x.tar'],
    ['an earlier tar -C / moves no later command', 'tar -C / -cf /tmp/a.tar home/x; find . -type f | xargs wc -l'],
    ['a remote tar -C / moves no local command', `D=/Users/someone/arch; ssh h 'tar -C / -cf - home/x' | tar -xf - -C "$D"; cd "$D" && find . -type f | while read f; do shasum "$f"; done`],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: false })
  })
})

describe('DENY: a recursive reader rooted at an ancestor of a run dir', () => {
  it.each([
    ['grep -r', 'grep -r token /run'],
    ['grep -Rl', `grep -Rl x '/Library/Application Support/Marveen'`],
    ['rg', 'rg secret /run'],
    ['tar', 'tar -cf /tmp/x.tar /run'],
    ['cp -r', 'cp -r /run /tmp/copy'],
    ['find -exec', 'find /run -name "*.token" -exec cat {} +'],
    ['rg from an ancestor cwd', 'cd / && rg secret'],
  ])('%s', (_n, cmd) => {
    expect(bash(cmd)).toEqual({ deny: true, reason: 'ancestor' })
  })
  it('the Grep tool on an ancestor', () => {
    expect(tool('Grep', { pattern: 'x', path: '/run' })).toEqual({ deny: true, reason: 'ancestor' })
    expect(tool('Grep', { pattern: 'x', path: '/' })).toEqual({ deny: true, reason: 'ancestor' })
  })
})

describe('DENY: MCP tools, every string leaf', () => {
  it.each([
    ['a path argument', { path: `${LINUX}/tokens/a.token` }],
    ['a nested leaf', { args: { files: [{ src: `${MAC}/agent.sock` }] } }],
    ['a file:// uri', { uri: `file://${LINUX}/dash.sock` }],
    ['a .. path', { path: `/run/a/../marveen-${'mxd'}/tokens/a` }],
    ['prose that names the path (the accepted price)', { text: `see ${LINUX}/agent.sock` }],
  ])('%s', (_n, input) => {
    expect(tool('mcp__fs__read_file', input).deny).toBe(true)
  })
})

describe('ALLOW controls', () => {
  it.each([
    ['gh on the mxd repo', 'gh pr view 84 -R Szotasz/marveen-mxd'],
    ['gh pr diff (Dani f)', 'gh pr diff -R Szotasz/marveen-mxd 90'],
    ['git grep agent.sock in a review clone (Dani f)', 'git -C /Users/someone/dani-rev-mxd grep agent.sock'],
    ['cargo with its own target dir', 'CARGO_TARGET_DIR=/Users/someone/.cargo-targets/marveen-mxd-bence cargo test'],
    ['ls of a run dir PARENT (not recursive)', 'ls /run'],
    ['ls of the macOS parent', `ls -la '/Library/Application Support/Marveen/'`],
    ['git in an mxd worktree', 'git -C /Users/someone/bence-wt-mxd-sockid status'],
    ['a bare /** (one level, like *)', 'ls -d /**'],
    ['find / -name (names only)', 'find / -name foo 2>/dev/null | head'],
    ['tar -C / of other paths', 'tar -C / -cf - home/x/build.log'],
    ['tar -x after a -C / (tar reads only what it is given)', 'tar -C / -cf - home/x/build.log | tar -xf - -C "$D"'],
    ['export -n (does not set, Dani e)', 'export -n MXD_AGENT'],
    ['a reference', 'echo "$MXD_AGENT" "${MXD_AGENT:-none}"'],
    ['a test on the value', '[ "$MXD_AGENT" = main ] && echo yes'],
    ['grep for the name', 'git grep -n MXD_AGENT_TOKEN_FILE'],
    ['a grep pattern with an alternation', `grep -rn "MXD_AGENT\\b\\|MXD_AGENT=" src`],
    ['a commit message naming the env form', `git commit -m "launcher: export MXD_AGENT=<slug> for the plugin"`],
    ['a message file in a heredoc', `cat > /tmp/m.txt <<'EOF'\nplugin pid 1 (MXD_AGENT=samu)\nEOF`],
    ['the plugin tests', 'npm test', '/x/plugin/gromzo-channel'],
    ['the plugin type check', 'npx tsc --noEmit -p tsconfig.json', '/x/plugin/gromzo-channel'],
    ['reading the plugin source', 'cat /x/plugin/gromzo-channel/server.ts'],
    ['pgrep for the plugin', 'pgrep -f "gromzo-channel/dist/server.js"'],
    ['a python edit script naming the plugin file, no spawn', `python3 - <<'PY'\np='plugin/gromzo-channel/server.ts'\ns=open(p).read()\nopen(p,'w').write(s.replace('MXD_AGENT=a','MXD_AGENT=b'))\nPY`],
    ['a python edit script with JS doc comments', `python3 - <<'PY'\ns=open('a.ts').read()\nold='''/** A doc */\n/* x */'''\nPY`],
    ['a sed script with a long brace list', `sed -i '' "s/import { A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q } from './x.js';/import { A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R } from './x.js';/" a.ts`],
  ])('%s', (_n, cmd, cwd = CWD) => {
    expect(bash(cmd, cwd)).toEqual({ deny: false })
  })
  it('native and MCP tools elsewhere', () => {
    expect(tool('Read', { file_path: '/Users/someone/ClaudeClaw/CLAUDE.md' }).deny).toBe(false)
    expect(tool('Grep', { pattern: 'agent.sock', path: '/Users/someone/mxd/src' }).deny).toBe(false)
    expect(tool('Glob', { pattern: '**/*.rs', path: '/Users/someone/mxd' }).deny).toBe(false)
    expect(tool('Write', { file_path: '/Users/someone/x.md', content: `${LINUX}/agent.sock` }).deny).toBe(false)
    expect(tool('mcp__fs__read_file', { path: '/Users/someone/x.md' }).deny).toBe(false)
    expect(tool('TodoWrite', { todos: [] }).deny).toBe(false)
  })
})

describe('the accepted price (Dani 71573 f): a source text that spells the run dir', () => {
  it('a grep for the literal in a worktree is denied', () => {
    expect(bash(`grep -n ${LINUX} src/main.rs`)).toEqual({ deny: true, reason: 'run-dir' })
  })
})

describe('the caps', () => {
  it('a command too deep to read: denied only when it names an mxd or gromzo name', () => {
    const deep = (inner: string) => Array.from({ length: 12 }).reduce<string>((t) => `bash -c ${JSON.stringify(t)}`, inner)
    expect(bash(deep('ls marveen-mxd'))).toEqual({ deny: true, reason: 'budget' })
    expect(bash(deep('ls /tmp')).deny).toBe(false)
  })
})

describe('fail closed', () => {
  it('an internal error is not swallowed as an allow (the hook entry turns it into a deny)', () => {
    const input = { get command(): string { throw new Error('boom') } }
    expect(() => gateDecision('Bash', input, { cwd: CWD })).toThrow('boom')
  })
})

describe('the hook process', () => {
  const run = (payload: unknown) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf-8' })
  it('prints a deny with the reason, allows a plain command, and lets non-JSON input through', () => {
    const d = run({ tool_name: 'Bash', cwd: CWD, tool_input: { command: `cat ${LINUX}/tokens/a` } })
    expect(d.status).toBe(0)
    const out = JSON.parse(d.stdout).hookSpecificOutput
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toBe(DENY_MSG['run-dir'])
    const e = run({ tool_name: 'Bash', cwd: CWD, tool_input: { command: 'export MXD_AGENT=main' } })
    expect(JSON.parse(e.stdout).hookSpecificOutput.permissionDecisionReason).toBe(DENY_MSG.env)
    const a = run({ tool_name: 'Bash', cwd: CWD, tool_input: { command: 'ls -la' } })
    expect(a.status).toBe(0)
    expect(a.stdout).toBe('')
    const n = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf-8' })
    expect(n.status).toBe(0)
    expect(n.stdout).toBe('')
  })
  it('every message says it is a text brake', () => {
    for (const m of Object.values(DENY_MSG)) expect(m).toMatch(/Szoveg-fek, nem OS-hatar/)
    expect(readFileSync(HOOK, 'utf-8')).toMatch(/A TEXT BRAKE, NOT AN OS BOUNDARY/)
  })
})

describe('wiring', () => {
  it('a sub-agent gets one entry with the anchored matcher, and a second inject does not add one', () => {
    const s: Record<string, unknown> = {}
    injectMxdPathGate(s)
    injectMxdPathGate(s)
    const ptu = (s.hooks as { PreToolUse: Array<{ matcher: string, hooks: Array<{ command: string }> }> }).PreToolUse
    expect(ptu).toHaveLength(1)
    expect(ptu[0].matcher).toBe(MXD_PATH_GATE_MATCHER)
    expect(MXD_PATH_GATE_MATCHER).toBe('^(?:Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|mcp__.*)$')
    expect(ptu[0].hooks[0].command).toContain(join('scripts', 'hooks', 'mxd-path-gate.mjs'))
  })
  it('the matcher fires on the guarded tools only', () => {
    const rx = new RegExp(MXD_PATH_GATE_MATCHER)
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'mcp__fs__read_file']) expect(rx.test(t)).toBe(true)
    for (const t of ['TodoWrite', 'WebFetch', 'Task', 'xRead']) expect(rx.test(t)).toBe(false)
  })
  it('the scaffold wires it for every sub-agent and the startup migration repairs it (pinned in source)', () => {
    const src = readFileSync(join(REPO, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('if (agentGetsGovernanceGates(name)) injectMxdPathGate(existing)')
    expect(src).toContain('if (needMxdGate) injectMxdPathGate(settings)')
  })
  it('it is a known hook script and cannot be switched off by an env var', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain('mxd-path-gate.mjs')
    expect(readFileSync(join(REPO, 'scripts', 'hooks', 'hook_switches.py'), 'utf-8')).toMatch(/^\s*"mxd-path-gate",/m)
  })
  it('the main agent\'s tracked settings do not carry it (sub-agents only, Samu 71433)', () => {
    expect(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf-8')).not.toContain('mxd-path-gate.mjs')
  })
})
