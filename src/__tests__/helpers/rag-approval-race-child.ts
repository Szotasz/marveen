// Child process of rag-approval-race.test.ts (card 9a77b3e5). Opens its OWN
// connection to the shared temp DB file, then for each round waits for the
// parent's go-file (the barrier) and calls consumeOwnerRunApproval. Network-free.
//
// argv: <dbfile> <syncdir> <name> <roundsJson>
//   roundsJson: [{ "id": "...", "runId": "...", "packageSha256": "..." }, ...]
import { existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, consumeOwnerRunApproval } from '../../db.js'

const [dbFile, syncDir, name, roundsJson, botId] = process.argv.slice(2) as [string, string, string, string, string]
const rounds = JSON.parse(roundsJson) as Array<{ id: string; runId: string; packageSha256: string }>

initDatabase(dbFile)

const sleeper = new Int32Array(new SharedArrayBuffer(4))
function waitFor(path: string): void {
  const deadline = Date.now() + 60_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${path}`)
    Atomics.wait(sleeper, 0, 0, 1) // 1 ms: a tight spin so both children leave the barrier together
  }
}

for (let r = 0; r < rounds.length; r++) {
  const round = rounds[r]!
  writeFileSync(join(syncDir, `ready-${r}-${name}`), '')
  waitFor(join(syncDir, `go-${r}`))
  const res = consumeOwnerRunApproval({
    id: round.id, category: 'rag_production_d', packageSha256: round.packageSha256, runId: round.runId,
    consumer: `child-${name}`, expectedBotId: botId,
  })
  const tmp = join(syncDir, `.res-${r}-${name}.tmp`)
  writeFileSync(tmp, JSON.stringify({ ok: res.ok, reason: res.reason ?? null }))
  renameSync(tmp, join(syncDir, `res-${r}-${name}`))
}
process.exit(0)
