#!/usr/bin/env node
// Idempotent local patch for the Telegram channel plugin's dropped quote-reply
// metadata.
//
// WHY: the upstream anthropics/claude-plugins-official telegram plugin builds
// the inbound `meta` object in handleInbound() (server.ts, the
// `mcp.notification({ method: 'notifications/claude/channel' ... })` block) with
// chat_id / message_id / user / ts / attachment_* -- but nothing from
// `ctx.message.reply_to_message`. So when a user quote-replies to an earlier
// message, the agent never sees WHICH message was quoted. The data is already
// on `ctx.message.reply_to_message` (the plugin uses it elsewhere, e.g. the
// implicit-mention check), it just never reaches the notification meta.
//
// Upstream fix is stuck: ~10 community PRs closed without merge, issues #929
// and #988 still open. So we patch the installed plugin in place, idempotently,
// and re-apply after any plugin update reverts it (see channel-watchdog.sh,
// which runs this every tick, and the marveen-channels.service ExecStartPre).
//
// UPSTREAM: github.com/anthropics/claude-plugins-official issue #929. If that
// ever merges, delete this script + its callers and drop the injected block.
//
// Usage:
//   node scripts/patch-telegram-reply-to.mjs            # discover + patch all installed versions (quiet unless it changes something)
//   node scripts/patch-telegram-reply-to.mjs --verbose  # also log no-op / already-patched
//   node scripts/patch-telegram-reply-to.mjs --file P   # patch exactly one server.ts (used by tests)
//   node scripts/patch-telegram-reply-to.mjs --self-test # hermetic self-check, no real plugin touched

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INSTALL_DIR = path.resolve(__dirname, '..')
const STATE_FILE = path.join(INSTALL_DIR, 'store', '.telegram-reply-to-patch.json')

// A stable marker the plugin source never contains on its own. Presence == already patched.
const MARKER = 'marveen-patch:reply-to'

// The anchor is the `ts:` line inside the notification meta object. It is the
// most stable line in that block (chat_id/message_id are conditional spreads;
// ts is unconditional). We insert our conditional spread right after it, at the
// same indentation. If upstream ever renames or reshapes this line the anchor
// stops matching and we report 'no-anchor' loudly rather than corrupting the file.
const ANCHOR_RE =
  /^([ \t]*)ts: new Date\(\(ctx\.message\?\.date \?\? 0\) \* 1000\)\.toISOString\(\),[ \t]*$/m

// Build the injected block at the anchor's indentation. Kept as a plain object
// spread so it disappears entirely when there is no reply_to_message.
// reply_to_text is truncated to 500 chars to stay a lightweight hint, not a
// full message copy.
function injectedBlock(indent) {
  const rt = 'ctx.message.reply_to_message.text ?? ctx.message.reply_to_message.caption'
  return [
    `${indent}// ${MARKER}: surface Telegram quote-reply metadata the upstream`,
    `${indent}// plugin drops (see scripts/patch-telegram-reply-to.mjs, issue #929).`,
    `${indent}...(ctx.message?.reply_to_message ? {`,
    `${indent}  reply_to_message_id: String(ctx.message.reply_to_message.message_id),`,
    `${indent}  ...((${rt}) ? { reply_to_text: (${rt}).slice(0, 500) } : {}),`,
    `${indent}} : {}),`,
  ].join('\n')
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

// Patch a single server.ts. Returns one of:
//   { status: 'already' }    -- marker present, nothing to do
//   { status: 'patched', sha } -- inserted the block, file rewritten
//   { status: 'no-anchor' }  -- anchor line not found (upstream shape changed)
function patchFile(serverPath) {
  const src = fs.readFileSync(serverPath, 'utf8')
  if (src.includes(MARKER)) return { status: 'already' }
  const m = ANCHOR_RE.exec(src)
  if (!m) return { status: 'no-anchor' }
  const indent = m[1]
  const block = injectedBlock(indent)
  const patched = src.replace(ANCHOR_RE, `${m[0]}\n${block}`)
  // Atomic-ish write: temp file in the same dir, then rename.
  const tmp = `${serverPath}.marveen-tmp-${process.pid}`
  fs.writeFileSync(tmp, patched, 'utf8')
  fs.renameSync(tmp, serverPath)
  return { status: 'patched', sha: sha256(patched) }
}

// Discover every installed telegram plugin server.ts. We deliberately glob ALL
// version directories (not just the current one) and never hardcode a version:
// a plugin update lands a new version dir with a fresh, unpatched server.ts,
// and this is exactly how the auto-reapply notices it -- next run finds a
// server.ts without the marker and patches it.
function findServers() {
  const roots = new Set()
  roots.add(path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram'))
  // Derive the telegram root from CLAUDE_PLUGIN_ROOT if the plugin exported it
  // (it points at .../telegram/<version>), so a non-default plugin cache still resolves.
  const pr = process.env.CLAUDE_PLUGIN_ROOT
  if (pr) {
    const marker = `${path.sep}telegram${path.sep}`
    const idx = pr.lastIndexOf(marker)
    if (idx !== -1) roots.add(pr.slice(0, idx + `${path.sep}telegram`.length))
    else if (path.basename(path.dirname(pr)) === 'telegram') roots.add(path.dirname(pr))
  }
  const servers = new Set()
  for (const root of roots) {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const sp = path.join(root, e.name, 'server.ts')
      if (fs.existsSync(sp)) servers.add(sp)
    }
  }
  return [...servers]
}

function writeState(results) {
  const state = {
    marker: MARKER,
    patchedAt: new Date().toISOString(),
    servers: results.map(r => ({ path: r.path, status: r.status, sha256: r.sha ?? null })),
  }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8')
  } catch {
    // store/ not writable in this context (e.g. a bare test run) -- state is
    // observability only, so a failure here must not fail the patch.
  }
}

function runAll({ verbose }) {
  const servers = findServers()
  if (servers.length === 0) {
    if (verbose) console.log('patch-telegram-reply-to: no telegram plugin server.ts found')
    return 0
  }
  const results = []
  let changed = 0
  let noAnchor = 0
  for (const sp of servers) {
    let res
    try {
      res = patchFile(sp)
    } catch (err) {
      console.error(`patch-telegram-reply-to: ERROR patching ${sp}: ${err.message}`)
      results.push({ path: sp, status: 'error' })
      continue
    }
    results.push({ path: sp, ...res })
    if (res.status === 'patched') {
      changed++
      console.log(`patch-telegram-reply-to: applied to ${sp}`)
    } else if (res.status === 'no-anchor') {
      noAnchor++
      console.error(`patch-telegram-reply-to: WARNING anchor not found in ${sp} -- upstream shape changed, skipped`)
    } else if (verbose) {
      console.log(`patch-telegram-reply-to: already patched ${sp}`)
    }
  }
  writeState(results)
  // Exit non-zero only when we found a plugin but could not patch it at all
  // (anchor gone everywhere), so ExecStartPre/tests surface a real regression.
  if (noAnchor > 0 && changed === 0 && !results.some(r => r.status === 'already')) return 2
  return 0
}

// -------------------------------------------------------------------- self-test
function selfTest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-to-patch-'))
  const fixture = path.join(tmpDir, 'server.ts')
  // Minimal fixture reproducing the meta block shape.
  const original = [
    'mcp.notification({',
    "  method: 'notifications/claude/channel',",
    '  params: {',
    '    content: text,',
    '    meta: {',
    '      chat_id,',
    '      user: from.username ?? String(from.id),',
    '      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
  fs.writeFileSync(fixture, original, 'utf8')

  const checks = []
  const ok = (name, cond) => checks.push({ name, cond: !!cond })

  const first = patchFile(fixture)
  ok('first run patches', first.status === 'patched')
  let after = fs.readFileSync(fixture, 'utf8')
  ok('marker inserted', after.includes(MARKER))
  ok('reply_to_message_id inserted', after.includes('reply_to_message_id: String(ctx.message.reply_to_message.message_id)'))
  ok('reply_to_text inserted', after.includes('reply_to_text:'))
  ok('anchor line preserved', after.includes('ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),'))

  const second = patchFile(fixture)
  ok('second run is a no-op', second.status === 'already')
  const afterSecond = fs.readFileSync(fixture, 'utf8')
  ok('idempotent: file unchanged on re-run', afterSecond === after)
  ok('exactly one marker', afterSecond.split(MARKER).length - 1 === 1)

  // A fresh (unpatched) fixture with a reshaped anchor -> no-anchor, no corruption.
  const reshaped = path.join(tmpDir, 'reshaped.ts')
  fs.writeFileSync(reshaped, original.replace('ts: new Date', 'timestamp: new Date'), 'utf8')
  const na = patchFile(reshaped)
  ok('no-anchor when anchor line changed', na.status === 'no-anchor')
  ok('no-anchor leaves file untouched', fs.readFileSync(reshaped, 'utf8') === original.replace('ts: new Date', 'timestamp: new Date'))

  fs.rmSync(tmpDir, { recursive: true, force: true })

  let failed = 0
  for (const c of checks) {
    console.log(`  ${c.cond ? 'PASS' : 'FAIL'}: ${c.name}`)
    if (!c.cond) failed++
  }
  console.log(failed === 0 ? 'self-test: OK' : `self-test: ${failed} FAILED`)
  return failed === 0 ? 0 : 1
}

// ------------------------------------------------------------------------- main
const args = process.argv.slice(2)
if (args.includes('--self-test')) {
  process.exit(selfTest())
} else if (args.includes('--file')) {
  const p = args[args.indexOf('--file') + 1]
  if (!p) {
    console.error('patch-telegram-reply-to: --file requires a path')
    process.exit(1)
  }
  const res = patchFile(path.resolve(p))
  console.log(`patch-telegram-reply-to: ${p} -> ${res.status}`)
  process.exit(res.status === 'no-anchor' ? 2 : 0)
} else {
  process.exit(runAll({ verbose: args.includes('--verbose') }))
}
