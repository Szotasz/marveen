import { describe, expect, it, vi } from 'vitest'
import { execFileFromSync } from './exec-file-from-sync.js'

describe('execFileFromSync', () => {
  it('calls back only after returning and passes String(result)', async () => {
    const syncImpl = vi.fn(() => 42)
    const execFile = execFileFromSync(syncImpl)
    let returned = false
    const callback = vi.fn()
    const done = new Promise<void>((resolve, reject) => {
      execFile('tmux', ['capture-pane'], { timeout: 3000 }, (err, stdout, stderr) => {
        callback(err, stdout, stderr)
        try {
          expect(returned).toBe(true)
          expect([err, stdout, stderr]).toEqual([null, '42', ''])
          resolve()
        } catch (error) { reject(error) }
      })
      expect(callback).not.toHaveBeenCalled()
      expect(syncImpl).not.toHaveBeenCalled()
      returned = true
    })
    await done
    expect(syncImpl).toHaveBeenCalledWith('tmux', ['capture-pane'], { timeout: 3000 })
    expect(callback).toHaveBeenCalledOnce()
  })

  it.each([
    ['ETIMEDOUT', true],
    ['ENOENT', false],
    [undefined, false],
  ])('passes thrown errors with empty stdout; code %s means killed=%s', async (code, killed) => {
    const error = Object.assign(new Error('capture failed'), { code })
    const execFile = execFileFromSync(() => { throw error })
    await new Promise<void>((resolve, reject) => {
      // The callback-only overload must keep working too.
      const child = execFile('tmux', ['capture-pane'], (err, stdout, stderr) => {
        try {
          expect(err).toBe(error)
          expect(stdout).toBe('')
          expect(stderr).toBe('')
          expect(child.killed).toBe(killed)
          resolve()
        } catch (error) { reject(error) }
      })
      expect(child.killed).toBe(false)
    })
  })
})
