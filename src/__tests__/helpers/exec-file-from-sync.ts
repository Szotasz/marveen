// Async capture must share the per-test sync tmux fake so call recording and pane queues stay shared.
export function execFileFromSync(syncImpl: (file: string, args: string[], opts?: object) => unknown) {
  type Callback = (err: unknown, stdout: string, stderr: string) => void
  return (file: string, args: string[], opts: object | Callback, cb?: Callback) => {
    const callback = typeof opts === 'function' ? opts : cb!
    const options = typeof opts === 'function' ? undefined : opts
    const child = { stdin: { end() {} }, killed: false }
    setImmediate(() => {
      try {
        const result = syncImpl(file, args, options)
        callback(null, String(result ?? ''), '')
      } catch (err) {
        child.killed = typeof err === 'object' && err !== null && 'code' in err && err.code === 'ETIMEDOUT'
        callback(err, '', '')
      }
    })
    return child
  }
}
