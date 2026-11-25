// Preload for src/__tests__/codex-relay-claim-then-read.test.ts, loaded via `node --import` before
// relay.mjs. Proves the read happens strictly AFTER the claim and FROM THE CLAIMED COPY: when the
// relay opens claimed/<pid>/race2.json, the requests/race2.json name must already be gone (the claim
// rename consumed it). On the old read-then-claim order this never fires -- the relay opened the
// requests/ path, never a claimed/<pid>/ one -- which is exactly what the paired test detects.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'

// The claimed copy of the race2 request, under any daemon pid.
const CLAIMED_OPEN = /[/\\]claimed[/\\]\d+[/\\]race2\.json$/
const realOpenSync = fs.openSync
const realExistsSync = fs.existsSync
const realWriteFileSync = fs.writeFileSync

fs.openSync = function openSync(path, flags, mode) {
  if (typeof path === 'string' && CLAIMED_OPEN.test(path)) {
    // <relayDir>/claimed/<pid>/race2.json -> three segments up is the relay dir.
    const relayDir = dirname(dirname(dirname(path)))
    if (!realExistsSync(join(relayDir, 'requests', 'race2.json'))) {
      try {
        realWriteFileSync(join(relayDir, 'read-after-claim.ok'), 'ok')
      } catch { /* never break openSync itself: the test fails on the missing marker */ }
    }
  }
  return realOpenSync(path, flags, mode)
}

syncBuiltinESMExports()
