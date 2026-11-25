// Preload for test H15 (codex-relay-enforcement.test.ts), loaded via `node --import` before relay.mjs.
// Simulates a writer racing the relay's CLAIM: the claim rename of requests/raceN.json frees that name
// the instant it succeeds, and the writer drops a NEW request file at the very same name in that
// window. The relay must answer the FIRST entry from its claimed copy (the test plants a directory
// there, so it is denied as invalid) and must still read and forward the injected request exactly
// once on a later tick -- its own claim of the injected entry frees the name again, so only the FIRST
// claim of a given race-named path injects (per-path dedupe): exactly one injected request exists per
// name and the test can count dashboard forwards.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const AGENT = 'relay-agent' // keep in sync with AGENT in src/__tests__/codex-relay-enforcement.test.ts
// Only the CLAIM of an entry of requests/ injects: the rename into the daemon's claimed directory is
// the one step that frees the requests/ name, so that is where the racing writer strikes.
const RACE_NAME = /[/\\]requests[/\\]race\d+\.json$/
const injected = new Set()
const realRenameSync = fs.renameSync
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

// The REAL rename runs first; only when it succeeded (the name is really free) does the racing
// writer grab that name for the injected request.
fs.renameSync = function renameSync(from, to) {
  const result = realRenameSync(from, to)
  maybeInject(from)
  return result
}

syncBuiltinESMExports()
