// Card cc4d0ddd, the scripts/channels.sh side: the FIRST reap pass must reach
// the main agent's plugin POLLER only, never the rest of the main agent's tree
// and never the tmux server.
//
// The old pass matched `<STATE_ENV_VAR>=<main channel dir>` in `ps eww -e` as an
// awk regex, on the environment alone. The launcher exports that variable, so
// every descendant of the main agent carried it -- and so did the tmux server
// whenever channels.sh had started it. The dashboard's twin of the same rule
// killed that server on 2026-09-24 12:23Z and took every session down with it;
// four campaign drivers started from the main agent's Bash died to this pass on
// 2026-09-23 (the original description of the card).
//
// Tested here, against the REAL helpers in scripts/lib/channel-reap.sh:
//   selection  -- fixture `ps eww -e` lines in the 12:23Z shape, and the real
//                 process table with real processes;
//   protection -- real processes and a fake tmux: the parent of a live pane
//                 (the server's position) and the pane survive even when they
//                 are passed in as candidates; a poller dies and is logged
//                 with its command line;
//   wiring     -- channels.sh sources the helpers for pass 1, and the old regex
//                 form is gone. The second pass is covered, unchanged, by
//                 channels-reap-scope.test.ts (acceptance (4)).
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIB = join(REPO_ROOT, 'scripts', 'lib', 'channel-reap.sh')
const channelsSh = readFileSync(join(REPO_ROOT, 'scripts', 'channels.sh'), 'utf-8')

function select(input: string, state: string, prov = '/telegram'): string[] {
  const out = execFileSync('bash', ['-c', `. "${LIB}"; channel_reap_select_pass1 "$1" "$2"`, 'x', state, prov],
    { input, encoding: 'utf-8' })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

const MAIN = '/test/install/.claude/channels/telegram'
const ROOT = '/srv/op/.claude/plugins/cache/official/telegram/0.0.7'
const STATE = `TELEGRAM_STATE_DIR=${MAIN}`
const PS_1223 = [
  `  2888 ?        Ss     0:00 tmux new-session -d -s main-channels bash -lc claude HOME=/srv/op ${STATE} LANG=C.UTF-8`,
  `  2889 pts/1    Ssl+   0:09 /srv/op/.local/bin/claude --channels plugin:telegram@x HOME=/srv/op ${STATE}`,
  `  4650 pts/1    Sl+    0:01 bun run --cwd ${ROOT} --shell=bun --silent start CLAUDE_PLUGIN_ROOT=${ROOT} ${STATE}`,
  ` 72915 pts/1    S+     0:00 /bin/bash -c eval 'npm test' HOME=/srv/op ${STATE}`,
  ` 76162 ?        S      0:00 sleep 600 HOME=/srv/op ${STATE}`,
  ` 77266 ?        Ss     0:00 /usr/lib/postgresql/18/bin/postgres -D pgdata ${STATE}`,
  ` 80001 pts/3    Sl+    0:01 bun run --cwd ${ROOT} start CLAUDE_PLUGIN_ROOT=${ROOT} TELEGRAM_STATE_DIR=/test/install/agents/dev/.claude/channels/telegram`,
  ` 80002 pts/4    Sl+    0:01 bun x CLAUDE_PLUGIN_ROOT=/srv/op/.claude/plugins/cache/official/telegram-inline/1.0.0 ${STATE}`,
  ` 80003 ?        S      0:00 bun y CLAUDE_PLUGIN_ROOT=${ROOT} ${STATE}-old`,
  ` 80004 ?        S      0:00 bun z CLAUDE_PLUGIN_ROOT=${ROOT} XTELEGRAM_STATE_DIR=${MAIN}`,
].join('\n') + '\n'

describe('cc4d0ddd channels.sh pass 1: selection', () => {
  it('selects only the main plugin poller out of the 12:23Z shape', () => {
    expect(select(PS_1223, STATE)).toEqual(['4650'])
  })

  it('keeps the old blast radius visible: the state dir alone matched the server and the tree', () => {
    const old = PS_1223.split('\n').filter((l) => l.includes(STATE)).map((l) => l.trim().split(/\s+/)[0])
    expect(old).toEqual(expect.arrayContaining(['2888', '2889', '72915', '76162', '77266']))
  })

  it('treats the path literally: regex metacharacters in the install dir do not widen the match', () => {
    const odd = '/test/in.st[a]ll/.claude/channels/telegram'
    const line = ` 5000 ? S 0:00 bun run CLAUDE_PLUGIN_ROOT=${ROOT} TELEGRAM_STATE_DIR=${odd}\n`
    const near = ` 5001 ? S 0:00 bun run CLAUDE_PLUGIN_ROOT=${ROOT} TELEGRAM_STATE_DIR=/test/inxstall/.claude/channels/telegram\n`
    expect(select(line + near, `TELEGRAM_STATE_DIR=${odd}`)).toEqual(['5000'])
  })
})

// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'channels-reap-pass1-'))
const chanDir = join(tmp, '.claude', 'channels', 'telegram')
const pluginRoot = join(tmp, 'plugins', 'cache', 'official', 'telegram', '0.0.1')
const fakeTmux = join(tmp, 'fake-tmux')
const reapLog = join(tmp, 'channels-reap.log')
const kids: number[] = []
function spawnEnv(cmd: string, args: string[], env: Record<string, string>): number {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...env } })
  p.unref(); kids.push(p.pid!); return p.pid!
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
afterAll(() => {
  for (const k of kids) { try { process.kill(k, 'SIGKILL') } catch { /* gone */ } }
  rmSync(tmp, { recursive: true, force: true })
})

describe('cc4d0ddd channels.sh pass 1: real processes', () => {
  it('on the real process table, a process that only inherited the state dir is not selected; a poller is', async () => {
    const plain = spawnEnv('/bin/sleep', ['600'], { TELEGRAM_STATE_DIR: chanDir })
    const poller = spawnEnv('/bin/sleep', ['600'], { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
    await sleep(200)
    const ps = execFileSync('/bin/ps', ['eww', '-e'], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 })
    const sel = select(ps, `TELEGRAM_STATE_DIR=${chanDir}`)
    expect(sel).toContain(String(poller))
    expect(sel).not.toContain(String(plain))
  })

  it('never signals the parent of a live pane or the pane, even as candidates; kills and logs a poller', async () => {
    const childFile = join(tmp, 'pane.pid')
    const server = spawnEnv('/bin/sh', ['-c', `sleep 300 & echo $! > ${childFile}; wait`],
      { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
    for (let i = 0; i < 40 && !existsSync(childFile); i++) await sleep(50)
    const pane = parseInt(readFileSync(childFile, 'utf-8').trim(), 10)
    kids.push(pane)
    const poller = spawnEnv('/bin/sleep', ['301'], { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
    writeFileSync(fakeTmux, `#!/bin/sh\necho ${pane}\n`); chmodSync(fakeTmux, 0o755)
    await sleep(200)
    execFileSync('bash', ['-c', `. "${LIB}"; channel_reap_kill "$1" pass1 "$2" "$3" "$4" "$5"`,
      'x', reapLog, fakeTmux, String(server), String(pane), String(poller)])
    await sleep(500)
    expect(alive(server)).toBe(true)
    expect(alive(pane)).toBe(true)
    expect(alive(poller)).toBe(false)
    const log = readFileSync(reapLog, 'utf-8')
    expect(log).toContain(`kill pid=${poller} cmd=/bin/sleep 301`)
    expect(log).toMatch(new RegExp(`spared \\(tmux server or live pane\\):.*\\b${server}\\b`))
    expect(log).not.toContain(`kill pid=${server}`)
  })
})

// Card 217d8669 (from the cc4d0ddd verification): protections of the shell
// path that had no test, and whose mutants stayed green:
//   (2) the argv[0]==tmux rule. `tmux list-panes -a` lists the default socket only,
//       so a server on another socket is no pane parent there; this rule spares it;
//   (3) the masking and the 240-character bound of the logged command line.
// And decision B for a failing `tmux list-panes`:
//   B1 a tmux process still runs -> the server exists but is unreachable: signal nothing;
//   B2 no tmux process at all    -> no server, the pollers are orphans: clean up;
//   B3 the process table is unreadable -> no answer: signal nothing, even when
//      list-panes itself succeeded (the pane parents cannot be resolved either).
// The tmux census reads CHANNEL_REAP_PS (a fake ps here), so the cases do not depend
// on whether this host runs a real tmux. argv[0] is set with bash `exec -a`.
describe('217d8669 channels.sh pass 1: argv[0]==tmux rule, decision B, log masking (real processes)', () => {
  const fakeTmuxDown = join(tmp, 'fake-tmux-down')
  const fakePs = join(tmp, 'fake-ps')
  const argsOf = (pid: number) => execFileSync('/bin/ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
  const psTable = (rows: string[]) => { writeFileSync(fakePs, `#!/bin/sh\ncat <<'EOF'\n${rows.join('\n')}\nEOF\n`); chmodSync(fakePs, 0o755) }
  const psBroken = () => { writeFileSync(fakePs, '#!/bin/sh\necho "ps: cannot read the process table" >&2\nexit 1\n'); chmodSync(fakePs, 0o755) }
  function reap(log: string, tmuxBin: string, pids: number[], env: Record<string, string> = {}): string {
    execFileSync('bash', ['-c', `. "${LIB}"; channel_reap_kill "$@"`, 'x', log, 'pass1', tmuxBin, ...pids.map(String)],
      { env: { ...process.env, ...env } })
    return readFileSync(log, 'utf-8')
  }
  const both = () => ({ TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
  writeFileSync(fakeTmuxDown, '#!/bin/sh\necho "error connecting to /tmp/tmux-test/default (No such file or directory)" >&2\nexit 1\n')
  chmodSync(fakeTmuxDown, 0o755)

  it('(2) with a working list-panes, a process whose argv[0] is tmux is spared; a poller in the same call dies', async () => {
    writeFileSync(fakeTmux, '#!/bin/sh\necho 4242\n'); chmodSync(fakeTmux, 0o755)
    const tmuxLike = spawnEnv('/bin/bash', ['-c', 'exec -a tmux /bin/bash -c "sleep 302; :"'], both())
    const poller = spawnEnv('/bin/sleep', ['304'], both())
    await sleep(200)
    expect(argsOf(tmuxLike)).toMatch(/^tmux /) // precondition
    const text = reap(join(tmp, 'reap-217-argv0.log'), fakeTmux, [tmuxLike, poller])
    await sleep(500)
    expect(alive(tmuxLike)).toBe(true)
    expect(alive(poller)).toBe(false)
    expect(text).toContain(`kill pid=${poller} cmd=/bin/sleep 304`)
    expect(text).toMatch(new RegExp(`spared \\(tmux server or live pane\\):.*\\b${tmuxLike}\\b`))
    expect(text).not.toContain(`kill pid=${tmuxLike}`)
  })

  it('B1: list-panes fails while a tmux process runs -> nothing is signalled, not even the poller', async () => {
    const poller = spawnEnv('/bin/sleep', ['306'], both())
    await sleep(200)
    expect(() => execFileSync(fakeTmuxDown, ['list-panes', '-a'], { stdio: 'ignore' })).toThrow() // precondition
    psTable(['  1 /sbin/init', ' 777 /usr/bin/tmux new-session -d -s other', ` ${poller} /bin/sleep 306`])
    const text = reap(join(tmp, 'reap-217-b1.log'), fakeTmuxDown, [poller], { CHANNEL_REAP_PS: fakePs })
    await sleep(500)
    expect(alive(poller)).toBe(true)
    expect(text).toMatch(new RegExp(`fail-safe, tmux list-panes failed while 1 tmux process\\(es\\) run; signalled nothing: ${poller}`))
    expect(text).not.toContain('kill pid=')
  })

  it('B2: list-panes fails and no tmux process runs -> no server: the orphan poller is cleaned up', async () => {
    const poller = spawnEnv('/bin/sleep', ['307'], both())
    await sleep(200)
    psTable(['  1 /sbin/init', ` ${poller} /bin/sleep 307`])
    const text = reap(join(tmp, 'reap-217-b2.log'), fakeTmuxDown, [poller], { CHANNEL_REAP_PS: fakePs })
    await sleep(500)
    expect(alive(poller)).toBe(false)
    expect(text).toContain('tmux list-panes failed and no tmux process runs (no server); orphan cleanup proceeds')
    expect(text).toContain(`kill pid=${poller} cmd=/bin/sleep 307`)
  })

  it('B3: an unreadable process table -> nothing is signalled, whether list-panes failed or not', async () => {
    psBroken()
    const p1 = spawnEnv('/bin/sleep', ['308'], both())
    const p2 = spawnEnv('/bin/sleep', ['309'], both())
    await sleep(200)
    const down = reap(join(tmp, 'reap-217-b3a.log'), fakeTmuxDown, [p1], { CHANNEL_REAP_PS: fakePs })
    writeFileSync(fakeTmux, '#!/bin/sh\necho 4242\n'); chmodSync(fakeTmux, 0o755)
    const up = reap(join(tmp, 'reap-217-b3b.log'), fakeTmux, [p2], { CHANNEL_REAP_PS: fakePs })
    await sleep(500)
    expect(alive(p1)).toBe(true)
    expect(alive(p2)).toBe(true)
    expect(down).toContain(`fail-safe, the process table is unreadable; signalled nothing: ${p1}`)
    expect(up).toContain(`fail-safe, the process table is unreadable; signalled nothing: ${p2}`)
    // an EMPTY table with exit 0 is no answer either (a real host always lists at least init)
    writeFileSync(fakePs, '#!/bin/sh\nexit 0\n'); chmodSync(fakePs, 0o755)
    const p3 = spawnEnv('/bin/sleep', ['310'], both())
    await sleep(200)
    const empty = reap(join(tmp, 'reap-217-b3c.log'), fakeTmuxDown, [p3], { CHANNEL_REAP_PS: fakePs })
    await sleep(500)
    expect(alive(p3)).toBe(true)
    expect(empty).toContain(`fail-safe, the process table is unreadable; signalled nothing: ${p3}`)
  })

  it('masks secret-looking values in the logged command line and keeps it within 240 characters', async () => {
    writeFileSync(fakeTmux, '#!/bin/sh\necho 4242\n'); chmodSync(fakeTmux, 0o755)
    const log = join(tmp, 'reap-217-mask.log')
    const secretish = spawnEnv('/bin/sh', ['-c', 'sleep 303; :', 'x',
      'API_KEY=supersecret123', 'MY_TOKEN_X=tok-abc', 'Authorization:', 'Bearer', 'bearer-xyz789'], {})
    const long = spawnEnv('/bin/sh', ['-c', 'sleep 305; :', 'x', 'L'.repeat(400)], {})
    await sleep(200)
    execFileSync('bash', ['-c', `. "${LIB}"; channel_reap_kill "$1" pass1 "$2" "$3" "$4"`,
      'x', log, fakeTmux, String(secretish), String(long)])
    await sleep(500)
    const lines = readFileSync(log, 'utf-8').split('\n')
    const s = lines.find((l) => l.includes(`kill pid=${secretish} cmd=`))
    expect(s).toBeDefined() // positive control: the kill was logged
    expect(s).toContain('API_KEY=<redacted>')
    expect(s).toContain('MY_TOKEN_X=<redacted>')
    expect(s).toContain('Bearer <redacted>')
    expect(s).not.toMatch(/supersecret123|tok-abc|bearer-xyz789/)
    const l = lines.find((x) => x.includes(`kill pid=${long} cmd=`))
    expect(l).toBeDefined()
    expect(l!.split(' cmd=')[1]!.length).toBeLessThanOrEqual(240)
    expect(l).toContain('LLLL')
  })
})

// Card 10ecf883: the two rules the dashboard's reaper keeps for its own kill paths, now in the shell pass too:
//   (uid)       only processes owned by our own uid are signalled; an owner that cannot be read is spared
//               (CHANNEL_REAP_OWN_UID stands in for `id -u` here, so a real process can play another user's);
//   (ancestors) every ancestor of a live pane is spared, not only its parent (a real process chain).
describe('10ecf883 channels.sh pass 1: own uid and every pane ancestor (real processes)', () => {
  const both = () => ({ TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
  function reapWith(log: string, pids: number[], env: Record<string, string> = {}): string {
    execFileSync('bash', ['-c', `. "${LIB}"; channel_reap_kill "$@"`, 'x', log, 'pass1', fakeTmux, ...pids.map(String)],
      { env: { ...process.env, ...env } })
    return readFileSync(log, 'utf-8')
  }

  it('(uid) a poller owned by another uid is spared and logged; the same poller dies with our own uid', async () => {
    writeFileSync(fakeTmux, '#!/bin/sh\necho 4242\n'); chmodSync(fakeTmux, 0o755)
    const poller = spawnEnv('/bin/sleep', ['311'], both())
    await sleep(200)
    const other = String((process.getuid?.() ?? 0) + 1)
    const spared = reapWith(join(tmp, 'reap-10ec-uid-a.log'), [poller], { CHANNEL_REAP_OWN_UID: other })
    await sleep(500)
    expect(alive(poller)).toBe(true)
    expect(spared).toContain(`spared (another uid, or the owner is unreadable): ${poller}`)
    expect(spared).not.toContain('kill pid=')
    const killed = reapWith(join(tmp, 'reap-10ec-uid-b.log'), [poller])
    await sleep(500)
    expect(alive(poller)).toBe(false)
    expect(killed).toContain(`kill pid=${poller} cmd=/bin/sleep 311`)
  })

  it('(uid) a candidate whose owner cannot be read (no such process) is spared, not signalled', () => {
    writeFileSync(fakeTmux, '#!/bin/sh\necho 4242\n'); chmodSync(fakeTmux, 0o755)
    const gone = [4194301, 3999991, 99997, 99991].find((p) => !alive(p))
    expect(gone).toBeDefined() // precondition: a pid that no process holds
    const text = reapWith(join(tmp, 'reap-10ec-uid-gone.log'), [gone!])
    expect(text).toContain(`spared (another uid, or the owner is unreadable): ${gone}`)
    expect(text).not.toContain(`kill pid=${gone}`)
  })

  it('(ancestors) every ancestor of a live pane is spared, not only its parent; a poller in the same call dies', async () => {
    const paneFile = join(tmp, 'pane-10ec.pid')
    const midFile = join(tmp, 'mid-10ec.pid')
    // outer sh -> mid sh -> sleep (the pane): the outer one is the pane's GRANDPARENT
    const outer = spawnEnv('/bin/sh', ['-c', `sh -c 'sleep 313 & echo $! > ${paneFile}; wait' & echo $! > ${midFile}; wait`], both())
    for (let i = 0; i < 60 && !(existsSync(paneFile) && existsSync(midFile)); i++) await sleep(50)
    const pane = parseInt(readFileSync(paneFile, 'utf-8').trim(), 10)
    const mid = parseInt(readFileSync(midFile, 'utf-8').trim(), 10)
    kids.push(pane, mid)
    const poller = spawnEnv('/bin/sleep', ['314'], both())
    writeFileSync(fakeTmux, `#!/bin/sh\necho ${pane}\n`); chmodSync(fakeTmux, 0o755)
    await sleep(200)
    const ppid = (p: number) => execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf-8' }).trim()
    expect(ppid(pane)).toBe(String(mid)) // precondition: the chain is outer -> mid -> pane
    expect(ppid(mid)).toBe(String(outer))
    const text = reapWith(join(tmp, 'reap-10ec-anc.log'), [outer, mid, poller])
    await sleep(500)
    expect(alive(outer)).toBe(true)
    expect(alive(mid)).toBe(true)
    expect(alive(poller)).toBe(false)
    expect(text).toMatch(new RegExp(`spared \\(tmux server or live pane\\):.*\\b${outer}\\b`))
    expect(text).not.toContain(`kill pid=${outer}`)
    expect(text).toContain(`kill pid=${poller} cmd=/bin/sleep 314`)
  })
})

describe('cc4d0ddd channels.sh pass 1: wiring', () => {
  it('sources the helpers and uses them for pass 1', () => {
    expect(channelsSh).toContain('. "$INSTALL_DIR/scripts/lib/channel-reap.sh"')
    expect(channelsSh).toMatch(/ORPHAN_PIDS="\$\(\/bin\/ps eww -e 2>\/dev\/null \| channel_reap_select_pass1 /)
    expect(channelsSh).toContain('channel_reap_kill "$INSTALL_DIR/store/channels-reap.log" pass1 "$TMUX" $ORPHAN_PIDS')
  })

  it('has no state-dir-only regex match left in pass 1', () => {
    expect(channelsSh).not.toContain(`awk -v needle="\${STATE_ENV_VAR}=\${MAIN_CHAN_DIR}" '$0 ~ needle`)
  })
})
