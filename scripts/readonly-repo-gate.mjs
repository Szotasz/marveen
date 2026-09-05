#!/usr/bin/env node
// PreToolUse hard-gate: a worker may READ the project repos but never WRITE them.
//
// Why a hook and not a permissions deny-list. The two permission modes each
// fail one half of the requirement:
//
//   - strict:     path denies are enforced, but Claude Code prompts on things
//                 an allow-list cannot pre-approve (notably the `cd X && git …`
//                 compound, which trips the cd-guard). An UNATTENDED worker
//                 cannot answer a prompt, so it simply hangs -- observed twice
//                 on davinci-ocura and vermeer-ocura.
//   - permissive: nothing prompts, but the launcher passes
//                 --dangerously-skip-permissions, which BYPASSES allow/deny.
//                 A `Write(/home/ubuntu/projects/**)` deny is then decorative.
//
// Hooks run regardless of permission mode. So the worker runs permissive (never
// hangs) and this gate provides the actual enforcement.
//
// Scope comes from READONLY_REPO_ROOTS (colon-separated). The default is
// <home>/projects, derived at runtime -- a shipped script must not carry one
// install's absolute home path.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'

const ROOTS = (process.env.READONLY_REPO_ROOTS || join(homedir(), 'projects'))
  .split(':').map(s => s.trim()).filter(Boolean)

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

// The rule is "do not change the SOURCE", not "do not touch the filesystem".
// Dependency and build output live inside the repo but are not source: a QA
// worker that cannot run `npm ci` in a fresh worktree is not a QA worker.
// (Learned the hard way: blocking installs pushed a worker onto `npx prisma`,
// which fetched the registry's latest instead of the pinned version and made it
// diagnose a config problem that did not exist.)
const ARTIFACT_SEGMENTS = new Set([
  'node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.turbo',
  '.cache', '.venv', '__pycache__', 'target', '.pytest_cache', '.nuxt',
  '.svelte-kit', '.output', 'tmp', '.parcel-cache',
])

function isArtifactPath(p) {
  return String(p || '').split('/').some(seg => ARTIFACT_SEGMENTS.has(seg))
}

// Package managers only ever write artifacts (node_modules, lockfile refresh),
// so they are allowed wholesale rather than path-checked.
// Every branch REQUIRES its subcommand. The yarn branch used to read
// `yarn\s+(install)?\b`, and the optional group made the pattern match bare
// `yarn ` + anything -- `yarn add`, `yarn exec`, `yarn dlx` all skipped the
// gate's inspection, which is the opposite of what an install-only exemption
// is for. (Found in review on #770, 2026-09-03.) Bare `yarn` (Yarn 1's
// implicit install) is no longer exempted either: it carries no redirect and
// no mutating verb, so it passes on its own merits rather than by blanket skip.
const INSTALL_RX = /\b(npm\s+(ci|install|i)\b|pnpm\s+(install|i)\b|yarn\s+install\b|pip\s+install\b|poetry\s+install\b|bundle\s+install\b)/

// Branch movement is not a source edit -- a QA worker needs it for baseline
// comparison. `git checkout -- <path>` / `git restore <path>` IS a working-tree
// mutation, so those stay blocked.
const GIT_SAFE_RX = /\bgit\s+(checkout|switch)\s+(?!.*(--\s|--\s*$))[^\s-][^\s]*\s*$|\bgit\s+(switch|checkout)\s+-b\b|\bgit\s+worktree\s+(add|list|prune)\b/

function underRoot(p) {
  if (!p) return false
  let abs
  try { abs = resolve(String(p)) } catch { return false }
  return ROOTS.some(r => abs === r || abs.startsWith(r.endsWith('/') ? r : r + '/'))
}

// Bash is the wide-open route: a redirect or an in-place edit reaches the repo
// without ever touching the Write tool. Checked per segment so a read command
// in one half of a compound is not judged by the other half.
function splitSegments(cmd) {
  return String(cmd || '').split(/&&|\|\||;|\n|\|/).map(s => s.trim()).filter(Boolean)
}

const MUTATING_RX = [
  /\bsed\s+[^|]*-i\b/,                       // in-place edit
  /\b(rm|mv|cp|install|truncate|chmod|chown)\b/,
  /\btee\b/,
  /\bgit\s+(commit|push|reset|restore|clean|rm|mv|apply|stash)\b/,
  /\bgit\s+checkout\s+.*--\s/,
  /\bnpm\s+publish\b/,
  /\b(pnpm|yarn)\s+(add|remove)\b/,
  /\bmkdir\b/,
  /\btouch\b/,
]

// `> file` / `>> file` -- capture the target so we only object when it lands in
// a protected root. `2>/dev/null` and friends are not file writes we care about.
const REDIRECT_RX = /(?<!\d)>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g

function bashViolation(cmd) {
  // The cwd carries ACROSS segments: `cd /repo && echo x > src/a.ts` puts the
  // redirect in a later segment than the cd, so judging segments in isolation
  // would wave it through. Track it.
  let cwd = null
  for (const seg of splitSegments(cmd)) {
    const cd = seg.match(/\bcd\s+("[^"]+"|'[^']+'|[^\s;|&]+)/)
    if (cd) cwd = cd[1].replace(/^["']|["']$/g, '')

    const inRoot = (p) => underRoot(p) || (cwd && !String(p).startsWith('/') && underRoot(cwd))

    if (INSTALL_RX.test(seg) || GIT_SAFE_RX.test(seg)) continue

    for (const m of seg.matchAll(REDIRECT_RX)) {
      const target = m[1].replace(/^["']|["']$/g, '')
      if (target === '/dev/null' || isArtifactPath(target)) continue
      if (inRoot(target)) {
        const shown = target.startsWith('/') ? target : `${cwd}/${target}`
        return `átirányítás a repóba: ${shown}`
      }
    }

    for (const rx of MUTATING_RX) {
      if (!rx.test(seg)) continue
      const touchesRoot = ROOTS.some(r => seg.includes(r)) || (cwd && underRoot(cwd))
      if (touchesRoot && !isArtifactPath(seg)) return `módosító parancs a repóban: ${seg.slice(0, 120)}`
    }
  }
  return null
}

const GATE_MSG = (detail) =>
  `Írás a projekt repóba TILTOTT (readonly-repo-gate). ${detail}. ` +
  'A szereped olvasó: elemzel, tesztelsz, jelentesz -- a kódot nem te módosítod. ' +
  'Ha a feladathoz tényleg írni kellene, azt az orchestratorodnak jelezd, és ő ' +
  'vagy átadja a végrehajtónak, vagy bemásolja amit készítettél. Írni szabadon ' +
  'tudsz a saját agent-mappádba és a /tmp alá -- oda dolgozz.'

function allow() { process.exit(0) }

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
  try { payload = JSON.parse(readFileSync(0, 'utf-8')) } catch { allow() }

  const tool = payload?.tool_name
  const input = payload?.tool_input || {}

  if (WRITE_TOOLS.has(tool)) {
    const target = input.file_path || input.notebook_path || input.path
    if (underRoot(target) && !isArtifactPath(target)) deny(GATE_MSG(`${tool} -> ${target}`))
  }

  if (tool === 'Bash') {
    const v = bashViolation(input.command)
    if (v) deny(GATE_MSG(v))
  }

  allow()
}

export { bashViolation, underRoot, isArtifactPath }
