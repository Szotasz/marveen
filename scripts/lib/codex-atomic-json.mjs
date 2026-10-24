import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Write JSON with a unique same-directory temporary file and atomic rename. */
export function writeAtomicJson(path, value, fs = {closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync}) {
  const directory = dirname(path)
  fs.mkdirSync(directory, {recursive: true, mode: 0o700})
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let fd
  let created = false
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    created = true
    fs.writeFileSync(fd, JSON.stringify(value))
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, path)
    created = false
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
    }
    if (created) {
      try { fs.unlinkSync(temporary) } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Atomic JSON write and cleanup failed')
      }
    }
    throw error
  }
}
