// Preload for test H15 (codex-relay-enforcement.test.ts), loaded via `node --import` before relay.mjs.
// Simulates a writer racing the relay: it re-creates a request file at the very name the relay has JUST
// removed itself (the rmdirSync/unlinkSync of a deny-path entry), in the window before finishDenied's
// removeRequest() would unlink that name again -- that second unlink must never happen, or the freshly
// written request is deleted unread. Only the FIRST successful removal of a given race-named path injects,
// so exactly one injected request exists per name and the test can count dashboard forwards.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const AGENT = 'relay-agent' // keep in sync with AGENT in src/__tests__/codex-relay-enforcement.test.ts
// Only an entry of requests/ is re-created: the same file name also passes through the daemon's claimed
// directory (the claim moves it there and removes it again), and nothing must be injected there.
const RACE_NAME = /[/\\]requests[/\\]race\d+\.json$/
const injected = new Set()
const realWriteFileSync = fs.writeFileSync

function maybeInject(path) {
  if (typeof path !== 'string' || !RACE_NAME.test(path) || injected.has(path)) return
  injected.add(path)
  const id = basename(path).replace(/\.json$/, '')
  realWriteFileSync(path, JSON.stringify({
    id,
    method: 'POST',
    path: '/api/daily-log',
    body: { agent_id: AGENT, content: `INJECTED-${id}` },
  }))
}

const realRmdirSync = fs.rmdirSync
fs.rmdirSync = function rmdirSync(path, options) {
  realRmdirSync(path, options)
  maybeInject(path)
}

const realUnlinkSync = fs.unlinkSync
fs.unlinkSync = function unlinkSync(path) {
  realUnlinkSync(path)
  maybeInject(path)
}

syncBuiltinESMExports()
