// Explicit operator path to the scheduled-task
// registry (see schedule-registry.ts for the guard itself).
//
// Usage:
//   node dist/web/schedule-registry-cli.js status
//       Every task on disk with its verdict (ok / unregistered / hash-mismatch).
//   node dist/web/schedule-registry-cli.js register <name> [<name>...]
//       Trust the CURRENT files of the named tasks (after you reviewed them).
//   node dist/web/schedule-registry-cli.js register --all
//       Trust every task currently on disk (the manual form of the one-time
//       upgrade backfill; review `status` first).
//   node dist/web/schedule-registry-cli.js verify <name> [<name>...]
//       Print each named task's verdict; exit 0 only if EVERY one is ok.
//       update.sh / migrate-main-agent-id.sh ask this BEFORE they rewrite a
//       task, and re-register afterwards only a task that was trusted before.
//   node dist/web/schedule-registry-cli.js unregister <name> [<name>...]
//
// Also used by update.sh / the installers to register the shipped tasks they
// seed or refresh. Exit codes: 0 ok, 1 a named task was not found (verify: or
// not ok), 2 usage error.
import { initDatabase, listScheduledTaskRegistry } from '../db.js'
import { listScheduledTasks, readScheduledTask } from './scheduled-tasks-io.js'
import { sanitizeScheduleName } from './sanitize.js'
import {
  registerScheduledTask,
  registerAllScheduledTasks,
  unregisterScheduledTask,
  verifyScheduledTask,
  describeVerdict,
} from './schedule-registry.js'

/* eslint-disable no-console */
function usage(): never {
  console.error('usage: schedule-registry-cli.js status | verify <name>... | register [--source S] (--all | <name>...) | unregister <name>...')
  process.exit(2)
}

const args = process.argv.slice(2)
const cmd = args.shift()
if (!cmd) usage()

let source = 'cli'
const si = args.indexOf('--source')
if (si !== -1) {
  const v = args[si + 1]
  if (!v) usage()
  source = `cli:${v.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'unknown'}`
  args.splice(si, 2)
}

initDatabase()

if (cmd === 'status') {
  const registered = new Map(listScheduledTaskRegistry().map(r => [r.name, r]))
  for (const t of listScheduledTasks()) {
    const name = t.dirName ?? t.name
    const v = verifyScheduledTask(t)
    const reg = registered.get(name)
    console.log(`${v.ok ? 'ok          ' : v.reason.padEnd(12)} ${name}${reg ? `  (source=${reg.source})` : ''}${v.ok ? '' : `  -- ${describeVerdict(v)}`}`)
    registered.delete(name)
  }
  for (const orphan of registered.keys()) console.log(`orphan       ${orphan}  -- registry entry without task files`)
  process.exit(0)
}

if (cmd === 'verify') {
  if (args.length === 0) usage()
  let bad = 0
  for (const raw of args) {
    const name = sanitizeScheduleName(raw)
    if (!name || name !== raw) { console.log(`invalid      ${raw}`); bad++; continue }
    const task = readScheduledTask(name)
    if (!task) { console.log(`not-found    ${name}`); bad++; continue }
    const v = verifyScheduledTask(task)
    console.log(`${v.ok ? 'ok' : v.reason} ${name}`)
    if (!v.ok) bad++
  }
  process.exit(bad ? 1 : 0)
}

if (cmd === 'register') {
  if (args.includes('--all')) {
    const names = registerAllScheduledTasks(source)
    console.log(`registered ${names.length} task(s): ${names.join(', ')}`)
    process.exit(0)
  }
  if (args.length === 0) usage()
  let missing = 0
  for (const raw of args) {
    const name = sanitizeScheduleName(raw)
    if (!name || name !== raw) { console.error(`invalid task name: ${raw}`); missing++; continue }
    const hash = registerScheduledTask(name, source)
    if (hash) console.log(`registered ${name} sha256=${hash}`)
    else { console.error(`not found: ${name}`); missing++ }
  }
  process.exit(missing ? 1 : 0)
}

if (cmd === 'unregister') {
  if (args.length === 0) usage()
  for (const name of args) console.log(`${unregisterScheduledTask(name) ? 'unregistered' : 'not registered'} ${name}`)
  process.exit(0)
}

usage()
