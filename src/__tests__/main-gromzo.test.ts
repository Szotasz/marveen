// GROMZOMAINAGENT1106 phase 1: the main agent's launch side of Gromzo.
//  - the .env token writer (only the gromzo id, atomic, mode kept, refuses an ambiguous file);
//  - switchMainGromzoOn: the marketplace first, .env only after it;
//  - restartMainAfterMxdReload: an observable signal (mxd answers, the main slug not held), never forced;
//  - the shell launcher helpers and their TS twin agree on the same inputs;
//  - the recovery respawn exports MXD_AGENT/MXD_SCOPE only when it carries the gromzo id.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readMainGromzoToken, setMainGromzoToken, switchMainGromzoOn, switchMainGromzoOff,
  restartMainAfterMxdReload, restartMainForGromzoNow, mainGromzoLaunchState, resetMainGromzoLaunchState,
  mainGromzoPanelState, mainSessionLoadsGromzo,
} from '../web/main-gromzo.js'
import { filterMainGromzoIds, mainGromzoEnv, mainGromzoSlug, MAIN_GROMZO_PLUGIN_ID } from '../web/main-gromzo-launch.js'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'

const ROOT = join(__dirname, '..', '..')
const GZ = MAIN_GROMZO_PLUGIN_ID
const SLACK = 'slack-channel@marveen-local'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'main-gromzo-')); resetMainGromzoLaunchState() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const envPath = () => join(dir, '.env')
const env = () => readFileSync(envPath(), 'utf-8')

describe('the .env token writer', () => {
  it('adds the id to an existing line, keeping the other ids, the other lines and the mode', () => {
    writeFileSync(envPath(), `A=1\nCHANNEL_PLUGINS_EXTRA=${SLACK}\nB=2\n`, { mode: 0o640 })
    chmodSync(envPath(), 0o640)
    expect(setMainGromzoToken(dir, true)).toEqual({ ok: true, changed: true })
    expect(env()).toBe(`A=1\nCHANNEL_PLUGINS_EXTRA=${SLACK} ${GZ}\nB=2\n`)
    expect(statSync(envPath()).mode & 0o777).toBe(0o640)
    expect(readMainGromzoToken(dir)).toEqual({ ok: true, on: true, ids: [SLACK, GZ] })
  })

  it('appends a new line before the final newline when the key is missing', () => {
    writeFileSync(envPath(), 'A=1\n')
    setMainGromzoToken(dir, true)
    expect(env()).toBe(`A=1\nCHANNEL_PLUGINS_EXTRA=${GZ}\n`)
  })

  it('creates .env with mode 600 when there is none', () => {
    setMainGromzoToken(dir, true)
    expect(env()).toBe(`CHANNEL_PLUGINS_EXTRA=${GZ}\n`)
    expect(statSync(envPath()).mode & 0o777).toBe(0o600)
  })

  it('is idempotent: a second on, or off when absent, does not touch the file', () => {
    writeFileSync(envPath(), `CHANNEL_PLUGINS_EXTRA=${GZ}\n`)
    const before = statSync(envPath()).mtimeMs
    expect(setMainGromzoToken(dir, true)).toEqual({ ok: true, changed: false })
    writeFileSync(join(dir, 'other'), '')
    expect(statSync(envPath()).mtimeMs).toBe(before)
    rmSync(envPath())
    expect(setMainGromzoToken(dir, false)).toEqual({ ok: true, changed: false })
    expect(existsSync(envPath())).toBe(false)
  })

  it('removes only the gromzo id, and drops the line when it was the last one', () => {
    writeFileSync(envPath(), `A=1\nCHANNEL_PLUGINS_EXTRA=${SLACK} ${GZ}\n`)
    setMainGromzoToken(dir, false)
    expect(env()).toBe(`A=1\nCHANNEL_PLUGINS_EXTRA=${SLACK}\n`)
    writeFileSync(envPath(), `A=1\nCHANNEL_PLUGINS_EXTRA=${GZ}\nB=2\n`)
    setMainGromzoToken(dir, false)
    expect(env()).toBe('A=1\nB=2\n')
  })

  it('refuses a key that appears twice, or a quoted value, and writes nothing', () => {
    for (const text of [
      `CHANNEL_PLUGINS_EXTRA=${SLACK}\nCHANNEL_PLUGINS_EXTRA=\n`,
      `CHANNEL_PLUGINS_EXTRA="${SLACK}"\n`,
      `CHANNEL_PLUGINS_EXTRA='${SLACK}'\n`,
    ]) {
      writeFileSync(envPath(), text)
      expect(setMainGromzoToken(dir, true)).toEqual({ ok: false, code: 'env_ambiguous' })
      expect(env()).toBe(text)
    }
  })

  it('leaves no temp file behind', () => {
    writeFileSync(envPath(), 'A=1\n')
    setMainGromzoToken(dir, true)
    setMainGromzoToken(dir, false)
    expect(execFileSync('ls', ['-A', dir], { encoding: 'utf-8' }).trim()).toBe('.env')
  })
})

describe('switchMainGromzoOn / Off', () => {
  function stage(home: string) {
    const root = join(home, 'marveen-local-plugins', 'gromzo')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    mkdirSync(join(root, 'gromzo-channel', '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'gromzo-local' }))
    writeFileSync(join(root, 'gromzo-channel', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'gromzo-channel', version: '0.3.7' }))
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  }

  it('no staged plugin: marketplace_failed, and .env is not written', () => {
    const home = join(dir, 'home'); mkdirSync(home)
    writeFileSync(envPath(), 'A=1\n')
    expect(switchMainGromzoOn(dir, home)).toBe('marketplace_failed')
    expect(env()).toBe('A=1\n')
    expect(mainGromzoLaunchState()).toBe('marketplace_failed')
  })

  it('staged plugin: registers it in the SHARED ~/.claude/plugins, then writes the id', () => {
    const home = join(dir, 'home'); stage(home)
    writeFileSync(envPath(), 'A=1\n')
    expect(switchMainGromzoOn(dir, home)).toBeNull()
    expect(env()).toBe(`A=1\nCHANNEL_PLUGINS_EXTRA=${GZ}\n`)
    expect(readFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf-8')).toContain('gromzo-local')
  })

  it('an ambiguous .env after a good marketplace: env_failed', () => {
    const home = join(dir, 'home'); stage(home)
    writeFileSync(envPath(), 'CHANNEL_PLUGINS_EXTRA=\nCHANNEL_PLUGINS_EXTRA=\n')
    expect(switchMainGromzoOn(dir, home)).toBe('env_failed')
  })

  it('off removes the id only', () => {
    writeFileSync(envPath(), `CHANNEL_PLUGINS_EXTRA=${SLACK} ${GZ}\n`)
    expect(switchMainGromzoOff(dir)).toBeNull()
    expect(env()).toBe(`CHANNEL_PLUGINS_EXTRA=${SLACK}\n`)
  })
})

describe('restartMainAfterMxdReload', () => {
  function deps(statuses: Array<object | Error>, allow = true) {
    const calls = { status: 0, gate: 0, restart: 0 }
    return {
      calls,
      d: {
        status: async () => {
          const r = statuses[Math.min(calls.status++, statuses.length - 1)]
          if (r instanceof Error) throw r
          return r as { ok?: unknown, running?: unknown, held_agents?: unknown }
        },
        gate: async () => { calls.gate++; return { allow } },
        restart: () => { calls.restart++; return { ok: true } },
        sleep: async () => {},
        mainSlug: 'marveen',
      },
    }
  }

  it('waits through the reload (throws, not running) and restarts once mxd answers', async () => {
    const { d, calls } = deps([new Error('reloading'), { ok: true, running: false }, { ok: true, running: true, held_agents: [] }])
    expect(await restartMainAfterMxdReload(d)).toBe('restarted')
    expect(calls).toEqual({ status: 3, gate: 1, restart: 1 })
  })

  it('a held main slug: no gate, no restart', async () => {
    const { d, calls } = deps([{ ok: true, running: true, held_agents: ['marveen'] }])
    expect(await restartMainAfterMxdReload(d)).toBe('held')
    expect(calls.gate + calls.restart).toBe(0)
  })

  it('another slug held: the main restarts', async () => {
    const { d } = deps([{ ok: true, running: true, held_agents: ['samu'] }])
    expect(await restartMainAfterMxdReload(d)).toBe('restarted')
  })

  it('a busy pane (gate 409): restart_waiting, never forced', async () => {
    const { d, calls } = deps([{ ok: true, running: true }], false)
    expect(await restartMainAfterMxdReload(d)).toBe('restart_waiting')
    expect(calls.restart).toBe(0)
    expect(mainGromzoLaunchState()).toBe('restart_waiting')
  })

  it('mxd never answers: restart_failed after a bounded wait, no restart', async () => {
    const { d, calls } = deps([new Error('down')])
    expect(await restartMainAfterMxdReload(d)).toBe('restart_failed')
    expect(calls.status).toBe(30)
    expect(calls.restart).toBe(0)
  })

  it('the panel restart: a failing restart is restart_failed', async () => {
    expect(await restartMainForGromzoNow({ gate: async () => ({ allow: true }), restart: () => ({ ok: false }) })).toBe('restart_failed')
  })
})

describe('the shell launcher helpers and their TS twin', () => {
  let server: Server
  let sock: string
  let plainFile: string
  let readOnlyFile: string
  beforeEach(async () => {
    sock = join(dir, 'a.sock')
    server = createServer()
    await new Promise<void>((res) => server.listen(sock, res))
    plainFile = join(dir, 'plain'); writeFileSync(plainFile, '')
    readOnlyFile = join(dir, 'ro'); writeFileSync(readOnlyFile, ''); chmodSync(readOnlyFile, 0o400)
  })
  afterEach(async () => { await new Promise<void>((res) => server.close(() => res())) })

  // Under a UTF-8 locale on purpose: macOS /bin/bash 3.2 then lets [a-z] match 'B' and accented letters
  // (measured 2026-11-06), and the launchers run with the owner's locale.
  function sh(fn: string, sockPath: string, main: string, ids: string[], locale = 'en_US.UTF-8'): string {
    return execFileSync('/bin/bash', ['-c', `. "$1"; shift; ${fn} "$@"`, 'x', join(ROOT, 'scripts', 'main-gromzo-launch.sh'), main, ...ids], {
      encoding: 'utf-8', env: { ...process.env, MAIN_GROMZO_SOCK_PATH: sockPath, LC_ALL: locale },
    })
  }

  const mains = ['', 'marveen', 'x-1', 'Marveen', 'B', 'a'.repeat(32), 'a'.repeat(33), 'bad name', 'é', 'aé', 'ß']
  const idSets = [[], [GZ], [SLACK], [SLACK, GZ], [GZ, SLACK, 'telegram@x']]

  it('filter and env agree for every slug, id set and socket', () => {
    let rows = 0
    for (const path of [() => sock, () => join(dir, 'missing.sock'), () => plainFile, () => readOnlyFile]) {
      for (const main of mains) {
        for (const ids of idSets) {
          const p = path()
          const tsIds = filterMainGromzoIds(main, ids, p)
          expect(sh('main_gromzo_filter_ids', p, main, ids), `${p} ${main} ${ids}`).toBe(tsIds.join(' '))
          expect(sh('main_gromzo_env', p, main, tsIds), `${p} ${main} ${ids}`).toBe(mainGromzoEnv(main, tsIds))
          rows++
        }
      }
    }
    expect(rows).toBe(4 * mains.length * idSets.length)
  })

  it('the slug rule holds under the C locale too', () => {
    for (const main of mains) expect(sh('main_gromzo_env', sock, main, [GZ], 'C'), main).toBe(mainGromzoEnv(main, [GZ]))
  })

  it('a usable socket and a good slug keep the id and export the slug', () => {
    expect(filterMainGromzoIds('', [SLACK, GZ], sock)).toEqual([SLACK, GZ])
    expect(mainGromzoEnv('', [GZ])).toBe('export MXD_AGENT="marveen" && export MXD_SCOPE="both" && ')
  })

  it('no socket, or a bad slug, drops only the gromzo id', () => {
    expect(filterMainGromzoIds('marveen', [SLACK, GZ], join(dir, 'missing.sock'))).toEqual([SLACK])
    expect(filterMainGromzoIds('Marveen', [SLACK, GZ], sock)).toEqual([SLACK])
    expect(mainGromzoSlug('a'.repeat(33))).toBeNull()
  })
})

describe('the recovery respawn (channel-monitor)', () => {
  const base = {
    claudePath: '/usr/local/bin/claude', pluginId: 'telegram@claude-plugins-official', model: 'claude-opus-5',
    continueSession: false, config: mainConfigDecisionForTest(),
    channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/opt/m/.claude/channels/telegram' },
  }

  it('with the gromzo id: exports the main slug and scope both, before claude starts', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, extraPluginIds: [SLACK, GZ], mainAgentId: 'x-1' })
    const at = cmd.indexOf('export MXD_AGENT="x-1" MXD_SCOPE="both"')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(cmd.indexOf('/usr/local/bin/claude'))
    expect(cmd).toContain(`plugin:${GZ}`)
  })

  it('without it, or with a bad slug: no MXD_ export at all', () => {
    expect(buildMainSessionRespawnCmd({ ...base, extraPluginIds: [SLACK], mainAgentId: 'x-1' })).not.toContain('MXD_')
    expect(buildMainSessionRespawnCmd({ ...base, extraPluginIds: [GZ], mainAgentId: 'Bad' })).not.toContain('MXD_')
  })

  it('the three respawn sites read the extras through the gromzo filter', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    expect(src).toContain("return filterMainGromzoIds(readMainAgentIdRaw(projectRoot), readEnvValue(projectRoot, 'CHANNEL_PLUGINS_EXTRA')")
  })
})

describe('the main row on the panel: observed, not assumed', () => {
  it('reads only yes/no from the pane start command', () => {
    expect(mainSessionLoadsGromzo('s', () => `claude --channels plugin:telegram@x plugin:${GZ} --settings x`)).toBe(true)
    expect(mainSessionLoadsGromzo('s', () => 'claude --channels plugin:telegram@x')).toBe(false)
    expect(mainSessionLoadsGromzo('s', () => '')).toBeNull()
    expect(mainSessionLoadsGromzo('s', () => { throw new Error('no session') })).toBeNull()
  })

  it('the .env id against the running session (the VPS case: id on, never restarted)', () => {
    expect(mainGromzoPanelState(true, true, 'idle')).toBe('running')
    expect(mainGromzoPanelState(true, false, 'idle')).toBe('restart_waiting')
    expect(mainGromzoPanelState(false, true, 'idle')).toBe('restart_waiting')
    expect(mainGromzoPanelState(false, false, 'idle')).toBe('idle')
    expect(mainGromzoPanelState(true, null, 'idle')).toBe('on_unknown')
    expect(mainGromzoPanelState(false, null, 'idle')).toBe('idle')
  })

  it('a run in progress or stopped says so; a stale restart_waiting gives way to the observation', () => {
    for (const run of ['waiting_mxd', 'held', 'marketplace_failed', 'env_failed'] as const) {
      expect(mainGromzoPanelState(true, true, run)).toBe(run)
    }
    expect(mainGromzoPanelState(true, true, 'restart_waiting')).toBe('running')
    expect(mainGromzoPanelState(true, true, 'restarted')).toBe('running')
    expect(mainGromzoPanelState(true, false, 'restart_failed')).toBe('restart_failed')
    expect(mainGromzoPanelState(true, true, 'restart_failed')).toBe('running')
  })
})

describe('the panel strings', () => {
  it('every main-row key exists in HU and EN, with no dash characters', () => {
    const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
    const keys = [...new Set([...app.matchAll(/'(gromzo\.agents\.main\.[a-z_]+)'/g)].map((m) => m[1]))]
    expect(keys.length).toBeGreaterThanOrEqual(14)
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(ROOT, 'web', 'lang', `${lang}.js`), 'utf-8')
      for (const k of keys) expect(src, `${lang} ${k}`).toMatch(new RegExp(`'${k.replace(/\./g, '\\.')}': '[^']+'`))
      for (const line of src.split('\n').filter((l) => l.includes("'gromzo.agents.main."))) expect(line).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

describe('the doctor (verify-channels-health.sh (d))', () => {
  it('judges the argv against what the launchers load, not the raw list', () => {
    const sh = readFileSync(join(ROOT, 'scripts', 'verify-channels-health.sh'), 'utf-8')
    const src = sh.indexOf('. "$INSTALL_DIR/scripts/main-gromzo-launch.sh"')
    const filter = sh.indexOf('_gz_kept="$(main_gromzo_filter_ids "$_gz_raw_main" $CHANNEL_PLUGINS_EXTRA)"')
    const assign = sh.indexOf('CHANNEL_PLUGINS_EXTRA="$_gz_kept"')
    const compare = sh.indexOf('for _p in $CHANNEL_PLUGINS_EXTRA; do')
    expect(src).toBeGreaterThan(-1)
    expect(src).toBeLessThan(filter)
    expect(filter).toBeLessThan(assign)
    expect(assign).toBeLessThan(compare)
  })
})

describe('the isolated main config provisioner (agent-process.ts)', () => {
  it('enables only the extras the launchers load: the same gromzo filter', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('export function readExtraChannelPluginIds(): string[] {'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain("return filterMainGromzoIds(env['MAIN_AGENT_ID'] ?? '', ")
    expect(src).toMatch(/provisionIsolatedConfigDir\(\s*mainAgentSharedConfigDir\(\),[\s\S]{0,200}readExtraChannelPluginIds\(\),/)
  })
})
