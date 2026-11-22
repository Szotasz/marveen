// Simulate another handler winning the first claim of each claim-named request.
// The claim is a rename of the request file into this daemon's claimed/<pid>/ directory;
// the entry is really removed here (as the winner's rename would have), and this daemon's
// own claim rename then reports ENOENT.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const claimed = new Set()
const realUnlinkSync = fs.unlinkSync
const realRenameSync = fs.renameSync
fs.renameSync = function renameSync(from, to) {
  if (typeof from !== 'string' || !/^claim\d+\.json$/.test(basename(from)) || claimed.has(from)) return realRenameSync(from, to)
  claimed.add(from)
  realUnlinkSync(from)
  throw Object.assign(new Error('simulated lost claim'), { code: 'ENOENT' })
}

syncBuiltinESMExports()
