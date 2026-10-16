/**
 * DETACHEDSHUTDOWN1007: the command-task (#1772) and pre-check (#1759) groups
 * run DETACHED, outside the dashboard's process group. When the dashboard
 * stops, nothing ended them: measured 2026-10-07 with a stand-in parent, the
 * detached bash and its sleep both kept running after the parent's SIGTERM and
 * exit (ppid 1), with their timeout timers gone along with the parent.
 *
 * The dashboard's shutdown (src/index.ts) now calls endAllDetachedGroups. These
 * tests run the REAL callers (runCommandTask, runPreCheckAsync), so a registry
 * nobody feeds cannot pass, and they pin that a finished group leaves the
 * registry: a stale pid is reused, and kill(-pid) on it would hit a stranger.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, TELEGRAM_BOT_TOKEN: '', STORE_DIR: '/tmp' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const cmd = await import('../web/command-task.js')
const sr = await import('../web/schedule-runner.js')
const reg = await import('../web/detached-groups.js')
const { logger } = await import('../logger.js')

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const leftovers: number[] = []
const dirs: string[] = []
afterEach(() => {
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'detachedshutdown-')); dirs.push(d); return d }
const readPid = async (f: string): Promise<number> => {
  await vi.waitFor(() => { expect(existsSync(f) && readFileSync(f, 'utf-8').trim() !== '').toBe(true) }, { timeout: 3000 })
  const pid = Number(readFileSync(f, 'utf-8').trim()); leftovers.push(pid); return pid
}
const labels = (): string[] => reg.runningDetachedGroups().map((g) => g.label)

describe('the dashboard shutdown ends the running detached groups', () => {
  it('a running command task: bash and the grandchild it started are gone after endAllDetachedGroups', async () => {
    const d = tmp(); const bashF = join(d, 'bash.pid'); const gF = join(d, 'grand.pid')
    cmd.runCommandTask({ name: 'ds-cmd', type: 'command', command: `echo $$ > '${bashF}'; sleep 300 & echo $! > '${gF}'; wait`, agent: 'system', timeoutMs: 60_000 } as never, Math.floor(Date.now() / 1000))
    const bashPid = await readPid(bashF); const grand = await readPid(gF)
    expect(labels()).toContain('command-task:ds-cmd')
    expect(reg.endAllDetachedGroups('test')).toBeGreaterThanOrEqual(1)
    await vi.waitFor(() => { expect(alive(grand)).toBe(false); expect(alive(bashPid)).toBe(false) }, { timeout: 2000 })
    expect(labels()).not.toContain('command-task:ds-cmd')
  })

  it('a running pre-check: bash and the grandchild it started are gone after endAllDetachedGroups', async () => {
    const d = tmp(); const gF = join(d, 'grand.pid'); const bashF = join(d, 'bash.pid'); const script = join(d, 'pre.sh')
    writeFileSync(script, `echo $$ > '${bashF}'\nsleep 300 & echo $! > '${gF}'\nwait\n`, { mode: 0o755 })
    const p = sr.runPreCheckAsync({ name: 'ds-pre', preCheck: script } as never, { timeoutMs: 60_000 })
    const bashPid = await readPid(bashF); const grand = await readPid(gF)
    expect(labels()).toContain('pre-check:ds-pre')
    expect(reg.endAllDetachedGroups('test')).toBeGreaterThanOrEqual(1)
    await vi.waitFor(() => { expect(alive(grand)).toBe(false); expect(alive(bashPid)).toBe(false) }, { timeout: 2000 })
    await p
  })

  it('a group that finished on its own leaves the registry (no stale pid to kill later)', async () => {
    cmd.runCommandTask({ name: 'ds-quick', type: 'command', command: 'true', agent: 'system', timeoutMs: 5000 } as never, Math.floor(Date.now() / 1000))
    await vi.waitFor(() => { expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ task: 'ds-quick' }), 'command task ran') }, { timeout: 4000 })
    expect(labels()).not.toContain('command-task:ds-quick')
    const d = tmp(); const script = join(d, 'pre.sh'); writeFileSync(script, 'echo SKIP\n', { mode: 0o755 })
    expect(await sr.runPreCheckAsync({ name: 'ds-pre-quick', preCheck: script } as never)).toEqual({ skip: true })
    expect(labels()).not.toContain('pre-check:ds-pre-quick')
  })

  it('a timed-out command task leaves the registry with its kill', async () => {
    cmd.runCommandTask({ name: 'ds-timeout', type: 'command', command: 'sleep 300', agent: 'system', timeoutMs: 500 } as never, Math.floor(Date.now() / 1000))
    await vi.waitFor(() => { expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ task: 'ds-timeout', detail: 'timeout 500ms' }), 'command task ran') }, { timeout: 4000 })
    expect(labels()).not.toContain('command-task:ds-timeout')
  })

  it('a pre-check past its limit stays tracked through the TERM grace second, and leaves after the KILL', async () => {
    const d = tmp(); const gF = join(d, 'grand.pid'); const script = join(d, 'pre.sh')
    // The grandchild ignores TERM, so only the KILL (or a shutdown) ends it.
    writeFileSync(script, `(trap '' TERM; exec sleep 300) & echo $! > '${gF}'\nwait\n`, { mode: 0o755 })
    const res = await sr.runPreCheckAsync({ name: 'ds-pre-limit', preCheck: script } as never, { timeoutMs: 300 })
    expect(res).toEqual({ skip: false })
    const grand = await readPid(gF)
    expect(labels()).toContain('pre-check:ds-pre-limit') // inside the grace second: a shutdown now would still end it
    await vi.waitFor(() => { expect(labels()).not.toContain('pre-check:ds-pre-limit'); expect(alive(grand)).toBe(false) }, { timeout: sr.PRECHECK_KILL_GRACE_MS + 2000 })
  })

  it('a group kill that fails with anything but ESRCH is logged', () => {
    const untrack = reg.trackDetachedGroup(424242, 'test:eperm')
    vi.spyOn(process, 'kill').mockImplementation((() => { const e = new Error('operation not permitted') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }) as never)
    reg.endAllDetachedGroups('test')
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ pid: 424242, label: 'test:eperm', error: 'operation not permitted' }), expect.stringContaining('detached process group'))
    expect(labels()).not.toContain('test:eperm')
    untrack()
  })

  it('src/index.ts shutdown calls endAllDetachedGroups before it exits', () => {
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')
    const body = src.slice(src.indexOf('const shutdown = (): void => {'), src.indexOf('async function main(): Promise<void>'))
    const call = body.indexOf("endAllDetachedGroups('dashboard shutdown')")
    expect(call).toBeGreaterThan(0)
    expect(call).toBeLessThan(body.indexOf('process.exit'))
    expect(call).toBeLessThan(body.indexOf('webServer.close'))
    expect(src).toMatch(/process\.on\('SIGTERM', shutdown\)/)
  })
})
