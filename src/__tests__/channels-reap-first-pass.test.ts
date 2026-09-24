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
const ROOT = '/home/op/.claude/plugins/cache/official/telegram/0.0.7'
const STATE = `TELEGRAM_STATE_DIR=${MAIN}`
const PS_1223 = [
  `  2888 ?        Ss     0:00 tmux new-session -d -s main-channels bash -lc claude HOME=/home/op ${STATE} LANG=C.UTF-8`,
  `  2889 pts/1    Ssl+   0:09 /home/op/.local/bin/claude --channels plugin:telegram@x HOME=/home/op ${STATE}`,
  `  4650 pts/1    Sl+    0:01 bun run --cwd ${ROOT} --shell=bun --silent start CLAUDE_PLUGIN_ROOT=${ROOT} ${STATE}`,
  ` 72915 pts/1    S+     0:00 /bin/bash -c eval 'npm test' HOME=/home/op ${STATE}`,
  ` 76162 ?        S      0:00 sleep 600 HOME=/home/op ${STATE}`,
  ` 77266 ?        Ss     0:00 /usr/lib/postgresql/18/bin/postgres -D pgdata ${STATE}`,
  ` 80001 pts/3    Sl+    0:01 bun run --cwd ${ROOT} start CLAUDE_PLUGIN_ROOT=${ROOT} TELEGRAM_STATE_DIR=/test/install/agents/dev/.claude/channels/telegram`,
  ` 80002 pts/4    Sl+    0:01 bun x CLAUDE_PLUGIN_ROOT=/home/op/.claude/plugins/cache/official/telegram-inline/1.0.0 ${STATE}`,
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
