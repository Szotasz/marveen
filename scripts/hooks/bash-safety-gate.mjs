#!/usr/bin/env node
// PreToolUse Bash safety gate for restricted (web-reading) fleet agents.
//
// PROBLEM this solves (2026-07-20): the "marketer" security profile locked Bash
// to a tiny prefix allowlist (ls/cat/...). Background fleet agents build COMPOUND
// commands routinely -- `cd /path && F=... python3 ...`, pipes, heredocs. A
// prefix allowlist matches the FIRST word (`cd`, a `VAR=` assignment), so every
// such command fell through to an interactive permission PROMPT. For a background
// agent driven over Telegram that means the operator gets spammed with endless
// "Permission: Bash / Allowed" cards -- useless friction, and it blocks the agent
// waiting on a human.
//
// FIX: auto-APPROVE Bash (permissionDecision: 'allow' -> no prompt) EXCEPT for a
// focused denylist of genuinely dangerous commands, which are hard-DENIED here.
// The gate is self-contained: it does NOT rely on the settings deny-list surviving
// a hook 'allow', because a hook 'allow' can bypass the normal permission system.
// So every dangerous pattern must be denied by THIS gate.
//
// Money safety (ad spend) is unaffected: it lives at the MCP tool-approval layer,
// not in Bash. Self-pace safety is unaffected: self-pace-gate.mjs runs alongside
// and its 'deny' still wins (deny beats allow across PreToolUse hooks).
//
// Wired into the agent's .claude/settings.json PreToolUse "Bash" matcher.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Split a compound command into simple segments so a dangerous token in one part
// is caught even when the command STARTS with something innocent (cd/VAR=). Same
// approach as self-pace-gate.mjs: collapse line-continuations first, then split on
// real separators. Not quote-aware (accepted: a dangerous binary inside a quoted
// string is rare and the worst case is a false-deny, which fails safe).
export function splitSegments(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|]|\r?\n/)
    .map((s) => s.trim())
}

// A leading wrapper before the real binary: env-assignments, sudo/env/command/
// exec/nice/time/builtin, and an absolute/relative path prefix. Mirrors
// self-pace-gate's SCHED_PREFIX so `sudo rm`, `/bin/rm`, `PATH=/x rm` all anchor.
const PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time|\\)\s+)*(?:\S*/)?`
// Command boundary inside a segment: start, or right after a substitution opener.
const BOUNDARY = '[(`]'
const at = (bin) => new RegExp(String.raw`(^|${BOUNDARY}\s*)${PREFIX}(?:${bin})\b`, 'i')

// Destructive / privilege / system-state commands, checked PER SEGMENT (anchored
// at command position, wrapper-tolerant). `rm` in any form (an agent has its Write
// scoped to its own dir; deletion via shell is not a routine need and is the
// classic injection payload). cp/mv are intentionally NOT here: they are routine
// and blocking them would break normal work; the real destructive verbs are.
const DANGEROUS_SEG = [
  at('rm|rmdir'),                       // deletion
  at('sudo|su|doas'),                   // privilege escalation
  at('chmod|chown|chgrp|chflags'),      // permission tampering
  at('kill|killall|pkill'),             // process killing
  at('dd|mkfs|fdisk|parted|newfs'),     // disk destruction
  at('shutdown|reboot|halt|poweroff'),  // host state
  at('diskutil|hdiutil'),               // macOS disk tooling
  at('osascript'),                      // AppleScript: can drive the whole Mac
]

// Patterns that span a pipe/substitution and so must be tested on the WHOLE
// command (splitSegments would cut the `|` and hide them).
const DANGEROUS_WHOLE = [
  // fork bomb
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // pipe a network fetch straight into a shell (remote code execution)
  /\b(?:curl|wget|fetch)\b[\s\S]*\|\s*(?:sudo\s+)?(?:ba|z|d|k)?sh\b/i,
  // pipe ANYTHING into a bare interactive shell reading stdin (`... | sh`)
  /\|\s*(?:sudo\s+)?(?:ba|z|d|k)?sh\s*(?:$|[;&|])/i,
  // eval of fetched content
  /\beval\b[\s\S]*\$\(\s*(?:curl|wget|fetch)\b/i,
]

// Reading secret material: SSH/AWS/GPG keys, any .env, keychain dumps. Blocked
// even though python3 could technically bypass -- this stops the casual/injected
// `cat ~/.ssh/id_rsa` exfil path, which is the realistic vector.
const SECRET_READ = [
  /(^|[(`\s])(?:\S*\/)?(?:cat|less|more|head|tail|bat|nl|xxd|od|strings|cp|scp|rsync)\b[\s\S]*(?:\/\.ssh\/|\/\.aws\/|\/\.gnupg\/|\.env\b|id_rsa|id_ed25519|\.pem\b)/i,
  /\bsecurity\b\s+(?:find-generic-password|find-internet-password|dump-keychain|export)\b/i,
]

// --- store/ is write-protected from an agent shell (2026-07-22) ----------------
//
// WHY: store/ holds the dashboard token, the vault, the sqlite DB and -- as of
// today -- the ads-write GRANT that decides whether an agent may spend money. The
// Write/Edit tools were already denied here by edit-safety-gate, but the shell was
// not, so `echo ... > store/ads-write-grant.json` would have let an agent widen its
// own permissions. A permission file that the permissioned party can rewrite is not
// a permission file.
//
// No agent needs to write here from a shell: the services that own these files
// (dashboard, bridge adapter) write them as PROCESSES, which this hook never sees.
// READING is deliberately untouched -- agents read the dashboard token here by design.
//
// HONEST LIMIT: a python3/node one-liner walks straight past this, exactly as the
// SECRET_READ comment above admits about its own rule. This raises the effort and
// makes a casual or injected attempt fail loudly; it is not containment.
const STORE_REF = /(?:\/marveen\/store\/|(?:\.\.\/)+store\/)/i

// Writing, moving, linking or re-permissioning. If a segment touches store/ with one
// of these it is refused -- including `cp store/.dashboard-token /tmp/`, a copy OUT,
// which is as much a leak as a write in.
const STORE_WRITE_CMD = at('tee|cp|mv|install|rsync|truncate|ln|touch|mkdir')
// `sed -i` edits in place; `dd of=` names a write target.
const STORE_WRITE_EXTRA = [/(^|\s)sed\b[^|;]*\s-i\b/i, /\bof=/i]
// A redirect whose TARGET is under store/. Deliberately narrow: `cat store/x > /tmp/y`
// reads from store and writes elsewhere, and must NOT be caught by this rule.
const STORE_REDIRECT = /(?:^|[^0-9>])>>?\s*["']?[^\s"';|&]*(?:\/marveen\/store\/|(?:\.\.\/)+store\/)/i

export function writesToStore(segment) {
  const s = String(segment ?? '')
  if (STORE_REDIRECT.test(s)) return true
  if (!STORE_REF.test(s)) return false
  if (STORE_WRITE_CMD.test(s)) return true
  return STORE_WRITE_EXTRA.some((re) => re.test(s))
}

// Pure decision. Returns { deny, reason } -- deny:true -> block; deny:false ->
// auto-approve (no prompt). Only Bash is gated; anything else -> allow (defer).
export function gateDecision(toolName, toolInput) {
  if (String(toolName ?? '') !== 'Bash') return { deny: false }
  const command = String(toolInput?.command ?? '')
  for (const re of DANGEROUS_WHOLE) {
    if (re.test(command)) return { deny: true, reason: DANGER_MSG }
  }
  for (const seg of splitSegments(command)) {
    for (const re of DANGEROUS_SEG) {
      if (re.test(seg)) return { deny: true, reason: DANGER_MSG }
    }
    for (const re of SECRET_READ) {
      if (re.test(seg)) return { deny: true, reason: SECRET_MSG }
    }
    if (writesToStore(seg)) return { deny: true, reason: STORE_WRITE_MSG }
  }
  return { deny: false }
}

// Loud AND useful: say what was refused, why, and what the legitimate route is --
// otherwise a well-meaning agent goes looking for a way around it.
const STORE_WRITE_MSG =
  'Iras a store/ ala TILTOTT agens-shellbol. Ott van a dashboard-token, a vault, az ' +
  'SQLite DB es a jogosultsagi grant-fajl -- ezeket a szolgaltatasok irjak sajat ' +
  'folyamatkent, nem shellbol. OLVASNI szabad, ez a tiltas csak az irasra/masolasra/ ' +
  'athelyezesre vonatkozik. LEGITIM UT, ha tenyleg kell oda irni: a fo-agens (Nova) ' +
  'teszi le a fajlt, vagy szolj Novanak inter-agent uzenettel es o intezi. NE keress ' +
  'kerulout -- ha megis kell egy kivetel, az egy beszelgetes, nem egy megkerules.'

const DANGER_MSG =
  'Ez a Bash-parancs a biztonsagi denylistre esik (destruktiv / rendszer-szintu / ' +
  'privilege / remote-code-exec). Ezt a profil tiltja. Ha tenyleg szukseges, kerd ' +
  'Zsolt jovahagyasat a Nova Fonokon keresztul, ne futtasd magadtol.'
const SECRET_MSG =
  'Titok-anyag olvasasa (SSH/AWS/GPG kulcs, .env, keychain) TILTOTT. Ha hitelesito ' +
  'adatra van szukseged, kerd a Nova Fonoktol a biztonsagos tarolas modjat.'
function dangerReason(_seg) { return DANGER_MSG }

function allow() {
  // Explicit allow -> skip the interactive prompt for safe commands.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'safe (bash-safety-gate)',
    },
  }))
  process.exit(0)
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}
if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    process.exit(0) // malformed/empty input: defer to normal flow, never crash
  }
  // Only opine on Bash. For any other tool, exit 0 with no output (no opinion).
  if (String(payload?.tool_name ?? '') !== 'Bash') process.exit(0)
  const { deny: shouldDeny, reason } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (shouldDeny) deny(reason)
  allow()
}
