import { createHook } from 'node:async_hooks'
import { execFile, execFileSync, spawn, type ExecFileException } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  brokerExecFile, brokerExecFileSync, isReadOnlyTmuxChain, spawnBrokerActive,
  startSpawnBroker, stopSpawnBroker, type BrokerSyncOptions,
} from '../web/spawn-broker.js'
import { BROKER_SOURCE } from '../web/spawn-broker-sources.js'

const readOnly = { readOnly: true }
const options: BrokerSyncOptions = { timeout: 1000, stdio: ['ignore', 'pipe', 'pipe'] }
let directories: string[] = []
const pids = new Set<number>()
const originalSwitch = process.env.MARVEEN_SPAWN_BROKER
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'marveen-spawn-broker-'))
  directories.push(directory)
  return directory
}
async function until(predicate: () => boolean, timeout = 3000) {
  const deadline = performance.now() + timeout
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Condition did not become true before deadline')
    await delay(10)
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    // Container PID 1 may retain an exited orphan as a zombie.
    try { if (/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false } catch { /* Non-Linux. */ }
    return true
  } catch { return false }
}
function brokerPid() {
  const pid = Number(brokerExecFileSync('/bin/sh', ['-c', 'printf "$PPID"'], { ...options, encoding: 'utf-8' }, { readOnly: false }))
  expect(pid).toBeGreaterThan(1)
  expect(pid).not.toBe(process.pid)
  pids.add(pid)
  return pid
}
beforeEach(async context => {
  if (/^(A4|A6|classifies|proves)/.test(context.task.name)) return
  delete process.env.MARVEEN_SPAWN_BROKER
  startSpawnBroker()
  await until(spawnBrokerActive)
  brokerPid()
})
afterEach(async () => {
  try {
    await stopSpawnBroker()
    for (const pid of pids) {
      await until(() => !alive(pid))
      expect(alive(pid), `broker ${pid} was reaped`).toBe(false)
    }
  } finally {
    pids.clear()
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    directories = []
    if (originalSwitch === undefined) delete process.env.MARVEEN_SPAWN_BROKER
    else process.env.MARVEEN_SPAWN_BROKER = originalSwitch
  }
})

function result(fn: () => unknown) {
  try { return { threw: false, value: fn() } } catch (error) {
    const err = error as Record<string, unknown>
    return { threw: true, constructor: err.constructor.name,
      ...Object.fromEntries(['message', 'code', 'errno', 'syscall', 'path', 'spawnargs', 'status', 'signal', 'stdout', 'stderr', 'output'].map(key => [key, err[key]])) }
  }
}
const cases = [
  { name: 'success', file: '/bin/sh', args: ['-c', 'printf hello; printf warning >&2'] },
  { name: 'exit 1 with stderr', file: '/bin/sh', args: ['-c', 'printf partial; printf failure >&2; exit 1'] },
  { name: 'exit 1 with empty args', file: '/bin/false', args: [] },
  { name: 'timeout', file: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], extra: { timeout: 300, killSignal: 'SIGKILL' as const } },
  { name: 'ENOENT', file: '/nonexistent-marveen-spawn-broker-program', args: ['argument'] },
  { name: 'maxBuffer exceeded', file: process.execPath, args: ['-e', "require('node:fs').writeSync(1,'x'.repeat(512))"], extra: { maxBuffer: 128 } },
  { name: 'non-ASCII split across chunks', file: process.execPath, args: ['-e', "const b=Buffer.from('árvíztűrő 🦊'.repeat(400));require('node:fs').writeSync(1,b.subarray(0,1));setTimeout(()=>require('node:fs').writeSync(1,b.subarray(1)),20)"] },
  { name: 'empty output', file: '/bin/sh', args: ['-c', ':'] },
]

describe('A2 synchronous parity with real execFileSync', () => {
  for (const encoding of [undefined, 'utf-8'] as const) {
    it(`matches the parity matrix, encoding ${encoding ?? 'Buffer'}`, () => {
      for (const c of cases) {
        const opts = { ...options, ...c.extra, encoding }
        const direct = result(() => execFileSync(c.file, c.args, opts))
        const broker = result(() => brokerExecFileSync(c.file, c.args, opts, readOnly))
        expect(broker, c.name).toEqual(direct)
      }
    })
    it(`ignored stdout is null, encoding ${encoding ?? 'Buffer'}`, () => {
      const opts: BrokerSyncOptions = { ...options, encoding, stdio: ['ignore', 'ignore', 'pipe'] }
      for (const exit of [0, 1]) {
        const args = ['-c', `printf hidden; printf warning >&2; exit ${exit}`]
        expect(result(() => brokerExecFileSync('/bin/sh', args, opts, readOnly)))
          .toEqual(result(() => execFileSync('/bin/sh', args, opts)))
      }
    })
  }
})

function asyncSnapshot(err: ExecFileException | null, stdout: string, stderr: string) {
  return { stdout, stderr, constructor: err?.constructor.name, error: err ? Object.fromEntries(
    ['message', 'code', 'killed', 'signal', 'cmd'].map(key => [key, (err as unknown as Record<string, unknown>)[key]]),
  ) : null }
}
describe('A2 asynchronous parity with real execFile', () => {
  it('matches the callback parity matrix', async () => {
    for (const c of [...cases, {
      name: 'multi-byte maxBuffer exceeded', file: process.execPath,
      args: ['-e', "require('node:fs').writeSync(1, 'é'.repeat(128))"], extra: { maxBuffer: 128 },
    }]) {
      const opts = { timeout: 1000, ...c.extra, encoding: 'utf-8' as const }
      const direct = await new Promise(resolve => execFile(c.file, c.args, opts, (err, stdout, stderr) => resolve(asyncSnapshot(err, stdout, stderr))))
      const broker = await brokerExecFile(c.file, c.args, opts, readOnly).then(
        ({ stdout, stderr }) => asyncSnapshot(null, stdout, stderr),
        err => asyncSnapshot(err, err.stdout, err.stderr),
      )
      expect(broker, c.name).toEqual(direct)
    }
  })
  it('runs concurrent requests and captures current main-thread cwd and environment', async () => {
    const directory = temporaryDirectory()
    const cwd = process.cwd()
    const env = process.env.SPAWN_BROKER_TEST_VALUE
    try {
      process.chdir(directory)
      const expectedDirectory = realpathSync(directory)
      process.env.SPAWN_BROKER_TEST_VALUE = 'fresh value'
      const calls = [30, 0, 10].map(ms => brokerExecFile(process.execPath, ['-e', `setTimeout(()=>require('node:fs').writeSync(1,process.cwd()+'|'+process.env.SPAWN_BROKER_TEST_VALUE+'|'+${ms}),${ms})`], options, readOnly))
      expect((await Promise.all(calls)).map(r => r.stdout)).toEqual([30, 0, 10].map(ms => `${expectedDirectory}|fresh value|${ms}`))
    } finally {
      process.chdir(cwd)
      if (env === undefined) delete process.env.SPAWN_BROKER_TEST_VALUE
      else process.env.SPAWN_BROKER_TEST_VALUE = env
    }
  })
})

describe('A3 broker failure handling', () => {
  it('runs non-read-only sync and async calls directly once when the broker is stopped', async () => {
    await stopSpawnBroker()
    const directory = temporaryDirectory()
    const directArgs = ['-c', 'printf done; printf warning >&2']
    const directSync = execFileSync('/bin/sh', directArgs, { ...options, encoding: 'utf-8' })
    const directAsync = await new Promise((resolve, reject) => {
      execFile('/bin/sh', directArgs, { ...options, encoding: 'utf-8' }, (err, stdout, stderr) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
    for (const sync of [true, false]) {
      const marker = join(directory, sync ? 'sync-marker' : 'async-marker')
      const args = ['-c', 'printf "once\\n" >> "$1"; printf done; printf warning >&2', 'sh', marker]
      const output = sync
        ? brokerExecFileSync('/bin/sh', args, { ...options, encoding: 'utf-8' }, { readOnly: false })
        : await brokerExecFile('/bin/sh', args, options, { readOnly: false })
      expect(output).toEqual(sync ? directSync : directAsync)
      expect(readFileSync(marker, 'utf8')).toBe('once\n')
    }
  })
  it('ends stdin in the async direct fallback when the broker is stopped', async () => {
    await stopSpawnBroker()
    const started = performance.now()
    const result = await brokerExecFile('/bin/sh', ['-c', 'cat >/dev/null; echo done'],
      { timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf-8' }, { readOnly: false })
    expect(result.stdout).toBe('done\n')
    expect(performance.now() - started).toBeLessThan(1500)
  })
  it('starts idempotently and is inactive after stop, so helpers use their existing direct path', async () => {
    const pid = brokerPid()
    startSpawnBroker()
    expect(brokerPid()).toBe(pid)
    await stopSpawnBroker()
    expect(spawnBrokerActive()).toBe(false)
  })
  for (const readOnly of [false, true]) {
    it(`does not repeat a lost mutation; readOnly=${readOnly}`, async () => {
      const pid = brokerPid()
      const marker = join(temporaryDirectory(), 'marker')
      const script = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'once\\n');setTimeout(()=>require('node:fs').writeSync(1,'done'),400)`
      const call = brokerExecFile(process.execPath, ['-e', script], { timeout: 1000 }, { readOnly })
        .then(value => ({ value, code: undefined }), err => ({ value: undefined, code: err.code }))
      await until(() => existsSync(marker))
      process.kill(pid, 'SIGKILL')
      const answer = await call
      if (readOnly) expect(answer.value?.stdout).toBe('done')
      else expect(answer.code).toBe('ESPAWNBROKER')
      await delay(450) // The original child's work cannot add a later duplicate.
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(readOnly ? 2 : 1)
      expect(spawnBrokerActive()).toBe(false)
      await until(spawnBrokerActive)
      expect(brokerPid()).not.toBe(pid)
    })
  }
  for (const readOnly of [false, true]) {
    it(`handles a sync mutation lost after dispatch; readOnly=${readOnly}`, async () => {
      const pid = brokerPid()
      const marker = join(temporaryDirectory(), 'marker')
      // Only the original invocation kills its parent; a direct retry must leave the test process alive.
      const script = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'once\\n');if(process.ppid===${pid})process.kill(process.ppid,'SIGKILL');fs.writeSync(1,'done')`
      const call = () => brokerExecFileSync(process.execPath, ['-e', script], { ...options, encoding: 'utf-8' }, { readOnly })
      if (readOnly) expect(call()).toBe('done')
      else expect(call).toThrow(expect.objectContaining({ code: 'ESPAWNBROKER' }))
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(readOnly ? 2 : 1)
      await until(spawnBrokerActive)
      expect(brokerPid()).not.toBe(pid)
    })
  }
  for (const sync of [false, true]) {
    for (const readOnly of [false, true]) {
      it(`bounds a stopped broker, restarts and discards late sync replies; sync=${sync}, readOnly=${readOnly}`, async () => {
        const pid = brokerPid()
        process.kill(pid, 'SIGSTOP')
        const args = ['-c', 'printf own-result']
        const started = performance.now()
        let value: unknown, code: unknown
        try {
          value = sync
            ? brokerExecFileSync('/bin/sh', args, { ...options, timeout: 300, encoding: 'utf-8' }, { readOnly })
            : (await brokerExecFile('/bin/sh', args, { timeout: 300, encoding: 'utf-8' }, { readOnly })).stdout
        } catch (err) { code = (err as NodeJS.ErrnoException).code }
        expect(performance.now() - started).toBeLessThan(2 * 300 + 1000 + 300)
        if (readOnly) expect(value, `fallback failed with ${code}`).toBe('own-result')
        else expect(code).toBe('ETIMEDOUT')
        await until(spawnBrokerActive)
        expect(brokerPid()).not.toBe(pid)
        expect(brokerExecFileSync('/bin/sh', ['-c', 'printf next-result'], { timeout: 300, encoding: 'utf-8' }, { readOnly: false })).toBe('next-result')
      })
    }
  }
})

it('A4 kill switch creates no worker or broker', async () => {
  let workers = 0
  const hook = createHook({ init(_id, type) { if (type === 'WORKER') workers++ } })
  hook.enable()
  try {
    process.env.MARVEEN_SPAWN_BROKER = 'off'
    startSpawnBroker()
    startSpawnBroker()
    await delay(100)
    expect(workers).toBe(0)
    expect(spawnBrokerActive()).toBe(false)
    // A positive control ensures the hook can observe a real worker creation.
    delete process.env.MARVEEN_SPAWN_BROKER
    startSpawnBroker()
    await until(spawnBrokerActive)
    brokerPid()
    expect(workers).toBeGreaterThan(0)
  } finally { hook.disable() }
})

it('A6 broker exits on stdin EOF', async () => {
  const child = spawn(process.execPath, ['-e', BROKER_SOURCE], { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise(resolve => child.once('exit', resolve))
  let output = ''
  child.stdout.on('data', data => { output += data })
  try {
    await until(() => output.includes('ready') || child.exitCode !== null)
    expect(child.exitCode, 'broker must stay alive while stdin is open').toBeNull()
    await delay(100)
    expect(child.exitCode).toBeNull()
    await until(() => child.pid !== undefined)
    pids.add(child.pid!)
    child.stdin.end()
    await closed
    expect(alive(child.pid!)).toBe(false)
  } finally { if (child.exitCode === null) child.kill('SIGKILL') }
})

it('A6 broker exits within two seconds of stdin EOF while a request is in flight', async () => {
  const directory = temporaryDirectory()
  const marker = join(directory, 'program-pid')
  const preload = join(directory, 'record-pid.cjs')
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid))`)
  const broker = spawn(process.execPath, ['-e', BROKER_SOURCE], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const closed = new Promise(resolve => broker.once('exit', resolve))
  let output = ''
  let programPid: number | undefined
  broker.stdout.on('data', data => { output += data })
  broker.stderr.resume()
  try {
    pids.add(broker.pid!)
    await until(() => output.includes('ready'))
    broker.stdin.write(JSON.stringify({
      id: 1, file: process.execPath, args: ['-e', 'setTimeout(() => {}, 3000)'],
      cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}` },
      timeout: 60000, killSignal: 'SIGKILL', stdout: 'pipe',
    }) + '\n')
    await until(() => existsSync(marker) && readFileSync(marker, 'utf8').length > 0)
    programPid = Number(readFileSync(marker, 'utf8'))
    expect(programPid).toBeGreaterThan(1)
    expect(alive(programPid)).toBe(true)
    broker.stdin.end()
    await until(() => broker.exitCode !== null || broker.signalCode !== null, 2000)
    expect(broker.exitCode).toBe(0)
  } finally {
    // The detached group also covers a child whose preload has not written its PID yet.
    if (broker.pid) { try { process.kill(-broker.pid, 'SIGKILL') } catch { /* Already exited. */ } }
    await closed
    if (programPid) await until(() => !alive(programPid!))
  }
})

it('A6 broker exits within two seconds after a real parent SIGKILL', async () => {
  const fixture = join(temporaryDirectory(), 'parent.mts')
  const moduleUrl = new URL('../web/spawn-broker.ts', import.meta.url).href
  writeFileSync(fixture, `
import { writeSync } from 'node:fs';
import { startSpawnBroker, spawnBrokerActive, brokerExecFileSync } from ${JSON.stringify(moduleUrl)};
startSpawnBroker();
const timer = setInterval(() => {
  if (!spawnBrokerActive()) return;
  clearInterval(timer);
  const pid = brokerExecFileSync('/bin/sh', ['-c', 'printf "$PPID"'], { timeout: 1000, encoding: 'utf-8' }, { readOnly: true });
  writeSync(1, 'BROKER_PID:' + pid + '\\n');
  setInterval(() => {}, 1000);
}, 10);
`)
  const parent = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fixture], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  parent.stdout.on('data', data => { stdout += data })
  parent.stderr.on('data', data => { stderr += data })
  try {
    try {
      await until(() => /BROKER_PID:\d+/.test(stdout) || parent.exitCode !== null || parent.signalCode !== null, 10000)
    } catch (err) {
      throw new Error(`Parent fixture did not report a broker: stdout=${stdout}; stderr=${stderr}`, { cause: err })
    }
    expect(parent.exitCode, stderr).toBeNull()
    const pid = Number(/BROKER_PID:(\d+)/.exec(stdout)![1])
    expect(pid).toBeGreaterThan(1)
    expect(pid).not.toBe(parent.pid)
    pids.add(pid)
    parent.kill('SIGKILL')
    await until(() => !alive(pid), 2000)
    expect(alive(pid)).toBe(false)
  } finally {
    parent.kill('SIGKILL')
    await new Promise(resolve => { if (parent.exitCode !== null || parent.signalCode !== null) resolve(undefined); else parent.once('exit', resolve) })
  }
})

it('classifies only wholly read-only tmux chains', () => {
  for (const verb of ['capture-pane', 'list-sessions', 'list-panes', 'list-windows', 'list-clients', 'display-message', 'has-session', 'show-options', 'show-environment', 'show-window-options']) {
    expect(isReadOnlyTmuxChain([verb, '-p'])).toBe(true)
  }
  expect(isReadOnlyTmuxChain(['capture-pane', '-t', '=a:', '-p', ';', 'list-panes'])).toBe(true)
  expect(isReadOnlyTmuxChain(['capture-pane', '-t', 'x'])).toBe(false)
  expect(isReadOnlyTmuxChain(['capture-pane', '-t', 'x', '-e', '-p'])).toBe(true)
  expect(isReadOnlyTmuxChain(['display-message', 'hello'])).toBe(false)
  expect(isReadOnlyTmuxChain(['display-message', '-p', 'm', ';', 'capture-pane', '-t', 'x', '-e', '-p'])).toBe(true)
  expect(isReadOnlyTmuxChain(['display-message', '-p', 'm', ';', 'capture-pane', '-t', 'x'])).toBe(false)
  expect(isReadOnlyTmuxChain(['capture-pane', '-t', 'x', ';', 'list-panes'])).toBe(false)
  expect(isReadOnlyTmuxChain(['display-message', 'hello', ';', 'list-panes', '-p'])).toBe(false)
  expect(isReadOnlyTmuxChain(['capture-pane', '-b', '-p', '-t', '=s:'])).toBe(false)
  expect(isReadOnlyTmuxChain(['display-message', '--', '-p'])).toBe(false)
  expect(isReadOnlyTmuxChain(['capture-pane', '-t', '-p'])).toBe(false)
  expect(isReadOnlyTmuxChain(['capture-pane', '-p', '-b', 'buf'])).toBe(true)
  expect(isReadOnlyTmuxChain(['display-message', '-p', '--', 'x'])).toBe(true)
  expect(isReadOnlyTmuxChain(['display-message', '--', 'x', ';', 'capture-pane', '-p'])).toBe(false)
  expect(isReadOnlyTmuxChain(['capture-pane', '--', ';', 'display-message', '-p'])).toBe(false)
  for (const verb of ['capture-pane', 'display-message']) {
    for (const flag of ['-b', '-E', '-S', '-t', '-c', '-d', '-F']) {
      expect(isReadOnlyTmuxChain([verb, flag, '-p']), `${verb} ${flag} -p`).toBe(false)
    }
  }
  expect(isReadOnlyTmuxChain(['display-message', '-p', '--', 'x', ';', 'capture-pane', '-p'])).toBe(true)
  expect(isReadOnlyTmuxChain(['capture-pane', ';', 'send-keys', 'Enter'])).toBe(false)
  expect(isReadOnlyTmuxChain(['send-keys'])).toBe(false)
  expect(isReadOnlyTmuxChain([])).toBe(false)
  expect(isReadOnlyTmuxChain([';', 'capture-pane'])).toBe(false)
  expect(isReadOnlyTmuxChain(['capture-pane', ';'])).toBe(false)
  expect(isReadOnlyTmuxChain(['capture-pane', '-eb', '-p', '-t', '=s:'])).toBe(false)
  expect(isReadOnlyTmuxChain(['capture-pane', '-t', '=s:', '-eb', '-p'])).toBe(false)
  expect(isReadOnlyTmuxChain(['display-message', '-vc', '-p'])).toBe(false)
  for (const verb of ['capture-pane', 'display-message']) {
    for (const flag of ['b', 'E', 'S', 't', 'c', 'd', 'F']) {
      expect(isReadOnlyTmuxChain([verb, `-e${flag}`, '-p']), `${verb} -e${flag} -p`).toBe(false)
    }
  }
  expect(isReadOnlyTmuxChain(['capture-pane', '-S', '-', '-p'])).toBe(true)
  expect(isReadOnlyTmuxChain(['capture-pane', '-eJ', '-p'])).toBe(true)
})
