// Simulate another handler winning the first claim of each claim-named request.
// The file is already gone when this handler's unlink reports ENOENT.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const claimed = new Set()
const realUnlinkSync = fs.unlinkSync
fs.unlinkSync = function unlinkSync(path) {
  realUnlinkSync(path)
  if (typeof path !== 'string' || !/^claim\d+\.json$/.test(basename(path)) || claimed.has(path)) return
  claimed.add(path)
  throw Object.assign(new Error('simulated lost claim'), { code: 'ENOENT' })
}

syncBuiltinESMExports()
