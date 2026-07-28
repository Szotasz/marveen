import { describe, it, expect } from 'vitest'
import { parseCrontab, getScheduledJobsProvider } from '../web/routes/system-cron.js'

// parseCrontab is the pure core of the read-only /api/system-cron view. These
// cases pin the behaviour the UI depends on: env lines skipped, comments
// attached to the following job (and cleared by a blank line), redirects split
// off the command, special (@reboot) schedules that cannot project a next run
// yielding null instead of throwing, and malformed lines surfaced rather than
// silently dropped.
describe('parseCrontab', () => {
  it('returns an empty list for empty / whitespace-only input', () => {
    expect(parseCrontab('')).toEqual([])
    expect(parseCrontab('\n\n   \n')).toEqual([])
  })

  it('skips environment-assignment lines (SHELL/PATH/MAILTO)', () => {
    const out = parseCrontab('SHELL=/bin/sh\nPATH=/usr/bin:/bin\nMAILTO=""\n0 5 * * * /bin/true')
    expect(out).toHaveLength(1)
    expect(out[0].command).toBe('/bin/true')
    expect(out[0].schedule).toBe('0 5 * * *')
  })

  it('attaches a preceding comment to the next job', () => {
    const out = parseCrontab('# nightly backup\n0 2 * * * /usr/bin/backup.sh')
    expect(out).toHaveLength(1)
    expect(out[0].comment).toBe('nightly backup')
  })

  it('clears a pending comment across a blank line so it does not leak onto a later job', () => {
    const out = parseCrontab('# orphan comment\n\n0 2 * * * /usr/bin/backup.sh')
    expect(out).toHaveLength(1)
    expect(out[0].comment).toBeUndefined()
  })

  it('splits a trailing shell redirect off the command', () => {
    const out = parseCrontab('0 15 * * * /home/x/run.sh --flag >> /var/log/x.log 2>&1')
    expect(out[0].command).toBe('/home/x/run.sh --flag')
    expect(out[0].redirect).toBe('>> /var/log/x.log 2>&1')
  })

  it('handles a redirect to /dev/null with no space before >', () => {
    const out = parseCrontab('*/30 * * * * /usr/bin/job.sh >/dev/null 2>&1')
    expect(out[0].command).toBe('/usr/bin/job.sh')
    expect(out[0].redirect).toBe('>/dev/null 2>&1')
  })

  it('parses @-form schedules; @reboot has a null nextRun instead of throwing', () => {
    const out = parseCrontab('@reboot /home/x/boot.sh')
    expect(out).toHaveLength(1)
    expect(out[0].schedule).toBe('@reboot')
    expect(out[0].command).toBe('/home/x/boot.sh')
    expect(out[0].nextRun).toBeNull()
  })

  it('computes a numeric nextRun for a standard schedule', () => {
    const out = parseCrontab('0 5 * * * /bin/true')
    expect(typeof out[0].nextRun).toBe('number')
    expect(out[0].nextRun).toBeGreaterThan(0)
  })

  it('surfaces a malformed line rather than dropping it', () => {
    const out = parseCrontab('this is not a cron line')
    expect(out).toHaveLength(1)
    expect(out[0].schedule).toBe('')
    expect(out[0].command).toBe('this is not a cron line')
    expect(out[0].nextRun).toBeNull()
  })

  it('normalises inner whitespace in the schedule field', () => {
    const out = parseCrontab('0   5    *  * * /bin/true')
    expect(out[0].schedule).toBe('0 5 * * *')
  })
})

// The platform gate keeps the crontab view off macOS (where launchd, not cron,
// is the real scheduler) while leaving a clean seam for a future launchd
// provider. macOS -> null (route reports available:false, UI hides itself);
// both Linux flavours -> the crontab provider.
describe('getScheduledJobsProvider', () => {
  it('returns no provider on macOS (launchd territory)', () => {
    expect(getScheduledJobsProvider('macos')).toBeNull()
  })

  it('returns the crontab provider on linux-server and linux-gui', () => {
    const server = getScheduledJobsProvider('linux-server')
    const gui = getScheduledJobsProvider('linux-gui')
    expect(server).not.toBeNull()
    expect(gui).not.toBeNull()
    expect(server?.source).toBe('crontab -l')
    expect(gui?.source).toBe('crontab -l')
    expect(typeof server?.list).toBe('function')
  })
})
