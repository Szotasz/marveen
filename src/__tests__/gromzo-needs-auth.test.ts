// GROMZONEEDSAUTH1109 (Samu 74033): the Gromzo server's cached needs-auth entry goes out before a launch that carries
// the Gromzo channel; nothing else in Claude Code's cache file changes. Measured on the QA VPS 11-09 (V30, V31): the
// entry a gromzo-pending session left there kept the next session deaf until a /mcp reconnect.
//   1. the helper itself (src/web/gromzo-needs-auth.ts), on real files;
//   2. the CLI (scripts/gromzo-needs-auth-clear.mjs) against a stub dist, as main-auth-helper.test.ts does;
//   3. channels.sh's REAL block, sliced and run with a recording `node` stub;
//   4. the respawns (GROMZONEEDSAUTHGUARDS1109): the step IN the pane command, right before claude, in the dashboard's
//      built command (gromzoNeedsAuthPaneStep) and in channel-watchdog.sh / stuck-modal-guard.sh
//      (scripts/gromzo-needs-auth-pane.sh); the two builders give the same group.
import { describe, it, expect } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  GROMZO_NEEDS_AUTH_KEY, NEEDS_AUTH_CACHE_FILE, clearGromzoNeedsAuth, describeNeedsAuthClear, launchLoadsGromzo, mainNeedsAuthConfigDir,
} from '../web/gromzo-needs-auth.js'
import { buildMainSessionRespawnCmd, gromzoNeedsAuthPaneStep } from '../web/channel-monitor.js'

const REPO = join(__dirname, '..', '..')
// The entry exactly as Claude Code 2.1.319 wrote it on the VPS (V31), next to another server's entry.
const GZ = `"${GROMZO_NEEDS_AUTH_KEY}":{"timestamp":1794220943542,"id":"65ecf56c3f03424e"}`
const OTHER = '"claude.ai Gmail":{"timestamp":1794000000000,"id":"0123456789abcdef"}'

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'gz-needsauth-'))
}
function put(d: string, body: string, mode = 0o600): string {
  const f = join(d, NEEDS_AUTH_CACHE_FILE)
  writeFileSync(f, body)
  chmodSync(f, mode)
  return f
}

describe('clearGromzoNeedsAuth: only the Gromzo key goes', () => {
  it('compact file: the Gromzo entry goes, the other entry stays byte for byte, the mode stays, no temp file left', () => {
    const d = dir()
    const f = put(d, `{${OTHER},${GZ}}`, 0o640)
    const r = clearGromzoNeedsAuth(d)
    expect(r.outcome).toBe('removed')
    expect(readFileSync(f, 'utf8')).toBe(`{${OTHER}}`)
    expect(statSync(f).mode & 0o777).toBe(0o640)
    expect(readdirSync(d)).toEqual([NEEDS_AUTH_CACHE_FILE])
  })

  it('a mode the umask would strip (o+w; CI runs under 022 and 002) stays exactly', () => {
    const d = dir()
    const f = put(d, `{${GZ}}`, 0o602)
    expect(clearGromzoNeedsAuth(d).outcome).toBe('removed')
    expect(statSync(f).mode & 0o777).toBe(0o602)
  })

  it('the Gromzo entry first or alone: what is left is exactly the rest', () => {
    const d1 = dir()
    put(d1, `{${GZ},${OTHER}}`)
    expect(clearGromzoNeedsAuth(d1).outcome).toBe('removed')
    expect(readFileSync(join(d1, NEEDS_AUTH_CACHE_FILE), 'utf8')).toBe(`{${OTHER}}`)
    const d2 = dir()
    put(d2, `{${GZ}}`)
    expect(clearGromzoNeedsAuth(d2).outcome).toBe('removed')
    expect(readFileSync(join(d2, NEEDS_AUTH_CACHE_FILE), 'utf8')).toBe('{}')
  })

  it('2-space file with a trailing newline: the same formatting and the newline stay', () => {
    const d = dir()
    const obj = { 'claude.ai Gmail': { timestamp: 1, id: 'a' }, [GROMZO_NEEDS_AUTH_KEY]: { timestamp: 2, id: 'b' } }
    put(d, JSON.stringify(obj, null, 2) + '\n')
    expect(clearGromzoNeedsAuth(d).outcome).toBe('removed')
    expect(readFileSync(join(d, NEEDS_AUTH_CACHE_FILE), 'utf8')).toBe(JSON.stringify({ 'claude.ai Gmail': { timestamp: 1, id: 'a' } }, null, 2) + '\n')
  })

  it('no file: absent, and no file is created', () => {
    const d = dir()
    expect(clearGromzoNeedsAuth(d).outcome).toBe('absent')
    expect(existsSync(join(d, NEEDS_AUTH_CACHE_FILE))).toBe(false)
  })

  const untouched: Array<[string, string, string]> = [
    ['no Gromzo key', `{${OTHER}}`, 'no_key'],
    ['the empty cache', '{}', 'no_key'],
    ['not JSON', `{${GZ},`, 'not_json'],
    ['a JSON array', `[{${GZ}}]`, 'unknown_shape'],
    ['JSON null', 'null', 'unknown_shape'],
    ['4-space formatting (a rewrite would change the other entry)', JSON.stringify({ [GROMZO_NEEDS_AUTH_KEY]: 1, x: { y: 1 } }, null, 4), 'unknown_format'],
  ]
  for (const [name, body, outcome] of untouched) {
    it(`${name}: ${outcome}, the file is left byte for byte`, () => {
      const d = dir()
      const f = put(d, body)
      expect(clearGromzoNeedsAuth(d).outcome).toBe(outcome)
      expect(readFileSync(f, 'utf8')).toBe(body)
      expect(readdirSync(d)).toEqual([NEEDS_AUTH_CACHE_FILE])
    })
  }

  it('a symlink: unknown_shape, neither the link nor its target is written', () => {
    const d = dir()
    const target = join(dir(), 'real.json')
    writeFileSync(target, `{${GZ}}`)
    symlinkSync(target, join(d, NEEDS_AUTH_CACHE_FILE))
    const r = clearGromzoNeedsAuth(d)
    expect(r.outcome).toBe('unknown_shape')
    expect(r.detail).toBe('a symlink')
    expect(readFileSync(target, 'utf8')).toBe(`{${GZ}}`)
  })

  it('every outcome has its own log line naming the file', () => {
    const d = dir()
    put(d, `{${GZ}}`)
    const line = describeNeedsAuthClear(clearGromzoNeedsAuth(d))
    expect(line).toMatch(/^gromzo-needs-auth: removed the cached needs-auth entry plugin:gromzo-channel:gromzo/)
    expect(line.endsWith(join(d, NEEDS_AUTH_CACHE_FILE))).toBe(true)
    expect(describeNeedsAuthClear({ outcome: 'not_json', file: '/x' })).toBe('gromzo-needs-auth: no-op: the file is not JSON, left as it is: /x')
  })
})

describe('launchLoadsGromzo and mainNeedsAuthConfigDir', () => {
  it('only the exact --channels word of the Gromzo plugin counts', () => {
    expect(launchLoadsGromzo("x && claude --dangerously-skip-permissions --channels plugin:slack-channel@x plugin:gromzo-channel@gromzo-local")).toBe(true)
    expect(launchLoadsGromzo('claude --channels plugin:gromzo-channel@gromzo-local')).toBe(true)
    expect(launchLoadsGromzo('claude --channels plugin:telegram@claude-plugins-official')).toBe(false)
    expect(launchLoadsGromzo('claude --channels plugin:gromzo-channel@gromzo-localx')).toBe(false)
    expect(launchLoadsGromzo('claude --dangerously-skip-permissions')).toBe(false)
  })
  it('the isolated dir, else CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(mainNeedsAuthConfigDir('/iso', { CLAUDE_CONFIG_DIR: '/env' })).toBe('/iso')
    expect(mainNeedsAuthConfigDir(null, { CLAUDE_CONFIG_DIR: '/env' })).toBe('/env')
    expect(mainNeedsAuthConfigDir(null, {}).endsWith(join('.claude'))).toBe(true)
  })
})

describe('scripts/gromzo-needs-auth-clear.mjs (against a stub dist)', () => {
  function cli(stub: string | null, args: string[]) {
    const root = dir()
    mkdirSync(join(root, 'scripts'))
    copyFileSync(join(REPO, 'scripts', 'gromzo-needs-auth-clear.mjs'), join(root, 'scripts', 'gromzo-needs-auth-clear.mjs'))
    if (stub !== null) {
      mkdirSync(join(root, 'dist', 'web'), { recursive: true })
      writeFileSync(join(root, 'dist', 'web', 'gromzo-needs-auth.js'), stub)
    }
    const r = spawnSync('node', [join(root, 'scripts', 'gromzo-needs-auth-clear.mjs'), ...args], { encoding: 'utf8' })
    return { status: r.status, out: r.stdout, err: r.stderr }
  }
  const STUB = `export function clearGromzoNeedsAuth(d) { return { outcome: 'removed', file: d + '/F' } }
export function describeNeedsAuthClear(r) { return 'LINE ' + r.outcome + ' ' + r.file }`
  it('passes the dir to the helper and prints its one line on stderr, nothing on stdout, exit 0', () => {
    const r = cli(STUB, ['/cfg'])
    expect(r).toEqual({ status: 0, out: '', err: 'LINE removed /cfg/F\n' })
  })
  it('no dir, no dist, or a throwing helper: one no-op line and exit 0 (a launch is never blocked)', () => {
    expect(cli(STUB, [])).toEqual({ status: 0, out: '', err: 'gromzo-needs-auth: no-op: no config dir given\n' })
    const nodist = cli(null, ['/cfg'])
    expect(nodist.status).toBe(0)
    expect(nodist.err).toMatch(/^gromzo-needs-auth: no-op: failed \(/)
    const thrown = cli('export function clearGromzoNeedsAuth() { throw new Error("boom") }\nexport function describeNeedsAuthClear() { return "" }', ['/cfg'])
    expect(thrown).toEqual({ status: 0, out: '', err: 'gromzo-needs-auth: no-op: failed (boom)\n' })
  })
})

describe('channels.sh: the REAL cleanup block before the launch', () => {
  const CH = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf8')
  const a = CH.indexOf('case " $CHANNELS_ARG " in\n  *" plugin:gromzo-channel@gromzo-local "*)')
  const b = CH.indexOf('\nesac\n', a) + '\nesac\n'.length
  const BLOCK = CH.slice(a, b)

  it('the block sits after the old session is killed and before the first new-session', () => {
    const kill = CH.indexOf('$TMUX kill-session -t "=$SESSION:" 2>/dev/null || true\n# GROMZONEEDSAUTH1109')
    const launch = CH.indexOf('$TMUX new-session -d -s "$SESSION" -c "$INSTALL_DIR"')
    expect(a).toBeGreaterThan(0)
    expect(kill).toBeGreaterThan(0)
    expect(kill).toBeLessThan(a)
    expect(b).toBeLessThan(launch)
    expect(BLOCK).not.toMatch(/\b(tmux|systemctl|launchctl|kill)\b/)
  })

  function run(o: { channelsArg: string; cfgEnv: string; mainCfgDir?: string; claudeConfigDir?: string; noScript?: boolean }) {
    const root = dir()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    mkdirSync(join(root, 'scripts'))
    if (!o.noScript) writeFileSync(join(root, 'scripts', 'gromzo-needs-auth-clear.mjs'), '')
    writeFileSync(join(bin, 'node'), `#!/bin/bash\necho "NODE $*" >> '${root}/calls'\nexit 3\n`)
    chmodSync(join(bin, 'node'), 0o755)
    const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: '/home/owner' }
    if (o.claudeConfigDir) env.CLAUDE_CONFIG_DIR = o.claudeConfigDir
    const r = spawnSync('bash', ['-c', [
      `INSTALL_DIR='${root}' CHANNELS_ARG='${o.channelsArg}' CFG_ENV='${o.cfgEnv}' _MAIN_CFG_DIR='${o.mainCfgDir ?? ''}'`,
      BLOCK,
      'echo "AFTER rc=$? na_dir=${_gz_na_dir-unset}"',
    ].join('\n')], { encoding: 'utf8', env })
    return { out: r.stdout, err: r.stderr, calls: existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : '', root }
  }

  it('a Gromzo launch with an isolated config: the helper runs on that dir; its failure does not stop the start', () => {
    const r = run({ channelsArg: '--channels plugin:gromzo-channel@gromzo-local', cfgEnv: 'export CLAUDE_CONFIG_DIR=x && ', mainCfgDir: '/iso/cfg' })
    expect(r.calls).toBe(`NODE ${r.root}/scripts/gromzo-needs-auth-clear.mjs /iso/cfg\n`)
    expect(r.out).toBe('AFTER rc=0 na_dir=unset\n')
  })
  it('a Gromzo extra next to another primary, shared config: the inherited CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    const r1 = run({ channelsArg: '--channels plugin:slack-channel@x plugin:gromzo-channel@gromzo-local', cfgEnv: '', claudeConfigDir: '/inh' })
    expect(r1.calls).toBe(`NODE ${r1.root}/scripts/gromzo-needs-auth-clear.mjs /inh\n`)
    const r2 = run({ channelsArg: '--channels plugin:gromzo-channel@gromzo-local', cfgEnv: '' })
    expect(r2.calls).toBe(`NODE ${r2.root}/scripts/gromzo-needs-auth-clear.mjs /home/owner/.claude\n`)
  })
  it('no Gromzo channel (a pending session, another provider, a look-alike id): the helper does not run', () => {
    for (const channelsArg of ['', '--channels plugin:slack-channel@x', '--channels plugin:gromzo-channel@gromzo-localx']) {
      const r = run({ channelsArg, cfgEnv: '', mainCfgDir: '/iso' })
      expect(r.calls).toBe('')
      expect(r.out).toBe('AFTER rc=0 na_dir=unset\n')
    }
  })
  it('the helper script missing: one no-op line, the start goes on', () => {
    const r = run({ channelsArg: '--channels plugin:gromzo-channel@gromzo-local', cfgEnv: '', claudeConfigDir: '/inh', noScript: true })
    expect(r.calls).toBe('')
    expect(r.err).toBe('gromzo-needs-auth: no-op: node or scripts/gromzo-needs-auth-clear.mjs missing: /inh\n')
    expect(r.out).toBe('AFTER rc=0 na_dir=unset\n')
  })
})

describe('the respawn step: runs in the pane, on the dir the new claude reads', () => {
  // A project root as the step sees it: the REAL helper script (unless left out) and a stub dist that records the dir.
  function root(name = 'gz root', withHelper = true) {
    const r = join(dir(), name)
    mkdirSync(join(r, 'scripts'), { recursive: true })
    mkdirSync(join(r, 'store'))
    mkdirSync(join(r, 'dist', 'web'), { recursive: true })
    if (withHelper) copyFileSync(join(REPO, 'scripts', 'gromzo-needs-auth-clear.mjs'), join(r, 'scripts', 'gromzo-needs-auth-clear.mjs'))
    writeFileSync(join(r, 'dist', 'web', 'gromzo-needs-auth.js'), `export function clearGromzoNeedsAuth(d) { return { outcome: 'removed', file: d } }
export function describeNeedsAuthClear(r) { return 'CLEARED ' + r.file }`)
    return r
  }
  function runStep(step: string, env: Record<string, string>) {
    const r = spawnSync('bash', ['-c', `${step} && echo "CLAUDE starts"`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } })
    return { out: r.stdout, err: r.stderr, status: r.status }
  }
  const log = (r: string) => (existsSync(join(r, 'store', 'channels-failures.log')) ? readFileSync(join(r, 'store', 'channels-failures.log'), 'utf8') : '')

  it("the pane's CLAUDE_CONFIG_DIR, else $HOME/.claude; the line goes to channels-failures.log; claude starts after it", () => {
    const r = root("it's a root") // an apostrophe and a space in the install path
    const step = gromzoNeedsAuthPaneStep(r)
    expect(runStep(step, { CLAUDE_CONFIG_DIR: "/cfg/o'neil dir", HOME: '/home/o' })).toEqual({ out: 'CLAUDE starts\n', err: '', status: 0 })
    expect(runStep(step, { HOME: '/home/o' }).out).toBe('CLAUDE starts\n')
    expect(log(r)).toBe("CLEARED /cfg/o'neil dir\nCLEARED /home/o/.claude\n")
  })
  it('the helper missing, or node failing: claude still starts, nothing on the pane', () => {
    const r = root('no helper', false)
    expect(runStep(gromzoNeedsAuthPaneStep(r), { HOME: '/h' })).toEqual({ out: 'CLAUDE starts\n', err: '', status: 0 })
    expect(log(r)).toBe('')
    const r2 = root()
    const bin = join(dir(), 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'node'), '#!/bin/bash\necho boom >&2\nexit 7\n')
    chmodSync(join(bin, 'node'), 0o755)
    const res = spawnSync('bash', ['-c', `${gromzoNeedsAuthPaneStep(r2)} && echo "CLAUDE starts"`], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: '/h' } })
    expect(res.stdout).toBe('CLAUDE starts\n')
    expect(res.stderr).toBe('')
    expect(log(r2)).toBe('boom\n')
  })
  it('the bash builder (channel-watchdog.sh, stuck-modal-guard.sh) gives the same group as the dashboard', () => {
    for (const r of ['/opt/marveen', "/Users/o'neil/my marveen"]) {
      const sh = spawnSync('bash', ['-c', `. '${join(REPO, 'scripts', 'gromzo-needs-auth-pane.sh')}'; gromzo_needs_auth_pane_step "$1" "$2"`, 'x', r, '--channels plugin:slack-channel@x plugin:gromzo-channel@gromzo-local'], { encoding: 'utf8' })
      expect(sh.stdout).toBe(`${gromzoNeedsAuthPaneStep(r)} && `)
    }
  })
  it('the bash builder prints nothing without the exact Gromzo channel word', () => {
    for (const arg of ['', '--channels plugin:slack-channel@x', '--channels plugin:gromzo-channel@gromzo-localx']) {
      const sh = spawnSync('bash', ['-c', `. '${join(REPO, 'scripts', 'gromzo-needs-auth-pane.sh')}'; gromzo_needs_auth_pane_step /opt/m "$1"; echo "rc=$?"`, 'x', arg], { encoding: 'utf8' })
      expect(sh.stdout).toBe('rc=0\n')
    }
  })
})

describe('the dashboard respawn: the step sits in the built command, after the exports, right before claude', () => {
  const base = { claudePath: '/x/claude', channelStateEnv: { name: 'GROMZO_STATE_DIR', dir: '/s' }, mainAgentId: 'marveen', gromzoTokenFile: null }
  const STEP = `&& ${gromzoNeedsAuthPaneStep()} && /x/claude `
  it('a REAL built respawn with the Gromzo channel (primary or extra): the step, once, right before claude, after the config exports', () => {
    for (const o of [
      { pluginId: 'gromzo-channel@gromzo-local', gromzoPrimaryReady: true },
      { pluginId: 'slack-channel@x', extraPluginIds: ['gromzo-channel@gromzo-local'] },
    ]) {
      const cmd = buildMainSessionRespawnCmd({ ...base, ...o, config: { isolatedConfigDir: '/iso', fleetToken: true } } as never)
      expect(cmd.split(gromzoNeedsAuthPaneStep()).length - 1).toBe(1)
      expect(cmd).toContain(STEP)
      expect(cmd.indexOf("export CLAUDE_CONFIG_DIR='/iso'")).toBeLessThan(cmd.indexOf(STEP))
      expect(cmd.indexOf('.channels-pane-auth-post')).toBeLessThan(cmd.indexOf(STEP))
    }
  })
  it('a pending respawn (no Gromzo channel) or another provider: no step', () => {
    const pending = buildMainSessionRespawnCmd({ ...base, pluginId: 'gromzo-channel@gromzo-local', gromzoPrimaryReady: false, config: { isolatedConfigDir: '/iso', fleetToken: true } } as never)
    const slack = buildMainSessionRespawnCmd({ ...base, pluginId: 'slack-channel@x', config: { isolatedConfigDir: '/iso', fleetToken: true } } as never)
    for (const c of [pending, slack]) expect(c).not.toContain('gromzo-needs-auth-clear.mjs')
  })
  it('an isolated config dir with an apostrophe is ONE shell word (it broke the command before; Dani 74108 (2))', () => {
    for (const config of [
      { isolatedConfigDir: "/Users/o'neil/cfg", ownCredentials: true },
      { isolatedConfigDir: "/Users/o'neil/cfg", tokenSecretId: 'T' },
      { isolatedConfigDir: "/Users/o'neil/cfg", fleetToken: true },
    ]) {
      const cmd = buildMainSessionRespawnCmd({ ...base, pluginId: 'gromzo-channel@gromzo-local', gromzoPrimaryReady: true, config } as never)
      expect(cmd).toContain("export CLAUDE_CONFIG_DIR='/Users/o'\\''neil/cfg' && ")
      const m = /export CLAUDE_CONFIG_DIR=('(?:[^']|'\\'')*') /.exec(cmd)
      const r = spawnSync('bash', ['-c', `printf '%s' ${m![1]}`], { encoding: 'utf8' })
      expect(r.stdout).toBe("/Users/o'neil/cfg")
    }
  })
  it('the three respawn-pane sites use the built command as is; the old before-respawn clear is gone', () => {
    const src = readFileSync(join(REPO, 'src', 'web', 'channel-monitor.ts'), 'utf8')
    expect(src.split("execFileSync(tmuxBin(), ['respawn-pane', '-k', '-t', exactTmuxTarget(MAIN_CHANNELS_SESSION), claudeCmd]").length - 1).toBe(3)
    expect(src.match(/const claudeCmd = buildMainSessionRespawnCmd\(\{/g)?.length).toBe(3)
    expect(src).not.toContain('clearGromzoNeedsAuthBeforeRespawn')
  })
})

describe('channel-watchdog.sh and stuck-modal-guard.sh: the step in their respawn command', () => {
  for (const [file, chanVar, claudeVar] of [
    ['channel-watchdog.sh', 'CHANNELS_ARG', '$CLAUDE --dangerously-skip-permissions'],
    ['stuck-modal-guard.sh', 'CHAN_ARG', '$CLAUDE_Q --dangerously-skip-permissions'],
  ] as const) {
    const src = readFileSync(join(REPO, 'scripts', file), 'utf8')
    it(`${file}: the step from its own channels arg, a no-op fallback, and right before claude in RESPAWN_CMD`, () => {
      expect(src).toContain('. "$INSTALL_DIR/scripts/gromzo-needs-auth-pane.sh" 2>/dev/null || gromzo_needs_auth_pane_step() { :; }')
      expect(src).toMatch(new RegExp(`GROMZO_NA_STEP="\\$\\(gromzo_needs_auth_pane_step "\\$INSTALL_DIR" "\\$${chanVar}"\\)"`))
      const cmd = src.split('\n').filter((l) => /RESPAWN_CMD="export PATH=/.test(l))
      expect(cmd.length).toBe(1)
      expect(cmd[0]).toContain(`\${PANE_AUTH_POST}\${GROMZO_ENV}\${GROMZO_NA_STEP}${claudeVar}`)
      // the step is computed after the channels arg is final and before the respawn command is built
      const at = src.indexOf('GROMZO_NA_STEP="$(')
      expect(at).toBeGreaterThan(src.lastIndexOf(`${chanVar}=`))
      expect(at).toBeLessThan(src.indexOf(cmd[0]))
    })
    it(`${file}: the sliced step block, run: the Gromzo arg gives the group, a pending arg gives nothing, no helper gives nothing`, () => {
      const a = src.indexOf('. "$INSTALL_DIR/scripts/gromzo-needs-auth-pane.sh"')
      const b = src.indexOf('\n', src.indexOf('GROMZO_NA_STEP="$(')) + 1
      const block = src.slice(a, b).replace(/^\s*local /gm, '')
      const run = (installDir: string, arg: string) =>
        spawnSync('bash', ['-c', `INSTALL_DIR='${installDir}' ${chanVar}='${arg}'\n${block}\nprintf '%s' "$GROMZO_NA_STEP"`], { encoding: 'utf8' }).stdout
      expect(run(REPO, '--channels plugin:gromzo-channel@gromzo-local')).toBe(`${gromzoNeedsAuthPaneStep(REPO)} && `)
      expect(run(REPO, '')).toBe('')
      expect(run(dir(), '--channels plugin:gromzo-channel@gromzo-local')).toBe('')
    })
  }
})
