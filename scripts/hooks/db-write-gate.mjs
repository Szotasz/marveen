#!/usr/bin/env node
// PreToolUse gate: agent writes to the dashboard's SECURITY surface
// (APPROVALDBGATE1030), for EVERY agent, the main agent included.
//
// What it denies:
//   1. An SQL write (INSERT / UPDATE / DELETE / REPLACE / DROP / ALTER / CREATE
//      TRIGGER|INDEX ... ON) on a security table of the dashboard database
//      (SECURITY_TABLES in self-pace-gate.mjs: approvals, approval_events,
//      auth_sessions, colleague_sessions, dashboard_users, device_keys, vault_ssh_keys, support_consents, support_password_state,
//      custom_commands, inbound_sig_log), whatever
//      program runs it: sqlite3, python -c, node -e, a heredoc, a pipe. Also
//      PRAGMA writable_schema and any write on sqlite_master / sqlite_schema
//      (and the temp aliases): through them a table is renamed, written under
//      the new name and renamed back without its name ever being spelled.
//   2. A FILE-level write of the database (store/claudeclaw.db and its -wal,
//      -shm, -journal): a redirect onto it, cp/mv/tee/dd/rm/ln/... naming it, a
//      sqlite3 dot-command that replaces or runs files, a native Write/Edit.
//   3. A write of this gate's own wiring and of the autonomy levels, in THIS
//      INSTALL: .claude/settings.json, .claude/settings.local.json,
//      scripts/hooks/, scripts/self-pace-gate.mjs, store/extra-hooks.json,
//      store/autonomy-config.json. "This install" is the root this file sits in
//      (scripts/hooks/ -> ../..), never the cwd: the same Edit in a worktree's
//      own copy passes, and every path is compared after realpath (symlinks and
//      ".." resolved, case folded as a case-insensitive volume reads it). An
//      archive extracted or a patch applied with no target directory writes
//      into the cwd: there the cwd is the target.
//   4. CHANINBOUNDFORGE1125: an agent_messages write that could forge who is
//      speaking: a reserved or unknown sender (the channel coordinator, the voice
//      channel, system, a future owner-voice id), a delivery flag (stop_authorized,
//      urgent, priority, affects_current_work), a rewrite of another sender's row,
//      or a statement the gate cannot read (agentMessagesForgeWrite in
//      self-pace-gate.mjs; reported as an SQL write, reason 'db').
//
// What still passes: SQL reads (SELECT, sqlite3 -readonly), SQL writes on any
// other table (the daily_logs date fix in CLAUDE.md), the ordinary agent_messages
// writes (an agent's own message, a status/result update, its own pending row's
// content), the kanban tool, reads of the protected files (cat/grep/jq/diff,
// git diff/log/show), running a hook script, and MESSAGE TEXT that merely
// quotes such a command: the data argument of curl -d/--data*, git commit -m/-F,
// gh --body/--title, scripts/agent-msg.sh, the kanban tool's --title. Only that
// argument is dropped, never the segment: `curl -d '...'; sqlite3 ... 'UPDATE
// approvals ...'` is still denied on its second segment.
//
// THE LIMIT, stated (Samu 56076, Dani 56081): this is a TEXT-BASED BRAKE, NOT AN
// OS BOUNDARY. It reads the command text; a program that builds the statement or
// the path at run time (a script file written earlier with the Write tool, a
// string assembled from pieces in an interpreter) passes. The owner-approval
// record is trustworthy only once GROMZODONTES1030 (F1-F3) moves the decision
// to the mxd store, which no agent can forge; this gate does not make the
// approvals table that place.
//
// Engine: scheduleSurfaceDeny in scripts/self-pace-gate.mjs (segments, quoting,
// escape/glob variants, message-data residue), run with `surface: 'security'`.

import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  commandName,
  cwdAfterSegment,
  substituteDefiniteCommand,
  dataResidue,
  definiteAssignments,
  expandBraces,
  expandHome,
  globMatchesName,
  isReadOnlyFsCommand,
  laterRuns,
  shellCodeStrings,
  shellScriptWord,
  nameForms,
  normalizePathSegments,
  pathKey,
  protectedSplit,
  sameKey,
  scheduleSurfaceDeny,
  scheduleSurfaceVariants,
  shellSegments,
  shellWords,
  splitSegments,
  underKey,
} from '../self-pace-gate.mjs'
import { claudeInvocations } from './child-claude-channel-guard.mjs'
import { mcpFileTargets } from './mcp-file-targets.mjs'

// The install this gate guards: scripts/hooks/ -> scripts/ -> root.
export const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// CHANSTATEWRITE1104: the trust files and directories of a channel plugin's state dir, per plugin (`*`), under each
// root. A name with a glob character matches one path segment by that glob (inbox-draining-<pid>.jsonl).
// SLACKOUTDM1007: the Slack plugin's delivered-dms.json (the DM channels an allowFrom user wrote from, kept across
// restarts) teaches its outbound gate whose DM a channel is, so a forged row would open a stranger's DM; it is a trust
// file like access.json, and so is the temporary name its atomic write renames from (delivered-dms.json.tmp.<pid>).
const CHANNEL_STATE_FILES = ['access.json', '.env', 'invites.json', 'inbound-evidence.jsonl', 'inbound-evidence.jsonl.1',
  'inbox-pending.jsonl', 'inbox-draining-*.jsonl', 'allowlist.json', 'pending.json', 'audit.jsonl', 'own-threads.json',
  'bot.pid', 'coordinator.pid', 'delivered-dms.json', 'delivered-dms.json.tmp.*']
const CHANNEL_STATE_DIRS = ['progress', 'approved']
function channelStateTargets() {
  const out = []
  for (const [kind, base] of [['home', '.claude/channels'], ['rel', '.claude/channels'], ['rel', 'agents/*/.claude/channels']]) {
    for (const f of CHANNEL_STATE_FILES) out.push({ [kind]: `${base}/*/${f}`, pattern: true })
    for (const d of CHANNEL_STATE_DIRS) out.push({ [kind]: `${base}/*/${d}`, pattern: true, dir: true })
  }
  return out
}

// What a background worker loads at its start, under its home (WORKERCFGDIR1104, Dani 68629/68889): its config dir
// (settings.json, .claude.json, worker-mcp.json, .credentials.json, ...), and, since the home is its cwd and a trusted
// project (.claude.json projects[home].hasTrustDialogAccepted), the project-scope files there too: .claude/ (settings,
// settings.local), .mcp.json (the dashboard writes it only when missing, so a planted server would stay), CLAUDE.md and
// CLAUDE.local.md. scratch/, where the worker writes its answers, stays free, and so does the rest of the home.
// The two CLAUDE*.md names are the first protected names without a leading dot that a caller reaches from its own cwd
// (the worker's cwd IS its home): the words are split on quotes and parentheses (fail closed), so the `*` of a quoted
// `count(*)` is a bare relative glob there, and without `noBareGlob` the worker's own `sqlite3 -readonly db "SELECT
// count(*) ..."` was denied (worker-gates.test.ts). The skip is bound to QUOTING (Dani, #2514 follow-up review): the
// shell never expands a glob inside quotes, so a quoted `*` is a literal whatever the command, while an UNQUOTED bare
// `*` expands to every existing non-dot name whatever the command (read vs write is a weaker proxy: sqlite3 writes too).
// A word of glob characters only skips these two entries when ALL of this holds: the segment's text, with its quoted
// spans removed, has no bare-glob word left (a backslash-escaped `\*` counts as unquoted, an unterminated quote fails
// closed); the whole command names no program that runs text as shell code again (reShellsText: a quoted `tee *`
// handed to `bash -c`, `eval`, an interpreter, `xargs`, `find -exec` or sqlite3's `.shell` is globbed after all, Dani's
// review of 7ae2931af; since INSTRFILES1104 A python only when its code is not data by a closed allowlist, node always,
// see PY_FAMILY); and the word is read from the caller's OWN project dir (another sub-agent's cd into the home
// gets no skip at all). An absolute or ~ glob, a partial one (`C*`), the name itself and an unquoted `tee *` / `> *` /
// `sed -i ... *` all still match. Stated limit: a program name put together at run time is beyond a text brake.
const WORKER_HOME_TARGETS = [{ sub: '.claude-config', dir: true }, { sub: '.claude', dir: true }, { sub: '.mcp.json' },
  { sub: 'CLAUDE.md', noBareGlob: true }, { sub: 'CLAUDE.local.md', noBareGlob: true }]
function workerHomeTargets(homeRel) {
  return WORKER_HOME_TARGETS.map((t) => ({ home: `${homeRel}/${t.sub}`, ...(t.dir ? { dir: true } : {}), ...(t.noBareGlob ? { noBareGlob: true } : {}) }))
}

// INSTRSURFACE1118 (kanban 0d0809bf): the instruction surfaces a session loads at its start. Claude Code reads the
// CLAUDE.md files of its cwd and of every ancestor directory (measured: a sub-agent's context carries the install
// root's CLAUDE.md), the .claude/{rules,skills,commands,agents,output-styles} trees of its project (the main agent's is
// the root; the root's skills reach the sub-agents too, per the scaffold's own text; the other trees from an ancestor
// are not measured, and listed anyway), and the same at user level from its config dir. One write there plants a
// lasting instruction in a session that is not the writer's, past the skill proposal, its quarantine and the
// owner-only skill routes:
//   the install root      -- every sub-agent's cwd is below it (agents/<name>), the main agent's cwd IS it
//   every ancestor of it  -- same reason (rootAncestorInstructionEntries, added per root in installTargets)
//   ~/.claude             -- the spawn links every top-level ~/.claude entry into each agent's isolated config dir
//                            (agent-process.ts), so a new ~/.claude/CLAUDE.md or rules/ reaches the whole fleet at
//                            its next start; skills/ and agents/ are listed above already (PLUGINCODEWRITE1104)
//   another agent's       -- its CLAUDE.md files, its .claude trees and its config dir's own (real) ones
// The caller's OWN agent directory stays free (`notCaller`): that is how an agent learns, writing its own skills,
// rules and CLAUDE.md (Laci, 2026-11-18). The main agent is not on this list. The dashboard's writes (scaffold,
// skill approval) are not tool calls.
const INSTRUCTION_SURFACES = [{ sub: 'CLAUDE.md' }, { sub: 'CLAUDE.local.md' }, { sub: '.claude/CLAUDE.md' },
  ...['rules', 'skills', 'commands', 'agents', 'output-styles'].map((d) => ({ sub: `.claude/${d}`, dir: true }))]
const CONFIG_INSTRUCTION_SURFACES = [{ sub: '.claude-config/CLAUDE.md' },
  ...['rules', 'commands', 'output-styles'].map((d) => ({ sub: `.claude-config/${d}`, dir: true }))]
const HOME_INSTRUCTION_SURFACES = [{ sub: '.claude/CLAUDE.md' },
  ...['rules', 'commands', 'output-styles'].map((d) => ({ sub: `.claude/${d}`, dir: true }))]
// A file entry (no leading dot, so a bare `*` matches it) is free for a quoted bare glob (classifyWord)
const withDir = (s) => (s.dir ? { dir: true } : { quotedGlobFree: true })
function instructionSurfaceTargets() {
  return [
    ...INSTRUCTION_SURFACES.map((s) => ({ rel: s.sub, ...withDir(s) })),
    ...HOME_INSTRUCTION_SURFACES.map((s) => ({ home: s.sub, ...withDir(s) })),
    ...[...INSTRUCTION_SURFACES, ...CONFIG_INSTRUCTION_SURFACES].map((s) => ({ rel: `agents/*/${s.sub}`, pattern: true, notCaller: true, ...withDir(s) })),
  ]
}
// The same surfaces under every ancestor of the install root that the agents' user can write: at or below $HOME, or
// a directory it may write. `/` and `/home` are not (root-owned), and an entry there only cost false denials: a
// docblock `/**` in a heredoc read as a glob matched /CLAUDE.md (the 2026-11-18 tool-log replay).
export function rootAncestorInstructionEntries(root) {
  const out = []
  const home = resolve(homedir())
  for (let dir = dirname(resolve(root)); ; dir = dirname(dir)) {
    if (dir === home || dir.startsWith(home + '/') || userMayWrite(dir)) {
      for (const s of INSTRUCTION_SURFACES) out.push({ rel: join(dir, s.sub), abs: join(dir, s.sub), ...withDir(s) })
    }
    if (dirname(dir) === dir) break
  }
  return out
}
function userMayWrite(dir) {
  try { accessSync(dir, fsConstants.W_OK); return true } catch { return false }
}
// The caller's own agent directory (<root>/agents/<name>, by its real path), read from its project dir; null for a
// caller outside agents/ (a background worker): every agent directory is then another agent's.
export function callerAgentDirKey(root, projectDir) {
  if (!projectDir) return null
  const agents = pathKey(join(resolve(root), 'agents'))[0]
  const rel = relative(agents, pathKey(resolve(String(projectDir)))[0])
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return pathKey(join(agents, rel.split('/')[0]))
}
// A `notCaller` entry never matches inside the caller's own agent directory.
function ownedByCaller(t, key) {
  return !!t.exceptKey && underKey(key, t.exceptKey)
}

// The install's own gate wiring and autonomy levels (Dani 56081 point 5, Samu 56090).
export const PROTECTED_INSTALL_PATHS = [
  { rel: '.claude/settings.json' },
  { rel: '.claude/settings.local.json' },
  { rel: 'scripts/hooks', dir: true },
  { rel: 'scripts/self-pace-gate.mjs' },
  { rel: 'store/extra-hooks.json' },
  { rel: 'store/autonomy-config.json' },
  // The sub-agents' sender-role gates (GROMZOGATECONF1030 (c), Samu 59516): only the dashboard writes them, so no
  // agent can widen its own gate for its next restart.
  { rel: 'store/agent-sender-role-gates.json' },
  // The dashboard's settings overrides (APPROVALSLACK1030, Samu 66026 / 65935): NOTIFY_SLACK_TARGET there names where
  // the owner's approval requests go, SLACK_OWNER_USER_ID whose Slack reaction approves. The sub-agents were already kept out (self-pace-gate, #2153); this covers the main agent.
  // The dashboard writes it through its API, which this gate does not see.
  { rel: 'store/config-overrides.json' },
  // The owner Slack target last announced (Dani 66036): the drift check compares against it.
  { rel: 'store/.owner-slack-target' },
  // The network-target origins recorded at the last boot (NETTARGETENV1104, Dani 68849): the drift check compares
  // against it, so a pre-written or deleted record would hide a target change.
  { rel: 'store/.net-target-hosts.json' },
  // The owner-gated agent settings the dashboard keeps in store/ (GATEFILES1110): custom-providers.json holds each
  // provider's baseUrl, where an agent's whole prompt goes (owner-only on the API, APIAGENTWRITE1104), and
  // context-guard.json the context-guard values (raising one is an owner session on the API, OWNERGATE3-1104). Only the
  // dashboard writes them, through those routes; no skill, script or hook writes them with a tool call.
  { rel: 'store/custom-providers.json' },
  { rel: 'store/context-guard.json' },
  // The dashboard login's TOTP second factor (DOCKERHTTPS1119, Dani 81107 B2): the secrets, the last accepted step and
  // the backup-code hashes. Only the dashboard writes it (its owner-gated enable/disable and the login), and the
  // break-glass CLI on the machine; deleting it no longer turns the factor off (dashboard_users.totp_enabled, a
  // security table, keeps it on and the login fails closed), but a write could swap a secret or reset the replay step.
  { rel: 'store/.dashboard-totp.json' },
  // The key the dashboard signs agent_messages rows with (HMACINBOUND1125, Dani #3117 review 1). Only the dashboard
  // creates it, at boot (not a tool call); a written key would make the dashboard sign and verify with a key someone
  // else knows after its next start. A read by a sub-agent is the self-pace gate's (inboundSigKeyBashSegmentAllowed).
  { rel: 'store/.inbound-sig-key' },
  // The node the dashboard runs on, recorded at its start for scripts/watchdog.sh (WDSANDBOXNODE1119), which runs it
  // (the Bash sandbox helper, npm start). Only the dashboard's start writes it; an edited path would be run by the
  // watchdog, a deleted one only makes it fall back to the node on its PATH.
  { rel: 'store/.dashboard-node' },
  // The install's platform marker (HOSTINGERROUTER1122): docker/first-boot.sh writes it once from the Hostinger compose
  // file, and the dashboard offers the Hostinger AI Router only when it says "hostinger". A written one would offer a
  // billed router on an install that is not a Hostinger one.
  { rel: 'store/.platform' },
  // The per-agent launch files the dashboard derives from the owner's switches and every restart path reads
  // (WDSANDBOXMARKER1119): store/bash-sandbox/<id>.settings.json, the --settings file of an agent on
  // BASH_SANDBOX_AGENTS, and store/code-mode/<id>.on, the Code Mode marker. Only the dashboard's start and the
  // watchdog's restart write them (neither is a tool call); a deleted or edited file would change how that agent
  // comes back. The whole directories, as directories.
  { rel: 'store/bash-sandbox', dir: true },
  { rel: 'store/code-mode', dir: true },
  // The scoped board's confinement (PR #2912 review B1, Dani): read on each request, so an agent that writes it
  // (enabled false, or its person's role set to all) un-scopes itself at once. Only the owner edits it.
  { rel: 'store/board-access.json' },
  // The scoped board's colleague logins (PR #2929, same class as #2912 B1): an agent that adds an account with a hash it
  // knows, or bumps a person's role, signs in as that colleague. Only the owner API and the CLI write it.
  { rel: 'store/colleague-accounts.json' },
  // The main checkout's git wiring (Samu 56299 2, Dani 56284): its remote, its remote-tracking refs and its hooks. A
  // worktree shares them, so a ref or a URL changed from a worktree is changed for the install's pull as well.
  { rel: '.git/config' },
  { rel: '.git/packed-refs' },
  { rel: '.git/refs/remotes', dir: true },
  { rel: '.git/hooks', dir: true },
  // The user's git config, read by every git on the machine (Samu 56310 2): an url.*.insteadOf there redirects origin.
  { home: '.gitconfig' },
  { home: 'git/config', xdg: true },
  // Every agent's own Claude settings (ENVRELAXGATE1104, Samu 67797): a sub-agent's gate hooks live in its
  // agents/<name>/.claude/settings.json, so one edit there takes a gate out (or adds disableAllHooks / an env block). Only
  // the dashboard writes them (on every spawn); no agent, the main agent included. `*` is ONE path segment (the agent's
  // name). A pattern has NO ancestor here: agents/<name> is where every sub-agent works, and a directory changer naming
  // its .claude directory is caught by claudeDirCopyIn below.
  { rel: 'agents/*/.claude/settings.json', pattern: true },
  { rel: 'agents/*/.claude/settings.local.json', pattern: true },
  // ...and the user-level settings of its isolated CLAUDE_CONFIG_DIR (Samu 67832): a disableAllHooks there switches off
  // every hook of that agent. Claude Code's own writes (/effort, /model) are not tool calls, so this gate never sees them.
  { rel: 'agents/*/.claude-config/settings.json', pattern: true },
  // Support access (SUPPORTKULCS1109, D5; terv-v7 3.9): EVERY support state of this machine is one folder outside the
  // install tree, ~/.marveen/support: the narrow token, the group record, the kit with the dispatcher (the command every
  // support line binds) and its manifest, the spool and the run folder. Only the routine writes it (the installer's and
  // the updater's install-kit, the dashboard's enable and disable, the reconcile), never a tool call; a write there
  // could swap the gate a support login runs through, plant or keep a token, or erase the spool the owner reads.
  { home: '.marveen/support', dir: true },
]
// ENVRELAXGATE1104 (Dani's inventory 67751 and plan v2, Samu 67732/67752/67763): files whose ONE write turns a gate off or
// gives an agent a right, for a SUB-AGENT only. The main agent writes the install .env legitimately (self-rename), so
// these are not in the common list above; the same real-path engine measures them, so a worktree's own copy (another
// root) stays free, and a read (`sed -n`, `grep`, `cat`, the seed skills' `PORT="$(sed -n ... .env)"`) passes.
//   .env                                -- SUDO_AGENTS (agentMaySudo reads it on every spawn: sudo at the next respawn),
//                                          MAIN_AGENT_ID (who the governance gates exempt), and the hooks' relaxing switches
//   store/provenance-gate-rules.json    -- "enabled": false switches the provenance gate off (missing today: creating it)
//   store/outgoing-copy-gate-rules.json -- no_name_rule: true drops the name check silently; deleting it fails open
//   store/credential-gate.json          -- mode: warn turns the credential gate into a warning (missing today)
//   store/egress-measure-hosts.json     -- a host there lets curl -q GET/HEAD through (bash-egress-parser.mjs)
//   store/.fleet-memgate-observe        -- its presence puts the fleet memory gate into observe-only (fleet-memory-gate.sh)
//   store/.channel-unconfigured         -- channels.sh's "the main session runs without its channel" marker
//                                          (CHANNELUNCONF1110, Dani #2691 K1): only channels.sh writes it, never a tool
//                                          call; a written one would ask the monitor to leave the main agent alone
//   store/claude-plans.json             -- which Claude subscription each agent runs on: a plan's configDir, its vault
//                                          secret id and its label (PLANSFILEGATE1111, Samu 75712). The owner-gated
//                                          POST /api/claude-plans writes it (OWNERGATE2-1104); a direct write went around
//                                          that gate, and a label reaches the main agent's rotation prompt. Only the
//                                          dashboard writes it (claude-plans.ts, atomicWriteFileSync); no skill, script or
//                                          scheduled task does with a tool call (measured 2026-11-11), so the main agent
//                                          stays free, as with the .env
export const SUBAGENT_PROTECTED_INSTALL_PATHS = [
  { rel: '.env' },
  { rel: 'store/provenance-gate-rules.json' },
  { rel: 'store/outgoing-copy-gate-rules.json' },
  { rel: 'store/credential-gate.json' },
  { rel: 'store/egress-measure-hosts.json' },
  { rel: 'store/.fleet-memgate-observe' },
  { rel: 'store/.channel-unconfigured' },
  { rel: 'store/claude-plans.json' },
  // The user's shared Claude settings (Dani 67840/67841): every agents/*/.claude-config/settings.local.json is a
  // SYMLINK to ~/.claude/settings.local.json, a real file the main agent loads too, so a sub-agent writing it (through
  // its symlink or straight) changes every session's settings. The main agent writes them legitimately: sub-agent only.
  // The real path is compared, so the symlink route lands here. ~/.claude/projects (memory files) is not touched.
  { home: '.claude/settings.json' },
  { home: '.claude/settings.local.json' },
  // The MAIN agent's isolated config dir (MAIN_AGENT_ISOLATED_CONFIG, Samu 68206/68210): its settings.json (env,
  // permissions, enabledPlugins, extraKnownMarketplaces, hooks) and a settings.local.json created there are loaded at
  // the main agent's next start, and so are its plugin registries (plugins/*.json) and its state. Every REAL file in it
  // is the main agent's; a sub-agent writes none of them. Its symlinked entries (projects, skills, agents, hooks, the
  // plugin cache...) resolve into ~/.claude, and the real path is compared, so they are judged where they land, not
  // here. The whole directory, as a directory: one entry covers a file Claude Code adds there tomorrow.
  { rel: '.channels-config', dir: true },
  // The MCP server lists (ENVRELAXMCPCFG1104, Samu 68033/68034): a stdio server written into one of them runs as a
  // command at the agent's next start, outside every PreToolUse gate, and the dashboard's reconcile only ever ADDS
  // servers, so the entry would stay. A sub-agent writes none of them; the main agent and the dashboard do (fleet MCP
  // setup), so this is the sub-agent list:
  //   agents/*/.mcp.json                   -- an agent's project-scope servers (its own and another's)
  //   agents/*/.claude-config/.claude.json -- an agent's isolated user-scope servers (mcpServers, projects[].mcpServers)
  //   .mcp.json                            -- the install's project-scope servers (tracked: a worktree's own copy is
  //                                           another root and stays free)
  //   .channels-config/.claude.json        -- the main agent's isolated user config (MAIN_AGENT_ISOLATED_CONFIG):
  //                                           covered by the .channels-config directory entry above (#2503)
  //   ~/.claude.json                       -- the shared user config: the reconcile copies servers FROM it
  // Claude Code's own writes of .claude.json (its state, on every session) are not tool calls: this gate never sees
  // them. Its backups/ copies are not listed (stated limit).
  { rel: 'agents/*/.mcp.json', pattern: true },
  { rel: 'agents/*/.claude-config/.claude.json', pattern: true },
  // ...and its record of which of those servers came from the shared config (MCPWRITEGATE1104 D4): dropping a name
  // from it would keep a server the reconcile is about to take back out
  { rel: 'agents/*/.claude-config/.marveen-mcp-inherited.json', pattern: true },
  { rel: '.mcp.json' },
  { home: '.claude.json' },
  // The Claude Code plugin trees and the shared user-level trees every session loads (PLUGINCODEWRITE1104, Samu
  // 68214/68229/68247): a sub-agent writes none of them; the main agent, the dashboard (skill propose), the launcher
  // (channels.sh patches, update.sh plugin refresh, ensureGromzoMarketplace) and Claude Code itself do, none of them by
  // a sub-agent's tool call. Each agent's config dir links cache/data/marketplaces/agents/skills/hooks here, and the
  // real path is compared, so the symlink route lands on these entries.
  //   ~/.claude/plugins            -- the plugin code (cache, marketplaces), data, and the shared registries
  //   <root>/plugins               -- the install's own plugin code (state observer, worksource MCP server, ...)
  //   ~/marveen-local-plugins      -- the gromzo directory marketplace: its plugin RUNS from there (installPath)
  //   ~/.claude/agents|skills|hooks -- subagent types, skills, hook scripts every session can load
  //   agents/*/.claude-config/plugins/{installed_plugins,known_marketplaces}.json -- each agent's own registries
  { home: '.claude/plugins', dir: true },
  { rel: 'plugins', dir: true },
  { home: 'marveen-local-plugins', dir: true },
  { home: '.claude/agents', dir: true },
  { home: '.claude/skills', dir: true },
  { home: '.claude/hooks', dir: true },
  { rel: 'agents/*/.claude-config/plugins/installed_plugins.json', pattern: true },
  { rel: 'agents/*/.claude-config/plugins/known_marketplaces.json', pattern: true },
  // The two background workers' start-up files (WORKERCFGDIR1104, Dani 68629/68889, Samu 68631): WORKER_HOME_TARGETS
  // under each home. The worker itself already may not write its own settings and server lists
  // (callerSettingsEntries); another sub-agent could, and a hooks entry would stay (worker-mcp.json is rewritten on
  // every start). The dashboard provisions these files, never a sub-agent's tool call. As with .channels-config: a
  // whole directory covers a file added there later, and its symlinked entries (projects, skills, plugins, ...) resolve
  // into ~/.claude and are judged where they land. The config dir replaces #2505's two plugins entries, which it
  // contains. The default id's homes are listed here; a renamed install's (MAIN_AGENT_ID) are added per call by
  // workerConfigEntries.
  ...workerHomeTargets('.marveen-worker'),
  ...workerHomeTargets('.marveen-worker-fast'),
  // The channel plugins' trust files (CHANSTATEWRITE1104, Marveen 69167, Samu 69174/69201): what decides who is the
  // owner or an allowed sender, what is paired or approved, which bot identity is used and what an inbound message's
  // provenance is (measured: work/chanstate-measure.md). Under every state root a plugin uses: the shared
  // ~/.claude/channels (every agent's .claude-config/channels and the main agent's .channels-config/channels link
  // there, compared by real path), the install's own .claude/channels (the main agent's Telegram), and each agent's
  // agents/<name>/.claude/channels, the caller's own included (a writable allowFrom is an owner-identity grant).
  // Their writers are the plugin processes, the hooks, the daemons, the dashboard and the launcher, none of them a
  // sub-agent's tool call; the plugins' own access/configure skills hard-code ~/.claude/channels, so in a sub-agent
  // they would write the main agent's state, and denying them there is right. Left free: inbox/, sessions/,
  // outbound-gate.log, Teams files/ and outbox/ (no trust reader measured). #2512's Telegram inbound-evidence log
  // entries (TGINREPLAYGATE1104) resolved into this list: CHANNEL_STATE_FILES names both the current and the
  // rotated file, under every state root, not only agents/<name>/.claude/channels/telegram.
  ...channelStateTargets(),
  // ...and the two Telegram state directories above the evidence log, as targets only (not their contents, no `dir`)
  // (TGINREPLAYGATE1104, #2512 review): classifyWord gives a pattern no 'ancestor', so without the entries a
  // directory changer aimed at one of them (`rm -rf telegram/`, a `mv` of or onto channels/, `cp x telegram/`,
  // `cp -r d/. telegram/`, rsync, `tar -C`) would take, replace or land on the log unnamed; a copy, rsync or
  // extraction into them is judged by its landing as well (CPDESTDIR1104). A write naming another file inside them
  // is denied only if CHANNEL_STATE_FILES lists that name (access.json it does; a look-alike like
  // inbound-evidence.jsonl.bak does not). Not seen (the content-copy limit of claudeDirCopyIn): an archive extracted,
  // or a directory's content copied, into the agent directory itself.
  { rel: 'agents/*/.claude/channels/telegram', pattern: true },
  { rel: 'agents/*/.claude/channels', pattern: true },
  // Every agent's agent-config.json (GATEFILES1110): its customProvider (owner-only on the API, APIAGENTWRITE1104),
  // model, oauthTokenFile and the rest, read on every spawn. The main agent's skills write it directly (model switch,
  // displayName, oauthTokenFile, a hand-made agent), so this is the sub-agent list: any agent's file, not only the
  // caller's own. Stated limit, as for agents/*/.claude/settings.json: a pattern has no ancestor, so renaming a whole
  // agents/<name> directory is not judged here. It is the first protected name without a leading dot in a sub-agent's
  // own directory, so a bare glob there matches it: noBareGlob keeps the #2514 rule (a QUOTED `count(*)` stays free in
  // the caller's own dir), while an unquoted `cp x *` there still matches, as the shell would expand it.
  { rel: 'agents/*/agent-config.json', pattern: true, noBareGlob: true },
  // The token-plan launch outcomes (SUBPLANTOKEN1110 follow-up, Dani 75495 (2)): store/plan-token-launch/<name>.json is
  // what POST /api/claude-plans/rotate reads back after a sub-agent's restart, and what the agent summary shows. A
  // sub-agent writing a fresh state:"plan-token" for another agent inside the 20 s read-back window would make the rotate
  // answer 200 for a launch that failed. Written by the dashboard and by the launched shell's resolve-plan-token-env.mjs
  // (neither is a tool call), never by a sub-agent: the whole directory, as a directory.
  { rel: 'store/plan-token-launch', dir: true },
  // INSTRSURFACE1118: the instruction surfaces other sessions load (see instructionSurfaceTargets)
  ...instructionSurfaceTargets(),
]

// Is the hook's caller a sub-agent? The main agent runs in the install root (its CLAUDE_PROJECT_DIR), a sub-agent in
// agents/<name>. Anything that is not exactly the install root counts as a sub-agent, an unset project dir too
// (fail-closed: the main agent's hook always has it). A second signal (Dani 67822): a CLAUDE_CONFIG_DIR under the
// install's agents/ is a sub-agent's isolated config, which a child `claude` it starts from the install root inherits;
// the main agent's config is ~/.claude or <root>/.channels-config, never under agents/. `env -i` drops it (stated limit).
export function isSubAgentCaller(projectDir, root = INSTALL_ROOT, configDir = null) {
  if (configDir && underKey(pathKey(resolve(String(configDir))), pathKey(join(resolve(root), 'agents')))) return true
  if (!projectDir) return true
  return !sameKey(pathKey(resolve(String(projectDir))), pathKey(resolve(root)))
}

// The database file, by NAME anywhere (as the Bash rule reads it).
const DB_FILE_NAME_RX = /(?:^|\/)claudeclaw\.db(?:-wal|-shm|-journal)?$/i

// The CALLER's own Claude settings, wherever they are (Samu 67803, 67832): a sub-agent's gate hooks live in
// <CLAUDE_PROJECT_DIR>/.claude/settings.json, and its user-level settings in <CLAUDE_CONFIG_DIR>/settings.json (unset:
// ~/.claude/settings.json, which then is the sub-agent's). Under the install's agents/ the common patterns cover the
// first two already; these entries also cover a caller outside it (the two workers: their config dir is
// ~/.marveen-worker{,-fast}/.claude-config). Sub-agent list only.
function callerSettingsEntries(projectDir, configDir) {
  const out = []
  if (projectDir) {
    const dir = resolve(String(projectDir))
    // ...and its project-scope MCP servers (ENVRELAXMCPCFG1104)
    for (const rel of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']) out.push({ rel, abs: resolve(dir, rel), caller: true })
  }
  if (configDir) {
    const dir = resolve(String(configDir))
    // ...and its user-scope MCP servers in the config dir's .claude.json (ENVRELAXMCPCFG1104)
    for (const f of ['settings.json', 'settings.local.json', '.claude.json', '.marveen-mcp-inherited.json']) out.push({ rel: `${basename(dir)}/${f}`, abs: join(dir, f), caller: true })
    // ...and its plugins tree (PLUGINCODEWRITE1104)
    out.push({ rel: `${basename(dir)}/plugins`, abs: join(dir, 'plugins'), dir: true, caller: true })
  }
  return out
}

// --- plugin code loaded from outside the cache, and the other config roots (PLUGINCODEWRITE1104) -----------------
// Claude Code loads a directory-marketplace plugin from where installed_plugins.json's installPath points (the gromzo
// plugin runs from ~/marveen-local-plugins, gromzo-marketplace.ts), and a config root other than the agents' (the
// main agent's MAIN_AGENT_CONFIG_DIR, a plan's configDir) has a plugins tree of its own. Read here, per hook call:
//   registries: ~/.claude/plugins and <root>/.channels-config/plugins (installed_plugins.json installPath,
//               known_marketplaces.json source.path of a directory/file marketplace, installLocation), and the same
//               files under each other config root;
//   other roots: MAIN_AGENT_CONFIG_DIR (store/config-overrides.json, then .env) and store/claude-plans.json configDir.
// Every path must be absolute after ~ expansion. Left out (one bad registry entry must not deny everything): /, /tmp,
// /private/tmp, $TMPDIR, and any path that is or contains $HOME, ~/.claude, the install root, its agents/ or the
// caller's project dir. A path already under ~/.claude/plugins is covered by that entry. At most DYN_CAP paths.
// A missing or unparseable file adds nothing: these files are on the sub-agent list themselves.
const DYN_CAP = 200
function readJsonFile(p) { try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null } }
function installSetting(root, key) {
  const ov = readJsonFile(join(root, 'store', 'config-overrides.json'))
  if (ov && typeof ov === 'object' && typeof ov[key] === 'string' && ov[key].trim()) return ov[key].trim()
  try {
    const m = readFileSync(join(root, '.env'), 'utf-8').match(new RegExp('^' + key + '=(.*)$', 'm'))
    if (m && m[1].trim()) return m[1].trim().replace(/^['"]|['"]$/g, '')
  } catch { /* no .env */ }
  return null
}
function mtimeOf(p) { try { return String(statSync(p).mtimeMs) } catch { return '-' } }
function dynamicSources(root) {
  const h = homedir()
  const otherRoots = []
  const mainCfg = installSetting(root, 'MAIN_AGENT_CONFIG_DIR')
  if (mainCfg) otherRoots.push(mainCfg)
  const plans = readJsonFile(join(root, 'store', 'claude-plans.json'))
  if (Array.isArray(plans)) for (const pl of plans) if (pl && typeof pl.configDir === 'string' && pl.configDir.trim()) otherRoots.push(pl.configDir.trim())
  const regDirs = [join(h, '.claude', 'plugins'), join(root, '.channels-config', 'plugins'), ...otherRoots.map((d) => join(expandHome(d), 'plugins'))]
  const files = [join(root, 'store', 'config-overrides.json'), join(root, '.env'), join(root, 'store', 'claude-plans.json'),
    ...regDirs.flatMap((d) => [join(d, 'installed_plugins.json'), join(d, 'known_marketplaces.json')])]
  return { otherRoots, regDirs, sig: files.map(mtimeOf).join(',') }
}
export function dynamicPluginEntries(root, projectDir, src = dynamicSources(root)) {
  const raw = []
  for (const r of src.otherRoots) raw.push(join(expandHome(r), 'plugins'))
  for (const d of src.regDirs) {
    const inst = readJsonFile(join(d, 'installed_plugins.json'))
    const plugins = inst && typeof inst === 'object' ? (inst.plugins ?? inst) : null
    if (plugins && typeof plugins === 'object') {
      for (const v of Object.values(plugins)) for (const e of Array.isArray(v) ? v : [v]) if (e && typeof e.installPath === 'string') raw.push(e.installPath)
    }
    const known = readJsonFile(join(d, 'known_marketplaces.json'))
    if (known && typeof known === 'object') {
      for (const m of Object.values(known)) {
        if (!m || typeof m !== 'object') continue
        const sp = m.source && typeof m.source === 'object' ? m.source : null
        if (sp && typeof sp.path === 'string' && (sp.source === 'directory' || sp.source === 'file')) raw.push(sp.source === 'file' ? dirname(sp.path) : sp.path)
        if (typeof m.installLocation === 'string') raw.push(m.installLocation)
      }
    }
  }
  const h = homedir()
  const tmp = process.env.TMPDIR ? resolve(process.env.TMPDIR) : null
  const keep = (abs) => {
    const key = pathKey(abs)
    if (['/', '/tmp', '/private/tmp', tmp].filter(Boolean).some((x) => sameKey(key, pathKey(x)))) return false
    for (const guard of [h, join(h, '.claude'), resolve(root), join(resolve(root), 'agents'), projectDir ? resolve(String(projectDir)) : null]) {
      if (guard && underKey(pathKey(guard), key)) return false // equals or contains it
    }
    if (underKey(key, pathKey(join(h, '.claude', 'plugins')))) return false // covered by that entry
    return true
  }
  const out = []
  const seen = new Set()
  for (const p of raw) {
    const e = expandHome(String(p).trim())
    if (!e.startsWith('/')) continue
    const abs = resolve(e).replace(/\/+$/, '') || '/'
    if (seen.has(abs) || !keep(abs)) continue
    seen.add(abs)
    out.push({ rel: abs.split('/').filter(Boolean).slice(-2).join('/'), abs, dir: true, dyn: true })
    if (out.length >= DYN_CAP) break
  }
  return out
}

// The workers' start-up files of a renamed install (WORKERCFGDIR1104): their home is ~/.<MAIN_AGENT_ID>-worker{,-fast}
// (agent-worker.ts workerHomeFor), with MAIN_AGENT_ID read from the install like the other settings here (overrides,
// then .env; both files' mtimes are in the cache key). Only a plain id (letters, digits, _ and -) is used; the default
// id adds nothing (the static entries cover it). A MARVEEN_WORKER_DIR{,_FAST} set only in the dashboard's process
// environment is not visible to a hook (stated limit).
const WORKER_ID_RX = /^[A-Za-z0-9_-]{1,64}$/
export function workerConfigEntries(root) {
  const id = installSetting(root, 'MAIN_AGENT_ID')
  if (!id || !WORKER_ID_RX.test(id) || id === 'marveen') return []
  return ['', '-fast'].flatMap((v) => workerHomeTargets(`.${id}-worker${v}`))
    .map((t) => ({ rel: t.home, abs: join(homedir(), t.home), ...(t.dir ? { dir: true } : {}), ...(t.noBareGlob ? { noBareGlob: true } : {}) }))
}

const targetCache = new Map()
export function installTargets(root = INSTALL_ROOT, subAgent = false, projectDir = null, configDir = null) {
  const k = resolve(root)
  const dyn = subAgent ? dynamicSources(k) : null
  const ck = `${subAgent ? 'sub' : 'all'}\u0000${k}\u0000${subAgent && projectDir ? resolve(String(projectDir)) : ''}\u0000${subAgent && configDir ? resolve(String(configDir)) : ''}\u0000${dyn ? dyn.sig : ''}\u0000${subAgent ? homedir() : ''}`
  if (!targetCache.has(ck)) {
    const entries = subAgent ? [...PROTECTED_INSTALL_PATHS, ...SUBAGENT_PROTECTED_INSTALL_PATHS, ...callerSettingsEntries(projectDir, configDir), ...workerConfigEntries(k), ...dynamicPluginEntries(k, projectDir, dyn), ...rootAncestorInstructionEntries(k)] : PROTECTED_INSTALL_PATHS
    const ownKey = subAgent ? callerAgentDirKey(k, projectDir) : null
    targetCache.set(ck, {
      rootKey: pathKey(k),
      list: entries.map((t) => {
        const abs = t.abs ? t.abs : t.home == null ? resolve(k, t.rel)
          : t.xdg ? resolve(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), t.home) : resolve(homedir(), t.home)
        const key = pathKey(abs)
        // the lexical and the real spelling, segment by segment, for glob words
        const segs = [normalizePathSegments(abs), normalizePathSegments(key[0])]
        return { ...t, abs, key, segs, ...(t.notCaller && ownKey ? { exceptKey: ownKey } : {}) }
      }),
    })
  }
  return targetCache.get(ck)
}

// Which words are resolved at all: anything path-like (a slash, a dotted name,
// a ~), since a symlink under any name can lead into a target (Dani 56096), and
// any word that names a target segment, a glob or an expansion. Inside a
// protected directory every relative word is a candidate.
const PATH_LIKE_RX = /\/|\.\w|^~/
export const TARGET_SEGMENT_NAMES = new Set(['settings.json', 'settings.local.json', 'hooks', 'self-pace-gate.mjs',
  'extra-hooks.json', 'autonomy-config.json', 'agent-sender-role-gates.json', 'config-overrides.json', '.owner-slack-target', '.net-target-hosts.json', 'custom-providers.json', 'context-guard.json', '.claude', 'scripts', 'store', '.', '..', '~',
  '.env', 'provenance-gate-rules.json', 'outgoing-copy-gate-rules.json', 'credential-gate.json', 'egress-measure-hosts.json', '.fleet-memgate-observe',
  // GATEFILES1110: an agent's agent-config.json, from its parent (`cd agents/samu && sed -i ... agent-config.json`)
  'agent-config.json',
  // PLUGINCODEWRITE1104 (E3): a bare plugin-tree name from its parent (`cd ~/.claude && rm -rf plugins`)
  'plugins', 'marveen-local-plugins', 'gromzo',
  // CPDESTDIR1104 (Dani B2, Samu 69132): the same for the start-loaded trees a session reads (`cd ~/.claude && rm -rf
  // skills` named no path-like word and passed)
  'rules', 'skills', 'agents', 'commands', 'output-styles',
  // CHANSTATEWRITE1104: the channel state dirs' trust directories, from their parent
  'progress', 'approved',
  // SUBPLANTOKEN1110 (Dani 75621): the token-plan launch status dir, from its parent (`cd store && rm -rf plan-token-launch`)
  'plan-token-launch'])
const GLOB_CHAR_RX = /[*?[{]/
// A shell glob does not match a leading-dot name unless its own segment starts with a dot (bash without dotglob,
// zsh without GLOB_DOTS). Without this, a bare `*` in a sub-agent's own directory matched its .mcp.json
// (ENVRELAXMCPCFG1104) and every non-reader command with one was denied: `sqlite3 db "SELECT count(*) ..."`
// (worker-gates.test.ts). Fail closed: a command that names any shell setting that lets a glob match leading-dot
// names, or a zsh glob qualifier on any pattern, keeps the old, strict reading. Option names are read the way the
// shells read them (underscores and case ignored). A false hit only brings back the strict reading.
// Stated limit: such a setting switched on in the user's shell rc is not visible here.
// Only the Bash path sets shellGlob; a file tool's path or an MCP argument is never read this way.
// GATEQUOTEDSQL1104: the zsh qualifier test reads only the UNQUOTED text, case-sensitively. The old
// `/\([^)\s]*D[^)\s]*\)/i` over the whole command fired on ANY "(...d...)" without a space: a quoted
// `left(t.id::text,8)` or a Python `open(p,encoding='utf-8')` turned the strict reading on, and the `*` of a quoted
// `select *` / `count(*)` in the same command then reached the caller's own .mcp.json, so a read-only query was denied
// (measured on 11-04 replays). zsh's dot qualifier is an upper-case D, and a quoted "(...D...)" is never a qualifier.
// Every unquoted parenthesis group with an upper-case D still counts, glob character or not (a narrower shape lost
// `(*|x)(D)`, `(*)(D)` and `{*,' '}(D)`, which zsh expands to the .mcp.json; Bence 69254). The option names keep the
// shells' case and underscore rules and are read over the whole command.
// The quoted spans are taken out only where that reading is the shell's own; otherwise the whole command is read (fail
// closed): a command that re-runs text as shell code (`zsh -c '... *(D)'`), a "..." span holding a command
// substitution (it runs, its globs expand, its own quotes end the scan early: `"$(cp x "y" *(D))"`), and a command
// whose quoting a plain scan may pair wrongly: a heredoc body
// or a comment (an apostrophe there is literal), arithmetic (`$((1<<x))` is not a heredoc), an unterminated quote.
const DOTGLOB_OPTION_RX = /dotglob|globdots|globignore|fignore/i
const ZSH_DOT_QUALIFIER_RX = /\([^)\s]*D[^)\s]*\)/
export function unquotedForQualifier(cmd) {
  const s = String(cmd ?? '')
  if (/(?:^|[\s;&|()])#/.test(s) || /(?<!<)<<(?!<)/.test(s) || /\(\(|\$\[/.test(s)) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { out += s.slice(i, i + 2); i++; continue }
    if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      let j = c === '$' ? i + 2 : i + 1
      while (j < s.length && s[j] !== "'") j += c === '$' && s[j] === '\\' ? 2 : 1
      if (j >= s.length) return s
      out += 'Q'
      i = j
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
      if (j >= s.length) return s
      // a command substitution inside "..." runs, and its own quotes end this scan early: read the whole command
      if (/\$\(|`/.test(s.slice(i, j + 1))) return s
      out += 'Q'
      i = j
      continue
    }
    out += c
  }
  return out
}
const namesDotglob = (cmd, reShell) => DOTGLOB_OPTION_RX.test(cmd.replace(/_/g, ''))
  || ZSH_DOT_QUALIFIER_RX.test(reShell ? cmd : unquotedForQualifier(cmd))

// Does a shell segment hold an UNQUOTED bare-glob word (`*`, `?`, `./*`)? The text outside '...' and "..." spans (a
// backslash inside double quotes escapes the next character) is split into words; backslashes outside quotes are
// dropped first, so an escaped `\*` counts as a bare glob (fail closed). An unterminated quote: the whole text is read.
export function unquotedBareGlob(text) {
  const src = String(text ?? '')
  let out = ''
  let q = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q === "'") { if (c === "'") q = null; continue }
    if (q === '"') { if (c === '\\') { i++; continue } if (c === '"') q = null; continue }
    if (c === "'" || c === '"') { q = c; out += ' '; continue }
    out += c
  }
  const plain = (q === null ? out : src).replace(/\\/g, '')
  return plain.split(/[\s;&|<>()`=,{}]+/).some((w) => /^(?:\.\/)*[*?]+$/.test(w))
}

// Does a shell segment name a program that runs (part of) its text as shell code again, so that a quoted glob gets
// expanded after all? Shells and eval/source, script interpreters, the command runners (xargs, find -exec, watch,
// script, parallel) and sqlite3's dot commands .shell/.system. A version suffix is ignored (python3.12, bash5). The
// whole command text is read (a pipe hands a quoted glob on), quoted parts included: a false hit only takes the
// noBareGlob skip away (fail closed).
// (env and exec run a program, never a string through a shell: `env bash -c` is caught by its bash.)
export const RESHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox',
  'eval', 'source', 'python', 'pypy', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'tclsh',
  'osascript', 'awk', 'gawk', 'mawk', 'nawk', 'xargs', 'find', 'watch', 'script', 'parallel', 'make'])
// INSTRFILES1104 A (Samu 69747 (a), Bence 69765): the python and node families run their own language, not shell code:
// a quoted glob handed to them, their inline code (-c, -e/-p) and a heredoc body they read are data, and no shell
// expands a glob in them. They count as re-shelling when the command shows a call that hands text to a shell
// (os.system, subprocess, child_process, execSync, shell=True, ...), a hidden call, or ANY reference to a module that can
// start a process (the reverse rule, Dani 69850): then the strict reading stays (Dani's review of 7ae2931af:
// `python3 -c "import os; os.system('tee *')"` is a glob after all). The other interpreters (perl, ruby, php, lua,
// awk, ...) keep the strict reading whatever their code says (fail closed).
// INSTRFILES1104 A, closing decision (Samu 69992/69997/70023, Dani 70000): the deny list of call shapes below was
// bypassed round after round, so the python decision is a CLOSED ALLOWLIST, made by scripts/hooks/py-inline-data.py
// with the real python ast: every python invocation must show its code (-c, a heredoc), and that code may import only
// measured modules, reach only measured module attributes, name only allowed builtins, no private name, no frame or
// code attribute, no dunder but __name__/__main__/__file__/__tests__, no format_map, .format only on a literal, and no
// pattern-expanding or directory-walking API. Anything it cannot show or parse is strict. The node family gets no data
// exception (computed member access and .constructor cannot be closed cheaply). The regexes below stay as a first,
// cheaper layer: any hit is strict without starting python.
const PY_FAMILY = new Set(['python', 'pypy'])
const NODE_FAMILY = new Set(['node', 'nodejs', 'deno', 'bun'])
const PY_DATA_CHECK = join(dirname(fileURLToPath(import.meta.url)), 'py-inline-data.py')
// /usr/bin/python3: a path the same OS user cannot plant a stand-in at (a PATH lookup could find one). -I -S: no user
// site, no environment, no site-packages start-up code.
const PY_DATA_PYTHON = '/usr/bin/python3'
// "data", or "strict <reason>"; no interpreter, a timeout or a crash is strict too (the develop reading).
export function pythonDataVerdict(command) {
  if (!existsSync(PY_DATA_PYTHON)) return 'strict no-python'
  const r = spawnSync(PY_DATA_PYTHON, ['-I', '-S', PY_DATA_CHECK], { input: String(command ?? ''), encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 16 })
  const out = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : ''
  return out === 'data' || out.startsWith('strict ') ? out : `strict checker-${r.error ? 'error' : `exit-${r.status}`}`
}
const SHELL_CALL_RX = /\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b|\bsubprocess\b|\bpty\s*\.\s*spawn\b|\bcommands\s*\.|\bplatform\s*\.\s*popen\b|\bchild_process\b|\b(?:execSync|execFileSync|spawnSync|execFile|execa)\b|\b(?:exec|spawn|fork)\s*\(|\bshell\s*=\s*True\b|\bshell\s*:\s*true\b|\bDeno\s*\.\s*(?:run|Command)\b|\bBun\s*\.\s*(?:spawn|spawnSync|\$)|\$`|\bzx\b/
// ...and the signs of a HIDDEN call (Samu 69768, Dani 69775): a name built at run time can reach a shell without any of
// the words above, so these count as a shell call too (fail closed): __import__, importlib, builtins, ctypes, the
// builtins getattr/vars/globals/locals, and eval/exec/compile wherever the name stands (Samu 69948: always a sign,
// except before a space or tab and a word starting with a letter, the `exec python3 ...` of shell text, or inside a
// longer identifier; an attribute counts too, `x.eval`, `x.exec` (Dani 69959: `global.eval`, `print.__self__.eval`),
// except `.compile`: `re.compile(` is the measured data shape, and running compiled code needs eval/exec anyway),
// new Function / vm.run*, process.binding/dlopen, and a require() or import() whose argument is no string literal.
// Dani's review of e53c1080 (69850): a list of call shapes leaks (`from os import system; system(...)`, `vars(os)[...]`,
// `os.__dict__[...]`, `__builtins__.getattr(...)`). So the rule is the other way round: the code is data only when it
// refers to NO module that can start a process and to NO reflection handle. Any such reference keeps the strict
// reading, whatever is done with it (PROCESS_REF_RX below, and the reflection handles in HIDDEN_CALL_RX).
// Any token, an attribute included (`shutil.os.system`, `asyncio.subprocess`): os, posix, subprocess, pty,
// multiprocessing, asyncio, _posixsubprocess, child_process, sys.modules, and the loaders that run code they are handed
// (pickle, marshal, shelve, runpy) or start a program (webbrowser). Modules whose names are everyday words (platform,
// commands, code, pdb) count when they are imported, the only way to reach them without a handle caught above.
const PROCESS_REF_RX = /\b_?(?:os|posix|subprocess|pty|multiprocessing|asyncio|_posixsubprocess|pickle|marshal|shelve|runpy|webbrowser)\b|\bchild_process\b|\bsys\s*\.\s*modules\b|\bfrom\s+(?:platform|commands|code|pdb)\b|\bimport\s+(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)*(?<![.\w])(?:platform|commands|code|pdb)(?!\w)/
const HIDDEN_CALL_RX = /__import__|\bimportlib\b|__builtins__|\bbuiltins\b|\bctypes\b|(?<![.\w$])(?:getattr|vars|globals|locals)\b|(?<![\w$-])(?:eval|exec)(?![\w$])(?![ \t]+[A-Za-z])|(?<![.\w$-])compile(?![\w$])(?![ \t]+[A-Za-z])|__dict__|__globals__|__subclasses__|__bases__|__mro__|__getattribute__|\bglobalThis\b|__code__|__closure__|__func__|\b(?:FunctionType|CodeType|LambdaType|MethodType)\b|\bfrom\s+types\b|\bimport\s+(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)*(?<![.\w])types(?!\w)|\bnew\s+Function\b|(?<![.\w$])Function\s*\(|\bvm\s*\.\s*run\w*|\brunIn(?:This|New)?Context\b|\bcompileFunction\b|['"`](?:node:)?vm['"`]|\bprocess\s*\.\s*(?:binding|dlopen)\b|\brequire\s*\(\s*(?!(?:'[^'$]*'|"[^"$]*"|`[^`$]*`)\s*\))|(?<![.\w$])import\s*\(\s*(?!(?:'[^'$]*'|"[^"$]*"|`[^`$]*`)\s*\))/
export function reShellsText(text) {
  const src = String(text ?? '')
  if (/(?:^|[;&|(]\s*)\.\s/.test(src) || /\.(?:shell|system)\b/i.test(src)) return true
  const shellCall = SHELL_CALL_RX.test(src) || HIDDEN_CALL_RX.test(src) || PROCESS_REF_RX.test(src)
  let pyData
  return src.split(/[\s;&|<>()`'"=,{}$]+/).some((w) => {
    if (/^-(?:exec|execdir|ok|okdir)$/i.test(w)) return true
    const name = (w.split('/').pop() ?? '').toLowerCase().replace(/[\d.]+$/, '')
    if (NODE_FAMILY.has(name)) return true
    if (PY_FAMILY.has(name)) {
      if (shellCall) return true
      pyData ??= pythonDataVerdict(src) === 'data'
      return !pyData
    }
    return RESHELL_NAMES.has(name)
  })
}

// GATESCRIPTARG1111 (Samu 75780 A, Boni 75773): `python3 x.py "select count(*) ..."` is a SCRIPT FILE run with a quoted
// argument. The shell never expands a glob in quotes, and the script's own code is not seen by this gate (the stated limit:
// a script can write any path itself, it needs no glob for it), so the quoted argument's glob characters are data, as
// they are for sqlite3. Such a segment is left out of the re-shell reading; the rest of the command is read as before.
// Narrow on purpose: only python (any version) and node by their bare or system-dir name, only the harmless python flags
// before the script, a script word that is a plain name (no `-`, no glob, no `$`), no `$` in any word (an unquoted
// expansion is split and globbed by the shell), and no heredoc body. Inline code (-c, -e, -p, --eval, -m, stdin `-`),
// bun/deno (their `run` goes to package scripts) and the shell family stay strict; an UNQUOTED glob still counts
// (unquotedBareGlob), since the shell expands it before the script starts.
const SCRIPT_PY_RX = /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)$/
const SCRIPT_NODE_RX = /^(?:node|nodejs)$/
const PY_SCRIPT_FLAGS = new Set(['-I', '-S', '-B', '-u', '-E', '-s', '-O', '-OO', '-q'])
export function scriptFileRun(words) {
  if (!words || !words.length || words.some((w) => w.dollar || String(w.value).includes('$'))) return false
  const name = commandName(words)
  const py = SCRIPT_PY_RX.test(name)
  if (!py && !SCRIPT_NODE_RX.test(name)) return false
  let i = 1
  for (; i < words.length && String(words[i].value).startsWith('-'); i++) {
    if (!py || !PY_SCRIPT_FLAGS.has(words[i].value)) return false
  }
  const script = i < words.length ? String(words[i].value) : ''
  return script !== '' && !/[*?[{]/.test(script)
}
// The command text the re-shell reading sees: every segment but the script-file runs above (unsplittable: the whole text).
export function reShellText(cmd, root = INSTALL_ROOT) {
  const segs = shellSegments(cmd, { surface: 'security', projectRoot: root })
  if (!segs) return cmd
  const kept = segs.filter((seg) => (seg.bodies?.length ?? 0) > 0 || !scriptFileRun(shellWords(seg.own)))
  if (kept.length === segs.length) return cmd
  return kept.map((seg) => [seg.own, ...(seg.bodies ?? [])].join('\n')).join('\n')
}

// INSTRFILES1104 A: the text a glob reading sees when no program in the command re-runs text as shell code
// (reShellsText false). The shell never expands a glob inside quotes, nor in a heredoc body (a body is data for the
// program it feeds), so their glob characters are literal: they are replaced by `_`, and the word is then read as the
// literal name it is. Fail closed, the text is returned unchanged: an unterminated quote, a "..." span or a body holding
// a command substitution or a backtick (it runs, and its globs expand). A word of glob characters only (`*`, `./*`) is
// left as it is: whether a quoted one may skip a noBareGlob entry stays the #2514 rule (bareGlobQuoted, the caller's
// own project dir only); this literal reading is for the other glob words (`/**`, `*/`, `x[0]`) of quoted code and data.
const GLOB_CHARS_G = /[*?[{]/g
const literalWords = (span) => span.replace(/[^\s;&|<>()'"`=,:{}]+/g, (tok) => (/^(?:\.\/)*[*?]+$/.test(tok) ? tok : tok.replace(GLOB_CHARS_G, '_')))
export function literalQuotedGlobs(text) {
  const s = String(text ?? '')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { out += s.slice(i, i + 2); i++; continue }
    if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      let j = c === '$' ? i + 2 : i + 1
      while (j < s.length && s[j] !== "'") j += c === '$' && s[j] === '\\' ? 2 : 1
      if (j >= s.length) return s
      out += literalWords(s.slice(i, j + 1))
      i = j
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
      if (j >= s.length) return s
      const span = s.slice(i, j + 1)
      if (/\$\(|`/.test(span)) return s
      out += literalWords(span)
      i = j
      continue
    }
    out += c
  }
  return out
}
export function literalHeredocBody(body) {
  const b = String(body ?? '')
  return /\$\(|`/.test(b) ? b : literalWords(b)
}

// A pattern entry against a resolved path key (CPDESTDIR1104, Dani B1): 'exact' when every segment matches (`*`
// matches one non-empty segment), 'under' when the entry is a directory and the key lies below a match, 'ancestor'
// when the key is a strict prefix of the pattern (a directory on the way to a match), else null. Every nameForms()
// form of the key is read against the same form of the pattern (the real path, its case folds).
export function patternRel(key, t) {
  if (ownedByCaller(t, key)) return null
  let best = null
  for (let i = 0; i < key.length; i++) {
    const K = normalizePathSegments(key[i])
    const T = normalizePathSegments(t.key[i] ?? t.key[0])
    const n = Math.min(K.length, T.length)
    let ok = true
    // `*` alone: any one non-empty segment; a segment with a glob character (CHANSTATEWRITE1104): matched as a glob
    for (let x = 0; x < n && ok; x++) ok = T[x] === '*' ? K[x] !== '' : GLOB_CHAR_RX.test(T[x]) ? K[x] !== '' && globMatchesName(T[x], K[x]) : T[x] === K[x]
    if (!ok) continue
    if (K.length === T.length) return 'exact'
    if (K.length > T.length) { if (t.dir) return 'under'; continue }
    best = 'ancestor'
  }
  return best
}
function patternExact(key, t) { return patternRel(key, t) === 'exact' }
function cpOnlyReadsProtected(words, ctx) {
  const vals = words.slice(1).map((w) => w.value)
  const operands = []
  let opts = true
  for (const v of vals) {
    if (opts && v === '--') { opts = false; continue }
    if (opts && v.startsWith('-')) {
      if (/^-[A-Za-z]*[lst]/.test(v) || /^--(?:link|symbolic-link|target-directory)/.test(v)) return false
      continue
    }
    operands.push(v)
  }
  if (operands.length < 2) return false
  const dest = operands[operands.length - 1]
  const d = classifyWord(dest, ctx)
  if (d == null) return true
  if (d !== 'ancestor') return false
  // a destination ABOVE a protected path (`cp x .` in one's own agent dir): each copy's own landing place must be free
  // (`cp ~/.claude/settings.json .claude/` would land on the agent's own settings)
  const destAbs = dest.startsWith('/') ? dest : resolve(ctx.cwd ?? process.cwd(), expandHome(dest))
  return operands.slice(0, -1).every((src) => classifyWord(join(destAbs, basename(src.replace(/\/+$/, ''))), ctx) == null)
}

// Strictly below $HOME ($HOME itself is not: `rsync x/ ~/` and `cd ~ && tar -xf` stay a stated limit, Samu 68214 D3).
function belowHome(key) {
  const hk = pathKey(homedir())
  return underKey(key, hk) && !sameKey(key, hk)
}
const UNRESOLVED_RX = /\$\{[^}]*\}|\$\(|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]|[`\u0000\u0003]/

// Every path-like word of a text: split on shell and code punctuation, in every
// spelling scheduleSurfaceVariants reads (quotes removed, escapes decoded, string
// concatenation glued). Once with , and {} as separators (code: open('x','w')),
// once without (a brace-expansion word stays whole).
function expandCallerVars(text, ctx = {}) {
  let src = String(text)
  if (ctx.configDir) src = src.replace(/\$\{CLAUDE_CONFIG_DIR\}|\$CLAUDE_CONFIG_DIR(?!\w)/g, String(ctx.configDir))
  if (ctx.projectDir) src = src.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR(?!\w)/g, String(ctx.projectDir))
  return src
}
function pathWords(text, ctx = {}) {
  const out = new Set()
  // PLUGINCODEWRITE1104 (E4): the caller's own CLAUDE_CONFIG_DIR / CLAUDE_PROJECT_DIR are known (the hook's opts), so
  // `$CLAUDE_CONFIG_DIR/settings.json` is read as that path, not as an unresolved word (it passed before: #2494's gap)
  const src = expandCallerVars(String(text ?? '').replace(/\$\{HOME\}|\$HOME(?!\w)/g, homedir()), ctx)
  for (const v of scheduleSurfaceVariants(src)) {
    for (const t of v.split(/[\s;&|<>()'"`=,:{}]+/)) if (t) out.add(t)
    for (const t of v.split(/[\s;&|<>()'"`=]+/)) if (t) out.add(t)
  }
  return [...out]
}

// WRITEGATERELPATH1115: is the current directory one that HOLDS a protected path (an ancestor of one, or inside a
// protected directory)? From there a relative word can name the path without any path-like spelling (a bare name).
// Cached per target list and directory.
const holdsCache = new WeakMap()
function cwdHoldsTarget(ctx) {
  if (!ctx.cwd) return false
  const { list } = installTargets(ctx.root, ctx.subAgent === true, ctx.projectDir, ctx.configDir)
  let byCwd = holdsCache.get(list)
  if (!byCwd) holdsCache.set(list, (byCwd = new Map()))
  const cwd = resolve(String(ctx.cwd))
  if (!byCwd.has(cwd)) {
    const key = pathKey(cwd)
    byCwd.set(cwd, list.some((t) => (t.pattern ? ['ancestor', 'exact', 'under'].includes(patternRel(key, t)) : underKey(t.key, key) || (t.dir && underKey(key, t.key)))))
  }
  return byCwd.get(cwd)
}

// WRITEGATERELPATH1115: a relative word after a change to an unknown directory. It may be read from any directory, so it
// is compared with every protected path's TAIL: the word's segments as the last segments of the path ('unresolved', read
// as the path itself), as a run of its segments (an 'ancestor'), or a protected directory's tail followed by more ('under').
function lostCwdRel(word, list) {
  const W = normalizePathSegments('/' + word).filter((x) => x !== '' && x !== '.')
  if (!W.length || W.includes('..')) return W.length ? 'unresolved' : null
  let best = null
  for (const t of list) {
    if (t.pattern) continue
    const T = normalizePathSegments(t.abs).filter((x) => x !== '')
    for (let start = 0; start < T.length; start++) {
      const n = Math.min(W.length, T.length - start)
      let ok = true
      for (let i = 0; i < n && ok; i++) ok = nameForms(W[i]).some((f) => f.toLowerCase() === T[start + i].toLowerCase())
      if (!ok) continue
      if (start + W.length === T.length) return 'unresolved'
      if (start + W.length > T.length) { if (t.dir) return 'under'; continue }
      best = 'ancestor'
    }
  }
  return best
}

function isCandidate(word, ctx) {
  if (GLOB_CHAR_RX.test(word) || UNRESOLVED_RX.test(word)) return true
  if (ctx.cwdLost && !word.startsWith('/') && !word.startsWith('~')) return true
  if (ctx.cwdInsideDir && !word.startsWith('/') && !word.startsWith('~')) return true
  if (!word.startsWith('/') && !word.startsWith('~') && cwdHoldsTarget(ctx)) return true
  if (PATH_LIKE_RX.test(word)) return true
  const root = basename(ctx.root).toLowerCase()
  return nameForms(word).some((f) => f.split('/').some((s) => TARGET_SEGMENT_NAMES.has(s) || s === root))
}

// Where a word lands relative to the protected paths: 'exact' (the path
// itself), 'under' (inside a protected directory), 'ancestor' (a directory at
// or below the install root that contains a protected path), or null.
// 'unresolved': an expansion this gate cannot resolve, followed by a protected
// path's tail (`$WT/.claude/settings.json`): read as that path (fail closed).
export function classifyWord(word, ctx) {
  const { list, rootKey } = installTargets(ctx.root, ctx.subAgent === true, ctx.projectDir, ctx.configDir)
  let w = expandCallerVars(String(word), ctx) // E4, here too: a redirect target reaches classifyWord directly
  if (w === '~' || w.startsWith('~/')) w = expandHome(w === '~' ? '~/' : w)
  if (UNRESOLVED_RX.test(w)) {
    const tail = ('/' + w.split(UNRESOLVED_RX).pop()).replace(/\/+/g, '/').replace(/\/$/, '')
    for (const f of nameForms(tail)) {
      for (const t of list) {
        const rel = '/' + (t.rel ?? t.home).toLowerCase()
        if (f.endsWith(rel) || (t.dir && f.includes(rel + '/'))) return 'unresolved'
      }
    }
    return null
  }
  if (GLOB_CHAR_RX.test(w)) {
    const exps = /[{}]/.test(w) ? expandBraces(w, 1024) : [w]
    if (!exps) return 'unresolved' // too many expansions to prove harmless
    let best = null
    for (const e of exps) {
      const abs = e.startsWith('/') ? e : (ctx.cwd ? resolve(ctx.cwd, e) : null)
      if (!abs) continue
      const W = normalizePathSegments(abs)
      // WORKERCFGDIR1104: a word of glob characters only (`*`, `./*`: relative by construction, an absolute or ~ word has
      // a named segment) skips a noBareGlob entry only when its segment's every bare glob was quoted (ctx.bareGlobQuoted,
      // set per segment; unset = not proven, no skip), no program in it re-runs text as shell code, and it is read from
      // the caller's OWN project dir; after a cd elsewhere (another sub-agent into a worker's home) it does not
      const bareQuoted = ctx.bareGlobQuoted === true && e.split('/').every((seg) => seg === '' || seg === '.' || /^[*?]+$/.test(seg))
      const bareRel = bareQuoted && !!ctx.cwd && !!ctx.projectDir && sameKey(pathKey(resolve(ctx.cwd)), pathKey(resolve(String(ctx.projectDir))))
      for (const t of list) {
        if (bareRel && t.noBareGlob) continue
        // INSTRSURFACE1118: a quoted bare glob that no program re-shells is the literal name `*`, wherever it is read
        // from: it names no CLAUDE.md (a cd to an ancestor of the root, `python3 -c ... '*'`, stayed free)
        if (bareQuoted && t.quotedGlobFree) continue
        if (t.exceptKey && ownedByCaller(t, nameForms(W.join('/')))) continue
        for (const T of t.segs) {
          const n = Math.min(W.length, T.length)
          let ok = true
          const dotRule = ctx.shellGlob === true && ctx.dotglob !== true
          for (let i = 0; i < n && ok; i++) {
            ok = T[i] === '*' && t.pattern ? W[i] !== ''
              : nameForms(W[i]).some((f) => globMatchesName(f, T[i]) && !(dotRule && T[i].startsWith('.') && !f.startsWith('.')))
          }
          if (!ok) continue
          if (W.length === T.length) return 'exact'
          if (W.length > T.length) { if (t.dir) return 'under'; continue }
          if (t.pattern) continue // no ancestor (see the entry)
          best = 'ancestor'
        }
      }
    }
    return best
  }
  const abs = w.startsWith('/') ? w : (ctx.cwd ? resolve(ctx.cwd, w) : null)
  if (!abs) return ctx.cwdLost ? lostCwdRel(w, list) : null
  const key = pathKey(abs)
  let best = null
  for (const t of list) {
    if (t.pattern) {
      const r = patternRel(key, t)
      if (r === 'exact' || r === 'under') return r
      continue
    }
    if (sameKey(key, t.key)) return 'exact'
    if (t.dir && underKey(key, t.key)) return 'under'
    // PLUGINCODEWRITE1104 (E2): also strictly below $HOME, so moving or extracting into ~/.claude reaches ~/.claude/plugins
    if (underKey(t.key, key) && (underKey(key, rootKey) || belowHome(key))) best = 'ancestor'
  }
  return best
}

function hitsIn(text, ctx) {
  const hits = []
  for (const w of pathWords(text, ctx)) {
    if (!isCandidate(w, ctx)) continue
    const c = classifyWord(w, ctx)
    if (c) hits.push({ word: w, kind: c })
  }
  return hits
}

// INSTRWRITEEXEC1105: true only when every later segment that names a written file either only reads it (a reader,
// chmod) or runs it as shell code: a shell with the file as its script word or its stdin, source/. of the file, or the
// file run directly with a shell shebang or none (exec falls back to sh). Anything else (another interpreter, a -c
// code word, xargs, a pipe) is not known to be shell, and at least one shell run must be seen. A shell is a bare name
// or one in a system bin directory: any other path may be another program under a shell's name (Dani, #2546). Run
// directly, the file's first line decides, so only a segment that starts the file (`>`, no earlier writer of it in the
// command) can show it; an append, or a file an earlier segment began, keeps the strict reading.
const SHELL_RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const SYSTEM_BIN = String.raw`(?:/usr(?:/local)?)?/s?bin/|/opt/homebrew/bin/`
const SYSTEM_SHELL_RX = new RegExp(`^(?:${SYSTEM_BIN})?(?:ba|z|da|k)?sh$`)
const SHELL_SHEBANG = new RegExp(String.raw`^#!\s*(?:${SYSTEM_BIN})(?:(?:ba|z|da|k)?sh|env\s+(?:-\S+\s+)*(?:ba|z|da|k)?sh)(?:\s|$)`)
const escapeRx = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A shell name the command itself redefines (a function, an alias or a hash entry named like a shell or source/.,
// a quoted alias name too, or a PATH set, exported or given as a prefix) may run another program: then no run is known to be shell (Dani #2546).
const SHELL_REDEF_RX = /(?:^|[\s;&|(])(?:function\s+(?:(?:ba|z|da|k)?sh|source|\.)(?=[\s({])|(?:(?:ba|z|da|k)?sh|source|\.)\s*\(\s*\))|\balias\s+(?:-\w+\s+)*['"]?(?:(?:ba|z|da|k)?sh|source|\.)['"]?=|\bhash\s+(?:-\w+\s+\S+\s+)*['"]?(?:(?:ba|z|da|k)?sh|source)(?![\w-])|(?:^|[\s;&|(])PATH\+?=/
function shellRunsOnly(segs, k, targets, text) {
  if (SHELL_REDEF_RX.test(segs.map((s) => s.own).join('\n'))) return false
  const startsFile = !targets.some((t) => new RegExp(`>>\\s*['"]?${escapeRx(t)}`).test(segs[k].own))
    && !segs.slice(0, k).some((s) => { const w = shellWords(s.own); return !!w && w.redirects.some((r) => targets.includes(r.value)) })
  let seen = false
  for (let j = k + 1; j < segs.length; j++) {
    const s = segs[j]
    if (!targets.some((t) => [s.own, ...s.bodies].join('\n').includes(t))) continue
    const all = shellWords(s.own)
    if (!all || !all.length) return false
    // leading assignments (`CARD=x sh F`) are the run's environment, not its command (a PATH among them is caught above)
    let a0 = 0
    while (a0 < all.length && /^[A-Za-z_]\w*=/.test(all[a0].value)) a0++
    const words = all.slice(a0)
    if (!words.length) return false
    const first = words[0].value
    const name = commandName(words) || first.slice(first.lastIndexOf('/') + 1)
    if (targets.includes(first)) {
      if (!startsFile) return false
      const line = text.split('\n', 1)[0]
      if (line.startsWith('#!') && !SHELL_SHEBANG.test(line)) return false
      seen = true
      continue
    }
    if (name === 'chmod' || (READERS.has(name) && !PRINTERS.has(name) && !s.bodies.length)) continue
    // F3: handed to a wrapper written here that runs it with a shell: a shell run of the file
    if (startsFile && wrapperShellRunsTarget(segs, j, words.map((w) => w.value), targets)) { seen = true; continue }
    if (SHELL_RUNNERS.has(name) || name === 'source' || name === '.') {
      const runner = words.find((w) => w.value === name || w.value.endsWith('/' + name))
      if (!runner || (runner.value !== name && !SYSTEM_SHELL_RX.test(runner.value))) return false
      const script = words.slice(words.indexOf(runner) + 1).find((w) => !w.value.startsWith('-'))
      const stdin = targets.some((t) => new RegExp(`(?:^|[^<])<\\s*['"]?${escapeRx(t)}`).test(s.own))
      if (words.slice(1).some((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.value))) return false
      // F5: the script word after a shell option's argument (sh -o errexit FILE) is a shell run of FILE too, as laterRuns
      // now reads it
      const sw = shellScriptWord(name, words.slice(words.indexOf(runner) + 1).map((w) => w.value))
      if ((script && targets.includes(script.value)) || (sw !== null && targets.includes(sw)) || stdin) { seen = true; continue }
      return false
    }
    return false
  }
  return seen
}

// GATEOPENFORMS1118 (Dani, #2883 review): run forms of a file this command writes that laterRuns alone does not see.
// The file is run
//   (a) through a copy under another name: cp/mv/ln/install/rsync/ditto with the file as a source, or a text tool
//       (cat, sed, tee, dd, ...) that read it and wrote it on (`cat f > g`, `cat f | tee g`); the new names join the
//       file's names;
//   (b) behind a wrapper (nice, nohup, timeout, stdbuf, time, command, builtin, exec, setsid, sudo, ionice, caffeinate,
//       env), leading assignments or a compound command's reserved word (do, then, else, {, !): the command after them
//       is read as the segment's command;
//   (c) by a start-up variable that names it (BASH_ENV, ENV, ...: as a prefix, through env or exported);
//   (d) as the program file of an option (awk/sed -f, make -f, vim -S, ...) or as make's default makefile;
//   (e) as the output of a command substitution in code position (eval "$(cat f)", sh -c "$(cat f)", the command word).
// A wrapper's directory change (env --chdir/-C, sudo -D) is a later directory the file may run in (laterCwds).
// Still the stated limit: a run in a LATER Bash call, and a program that reads its code from a file it finds itself.
// The tables keyed by a command name have no prototype: a command named toString or constructor finds no entry.
const RUN_WRAPPERS = {
  __proto__: null,
  nice: ['-n', '--adjustment'], nohup: [], time: ['-f', '--format', '-o', '--output'], command: [], builtin: [],
  exec: ['-a'], setsid: [], stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  timeout: ['-s', '--signal', '-k', '--kill-after'], gtimeout: ['-s', '--signal', '-k', '--kill-after'],
  sudo: ['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt',
    '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'],
  ionice: ['-c', '--class', '-n', '--classdata'], caffeinate: ['-t', '-w'],
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
}
const WRAPPER_CHDIR = { __proto__: null, env: ['-C', '--chdir'], sudo: ['-D', '--chdir'] }
const RESERVED_RUN_LEAD = new Set(['do', 'then', 'else', '{', '!'])
// A variable whose value a program reads code from at start-up (a file, or code naming one).
const STARTUP_VARS = new Set(['BASH_ENV', 'ENV', 'ZDOTDIR', 'PROMPT_COMMAND', 'NODE_OPTIONS', 'PERL5OPT', 'RUBYOPT',
  'PYTHONSTARTUP', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'])
const DECLARERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly'])
const wordName = (w) => commandName([w]) || w.value.slice(w.value.lastIndexOf('/') + 1)
export function unwrapRun(words) {
  let i = 0
  const assigns = []
  const chdirs = []
  const splits = []
  let wrapped = false
  for (;;) {
    while (i < words.length && ASSIGN_RX.test(words[i].value)) {
      const v = words[i].value
      assigns.push({ name: v.slice(0, v.indexOf('=')), value: v.slice(v.indexOf('=') + 1) })
      i++
    }
    if (i >= words.length) break
    // a compound command's leading reserved word (`do sh f`, `then sh f`, `{ sh f`, `! sh f`) starts no program
    if (RESERVED_RUN_LEAD.has(words[i].value)) { wrapped = true; i++; continue }
    const name = wordName(words[i])
    const opts = RUN_WRAPPERS[name]
    if (!opts) break
    wrapped = true
    i++
    while (i < words.length) {
      const v = words[i].value
      if (v === '--') { i++; break }
      if (!v.startsWith('-') || v === '-') break
      const eq = v.indexOf('=')
      const long = v.startsWith('--')
      const flag = long && eq > 0 ? v.slice(0, eq) : !long && v.length > 2 && opts.includes(v.slice(0, 2)) ? v.slice(0, 2) : v
      let arg = null
      if (long && eq > 0) arg = v.slice(eq + 1)
      else if (flag !== v) arg = v.slice(2)
      else if (opts.includes(v)) { arg = words[i + 1]?.value ?? ''; i++ }
      if (arg !== null && WRAPPER_CHDIR[name]?.includes(flag)) chdirs.push(arg)
      if (arg !== null && name === 'env' && (flag === '-S' || flag === '--split-string')) splits.push(arg)
      i++
    }
    // timeout's DURATION
    if ((name === 'timeout' || name === 'gtimeout') && i < words.length) i++
  }
  return { rest: words.slice(i), assigns, chdirs, splits, wrapped }
}
const segCommand = (rest) => (rest.length ? wordName(rest[0]) : '')
const namesAny = (text, names) => names.some((t) => text.includes(t))
const COPY_PROGRAMS = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'ditto', 'gcp', 'gmv', 'gln', 'ginstall'])
// Tools that pass a file's text on as it is (or as a slice of it). A program that builds new text from it (an interpreter,
// jq, printf with the name in its format) is the stated limit (a string assembled at run time), not a copy.
const TEXT_PASS = new Set(['cat', 'tac', 'head', 'tail', 'tee', 'dd', 'sed', 'gsed', 'awk', 'gawk', 'mawk', 'nawk', 'tr',
  'sort', 'uniq', 'cut', 'paste', 'fold', 'expand', 'unexpand', 'iconv'])
// (a) the file's names, grown by every copy a later segment makes of it (to a fixpoint)
// GATEPATHNORM1118 (a): beyond the text tools, ANY program that is fed the file (an operand, its stdin, a carrying pipe,
// or a command substitution that reads it, [subs]) and writes a redirect makes a copy, and passes the text on down a
// pipe; tar extracting a carried archive into a directory writes the file's last part there; split writes its pieces
// under its prefix; a copier's brace source is expanded, and a glob source that matches the file is the file.
// A segment the shell-word parser cannot read (a brace pattern, find's `{} \;`) is read loosely, by whitespace, so the
// file reaches the rules above instead of the segment being skipped. Loose words only add matches.
function looseWords(own) {
  const toks = String(own).trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^['"]|['"]$/g, '').replace(/\\$/, ''))
  const words = []
  const redirects = []
  for (let i = 0; i < toks.length; i++) {
    const m = /^(\d?)(>>?|<)(.*)$/.exec(toks[i])
    if (m) { const target = m[3] || toks[++i]; if (m[2] !== '<' && target) redirects.push({ value: target }); continue }
    words.push({ value: toks[i] })
  }
  return Object.assign(words, { redirects })
}
const wordsOf = (own) => shellWords(own) ?? looseWords(own)
const SPLIT_SUFFIXES = [...'abcdefghijklmnopqrstuvwxyz'].map((c) => `a${c}`).concat([...'0123456789'].map((d) => `0${d}`))
export function copiedNames(segs, k, targets, subs = []) {
  const names = [...targets]
  const add = (v) => { if (v && v !== '/dev/null' && !names.includes(v)) { names.push(v); return true } return false }
  const stdinOf = (own) => names.some((t) => new RegExp(`(?:^|[^<])<\\s*['"]?${escapeRx(t)}(?:['"\\s;|&)]|$)`).test(own))
  const isTheFile = (src) => names.includes(src) || (GLOB_CHAR_RX.test(src) && !src.includes('{')
    && names.some((t) => dirname(t) === dirname(src) && globMatchesName(basename(src), basename(t))))
  for (let grew = true; grew;) {
    grew = false
    // carries[j]: segment j passes the file's text on unchanged (a text tool or copier that read it, as an operand, on
    // its stdin, or from a carrying segment piped into it)
    const carries = []
    for (let j = k + 1; j < segs.length; j++) {
      const s = segs[j]
      const all = wordsOf(s.own)
      if (!all || !all.length) continue
      const { rest } = unwrapRun(all)
      const prog = segCommand(rest)
      const vals = rest.slice(1).map((w) => w.value)
      // a copier's brace word (cp /tmp/{f,g}): when one of its expansions is the file, every expansion is a name of it
      // (the expansion order is not relied on)
      if (COPY_PROGRAMS.has(prog)) {
        for (const v of vals) {
          if (!v.includes('{')) continue
          const parts = expandBraces(v, 16) ?? []
          if (parts.some((p) => names.includes(p))) for (const p of parts) if (add(p)) grew = true
        }
      }
      const piped = j > k + 1 && (segs[j - 1].sep === '|' || segs[j - 1].sep === '|&') && carries[j - 1] === true
      if (TEXT_PASS.has(prog)) {
        const fed = piped || stdinOf(s.own) || vals.some((v) => names.includes(v) || (v.startsWith('if=') && names.includes(v.slice(3))))
        if (!fed) continue
        carries[j] = true
        for (const r of all.redirects) if (add(r.value)) grew = true
        if (prog === 'tee') for (const v of vals) if (!v.startsWith('-') && add(v)) grew = true
        if (prog === 'dd') for (const v of vals) if (v.startsWith('of=') && add(v.slice(3))) grew = true
        continue
      }
      if (!COPY_PROGRAMS.has(prog)) {
        // an interpreter or jq builds new text (the stated limit), and a sender's output is the reply: neither is a copy
        if (LATER_RUNS_DECIDES_RX.test(prog) || SENDERS.has(prog) || prog === 'jq') continue
        // the caller's own scripts and functions (a path, a .sh name) and the remote/container runners make output of
        // their own (a query result, a remote reply), not a copy of what they read
        const w0 = rest[0]?.value ?? ''
        if (w0.includes('/') || /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php)$/.test(w0) || CONTAINER_RUNNERS.has(prog) || prog === 'ssh') continue
        // a command substitution reading the file feeds a copy only through a printer (echo/printf print its text)
        const subFed = PRINTERS.has(prog) && s.own.includes(SUBST_MARK) && subs.some((x) => names.some((t) => x.includes(t)))
        const cDir = prog === 'tar' ? vals[vals.findIndex((v) => v === '-C' || v === '--directory') + 1] : undefined
        const tarMember = !!cDir && vals.some((v) => !v.startsWith('-') && v !== cDir && names.includes(join(cDir, v)))
        const fed = piped || stdinOf(s.own) || subFed || tarMember || vals.some((v) => names.includes(v))
        if (!fed) continue
        carries[j] = true
        for (const r of all.redirects) if (add(r.value)) grew = true
        if (prog === 'tar' && (piped || vals.some((v) => names.includes(v))) && vals.some((v) => /^-?[A-Za-z]*x/.test(v) || v === '--extract')) {
          const cIdx = vals.findIndex((v) => v === '-C' || v === '--directory')
          const dir = cIdx >= 0 ? vals[cIdx + 1] : null
          if (dir) for (const t of [...names]) if (add(dir.replace(/\/+$/, '') + '/' + basename(t))) grew = true
        }
        if (prog === 'split') {
          const ops = vals.filter((v, x) => !v.startsWith('-') && !/^-[A-Za-z]$/.test(vals[x - 1] ?? ''))
          const prefix = ops.length >= 2 ? ops[ops.length - 1] : 'x'
          for (const sfx of SPLIT_SUFFIXES) if (add(prefix + sfx)) grew = true
        }
        continue
      }
      const operands = []
      let dest = null
      for (let x = 0; x < vals.length; x++) {
        const v = vals[x]
        if (v.startsWith('--target-directory=')) dest = v.slice('--target-directory='.length)
        else if (v === '--target-directory' || (prog !== 'rsync' && /^-[A-Za-z]*t$/.test(v))) dest = vals[++x] ?? null
        else if (!v.startsWith('-')) operands.push(v)
      }
      if (dest === null) dest = operands.length >= 2 ? operands.pop() : null
      // a copier writes its destination, and a source's name inside it when that is a directory, only when a source is the file
      if (dest === null || !operands.some(isTheFile)) continue
      if (add(dest)) grew = true
      for (const src of operands) if (isTheFile(src) && add(dest.replace(/\/+$/, '') + '/' + basename(src))) grew = true
    }
  }
  return names
}
const OPTION_PROGRAMS = { __proto__: null, awk: ['-f', '--file'], gawk: ['-f', '--file'], mawk: ['-f', '--file'], nawk: ['-f', '--file'],
  sed: ['-f', '--file'], gsed: ['-f', '--file'], make: ['-f', '--file', '--makefile'], gmake: ['-f', '--file', '--makefile'],
  bmake: ['-f'] }
const VIM_NAMES = new Set(['vim', 'vi', 'nvim', 'ex', 'view', 'gvim', 'mvim', 'vimdiff', 'rvim'])
const MAKEFILE_RX = /(?:^|\/)(?:GNUmakefile|makefile|Makefile)$/
// (d) the file as a program's code file, given by an option (or make's default makefile)
function optionProgramRuns(name, rest, names) {
  const vals = rest.slice(1).map((w) => w.value)
  if (VIM_NAMES.has(name)) return vals.some((v) => namesAny(v, names))
  const flags = OPTION_PROGRAMS[name]
  if (!flags) return false
  if (flags.includes('--makefile') && names.some((t) => MAKEFILE_RX.test(t))) return true
  return vals.some((v, x) => {
    const eq = v.indexOf('=')
    if (v.startsWith('--') && eq > 0) return flags.includes(v.slice(0, eq)) && names.includes(v.slice(eq + 1))
    if (flags.includes(v) || /^-[A-Za-z]*f$/.test(v)) return names.includes(vals[x + 1])
    return /^-f./.test(v) && names.includes(v.slice(2))
  })
}
const SUBST_MARK = '\u0000SPVAL\u0000'
const CODE_RUNNER_RX = /^(?:(?:ba|z|da|k)?sh|ash|fish|python[\d.]*|node|nodejs|perl|ruby|php|bun|deno|osascript|tsx)$/
// (e) a command substitution's output used as code
function substAsCode(rest, name) {
  if (!rest.length) return false
  if (rest[0].value.includes(SUBST_MARK)) return true
  if (name === 'eval' || name === 'source' || name === '.') return rest.slice(1).some((w) => w.value.includes(SUBST_MARK))
  if (!CODE_RUNNER_RX.test(name)) return false
  return rest.some((w, i) => i > 0 && /^-[A-Za-z]*[ceE]$/.test(w.value) && (rest[i + 1]?.value ?? '').includes(SUBST_MARK))
}
// GATEPATHNORM1118 (b)(c)(d): the rule turned around. A later program that names the written file runs it, unless it is
// known not to: a reader, a copier or text tool (its copies are followed in copiedNames), a data transformer, a file
// handler, or a sender. Interpreters are left to laterRuns (their script word, stdin and code decide). Two named
// exceptions inside the known programs: an awk/sed program text that names the file runs it, and find with an -exec
// action whose path or -name pattern reaches the file runs it. chmod stays a runner (laterRuns), as before.
const DATA_TRANSFORMERS = new Set(['base64', 'xxd', 'od', 'hexdump', 'rev', 'strings', 'column', 'fmt', 'nl', 'pr', 'gzip',
  'gunzip', 'zcat', 'bzip2', 'bunzip2', 'bzcat', 'xz', 'unxz', 'xzcat', 'zstd', 'tar', 'zip', 'unzip', 'split', 'csplit',
  'comm', 'join', 'look', 'cksum', 'b2sum', 'sha512sum', 'sha384sum', 'sha224sum', 'xattr', 'lsattr', 'getfacl'])
const FILE_HANDLERS = new Set(['touch', 'mkdir', 'rm', 'rmdir', 'unlink', 'chown', 'chgrp', 'truncate', 'find', 'read', 'mapfile', 'readarray'])
const SENDERS = new Set(['curl', 'gh', 'glab'])
const PROGRAM_TEXT_TOOLS = new Set(['awk', 'gawk', 'mawk', 'nawk', 'sed', 'gsed'])
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
// the programs laterRuns already decides for (the interpreters by their script word, stdin and code; the runners always)
const LATER_RUNS_DECIDES_RX = /^(?:(?:ba|z|da|k)?sh|ash|fish|node|nodejs|deno|bun|ruby|perl|php|osascript|tsx|python[\d.]*|sqlite3?|source|\.|chmod|env|xargs|exec|eval|npx)$/
const NAME_EDGE = `['"=!|:@(\\s,;]`
/** Does word [v] name [t]: the whole word, or [t] after =, !, |, :, @, a quote or a space, up to a word end. */
export function wordNamesFile(v, t) {
  if (!v || !t) return false
  if (v === t) return true
  return new RegExp(`(?:^|${NAME_EDGE})${escapeRx(t)}(?=$|['")|;&:,\\s])`).test(v)
}
// Containers and VMs run a file's text over there, not against this install (the container rules judge their own text).
const CONTAINER_RUNNERS = new Set(['docker', 'podman', 'nerdctl', 'kubectl', 'colima', 'lima', 'limactl', 'tart', 'orb', 'multipass'])
const LOCAL_HOST_RX = /^(?:[^@\s]+@)?(?:localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0)$/
const SSH_ARG_OPTS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'])
function namedByUnknownProgram(name, rest, own, names, fns = new Set(), made = new Set()) {
  if (!rest.length || !name) return false
  // a program given by its path, or a shell function the command defines, is the caller's own code: what it does with
  // a file it is handed is the stated limit (like an interpreter's script arguments), not a run read from its name.
  // Not when this command made that program itself (F1: a copied or linked shell under a path or a .sh name).
  const word0 = rest[0].value
  const madeHere = made.has(lastPart(word0))
  if (!madeHere && (word0.includes('/') || fns.has(word0) || /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php)$/.test(word0))) return false
  if (CONTAINER_RUNNERS.has(name)) return false
  const vals = rest.slice(1).map((w) => w.value)
  const stdin = names.some((t) => new RegExp(`(?:^|[^<])<\\s*['"]?${escapeRx(t)}(?:['"\\s;|&)]|$)`).test(own))
  if (name === 'find') {
    if (!vals.some((v) => FIND_ACTIONS.has(v))) return false
    return vals.some((v, x) => names.includes(v) || (/^-(?:i?name|i?path|regex)$/.test(vals[x - 1] ?? '') && names.some((t) => globMatchesName(v, lastPart(t)))))
  }
  const named = stdin || vals.some((v) => names.some((t) => wordNamesFile(v, t)))
  if (!named) return false
  if (PROGRAM_TEXT_TOOLS.has(name)) return vals.some((v) => !names.includes(v) && !v.startsWith('if=') && names.some((t) => wordNamesFile(v, t)))
  // git runs a file named in a -c value (a pager, an editor, an external diff, an alias with !); a path it diffs, shows,
  // adds or takes as a message is not run
  if (name === 'git') return vals.some((v, x) => vals[x - 1] === '-c' && names.some((t) => wordNamesFile(v, t)))
  // ssh runs a file it reads as its config (-F, -o), and a file it hands to a shell on this machine; on another host the
  // text runs over there
  if (name === 'ssh') {
    if (vals.some((v, x) => ['-F', '-o'].includes(vals[x - 1] ?? '') && names.some((t) => wordNamesFile(v, t)))) return true
    let host = null
    for (let x = 0; x < vals.length; x++) {
      if (SSH_ARG_OPTS.has(vals[x])) { x++; continue }
      if (vals[x].startsWith('-')) continue
      host = vals[x]
      break
    }
    return !!host && LOCAL_HOST_RX.test(host)
  }
  if (name === 'curl') return vals.some((v, x) => ['-K', '--config'].includes(vals[x - 1] ?? '') && names.includes(v))
  if (READERS.has(name) || COPY_PROGRAMS.has(name) || TEXT_PASS.has(name) || DATA_TRANSFORMERS.has(name)
    || FILE_HANDLERS.has(name) || SENDERS.has(name) || LATER_RUNS_DECIDES_RX.test(name)) return false
  return true
}

// Does a later segment run (or feed as code) a file segment [k] writes? laterRuns, plus the forms above.
// GATEPATHNORM1118 F1 (Dani 81347): the last path parts of the files segments [0, upto) write, copy or link: a redirect
// target, a copier's destination (cp/mv/install/ln/rsync, -t DIR naming the sources' last parts there) and tee's
// operands. A program word among them is not the caller's own code (a copied or linked shell given by a path or a .sh
// name): its run is judged like any program's. A redirect counts only when it carries another file's content
// (cat /bin/sh > m): a script whose text the command itself writes (a heredoc, a here-string, echo/printf) is read
// by the run rules when it runs, and the data handed to it stays data (the fleet meter's one false denial).
// GATEPATHNORM1118 F3 (Dani 81542, his cases7.json): a program whose text this same command writes (a heredoc,
// echo/printf), with a positional parameter in a run position ($1, "$@", ${1}, $* as the command, after exec, eval, a
// shell (its options, -c too), source or .), runs what it is handed: its arguments are run positions too. A later
// segment that runs such a program (by its name, or as a shell's script word) and hands it the written file runs it.
// F4: a braced form with a modifier (${1:-x}, ${1-x}, ${1:=x}, ${@}, ${1#p}, ${1%s}, ${1/a/b}) is the parameter too
// (${#1} is its length, not it)
// F5: a braced form may be two digits (${10}) and its modifier may hold one nested braced expansion (${1:-${2}}); the
// F4 reading ([^}]* up to the first brace) stays as an alternative, so nothing it read is lost. A shell's option may
// start with + (+x), and an option cluster ending in o or O takes a plain word as its argument (-o errexit, +O extglob).
const POSITIONAL = String.raw`["']?\$(?:\{(?:[1-9][0-9]*|[@*])(?:[-:=?+#%/^,](?:[^{}]|\{[^{}]*\})*|[-:=?+#%/^,][^}]*)?\}|[1-9@*])["']?`
const RUNNER_PREFIX = String.raw`(?:(?:exec|eval|command|nohup|builtin)\s+)*(?:(?:\S*\/)?(?:ba|z|da|k)?sh(?:\s+--(?:rcfile|init-file)(?:\s+|=)\S+|\s+--[A-Za-z][\w-]*|\s+[-+][A-Za-z]*[oO]\s+[A-Za-z_][\w-]*|\s+[-+][A-Za-z]+)*\s+|source\s+|\.\s+)?`
const POSITIONAL_RUN_RX = new RegExp(String.raw`(?:^|[;&|\n(]|\bthen\b|\bdo\b|\belse\b)\s*${RUNNER_PREFIX}${POSITIONAL}(?=\s|$|[;&|)])`, 'm')
export function textRunsPositional(text) {
  return POSITIONAL_RUN_RX.test(flatPositionals(String(text)))
}
/** F6: every balanced ${N...} / ${@...} / ${*...} (N one or more digits), at any nesting depth, read as ${N}: the
 *  regexes then see the parameter however deep its modifier nests. An unbalanced one is left as it is, so nothing the
 *  regexes read before is lost. */
export function flatPositionals(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const m = /^\$\{([1-9][0-9]*|[@*])(?=[^}])/.exec(text.slice(i, i + 24))
    if (!m) { out += text[i]; i++; continue }
    let depth = 0
    let j = i + 1
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}' && --depth === 0) break
    }
    if (j >= text.length) { out += text[i]; i++; continue }
    out += '${' + m[1] + '}'
    i = j + 1
  }
  return out
}
// ...and when the wrapper hands it to a shell (sh "$1", . "$1", source, exec sh "$@"; never a shell's -c), that run is
// a shell run of the file, judged as running it directly with sh would be (the fleet meter: a wrapper sourcing an
// extracted function, which `sh redact.sh` itself passes).
const SHELL_POSITIONAL_RUN_RX = new RegExp(String.raw`(?:^|[;&|\n(]|\bthen\b|\bdo\b|\belse\b)\s*(?:(?:exec|command|nohup|builtin)\s+)*(?:(?:\S*\/)?(?:ba|z|da|k)?sh(?:\s+-(?![A-Za-z]*c)[A-Za-z]+)*|source|\.)\s+${POSITIONAL}(?=\s|$|[;&|)])`, 'm')
const WRAPPER_SHELL_RX = /^(?:\S*\/)?(?:(?:ba|z|da|k)?sh|source|\.)$/
// F4: "$@" / $* (any form) as the command word: the wrapper runs its arguments as a command
const RUNS_ALL_ARGS_RX = new RegExp(String.raw`(?:^|[;&|\n(]|\bthen\b|\bdo\b|\belse\b)\s*(?:(?:exec|command|nohup|builtin)\s+)*["']?\$(?:\{[@*]\}|[@*])["']?(?=\s|$|[;&|)])`, 'm')
/** F4: the shell functions the command defines (f() { ...; } and function f { ...; }), name -> body. The segmenter
 *  splits a definition at its separators, so the bodies are read over the segments joined by line breaks. */
function fnBodiesOf(segs) {
  const text = segs.map((x) => x.own).join('\n')
  const out = new Map()
  // the body runs to the closing brace the segmenter leaves on a line of its own (a ${1:-x} inside holds a brace too)
  for (const m of text.matchAll(/(?:^|[;&|{(\s])(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\s*\))?|([A-Za-z_][\w-]*)\s*\(\s*\))\s*\{([\s\S]*?)\n\s*\}(?=\s*(?:\n|$))/g)) out.set(m[1] ?? m[2], m[3])
  // F5: a body that hands a positional argument to another defined function runs what that function runs: its text
  // takes that function's text too. F6: every function it reaches that way, with no depth ceiling (a breadth-first
  // walk over the call graph; a function is read once, so a cycle ends). Bodies are read with flatPositionals.
  for (const [name, body] of out) out.set(name, flatPositionals(body))
  const callsWithPositional = (body, g) => new RegExp(String.raw`(?:^|[;&|\n({]|\bthen\b|\bdo\b|\belse\b)\s*(?:(?:exec|command|nohup|builtin)\s+)*${escapeRx(g)}(?=\s)[^\n;&|]*?${POSITIONAL}`, 'm').test(body)
  const calls = new Map([...out.keys()].map((f) => [f, [...out.keys()].filter((g) => g !== f && callsWithPositional(out.get(f), g))]))
  const expanded = new Map()
  for (const name of out.keys()) {
    const seen = new Set([name])
    const queue = [...calls.get(name)]
    let text = out.get(name)
    while (queue.length) {
      const g = queue.shift()
      if (seen.has(g)) continue
      seen.add(g)
      text += '\n' + out.get(g)
      queue.push(...calls.get(g))
    }
    expanded.set(name, text)
  }
  return expanded
}
/** The wrapper a segment's words run and the arguments it gets, with the text this command wrote into it (a file an
 *  earlier segment wrote, or F4: a shell function the command defines); null when there is none. */
function hereWrittenWrapper(segs, j, vals) {
  const body = fnBodiesOf(segs).get(vals[0])
  if (body !== undefined) return { args: vals.slice(1), text: body, viaShell: false, fn: true }
  // the program word: the command itself, or a shell's / source's script word (F5: also the word after a shell option's
  // argument, -o NAME; the first non-option word is still tried first)
  const ats = [0]
  if (WRAPPER_SHELL_RX.test(vals[0])) {
    ats.length = 0
    const first = vals.findIndex((v, x) => x > 0 && !v.startsWith('-'))
    if (first > 0) ats.push(first)
    const sw = shellScriptWord(lastPart(vals[0]), vals.slice(1))
    const second = sw === null ? -1 : vals.indexOf(sw, 1)
    if (second > 0 && second !== first) ats.push(second)
    if (!ats.length) return null
  }
  for (const at of ats) {
    const prog = lastPart(vals[at] ?? '')
    if (!prog) continue
    for (let i = j - 1; i >= 0; i--) {
      const ws = shellWords(segs[i].own)
      if (!ws || !(ws.redirects ?? []).some((r) => lastPart(r.value) === prog)) continue
      const writer = lastPart(unwrapRun(ws).rest[0]?.value ?? '')
      return { args: vals.slice(at + 1), text: flatPositionals(scriptTextOf(segs[i].own, segs[i].bodies ?? [], writer)), viaShell: at > 0 }
    }
  }
  return null
}
function wrapperRunsItsArgs(segs, j, rest, names) {
  const w = hereWrittenWrapper(segs, j, rest.map((x) => x.value))
  if (!w || !w.args.some((v) => names.some((t) => wordNamesFile(v, t)))) return false
  return textRunsPositional(w.text)
}
/** For shellRunsOnly: this segment hands one of `targets` to a wrapper written here that runs it with a shell. */
function wrapperShellRunsTarget(segs, j, vals, targets) {
  const w = hereWrittenWrapper(segs, j, vals)
  if (!w || !w.args.some((v) => targets.includes(v))) return false
  const line = w.text.split('\n', 1)[0]
  if (!w.fn && !w.viaShell && line.startsWith('#!') && !SHELL_SHEBANG.test(line)) return false
  if (SHELL_POSITIONAL_RUN_RX.test(w.text)) return true
  // F4: a wrapper that runs "$@" as the command, handed `sh FILE`: the shell runs FILE, as `sh FILE` directly would
  if (RUNS_ALL_ARGS_RX.test(w.text) && SYSTEM_SHELL_RX.test(w.args[0] ?? '')) {
    const script = w.args.slice(1).find((v) => !v.startsWith('-'))
    return script !== undefined && targets.includes(script) && !w.args.slice(1).some((v) => /^-[A-Za-z]*c[A-Za-z]*$/.test(v))
  }
  return false
}

export function madeFileParts(segs, upto) {
  const made = new Set()
  for (let i = 0; i < upto && i < segs.length; i++) {
    const ws = shellWords(segs[i].own)
    if (!ws) continue
    const { rest } = unwrapRun(ws)
    const prog = lastPart(rest[0]?.value ?? '')
    const ownText = segs[i].own.includes('<<') || PRINTERS.has(prog)
    if (!ownText) for (const r of ws.redirects ?? []) if (r.value && r.value !== '/dev/null') made.add(lastPart(r.value))
    const vals = rest.slice(1).map((w) => w.value)
    const ops = vals.filter((v, x) => !v.startsWith('-') && !['-t', '--target-directory'].includes(vals[x - 1] ?? ''))
    if (COPY_PROGRAMS.has(prog)) {
      const t = vals.findIndex((v) => v === '-t' || v === '--target-directory')
      const tEq = vals.find((v) => v.startsWith('--target-directory='))
      if (t >= 0 || tEq) for (const src of ops) made.add(lastPart(src))
      else if (ops.length >= 2) made.add(lastPart(ops[ops.length - 1]))
    } else if (prog === 'tee') for (const v of ops) made.add(lastPart(v))
  }
  made.delete('')
  return made
}

export function runsWrittenFile(segs, k, targets, cmd) {
  if (!targets.length) return false
  // a substitution's text with the command's own literal assignments spelled out (S=/abs; ... "$(cat $S/a.sh)")
  const lits = new Map([...String(cmd).matchAll(/(?:^|[;&|\s])([A-Za-z_]\w*)=([^\s;&|'"$`()<>]+)/g)].map((m) => [m[1], m[2]]))
  const subs = liveSubstitutions(cmd).flatMap((x) => {
    const e = x.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => lits.get(a ?? b) ?? m)
    return e === x ? [x] : [x, e]
  })
  const names = copiedNames(segs, k, targets, subs)
  // names are writtenFileSpellings' per-directory spellings: laterRuns matches them exactly (47eeb016 R5)
  if (laterRuns(segs, k, names, { exactNames: true })) return true
  const subsName = subs.some((s) => namesAny(s, names))
  const startup = (a) => STARTUP_VARS.has(a.name) && (namesAny(a.value, names)
    || names.some((t) => t.startsWith(a.value.replace(/\/+$/, '') + '/')))
  // GATEPATHNORM1118 (e): a variable that holds the file's text (X=$(cat f), export X=$(<f), read/mapfile X < f) is code
  // where a shell takes it as code: eval, source, a shell's -c, a here-string to a shell, or the command word
  const fns = new Set([...String(cmd).matchAll(/(?:^|[;&|{(\s])(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/g)].map((m) => m[1]))
  const tainted = new Set()
  const stdinNames = (own) => names.some((t) => new RegExp(`(?:^|[^<])<\\s*['"]?${escapeRx(t)}(?:['"\\s;|&)]|$)`).test(own))
  const refs = (v) => [...tainted].some((x) => new RegExp(`\\$\\{?${escapeRx(x)}(?![A-Za-z0-9_])`).test(v))
  for (let j = k + 1; j < segs.length; j++) {
    const s = segs[j]
    const all = wordsOf(s.own)
    if (!all || !all.length) continue
    const { rest, assigns, splits, wrapped } = unwrapRun(all)
    const name = segCommand(rest)
    {
      const decl = DECLARERS.has(name) ? rest.slice(1).filter((w) => ASSIGN_RX.test(w.value)).map((w) => ({ name: w.value.slice(0, w.value.indexOf('=')), value: w.value.slice(w.value.indexOf('=') + 1) })) : []
      for (const a of [...assigns, ...decl]) if (subsName && a.value.includes(SUBST_MARK)) tainted.add(a.name)
      if ((name === 'read' || name === 'mapfile' || name === 'readarray') && stdinNames(s.own)) {
        for (const w of rest.slice(1)) if (!w.value.startsWith('-') && /^[A-Za-z_]\w*$/.test(w.value)) tainted.add(w.value)
      }
      if (tainted.size) {
        const vals = rest.map((w) => w.value)
        if (vals.length && refs(vals[0])) return true
        if ((name === 'eval' || name === 'source' || name === '.') && vals.slice(1).some(refs)) return true
        if (CODE_RUNNER_RX.test(name) && vals.some((v, i) => i > 0 && /^-[A-Za-z]*[ceE]$/.test(v) && refs(vals[i + 1] ?? ''))) return true
        if (CODE_RUNNER_RX.test(name) && s.own.includes('<<<') && refs(s.own.slice(s.own.indexOf('<<<')))) return true
      }
    }
    const declared = DECLARERS.has(name)
      ? rest.slice(1).filter((w) => ASSIGN_RX.test(w.value)).map((w) => ({ name: w.value.slice(0, w.value.indexOf('=')), value: w.value.slice(w.value.indexOf('=') + 1) }))
      : []
    if ([...assigns, ...declared].some(startup)) return true
    if (splits.some((v) => namesAny(v, names))) return true
    if (rest.length && wrapped) {
      const q = (v) => `'${v.replace(/'/g, `'\\''`)}'`
      const stdin = names.filter((t) => new RegExp(`(?:^|[^<])<\\s*['"]?${escapeRx(t)}`).test(s.own)).map((t) => ` < ${q(t)}`).join('')
      if (laterRuns([segs[k], { ...s, own: rest.map((w) => q(w.value)).join(' ') + stdin }], 0, names, { exactNames: true })) return true
    }
    if (rest.length && optionProgramRuns(name, rest, names)) return true
    // GATEPATHNORM1118 (b)(c)(d): any other program naming it, and an assignment before the command that names it
    if (rest.length && namedByUnknownProgram(name, rest, s.own, names, fns, madeFileParts(segs, j))) return true
    if (rest.length && wrapperRunsItsArgs(segs, j, rest, names)) return true
    if (rest.length && assigns.some((a) => names.some((t) => wordNamesFile(a.value, t)))) return true
    if (subsName && substAsCode(rest, name)) return true
    // (e) a here-string to a shell holding a substitution that reads the file (bash <<< "$(cat f)") needs no rule here:
    // the gate denies it without one (on develop too); a dedicated check here survived as a mutant every gate test and
    // five probe forms (sh -s, zsh with a backtick, python3, $(<f), the path in a variable).
  }
  return false
}

// GATEPATHNORM1118: the run checks compare names as the command spells them. The same file spelled another way (a
// relative name after a directory change, ./, ../, //, /./, an absolute path for a relative write) is the same file:
// every word of a later segment that resolves, at the directory that segment runs in, to a written (or copied) file
// is added as one more spelling of it. Only spellings are added, never taken away, so this can only deny more. Where a
// directory cannot be followed (a cd or a wrapper chdir to a variable, a write at an unknown directory), a word with
// the same last path part counts, as the lost-cwd reading does for the text (WRITEGATERELPATH1115).
const UNRESOLVABLE_WORD_RX = /[$`*?[\]\u0000]/
function resolvedAt(word, cwd) {
  if (!word || word.startsWith('-') || UNRESOLVABLE_WORD_RX.test(word)) return null
  if (word.startsWith('/')) return resolve(word)
  if (word === '~' || word.startsWith('~/')) return resolve(expandHome(word === '~' ? '~/' : word))
  if (word.startsWith('~')) return null
  return cwd ? resolve(cwd, word) : null
}
const lastPart = (p) => { const s = String(p).replace(/\/+$/, ''); return s.slice(s.lastIndexOf('/') + 1) }
export function writtenFileSpellings(segs, k, targets, ctx) {
  const names = new Set(targets)
  const abs = new Set()
  const lostParts = new Set()
  const add = (n, cwd) => {
    const a = resolvedAt(n, cwd)
    if (a) abs.add(a)
    else if (!n.startsWith('-') && lastPart(n)) lostParts.add(lastPart(n))
  }
  // a literal value the command assigns itself (S=/abs/dir) stands for its $S and ${S}, in the names and in the cds
  const lit = new Map()
  const learn = (own) => {
    const ws = shellWords(own)
    if (!ws || !ws.length) return
    const { assigns, rest } = unwrapRun(ws)
    if (rest.length) return
    for (const a of assigns) if (a.value && !/[$`*?\s]/.test(a.value)) lit.set(a.name, a.value)
  }
  const expand = (w) => String(w).replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, x, y) => lit.get(x ?? y) ?? m)
  for (let i = 0; i <= k; i++) learn(segs[i].own)
  for (const t of targets) { add(t, ctx.cwd); if (expand(t) !== t) add(expand(t), ctx.cwd) }
  // the directory each later segment's command runs in (its wrapper's chdir included); null where it cannot be followed
  // (a later absolute cd makes it known again)
  const where = []
  const c = { ...ctx }
  const segWords = []
  for (let j = k + 1; j < segs.length; j++) {
    learn(segs[j].own)
    const body = subshellParts(segs[j].own).body
    const ws = shellWords(body)
    const wsx = shellWords(expand(body))
    let here = c.cwd ?? null
    for (const d of wsx ? unwrapRun(wsx).chdirs : []) here = here === null ? null : resolvedAt(d, here)
    where[j] = here
    // the words, the write redirects, and the stdin redirects (sh < "$F": the spelling is only in the input redirect;
    // a heredoc, a here-string, an fd duplication and a process substitution are not a file read)
    const stdinWords = [...body.matchAll(/(?:^|[^<])<(?![<&(])\s*(['"]?)([^\s;&|'"<>()`]+)\1/g)].map((m) => m[2])
    segWords[j] = ws ? [...ws.map((w) => w.value), ...(ws.redirects ?? []).map((r) => r.value), ...stdinWords] : []
    cwdAfterSegment(expand(body), c)
  }
  // F2 (Dani 81347): on a case-insensitive file system (macOS, Windows; ctx.caseInsensitiveFs overrides) a case variant
  // of the path is the same file; and $PWD / ${PWD} is the directory the segment runs in
  const ci = ctx.caseInsensitiveFs ?? (process.platform === 'darwin' || process.platform === 'win32')
  const same = (x, y) => x === y || (ci && x.toLowerCase() === y.toLowerCase())
  const matches = (w0, j) => {
    const w = expand(w0).replace(/\$\{PWD\}|\$PWD(?![A-Za-z0-9_])/g, (m) => where[j] ?? m)
    const a = resolvedAt(w, where[j])
    if (a && (abs.has(a) || (ci && [...abs].some((x) => same(x, a))))) return true
    if (!lostParts.size && where[j] !== null) return false
    // an unknown directory on either side: the last path part decides
    const part = lastPart(w)
    if (!part || w.startsWith('-') || UNRESOLVABLE_WORD_RX.test(w)) return false
    return [...lostParts].some((p) => same(p, part)) || (where[j] === null && !w.startsWith('/') && [...abs].some((x) => same(lastPart(x), part)))
  }
  // a copy made later is one more written file: its spellings are added the same way, until nothing new appears
  for (let round = 0; round <= segs.length; round++) {
    let grew = false
    for (let j = k + 1; j < segs.length; j++) {
      const ws = segWords[j].map(expand)
      // (a) a symlink made to a directory that holds the file: the file's path through the link is one more path of it
      if (lastPart(ws[0] ?? '') === 'ln' && ws.some((v) => /^-[A-Za-z]*s/.test(v))) {
        const ops = ws.slice(1).filter((v) => !v.startsWith('-'))
        const src = ops.length === 2 ? resolvedAt(ops[0], where[j]) : null
        const link = ops.length === 2 ? resolvedAt(ops[1], where[j]) : null
        if (src && link) for (const a of [...abs]) if (a.startsWith(src + '/') && !abs.has(link + a.slice(src.length))) { abs.add(link + a.slice(src.length)); grew = true }
      }
      // (d) python -m MOD runs MOD.py (or MOD/__main__.py) from the directory it runs in: MOD is a spelling of the file
      const m = ws.indexOf('-m')
      if (m > 0 && /^python[\d.]*$/.test(lastPart(ws[0])) && ws[m + 1] && !names.has(segWords[j][m + 1])) {
        const mod = ws[m + 1].replace(/\./g, '/')
        if ([`${mod}.py`, `${mod}/__main__.py`].some((c) => { const a = resolvedAt(c, where[j]); return !!a && abs.has(a) })) { names.add(segWords[j][m + 1]); grew = true }
      }
      for (const w of segWords[j]) if (!names.has(w) && matches(w, j)) { names.add(w); grew = true }
    }
    for (const n of copiedNames(segs, k, [...names])) {
      if (names.has(n)) continue
      names.add(n)
      grew = true
      const j = segWords.findIndex((ws, i) => i > k && ws?.includes(n))
      add(n, j > k ? where[j] : null)
    }
    if (!grew) break
  }
  return [...names]
}

const PRINTERS = new Set(['echo', 'printf'])
// The escapes printf (format and %b), echo -e and a POSIX echo decode: \\ and the letter escapes, octal (\NNN, \0NNN),
// hex (\xHH) and \uHHHH. A decoded control character is a line break for the reading (it ends a word).
const PRINT_ESC = { a: '\n', b: '\n', f: '\n', n: '\n', r: '\n', t: ' ', v: '\n', e: '\n', E: '\n', c: '\n', '\\': '\\' }
export function decodePrintEscapes(s) {
  return String(s).replace(/\\(?:0([0-7]{0,3})|([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|([abfnrtveEc\\]))/g,
    (m, o0, o, x, u, c) => {
      if (c !== undefined) return PRINT_ESC[c]
      const code = o0 !== undefined ? parseInt(o0 || '0', 8) : o !== undefined ? parseInt(o, 8) : parseInt(x ?? u, 16)
      return code < 0x20 || code === 0x7f ? '\n' : String.fromCharCode(code)
    })
}

// INSTRWRITEEXEC1105: the text a segment puts into the file it writes, as a script would read it. printf/echo: what
// they print, i.e. their arguments' values (a printf argument on its own line), an escape as the break it prints; a
// reader: its heredoc bodies only (it copies file contents, not its arguments); any other program (sed, awk, an
// interpreter): its own text and bodies. Words that do not split: the own text, as for any other program.
function scriptTextOf(own, bodies, name) {
  if (PRINTERS.has(name)) {
    const words = shellWords(own)
    const vals = words ? words.slice(1).map((w) => w.value).filter((v) => !/^-[neE]+$/.test(v)) : [own]
    return [decodePrintEscapes(vals.join(name === 'printf' ? '\n' : ' ')), ...bodies].join('\n')
  }
  if (READERS.has(name)) return bodies.join('\n')
  return [own, ...bodies].join('\n')
}

// Commands that only read a file they name (the output redirect is checked apart).
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'wc', 'ls',
  'stat', 'file', 'shasum', 'sha1sum', 'sha256sum', 'md5', 'md5sum', 'diff', 'cmp', 'echo', 'printf', 'test', '[',
  'readlink', 'realpath', 'basename', 'dirname', 'du', 'pwd', 'cd', 'pushd', 'popd'])
const GIT_READ = new Set(['diff', 'log', 'show', 'status', 'blame', 'ls-files', 'grep', 'rev-parse', 'ls-tree', 'cat-file'])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh'])
// Commands that change what a DIRECTORY holds: pointed at a directory that
// contains a protected path, they reach it without naming it.
const DIR_CHANGERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'rsync', 'ln', 'install', 'tar', 'bsdtar', 'gtar', 'unzip',
  'cpio', 'patch', 'ditto', '7z', '7za', 'chmod', 'chown', 'chflags', 'find'])

// CPDESTDIR1104: the programs whose landing place is judged always (see landingDenied), and the extracting programs'
// target-directory flags.
const COPIERS = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'ditto'])
const COPIER_WORD_RX = /(?:^|[\s;&|(/`"'])(?:cp|mv|install|ln|rsync|ditto)(?=\s|$)/
const EXTRACT_DIR_FLAGS = { __proto__: null, tar: ['-C', '--directory', '--cd'], bsdtar: ['-C', '--directory', '--cd'], gtar: ['-C', '--directory', '--cd'],
  unzip: ['-d'], cpio: ['-D', '--directory'], patch: ['-d', '--directory'], '7z': ['-o'], '7za': ['-o'] }
// The target directory an extracting program writes into (null when it names none, or does not extract). Joined
// (`-Cdir`, `--directory=dir`, 7z's `-odir`) and separate (`-C dir`) forms.
function extractTargetDir(vals, name) {
  if (['tar', 'bsdtar', 'gtar'].includes(name)) {
    const extract = vals.some((v) => v === '--extract' || v === '--get' || (!v.startsWith('--') && /^-?[A-Za-z]*x/.test(v)))
    if (!extract) return null
  }
  if (name === 'cpio' && !vals.some((v) => /^-[A-Za-z]*i/.test(v) || v === '--extract')) return null
  if ((name === '7z' || name === '7za') && !['x', 'e'].includes(vals[0])) return null
  let dir = null
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    for (const f of EXTRACT_DIR_FLAGS[name]) {
      if (v === f && f !== '-o') dir = vals[i + 1] ?? null
      else if (f.startsWith('--') && v.startsWith(f + '=')) dir = v.slice(f.length + 1)
      else if (!f.startsWith('--') && v.startsWith(f) && v.length > f.length) dir = v.slice(f.length)
    }
  }
  return dir
}

// A directory named .claude copied or moved INTO an agent directory (ENVRELAXGATE1104): `cp -r /tmp/x/.claude .` in
// agents/<name> lands on its .claude/settings.json without naming it, and agents/<name> itself is not an ancestor (every
// sub-agent works there). So: a directory changer with a source word whose last part is (or globs onto) .claude, and the
// cwd or a word under the install's agents/. A content copy (`cp -r x/. .`, an archive) is not seen: stated limit.
const CLAUDE_DIR_WORD_RX = /\.claude(?:-config)?(?![\w-])|(?:^|[\s/'"])\.[^\s/'"]*[*?[]/i
function claudeDirCopyIn(words, ctx) {
  const vals = words.slice(1).map((w) => w.value).filter((v) => v && !v.startsWith('-'))
  const named = vals.some((v) => {
    const last = normalizePathSegments(v).filter(Boolean).pop() ?? ''
    return nameForms(last).some((f) => f === '.claude' || f === '.claude-config'
      || (f.startsWith('.') && GLOB_CHAR_RX.test(f) && (globMatchesName(f, '.claude') || globMatchesName(f, '.claude-config'))))
  })
  if (!named) return false
  const agentsKey = pathKey(join(ctx.root, 'agents'))
  const inAgents = (p) => !!p && underKey(pathKey(p), agentsKey)
  if (inAgents(ctx.cwd)) return true
  return vals.some((v) => inAgents(v.startsWith('/') || v === '~' || v.startsWith('~/') ? expandHome(v === '~' ? '~/' : v) : (ctx.cwd ? resolve(ctx.cwd, v) : null)))
}

// Programs that write into the CWD when no target directory is named: an
// archive extracted, a patch applied (Dani 56276 2a). The names they create
// come from the archive or the patch, not from the command.
const IMPLICIT_WRITER_RX = /(?:^|[\s;&|(/`"'])(?:tar|bsdtar|gtar|unzip|patch|cpio|7z|7za)(?=\s|$)/
// UNKCWDEXTRACT1121 (review round 2, R2/R3): a program that runs text it is given as commands: one in RESHELL_NAMES at the command
// position (a shell -- fish, mksh, ash, busybox too --, eval, xargs, find with -exec/-execdir/-ok/-okdir, ...), or env with
// -S/--split-string. The program word counts by its last path part (any path: fail closed). An extract word is looked for with the quotes and backslashes taken off (`t"a"r`, `un''zip`, `ta\r`).
const SHELLS_ALL = new Set([...SHELL_RUNNERS, 'fish', 'mksh', 'ash', 'tcsh', 'csh'])
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const STDIN_SCRIPTS = new Set(['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])
const writerWordIn = (text) => IMPLICIT_WRITER_RX.test(String(text ?? '').replace(/["'\\]/g, ''))
function reshells(rest, splits) {
  if (splits && splits.length) return true
  if (!rest.length) return false
  // the gate's own list of re-shelling programs (RESHELL_NAMES: shells, eval/source, interpreters, xargs, find, watch, ...), by the
  // program word's last path part, a version suffix ignored (python3.12, bash5); find only with an -exec form
  const v = rest[0].value
  const n = (commandName(rest) || v.slice(v.lastIndexOf('/') + 1)).toLowerCase().replace(/[\d.]+$/, '')
  return n === 'find' ? rest.some((w) => FIND_EXEC.has(w.value)) : RESHELL_NAMES.has(n)
}
function writesIntoCwd(words, name) {
  const vals = words.map((w) => w.value)
  const named = (...flags) => vals.some((v, i) => flags.some((f) =>
    v === f ? i + 1 < vals.length : v.startsWith(f + '=') || (f.length === 2 && v.startsWith(f) && v.length > 2)))
  if (name === 'tar' || name === 'bsdtar' || name === 'gtar') {
    const extract = vals.slice(1).some((v) => v === '--extract' || v === '--get' || (!v.startsWith('--') && /^-?[A-Za-z]*x/.test(v)))
    // UNKCWDEXTRACT1121 (review round 3, Dani 3): -O / --to-stdout writes the members to stdout, no file. The -O is read only in an option
    // cluster of letters (`-xzOf`, or the dashless first word `xzOf`), never in a file name or any other word.
    const toStdout = vals.slice(1).some((v, i) => v === '--to-stdout' || /^-[A-Za-z]*O[A-Za-z]*$/.test(v) || (i === 0 && /^[A-Za-z]*O[A-Za-z]*$/.test(v)))
    return extract && !toStdout && !named('-C', '--directory', '--cd')
  }
  // unzip -p / -c write the member to stdout (a letter cluster of options only, as above)
  if (name === 'unzip') return !named('-d') && !vals.slice(1).some((v) => /^-[A-Za-z]*[pc][A-Za-z]*$/.test(v))
  if (name === 'patch') return !named('-d', '--directory')
  if (name === 'cpio') return vals.slice(1).some((v) => /^-[A-Za-z]*i/.test(v) || v === '--extract') && !named('-D', '--directory')
  if (name === '7z' || name === '7za') return ['x', 'e'].includes(vals[1]) && !vals.some((v) => v.startsWith('-o'))
  return false
}

// GIT (Samu 56294/56299/56310, Dani 56284/56308; measured on a throwaway clone, probes/gitprobe-2b-1030.txt): a
// worktree shares the main checkout's refs and .git/config, so `merge --ff-only origin/<branch>` in the install can take
// a commit any worktree put under refs/remotes/origin; `pull --ff-only origin <branch>` fetches the ref itself and does
// not, unless the remote's address is redirected (url.*.insteadOf from -c, from the GIT_CONFIG_* environment or from the
// user's config). So:
//   - everywhere: no write of refs/remotes/* (update-ref, a refspec onto it, branch -f/-m/-c on an origin name), no
//     write of the remote/hook config keys (any scope), no -c or --config-env with such a key, no GIT_CONFIG_* / GIT_DIR /
//     GIT_WORK_TREE in the command;
//   - in the install's main checkout (the cwd or a -C/--git-dir/--work-tree inside it, an unresolved one counted as
//     inside): only reads, `fetch [origin]` and exactly `pull --ff-only origin <branch>`, plus `checkout -- <paths>` and
//     `restore <paths>` with no ref (they put back the reviewed tree: the host update skill's clean-up step); every
//     other writing subcommand is denied, and so is any -c there.
const GIT_WORD_RX = /(?:^|[\s;&|(/`"'])git(?=\s|$)/
const GIT_ENV_RX = /(?:^|[\s;&|(])(?:export\s+|env\s+)?GIT_(?:CONFIG\w*|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|SSH_COMMAND|SSH|EXEC_PATH|TEMPLATE_DIR|ALTERNATE_OBJECT_DIRECTORIES)=/
const GIT_PROTECTED_KEY_RX = /^(?:remote\..+\.(?:url|pushurl|fetch|pushurl)|core\.hookspath|include\.path|includeif\..+|url\..+\.(?:insteadof|pushinsteadof))$/i
const GIT_ROOT_READS = new Set([...['diff', 'log', 'show', 'status', 'blame', 'ls-files', 'grep', 'rev-parse', 'ls-tree', 'cat-file'],
  'rev-list', 'merge-base', 'describe', 'shortlog', 'for-each-ref', 'show-ref', 'name-rev', 'check-ignore', 'count-objects',
  'ls-remote', 'cherry', 'whatchanged', 'version', 'help'])
const GIT_FETCH_FLAGS = new Set(['-q', '--quiet', '--prune', '-p'])

// The git words of a segment: the words after any leading assignments and `env`, or null when it is not git.
function gitWords(words) {
  let i = 0
  while (i < words.length && ASSIGN_RX.test(words[i].value)) i++
  if (words[i]?.value === 'env') { i++; while (i < words.length && (ASSIGN_RX.test(words[i].value) || words[i].value.startsWith('-'))) i++ }
  const rest = words.slice(i)
  return commandName(rest) === 'git' ? rest : null
}

// The directory after a segment (cwdAfterSegment), and one thing it cannot see: a cd joined to the next command by ";" or a
// newline, not "&&", that may FAIL. bash then runs the next command in the old directory, so "cd <dir>; git ..." would
// write the install when <dir> is missing (found while measuring Dani 60251's case 4). A target that does not exist now is
// such a cd: the directory after it is unknown, which the git rule takes as the install. With "&&" a failed cd runs
// nothing after it, and an existing directory is taken as reached. A FILE fails a cd too (Dani 60262: "cd <file> ||
// git ..." runs the git only then), so the test is "a directory", not "exists".
function isDirectory(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

// UNKCWDEXTRACT1121 (review round 3, Dani 2): `D=/abs/dir && cd $D && tar -x -C bin`. A `cd $NAME` / `cd ${NAME}` (or `pushd`, and a
// plain `/sub/dir` after it) whose NAME the same command sets to an ABSOLUTE literal is a literal cd, not an unknown one. What counts as
// "sets" is the rule the gate family already uses for a literal variable (self-pace-gate definiteAssignments, as the mail gate's
// ISSUE2582): the assignment is a segment of its own, assigned once, every separator from it to the use is `&&` or `;`, and the command
// holds no group, subshell, compound command or variable-setting builtin (the heredocs are taken out first, see below). Anything else
// stays an unknown directory.
// The text without its heredocs: each `<<TAG` operator and the body lines up to the closing TAG line are taken out (a heredoc is data for
// the command it feeds, it cannot set a variable of the shell that runs the command). null: a heredoc that is not closed.
const HEREDOC_OP_RX = /(?<!<)<<(?!<)-?[ \t]*(['"]?)([A-Za-z_]\w*)\1/g
function withoutHeredocs(text) {
  const lines = String(text).split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const tags = []
    const line = lines[i].replace(HEREDOC_OP_RX, (m, _q, tag) => { tags.push([tag, m.startsWith('<<-')]); return '' })
    out.push(line)
    for (const [tag, dash] of tags) {
      let closed = false
      for (i++; i < lines.length; i++) {
        if ((dash ? lines[i].replace(/^\t+/, '') : lines[i]) === tag) { closed = true; break }
      }
      if (!closed) return null
    }
  }
  return out.join('\n')
}
// Returns segment index -> the segment text with the literal in place (`cd '<dir>'`); the other segments are read as written.
function literalCdSegments(cmd, segs) {
  const out = new Map()
  if (!cmd.includes('$') || !cmd.includes('=')) return out
  const bare = withoutHeredocs(cmd)
  if (bare === null) return out
  let split
  let defs
  try {
    split = protectedSplit(bare)
    // A pipe between the assignment and the use does not touch the assignment (`S=/x; cd /y && git log | tail -2; cd $S/z`): it reads as `;`
    // there, unless a neighbour of the pipe is an assignment segment (an assignment in a pipeline runs in a subshell and is lost).
    const assignSeg = (k) => { const w = k >= 0 && k < split.segs.length ? shellWords(split.segs[k]) : null; return !!w && w.length > 0 && w.every((x) => ASSIGN_RX.test(x.value)) }
    const seps = split.seps.map((sep, k) => ((sep === '|' || sep === '|&') && !assignSeg(k) && !assignSeg(k + 1) ? ';' : sep))
    defs = definiteAssignments({ ...split, seps })
  } catch { return out }
  if (!split.quoteAware || split.segs.length !== segs.length) return out
  segs.forEach((seg, i) => {
    const known = defs[i]
    if (!known || !known.size || split.segs[i] !== withoutHeredocs(String(seg.own))?.trim()) return
    const w = shellWords(seg.own)
    if (!w || !w.length || !['cd', 'pushd'].includes(w[0].value)) return
    const arg = w.slice(1).find((x) => !/^-[LPe@]+$/.test(x.value))
    // `dollar` marks an UNQUOTED expansion; a double-quoted one (`cd "$D"`) is read too, but a segment with a single quote or a
    // backslash may hold the literal text `$D` (`cd '$D'`, `cd \$D`): left unknown
    if (!arg || (!arg.dollar && /['\\]/.test(seg.own))) return
    const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))((?:\/[^$`*?[\]{}~\s'"\\]*)?)$/.exec(arg.value)
    const v = m ? known.get(m[1] ?? m[2]) : undefined
    if (v === undefined || !v.startsWith('/') || /[\s'"\\$`*?[\]{}~]/.test(v)) return
    out.set(i, `${w[0].value} '${v}${m[3]}'`)
  })
  return out
}

// INSTRFILES1104 A (Dani 69753 SHOULD 3, Samu 69755): a cd joined to the next command by ";", "||" or a newline may
// fail, and the next commands then run in the OLD directory. The old one is kept as ctx.altCwd, and the segment checks
// that read the cwd are run on both (the stricter decides). A later cd moves both; when they meet, the second is
// dropped. ctx.cwd keeps its meaning for the git rule (null: unknown, read as the install).
function moveCwd(own, seg, ctx, reaches = null) {
  const before = ctx.cwd
  const altBefore = ctx.altCwd ?? null
  cwdAfterSegment(own, ctx)
  const first = shellWords(String(own ?? '').trim())?.[0]?.value
  const isCd = first === 'cd' || first === 'pushd'
  // WRITEGATERELPATH1115: a directory change to a place this gate cannot know: the relative words after it are read
  // against every protected path's tail (fail closed), not dropped
  if (first === 'cd' || first === 'pushd' || first === 'popd') ctx.cwdLost = !ctx.cwd
  if (altBefore) {
    const a = { ...ctx, cwd: altBefore }
    cwdAfterSegment(own, a)
    ctx.altCwd = a.cwd && !(ctx.cwd && sameKey(pathKey(a.cwd), pathKey(ctx.cwd))) ? a.cwd : null
  }
  if (isCd && seg.sep !== '&&') {
    if (before && !(ctx.cwd && sameKey(pathKey(before), pathKey(ctx.cwd)))) ctx.altCwd = before
    if (ctx.cwd && !isDirectory(ctx.cwd)) {
      // UNKCWDEXTRACT1121 (review N4): a directory that is not there now but reaches a protected path (it may be made by
      // then) is an unknown directory, read as one (cwdLost)
      if (reaches && reaches(ctx.cwd)) ctx.cwdLost = true
      ctx.cwd = null
    }
  }
}

// The main checkout this repo dir belongs to: the nearest directory up from it that has a .git entry.
function repoTop(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return null
  }
}

// 'deny', 'allow' (an allowed write in the main checkout: decided, no path rule after it), or null (judge as any other).
export function gitDecision(words, ctx) {
  const { rootKey } = installTargets(ctx.root)
  const inRootDir = (dir) => { const top = dir && repoTop(dir); return !!top && sameKey(pathKey(top), rootKey) }
  let dir = ctx.cwd
  let dirUnknown = !ctx.cwd
  let pointsIn = false
  const configs = []
  let i = 1
  for (; i < words.length && words[i].value.startsWith('-'); i++) {
    const v = words[i].value
    const val = () => (v.includes('=') ? v.slice(v.indexOf('=') + 1) : words[++i]?.value ?? '')
    if (v === '-C') {
      const d = val()
      if (/[$`\u0000]/.test(d) || words[i]?.dollar) dirUnknown = true
      else if (d.startsWith('/') || d === '~' || d.startsWith('~/')) { dir = resolve(expandHome(d === '~' ? '~/' : d)); dirUnknown = false }
      else if (dir) dir = resolve(dir, d)
      else dirUnknown = true
    } else if (v === '-c' || v.startsWith('--config-env')) {
      configs.push(val().split('=')[0])
    } else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(v)) {
      const d = val()
      if (/[$`\u0000]/.test(d) || !(d.startsWith('/') || ctx.cwd)) pointsIn = true
      else if (inRootDir(resolve(ctx.cwd ?? '/', expandHome(d)))) pointsIn = true
    }
  }
  const sub = words[i]?.value ?? ''
  const args = words.slice(i + 1).map((w) => w.value)
  // everywhere
  if (configs.some((k) => GIT_PROTECTED_KEY_RX.test(k))) return 'deny'
  if (args.some((a) => /(?:^|:)\+?refs\/remotes\//.test(a) && (a.includes(':') || sub === 'update-ref' || sub === 'symbolic-ref'))) return 'deny'
  if (sub === 'update-ref' && args.includes('--stdin')) return 'deny'
  if (sub === 'fetch' && args.some((a) => a.startsWith('--refmap'))) return 'deny'
  if (sub === 'branch' && args.some((a) => /^-[A-Za-z]*[fmMcC]|^--(?:force|move|copy)$/.test(a))
    && args.some((a) => /^(?:origin\/|remotes\/|refs\/remotes\/)/.test(a))) return 'deny'
  if (sub === 'config') {
    const plain = args.filter((a) => !a.startsWith('-'))
    const verb = ['set', 'unset', 'get', 'list', 'edit', 'rename-section', 'remove-section'].includes(plain[0]) ? plain.shift() : null
    const reading = verb === 'get' || verb === 'list' || args.some((a) => /^--(?:get|get-all|get-regexp|get-urlmatch|list)$|^-l$/.test(a))
      || (!verb && plain.length === 1 && !args.some((a) => /^--(?:unset|unset-all|add|replace-all|rename-section|remove-section|edit)$|^-e$/.test(a)))
    if (!reading && (verb === 'edit' || args.some((a) => a === '--edit' || a === '-e') || GIT_PROTECTED_KEY_RX.test(plain[0] ?? '')
      || ['rename-section', 'remove-section'].includes(verb ?? '') || args.some((a) => /^--(?:rename|remove)-section$/.test(a)))) return 'deny'
  }
  if (sub === 'remote' && ['set-url', 'rename', 'remove', 'rm', 'set-branches', 'set-head'].includes(args[0] ?? '')) return 'deny'
  if (sub === 'remote' && args[0] === 'add' && args.includes('origin')) return 'deny'
  // the main checkout
  const inRoot = pointsIn || dirUnknown || inRootDir(dir)
  if (!inRoot) return null
  if (configs.length) return 'deny'
  if (GIT_ROOT_READS.has(sub)) return null
  if (sub === 'fetch') return args.every((a) => GIT_FETCH_FLAGS.has(a)) || (args.filter((a) => !GIT_FETCH_FLAGS.has(a)).join(' ') === 'origin') ? 'allow' : 'deny'
  if (sub === 'pull') {
    const rest = args.filter((a) => a !== '-q' && a !== '--quiet')
    return rest.length === 3 && rest[0] === '--ff-only' && rest[1] === 'origin' && /^[A-Za-z0-9._\/-]+$/.test(rest[2]) && !rest[2].startsWith('-') ? 'allow' : 'deny'
  }
  if (sub === 'checkout') {
    const dash = args.indexOf('--')
    return dash >= 0 && dash < args.length - 1 && args.slice(0, dash).every((a) => a === '-q' || a === '--quiet') ? 'allow' : 'deny'
  }
  if (sub === 'restore') {
    return args.some((a) => /^(?:-s|--source)(?:=|$)|^-s./.test(a)) || !args.some((a) => !a.startsWith('-')) ? 'deny' : 'allow'
  }
  // branch / tag: a listing only. A name without a listing option creates one.
  const listing = (flags, listFlags) => {
    const names = args.filter((a) => !a.startsWith('-'))
    return args.filter((a) => a.startsWith('-')).every((a) => flags.test(a)) && (!names.length || args.some((a) => listFlags.test(a)))
  }
  const LIST_ARG = /^(?:-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/
  // A local branch deleted after its worktree is gone (Samu 56807: the fleet could add worktrees but not clean up):
  // allowed, but never a remote-tracking ref (-r, an origin/ or refs/ name) and never the branch the install runs.
  if (sub === 'branch' && args.some((a) => /^-[A-Za-z]*[dD]$|^--delete$/.test(a))) {
    const names = args.filter((a) => !a.startsWith('-'))
    const head = (() => { try { return readFileSync(join(ctx.root, '.git', 'HEAD'), 'utf-8').trim().replace(/^ref: refs\/heads\//, '') } catch { return null } })()
    const bad = !names.length || args.some((a) => /^-[A-Za-z]*r$|^--remotes$/.test(a))
      || names.some((n) => /^(?:origin\/|remotes\/|refs\/)/.test(n) || n === head || /[$`\u0000]/.test(n))
    return bad ? 'deny' : null
  }
  if (sub === 'branch') return listing(/^(?:-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--verbose|--no-color|--color|--contains|--no-contains|--merged|--no-merged|--format=.*|--sort=.*)$/, LIST_ARG) ? null : 'deny'
  if (sub === 'tag') return listing(/^(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--sort=.*|--format=.*)$/, LIST_ARG) ? null : 'deny'
  if (sub === 'remote') return args.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(args[0]) ? null : 'deny'
  if (sub === 'config') return args.some((a) => /^--(?:get|get-all|get-regexp|get-urlmatch|list)$|^-l$/.test(a)) || ['get', 'list'].includes(args[0]) ? null : 'deny'
  if (sub === 'stash') return ['list', 'show'].includes(args[0]) ? null : 'deny'
  // A worktree is added, moved or removed only OUTSIDE the install (Samu 56807): one inside it would be a second
  // checkout of the tree the install runs.
  if (sub === 'worktree') {
    if (args[0] === 'list' || args[0] === 'prune') return null
    if (!['add', 'remove', 'move'].includes(args[0])) return 'deny'
    const paths = []
    for (let j = 1; j < args.length; j++) {
      if (['-b', '-B', '--reason'].includes(args[j])) { j++; continue }
      if (!args[j].startsWith('-')) paths.push(args[j])
    }
    const where = args[0] === 'add' ? paths.slice(0, 1) : paths
    if (!where.length || where.some((p) => /[$`\u0000]/.test(p))) return 'deny'
    return where.some((p) => underKey(pathKey(resolve(dir ?? ctx.cwd ?? '/', expandHome(p))), rootKey)) ? 'deny' : null
  }
  return 'deny'
}

function gitIsRead(words) {
  let i = 1
  while (i < words.length && words[i].value.startsWith('-')) {
    if (['-C', '--git-dir', '--work-tree'].includes(words[i].value)) i++
    else if (words[i].value === '-c') return false // a config override can name a pager or a hook
    i++
  }
  return GIT_READ.has(words[i]?.value) && !words.some((w) => /^--(?:ext-diff|output)(?:=|$)/.test(w.value))
}

// Running a protected script is not writing it: `node <path>`, `python3 <path>`,
// `bash <path>`, or the path as the command word, with the hit as the script.
function isExecOf(words, name, hitWords) {
  if (hitWords.has(words[0]?.value) && !words.slice(1).some((w) => hitWords.has(w.value))) return true
  if (!INTERPRETERS.has(name)) return false
  const script = words.findIndex((w, i) => i > 0 && !w.value.startsWith('-'))
  if (script < 0 || words.slice(1, script).some((w) => /^-[A-Za-z]*[ceE]$/.test(w.value))) return false
  return hitWords.has(words[script].value) && !words.slice(script + 1).some((w) => hitWords.has(w.value))
}

// The live command substitutions of a command line, as their inner text: backticks and $(...)
// outside single quotes, $'...' and the body of a heredoc with a quoted tag (those are literal text). The segment
// parser replaces a substitution by an opaque marker, so a git write inside one never reached the git rule (Dani 56844:
// `git update-ref refs/remotes/...` in backticks passed; measured: a flat $(...) too).
export function liveSubstitutions(cmd) {
  const out = []
  const s = String(cmd ?? '')
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') { i += 2; continue }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue }
    if (c === '$' && s[i + 1] === "'") {
      let j = i + 2
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1
      i = j + 1
      continue
    }
    const here = /^<<-?\s*(['"])([A-Za-z_]\w*)\1/.exec(s.slice(i))
    if (here) {
      const nl = s.indexOf('\n', i)
      const end = nl < 0 ? -1 : s.slice(nl + 1).search(new RegExp(`^[ \\t]*${here[2]}[ \\t]*$`, 'm'))
      i = nl < 0 || end < 0 ? s.length : nl + 1 + end + here[2].length
      continue
    }
    if (c === '`') {
      let j = i + 1
      while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1
      const inner = s.slice(i + 1, j)
      out.push(inner)
      i = j + 1
      continue
    }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] !== '(') {
      let j = i + 2
      let depth = 1
      while (j < s.length && depth > 0) {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === "'") { const e = s.indexOf("'", j + 1); j = e < 0 ? s.length : e + 1; continue }
        if (s[j] === '(') depth++
        else if (s[j] === ')') depth--
        j++
      }
      const inner = s.slice(i + 2, j - 1)
      out.push(inner)
      i = j
      continue
    }
    i++
  }
  return out
}

// Every command of a command line whose quoting does not resolve, read roughly: split at the separators, at every
// command substitution's start and end and at every parenthesis (a subshell, a case pattern), the quotes taken off each
// word. Only for the rules that must not be lost there.
const ROUGH_CONTROL = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time'])
function roughCommands(cmd) {
  const out = []
  for (const seg of splitSegments(cmd)) {
    for (const piece of seg.split(/\$\(|`|\(|\)/)) {
      let words = piece.trim().split(/\s+/).filter(Boolean)
        .map((v) => ({ value: v.replace(/^['"]+|['"]+$/g, ''), dollar: v.includes('$') }))
      while (words.length && ROUGH_CONTROL.has(words[0].value)) words = words.slice(1)
      if (words.length) out.push(words)
    }
  }
  return out
}

// 47eeb016: the written file the script rule treated as run, and the protected name that matched in its text.
// redirect noise a read-only reading may ignore: fd dups and /dev/null, as whole tokens only (not /dev/nullx)
const REDIRECT_NOISE_RX = /\d*>&\d(?![\w/.])|\d*>\s*\/dev\/null(?![\w/.])/g
let scriptDetail = null
const ASSIGN_RX = /^([A-Za-z_]\w*)=/

// A segment's subshell parentheses: the "(" that open one before its command (after a control word too) and the ")"
// that close one after it, counted, and the command between. The word reader cannot split a parenthesis, and a
// segment it could not split passed unjudged: `(git reset --hard)` went through (Bence 57071). A ")" that is not a
// subshell's (a case pattern's) only ends the cwd of an enclosing subshell early: the stricter reading.
export function subshellParts(own) {
  let body = own
  let opens = 0
  for (let m; (m = /^(?:(?:do|then|else|elif|if|while|until|!|\{)\s+|\(\s*)/.exec(body));) {
    if (m[0].startsWith('(')) opens++
    body = body.slice(m[0].length)
  }
  let closes = 0
  for (let m; (m = /(?<!\\)\s*\)$/.exec(body));) {
    closes++
    body = body.slice(0, m.index)
  }
  return { opens, body: body.trim(), closes }
}

// A directory change anywhere in a command (cd, pushd, popd as a word of their own).
const DIR_CHANGE_RX = /(?:^|[\s;&|(`{])(?:cd|pushd|popd)(?=$|[\s;&|)`}])/

// Bash: does the command write a protected install path? true = deny.
// The fast-path reading context of installFileDeny; caughtItem reads the same one to name what a deny caught.
function strictCtx(cmd, opts) {
  return { root: opts.root ?? INSTALL_ROOT, cwd: opts.cwd ? resolve(String(opts.cwd)) : null, subAgent: opts.subAgent === true, projectDir: opts.projectDir ?? null, configDir: opts.configDir ?? null, shellGlob: true, dotglob: namesDotglob(cmd, true),
    caseInsensitiveFs: typeof opts.caseInsensitiveFs === 'boolean' ? opts.caseInsensitiveFs : undefined,
    reShell: true,
    // WRITEGATERELPATH1115: a command that sets HOME itself: a `cd ~` / `cd $HOME` there leads to no known directory
    homeTouched: /(?<![$\w{])HOME(?!\w)/.test(cmd.replace(/\$(?=['"])|["'\\]/g, '')) }
}

export function installFileDeny(command, opts = {}) {
  scriptDetail = null
  const cmd = String(command ?? '')
  // The fast path below is judged with the STRICT re-shell reading (reShell true: no literal reading, the wider dotglob
  // test), whose hits include the literal reading's; the real reading (for python a python start, py-inline-data.py)
  // is computed only past it. (Only the segment reading below and the dotglob test read it.)
  const ctx0 = strictCtx(cmd, opts)
  const insideDir = (cwd) => !!cwd && installTargets(ctx0.root, ctx0.subAgent, ctx0.projectDir, ctx0.configDir).list.some((t) => t.dir
    && (t.pattern ? ['exact', 'under'].includes(patternRel(pathKey(cwd), t)) : underKey(pathKey(cwd), t.key)))
  const ctx = { ...ctx0, cwdInsideDir: insideDir(ctx0.cwd) }
  // fast path: nothing in any spelling of the whole command reaches a target,
  // and no program in it writes into the cwd on its own
  // (a .claude source, or a dot-glob that may be one, goes on to the segments: claudeDirCopyIn)
  // INSTRWRITEEXEC1105: a printf/echo escape glued to a name (`scripts/hooks\\n`, `\\x2f`) hides it from the raw text, so
  // a command with a backslash is also read with its escapes decoded
  const decoded = cmd.includes('\\') ? decodePrintEscapes(cmd) : ''
  // WRITEGATERELPATH1115: the fast path reads every word from the caller's cwd. After a change of directory a relative
  // word lands elsewhere, so a command that changes directory always goes on to the segments, which follow the cwd.
  if (!DIR_CHANGE_RX.test(cmd) && !hitsIn(cmd, ctx).length && !(decoded && hitsIn(decoded, ctx).length) && !IMPLICIT_WRITER_RX.test(cmd) && !GIT_WORD_RX.test(cmd) && !CLAUDE_DIR_WORD_RX.test(cmd) && !COPIER_WORD_RX.test(cmd)) return false
  // WORKERCFGDIR1104: read over the WHOLE command, a pipe carries a quoted glob to the next segment (`printf '*' | xargs rm`)
  // GATESCRIPTARG1111: a python/node script-file run is no re-shelling program for its quoted arguments (reShellText)
  ctx.reShell = reShellsText(reShellText(cmd, ctx.root))
  ctx.dotglob = namesDotglob(cmd, ctx.reShell)
  // the git environment that redirects a remote or points git at another repo or work tree, anywhere in a git command
  if (GIT_WORD_RX.test(cmd) && GIT_ENV_RX.test(cmd)) return 'git'
  // the cwd is the install root, a directory on the way to a protected path, or
  // inside a protected directory: an implicit writer there reaches it
  const { list, rootKey } = installTargets(ctx.root, ctx.subAgent, ctx.projectDir, ctx.configDir)
  const cwdReaches = (cwd) => {
    if (!cwd) return false
    const key = pathKey(cwd)
    // CPDESTDIR1104: a pattern entry too (a directory on the way to another agent's .mcp.json, or inside a pattern dir)
    return (underKey(key, rootKey) || belowHome(key)) && list.some((t) => {
      if (!t.pattern) return underKey(t.key, key) || (t.dir && underKey(key, t.key))
      const r = patternRel(key, t)
      return r === 'ancestor' || (t.dir && (r === 'exact' || r === 'under'))
    })
  }
  // UNKCWDEXTRACT1121 (review round 3, Dani 1): the CLASS rule (a re-shelling program whose text holds an extract word) does not count the
  // caller's own agent directory as a protected place: the agent writes there anyway (its HANDOFF.md), and a heredoc or a sed text that
  // only NAMES `patch` or `tar` is no extract. An unknown directory, the install root, scripts/ and another agent's directory still
  // count. A target-less extract in the own directory is judged by the rules below as before.
  const ownDirKey = ctx.subAgent ? callerAgentDirKey(ctx.root, ctx.projectDir) : null
  const classProtected = (cwd) => cwdReaches(cwd) && !(ownDirKey && sameKey(pathKey(resolve(cwd)), ownDirKey))
  // CPDESTDIR1104 (Dani 69118, Samu 69122): where a copy, move, link or install LANDS is judged always, not only after
  // a protected word was found. A destination that is a directory names no file, so `cp x/.mcp.json ../other/` found
  // nothing and passed. Each source's landing (destination + its basename) and the destination itself go through
  // classifyWord; a directory source copied recursively, or a content copy (`src/`, `src/.`, ditto), counts as
  // landing ON its target directory, which is judged like a cwd: denied when a protected path is inside or below it.
  // An extracting program's target directory (tar -C, unzip -d, cpio -D, patch -d, 7z -o) is judged the same way.
  const landingDenied = (words, name) => {
    const vals = words.slice(1).map((w) => w.value)
    const absOf = (v) => (v.startsWith('/') || v === '~' || v.startsWith('~/') ? resolve(expandHome(v === '~' ? '~/' : v)) : resolve(ctx.cwd ?? process.cwd(), v))
    if (EXTRACT_DIR_FLAGS[name]) {
      const dir = extractTargetDir(vals, name)
      // UNKCWDEXTRACT1121: a relative target after an unknown directory change is relative to that unknown directory
      if (dir != null && ctx.cwdLost && !(dir.startsWith('/') || dir === '~' || dir.startsWith('~/'))) return true
      // review round 2 R4: a ~user or a brace target is no directory this gate can resolve (the base read it relative to the cwd)
      if (dir != null && (/^~[^/]/.test(dir) || dir.includes('{'))) return true
      return dir != null && cwdReaches(absOf(dir))
    }
    if (!COPIERS.has(name)) return false
    let target = null
    let opts = true
    let recursive = name === 'mv' || name === 'rsync' || name === 'ditto'
    const operands = []
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i]
      if (opts && v === '--') { opts = false; continue }
      if (opts && v.startsWith('--') && v.length > 2) {
        if (v.startsWith('--target-directory=')) target = v.slice('--target-directory='.length)
        else if (v === '--target-directory') target = vals[++i] ?? null
        else if (v === '--recursive' || v === '--archive') recursive = true
        continue
      }
      if (opts && v.startsWith('-') && v.length > 1) {
        if (name !== 'rsync' && /^-[A-Za-z]*t$/.test(v)) target = vals[++i] ?? null // rsync -t keeps times
        else if (name !== 'rsync' && /^-[A-Za-z]*t./.test(v)) target = v.slice(v.indexOf('t') + 1)
        if (/^-[A-Za-z]*[rRa]/.test(v)) recursive = true
        continue
      }
      operands.push(v)
    }
    let dest
    let srcs
    if (target != null) { dest = target; srcs = operands }
    else if (operands.length >= 2) { dest = operands[operands.length - 1]; srcs = operands.slice(0, -1) }
    else if (operands.length === 1 && name === 'ln') { dest = '.'; srcs = operands }
    else return false
    if (['exact', 'under', 'unresolved'].includes(classifyWord(dest, ctx))) return true
    const destAbs = absOf(dest)
    let destIsDir = false
    try { destIsDir = statSync(destAbs).isDirectory() } catch { /* a new name: the copy takes it */ }
    for (const src of srcs) {
      const content = name === 'ditto' || /\/\.?$/.test(src) || src === '.'
      const base = basename(src.replace(/\/+\.?$/, ''))
      const land = content ? destAbs : destIsDir || /\/$/.test(dest) || srcs.length > 1 ? join(destAbs, base) : destAbs
      if (land !== destAbs && ['exact', 'under', 'unresolved'].includes(classifyWord(land, ctx))) return true
      let srcIsDir = content
      if (!srcIsDir && recursive && name !== 'ln') {
        try { srcIsDir = statSync(absOf(src)).isDirectory() } catch { srcIsDir = GLOB_CHAR_RX.test(src) || /\$/.test(src) }
      }
      if (srcIsDir && cwdReaches(land)) return true
    }
    return false
  }
  // UNKCWDEXTRACT1121 (review round 1 N2, N3): the extract rule (a target-less extract into a cwd that is unknown or
  // reaches a protected path; an extract target relative to an unknown cwd, or one that reaches a protected path) on
  // what a command RUNS, at the directory it runs in:
  //   - a wrapper (env, sudo, nice, timeout, ...: unwrapRun) is taken off, and its directory changes (env -C/--chdir,
  //     sudo -D/--chdir), followed in order, are where the command runs: it is judged at each (the stricter); an
  //     expansion, or a relative one from an unknown cwd, is an unknown directory;
  //   - a shell's code (its -c word, or the text piped or heredoc'd into it) is read roughly with its cd followed, every
  //     command at every directory the reading has passed (the stricter, as ancestorOnlyHolds); a shell in that code
  //     once more (two levels).
  const extractAt = (cwd, lost, fn) => {
    const saved = [ctx.cwd, ctx.altCwd, ctx.cwdLost, ctx.cwdInsideDir]
    ctx.cwd = cwd
    ctx.altCwd = null
    ctx.cwdLost = lost
    ctx.cwdInsideDir = insideDir(cwd)
    try { return fn() } finally { [ctx.cwd, ctx.altCwd, ctx.cwdLost, ctx.cwdInsideDir] = saved }
  }
  const extractDenied = (words, stdinCode = '', depth = 0, text = null) => {
    const { rest, chdirs, splits } = unwrapRun(words)
    if (!rest.length && !splits.length) return false
    const n = rest.length ? commandName(rest) : ''
    // review round 2 R2 (fail closed, a class): where the cwd is unknown or reaches a protected path, a program that runs text as commands
    // with an extract word in its text is denied, whatever reading of that text below would or would not follow it
    const ujraShell = reshells(rest, splits)
    const szoveg = text ?? words.map((w) => w.value).join(' ')
    const here = () => {
      if (ujraShell && (ctx.cwdLost || classProtected(ctx.cwd)) && writerWordIn(szoveg)) return true
      // R1: env -S / --split-string: each split string is a command line, read as one
      for (const sp of splits) if (depth >= 2 ? writerWordIn(sp) : roughExtracts(sp, depth + 1)) return true
      if (!rest.length) return false
      if (writesIntoCwd(rest, n) && (ctx.cwdLost || cwdReaches(ctx.cwd))) return true
      if (EXTRACT_DIR_FLAGS[n] && landingDenied(rest, n)) return true
      // the depth limit: a code text read no deeper is denied when it holds an extract word (fail closed)
      const tovabb = (code) => !!code && (depth >= 2 ? writerWordIn(code) : roughExtracts(code, depth + 1))
      const sn = rest.length ? (commandName(rest) || rest[0].value.slice(rest[0].value.lastIndexOf('/') + 1)) : ''
      if (!SHELLS_ALL.has(sn)) return false
      // R2: the -c code is the word after -c; a rough reading (depth > 0) splits the code into words, so all of them from there on are the code
      const ci = rest.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.value))
      let code = ''
      if (ci > 0) {
        const k = ci + 1 < rest.length ? ci + 1 : -1
        code = k < 0 ? '' : depth > 0 ? rest.slice(k).map((w) => w.value).join(' ') : rest[k].value
      } else {
        // the stdin is the code: no script word, or -s (its positional words are arguments), or a script word that is the stdin
        const lead = rest.slice(1)
        const elso = lead.find((w) => !w.value.startsWith('-'))
        if (!elso || lead.some((w) => /^-[A-Za-z]*s[A-Za-z]*$/.test(w.value)) || STDIN_SCRIPTS.has(elso.value)) code = stdinCode
      }
      return tovabb(code)
    }
    // the directory changes in order (`env -C a sudo -D b`: b from a); the command runs in the LAST one (N5, review round 2): the
    // intermediate ones are only the base of a relative later one. An expansion, a brace, ~user or a relative one from an unknown cwd: unknown
    const at = () => {
      if (!chdirs.length) return here()
      let cur = ctx.cwdLost ? null : ctx.cwd ?? null
      for (const d of chdirs) {
        if (!d || /[$`*?[{]/.test(d) || /^~[^/]/.test(d)) cur = null
        else if (d.startsWith('/') || d === '~' || d.startsWith('~/')) cur = resolve(expandHome(d === '~' ? '~/' : d))
        else cur = cur ? resolve(cur, d) : null
      }
      return extractAt(cur, !cur, here)
    }
    return !!(at() || (ctx.altCwd && extractAt(ctx.altCwd, false, at)))
  }
  const roughExtracts = (text, depth = 0) => {
    const c = { ...ctx }
    const cwds = [[ctx.cwd ?? null, !!ctx.cwdLost], ...(ctx.altCwd ? [[ctx.altCwd, false]] : [])]
    for (const words of roughCommands(text)) {
      if (cwds.some(([cwd, lost]) => extractAt(cwd, lost, () => extractDenied(words, '', depth)))) return true
      if (!['cd', 'pushd', 'popd'].includes(words[0].value)) continue
      cwdAfterSegment(words.map((w) => w.value).join(' '), c)
      const next = [c.cwd ?? null, !c.cwd]
      if (!cwds.some(([cwd, lost]) => cwd === next[0] && lost === next[1])) cwds.push(next)
    }
    return false
  }
  // A flat $(...) naming a protected path is kept as written (not replaced by an
  // opaque marker), so its segment fails to parse below and is denied.
  // 47eeb016: ...unless the outer command is a reader and everything inside the substitution is a plain reader too
  // (`grep -n x $(ls <root>/scripts/hooks/*.mjs)`): nothing there can write, so the substitution is blanked as usual.
  // Anything else (a redirect write, a directory changer, an interpreter, a non-reader outer such as curl -d) stays kept.
  let outerReadersOnly
  const outerIsReader = () => {
    if (outerReadersOnly !== undefined) return outerReadersOnly
    let flat = cmd
    for (let i = 0; i < 8; i++) flat = flat.replace(/[$<]\(([^()]*)\)/g, ' X ')
    outerReadersOnly = !/[$<>`()]/.test(flat.replace(REDIRECT_NOISE_RX, '')) && splitSegments(flat).filter(Boolean).every((sg) => {
      const w = shellWords(sg)
      if (!w || !w.length) return false
      const n = commandName(w)
      return READERS.has(n) || isReadOnlyFsCommand(w, n)
    })
    return outerReadersOnly
  }
  const innerReadOnly = (inner) => {
    if (/>/.test(inner.replace(REDIRECT_NOISE_RX, ''))) return false
    const cmds = roughCommands(inner)
    return cmds.length > 0 && cmds.every((w) => {
      const n = commandName(w)
      // DIR_CHANGERS decides only for `find` here: a find with no action counts as read-only below, but it walks a
      // directory, so it stays kept as written (conservative). The other directory changers are never readers.
      if (DIR_CHANGERS.has(n) || INTERPRETERS.has(n) || writesIntoCwd(w, n)) return false
      return READERS.has(n) || isReadOnlyFsCommand(w, n)
    })
  }
  // 47eeb016: a flat process substitution `<(cat <path>)` is blanked under the same two conditions (shellWords cannot
  // read it, so it would deny the whole segment); with a writer inside or a non-reader outer it stays.
  const cmdForSegs = cmd.replace(/<\(([^()]*)\)/g, (full, inner) =>
    hitsIn(inner, ctx).length > 0 && outerIsReader() && innerReadOnly(inner) ? ' X ' : full)
  const segs = shellSegments(cmdForSegs, { surface: 'security', projectRoot: ctx.root,
    keepSubst: (inner) => hitsIn(inner, ctx).length > 0 && !(outerIsReader() && innerReadOnly(inner)) })
  // A git write or an implicit cwd writer inside a live command substitution: the segments below see only a marker
  // in its place.
  for (const inner of liveSubstitutions(cmd)) {
    for (const words of roughCommands(inner)) {
      const git = gitWords(words)
      if (git && gitDecision(git, ctx) === 'deny') return 'git'
      if (writesIntoCwd(words, commandName(words)) && cwdReaches(ctx.cwd)) return true
    }
    if (roughExtracts(inner)) return true // UNKCWDEXTRACT1121 (review N3): its cd followed
  }
  // An unresolved quoting whose only mention is a directory on the way to a protected path, the install root itself
  // most often (`cd <root>; ... "$(cd $d; git remote get-url origin)"`, Marveen 57083). Holds when the rest, read
  // roughly with its cd followed, names no protected path from the cwd each command runs in, and no substitution's own
  // text names one (ancestor too) from any of those cwds. A cd that cannot be followed outside a substitution: no.
  // The git rule and the implicit writer rule run from the followed cwd too, every command of a substitution from each
  // of those cwds (Dani 57368: measured from the caller's cwd, `cd <root>; tar -xf ...; echo "$(date $y)"` passed).
  const writes = (words, cw) => {
    const git = gitWords(words)
    return (git && gitDecision(git, cw) === 'deny') || (writesIntoCwd(words, commandName(words)) && cwdReaches(cw.cwd))
  }
  const ancestorOnlyHolds = (text) => {
    const subs = liveSubstitutions(text)
    let outer = text
    for (const s of subs) outer = outer.split('$(' + s + ')').join(' ').split('`' + s + '`').join(' ')
    const c = { ...ctx }
    const cwds = [c.cwd]
    // Every command is measured from EVERY cwd the reading has passed, the caller's included: the rough reading follows
    // each cd unconditionally (one in a subshell, or after || / &&, may not run, Dani 57400), so a cd followed wrongly
    // can only make it stricter.
    for (const words of roughCommands(outer)) {
      c.cwdInsideDir = insideDir(c.cwd)
      const line = words.map((w) => w.value).join(' ')
      for (const cwd of cwds) {
        const at = { ...ctx, cwd, cwdInsideDir: insideDir(cwd) }
        if (hitsIn(line, at).some((h) => h.kind !== 'ancestor') || writes(words, at)) return false
      }
      if (!['cd', 'pushd', 'popd'].includes(words[0].value)) continue
      cwdAfterSegment(line, c)
      if (!c.cwd) return false
      if (!cwds.includes(c.cwd)) cwds.push(c.cwd)
    }
    return !subs.some((s) => cwds.some((cwd) => {
      const at = { ...ctx, cwd, cwdInsideDir: insideDir(cwd) }
      return hitsIn(s, at).length || roughCommands(s).some((words) => writes(words, at))
    }))
  }
  // INSTRWRITEEXEC1105: a script text that, read with its cd followed, runs a directory-changing program (rm, mv, cp,
  // chmod, find, tar, ...) on a path that names a protected one or a directory on the way to one (`cd <root> && rm -rf
  // scripts`): the earlier heredoc rule denied every such name, so an ancestor-only allowance must not let this pass.
  const dirChangeInScript = (text) => {
    const c = { ...ctx }
    const cwds = [c.cwd]
    for (const words of roughCommands(text)) {
      const line = words.map((w) => w.value).join(' ')
      if (DIR_CHANGERS.has(commandName(words)) && cwds.some((cwd) => hitsIn(line, { ...ctx, cwd, cwdInsideDir: insideDir(cwd) }).length)) return true
      if (!['cd', 'pushd', 'popd'].includes(words[0].value)) continue
      cwdAfterSegment(line, c)
      if (!c.cwd) return true
      if (!cwds.includes(c.cwd)) cwds.push(c.cwd)
    }
    return false
  }
  // INSTRWRITEEXEC1105: the directories later segments move to (cd/pushd, a subshell's included, conservatively), or
  // null when a cd cannot be followed
  const laterCwds = (k) => {
    const c = { ...ctx }
    const out = []
    for (let j = k + 1; j < segs.length; j++) {
      const body = subshellParts(segs[j].own).body
      // GATEOPENFORMS1118: a wrapper's directory change (env --chdir/-C, sudo -D) is where its command runs
      const ws = shellWords(body)
      for (const d of ws ? unwrapRun(ws).chdirs : []) {
        if (/[$`*?[]/.test(d) || !c.cwd) return null
        const at = d.startsWith('/') || d === '~' || d.startsWith('~/') ? resolve(expandHome(d === '~' ? '~/' : d)) : resolve(c.cwd, d)
        if (at !== ctx.cwd && !out.includes(at)) out.push(at)
      }
      cwdAfterSegment(body, c)
      if (!c.cwd) return null
      if (c.cwd !== ctx.cwd && !out.includes(c.cwd)) out.push(c.cwd)
    }
    return out
  }
  // (a null cwd: a directory this gate cannot know, read with the lost-cwd reading, GATEOPENFORMS1118)
  const atCwd = (cwd, fn) => {
    const c = ctx.cwd
    const d = ctx.cwdInsideDir
    const l = ctx.cwdLost
    ctx.cwd = cwd
    ctx.cwdInsideDir = insideDir(cwd)
    if (cwd === null) ctx.cwdLost = true
    try { return fn() } finally { ctx.cwd = c; ctx.cwdInsideDir = d; ctx.cwdLost = l }
  }
  // INSTRWRITEEXEC1105: the text of the segments piped into segment k (printf/echo decoded, a reader's heredoc only)
  const pipedInText = (k) => {
    const feeders = []
    for (let j = k; j > 0 && (segs[j - 1].sep === '|' || segs[j - 1].sep === '|&'); j--) {
      const fw = shellWords(segs[j - 1].own)
      feeders.push(scriptTextOf(segs[j - 1].own, segs[j - 1].bodies, fw ? commandName(fw) : ''))
    }
    return feeders.reverse().filter(Boolean).join('\n')
  }
  // shell code text: a protected name in it is denied; a directory on the way to one passes only when the text, read
  // with its cd followed, names and writes nothing protected and runs no directory-changing program on such a path
  const shellTextDenied = (text) => {
    const hits = hitsIn(text, ctx)
    return hits.some((h) => h.kind !== 'ancestor') || (hits.length > 0 && (!ancestorOnlyHolds(text) || dirChangeInScript(text)))
  }
  if (!segs) {
    // The quoting does not resolve: a command substitution with quotes or an expansion inside, most often a plain reader
    // (`echo "$(git log -1 --format='%ad' $c)"`, Dani 56794). A protected path anywhere in it: fail closed. Otherwise
    // the git and the implicit-writer rules still run on a rough reading of every command in it, so a write hidden in
    // a substitution is not lost.
    const hits = hitsIn(cmd, ctx)
    if (hits.some((h) => h.kind !== 'ancestor') || (hits.length && !ancestorOnlyHolds(cmd))) return true
    // GATEPATHNORM1118 (e): a file written by a redirect and named again later, in a command the segmenter cannot read
    // (a quoted substitution with an expansion inside: bash <<< "$(cat $S/a.sh)", eval "`cat $S/a.sh`"). The written
    // text cannot be told apart from its run here, so it is read as commands: quotes and printf/echo escapes undone, a
    // protected name in it is denied.
    const written = [...cmd.matchAll(/>>?\s*['"]?([^\s;&|'"()<>`]+)/g)].map((m) => ({ t: m[1], at: m.index + m[0].length }))
      .filter(({ t }) => t !== '/dev/null' && !/^&\d*-?$/.test(t) && lastPart(t))
    if (written.some(({ t, at }) => cmd.slice(at).includes(lastPart(t)))) {
      const asCommands = cmd.replace(/\\[nr]/g, '\n').replace(/['"`]/g, ' ')
      if (hitsIn(asCommands, ctx).some((h) => h.kind !== 'ancestor')) return true
    }
    for (const words of roughCommands(cmd)) {
      const git = gitWords(words)
      if (git && gitDecision(git, ctx) === 'deny') return 'git'
      if (writesIntoCwd(words, commandName(words)) && cwdReaches(ctx.cwd)) return true
      if (landingDenied(words, commandName(words))) return true
    }
    if (roughExtracts(cmd)) return true // UNKCWDEXTRACT1121 (review N3): its cd followed
    return false
  }
  const tainted = new Set()
  const taintedIn = (text) => [...tainted].some((n) => new RegExp(`\\$\\{?${n}(?!\\w)`).test(text))
  // INSTRFILES1104 A: a check run at the cwd and, after a cd that may have failed (moveCwd), at the old directory too
  const atAlt = (fn) => {
    if (!ctx.altCwd) return undefined
    const c = ctx.cwd
    const d = ctx.cwdInsideDir
    ctx.cwd = ctx.altCwd
    ctx.cwdInsideDir = insideDir(ctx.cwd)
    try { return fn() } finally { ctx.cwd = c; ctx.cwdInsideDir = d }
  }
  const both = (fn) => fn() || atAlt(fn)
  const hitsBoth = (text) => [...hitsIn(text, ctx), ...(atAlt(() => hitsIn(text, ctx)) ?? [])]
  // A subshell's cd ends with it: the cwd before its "(" comes back after its ")".
  const cwdStack = []
  let closing = 0
  const literalCds = literalCdSegments(cmdForSegs, segs)
  for (const seg of segs) {
    for (; closing > 0; closing--) if (cwdStack.length) [ctx.cwd, ctx.altCwd, ctx.cwdLost] = cwdStack.pop()
    const sub = subshellParts(seg.own)
    for (let k = 0; k < sub.opens; k++) cwdStack.push([ctx.cwd, ctx.altCwd ?? null, !!ctx.cwdLost]) // UNKCWDEXTRACT1121 (review N1): and whether it was lost
    closing = sub.closes
    const own = sub.body
    const ownMove = literalCds.get(segs.indexOf(seg)) ?? own // UNKCWDEXTRACT1121 (review round 3, Dani 2): a cd to a literal variable
    const words = shellWords(own)
    // INSTRFILES1104 A: with no re-shelling program in the command, quoted spans and heredoc bodies hold no glob.
    // Not when a later segment of the command runs the file this one writes (Dani 69850: `cat > x.sh <<'EOF' ...
    // EOF; chmod +x x.sh && ./x.sh` runs the body as shell code, its globs expand): then both stay strict.
    const runsWritten = !!words && laterRuns(segs, segs.indexOf(seg), words.redirects.map((t) => t.value).filter((v) => v !== '/dev/null'))
    const literal = !ctx.reShell && !runsWritten
    const bodies = literal ? seg.bodies.map(literalHeredocBody) : seg.bodies
    const ownText = literal ? literalQuotedGlobs(own) : own
    const view = { ...seg, own, bodies, text: [ownText, ...bodies].join('\n') }
    ctx.cwdInsideDir = insideDir(ctx.cwd)
    // WORKERCFGDIR1104: the segment's own text (a heredoc body is never globbed) and the whole command (re-shelling)
    // decide the noBareGlob skip
    ctx.bareGlobQuoted = ctx.reShell === false && !unquotedBareGlob(own)
    const rawHits = hitsBoth(view.text)
    const usesTainted = taintedIn(own)
    // A segment the word reader still cannot split (a case pattern, an arithmetic group): its git commands are read
    // roughly, so they reach the git rule.
    if (!words) {
      for (const rough of roughCommands(own)) {
        const g = gitWords(rough)
        if (g && gitDecision(g, ctx) === 'deny') return 'git'
      }
      if (roughExtracts(own)) return true // UNKCWDEXTRACT1121 (review N3)
    }
    const name = words ? commandName(words) : ''
    if (words && words.length && DIR_CHANGERS.has(name) && both(() => claudeDirCopyIn(words, ctx))) return true
    const git = words && gitWords(words)
    if (git) {
      const g = gitDecision(git, ctx)
      if (g === 'deny') return 'git'
      if (g === 'allow') continue
    }
    if (words && words.length && !usesTainted && both(() => landingDenied(words, name))) return true
    // INSTRWRITEEXEC1105: a file this segment writes and a later segment of the same command runs or feeds (a script)
    // holds shell code, whatever wrote it: a heredoc body, the text of printf/echo, the code of a program that prints
    // (sed, awk, ...), and the same of the segments piped into the writer. A reader (cat, ls, grep, ...) puts file
    // contents there, not its arguments, so only its heredoc body counts. The script text is judged as commands: a
    // protected name in it is denied; a directory on the way to one (the install root) passes only when the text,
    // read with its cd followed, names and writes nothing protected (ancestorOnlyHolds). A message or comment file
    // that is only written, read or sent on (curl -d @file) passes (Marveen 56653). This replaces the heredoc-only
    // rule. A printf/echo escape (\n, \r) is the line break it prints.
    if (words && words.length) {
      const targets = words.redirects.map((r) => r.value).filter((v) => v !== '/dev/null')
      const k = segs.indexOf(seg)
      // a later segment that starts with an assignment (`PATH=... bash F`, `X=1 ./F`) and names the file is read as
      // running it: laterRuns sees the assignment as the command word (Dani #2546)
      // ...only when the file is that command or the script word of a shell or an interpreter after it; a file that is
      // only an argument of another script (`CARD=X sh card.sh note.txt`) is not run
      const prefixedRun = () => segs.slice(k + 1).some((s) => {
        if (!/^\s*[A-Za-z_]\w*=/.test(s.own)) return false
        const ws = shellWords(s.own)
        if (!ws) return false
        const rest = ws.map((w) => w.value).filter((v, i, a) => !a.slice(0, i + 1).every((x) => /^[A-Za-z_]\w*=/.test(x)))
        const [w, ...args] = rest
        if (!w) return false
        if (spellings.includes(w)) return true
        if (!/^(?:\S*\/)?(?:(?:ba|z|da|k)?sh|source|\.|python[\d.]*|node|perl|ruby|php)$/.test(w)) return false
        const script = args.find((v) => !v.startsWith('-'))
        return script !== undefined && spellings.includes(script)
      })
      // GATEPATHNORM1118: the run checks take every spelling of the written file, resolved at each segment's directory
      const spellings = targets.length ? writtenFileSpellings(segs, k, targets, ctx) : targets
      if (targets.length && (runsWrittenFile(segs, k, spellings, cmd) || prefixedRun())) {
        const text = [pipedInText(k), scriptTextOf(own, seg.bodies, name)].filter(Boolean).join('\n')
        // a name an earlier segment assigned a protected path to, used in the text: an unquoted heredoc expands it as it
        // is written, an exported one expands as the file runs
        if (taintedIn(text)) { scriptDetail = { file: targets[0], name: text.match(/\$\{?(\w+)/)?.[0] ?? '(tainted variable)' }; return true }
        // GATEPATHNORM1118: "only a shell runs it" read over the other spellings too, so a run under another spelling is
        // read as the same run under the written one. Where the written names are named again (the only runs the earlier
        // reading saw), the written names must agree as well; the later-directory reading takes either: neither can pass
        // more than before.
        const literalNamed = segs.slice(k + 1).some((s) => targets.some((t) => [s.own, ...s.bodies].join('\n').includes(t)))
          || liveSubstitutions(cmd).some((x) => namesAny(x, targets))
        const shellRunsOnlyJudge = () => shellRunsOnly(segs, k, spellings, text) && (!literalNamed || shellRunsOnly(segs, k, targets, text))
        const shellRunsOnlyLater = () => shellRunsOnly(segs, k, targets, text) || shellRunsOnly(segs, k, spellings, text)
        // judged at the cwd and, after a cd that may have failed, at the old directory too (INSTRFILES1104 A)
        const judge = () => {
          const hits = text ? hitsIn(text, ctx) : []
          if (hits[0]) scriptDetail = { file: targets[0], name: hits[0].word }
          if (hits.some((h) => h.kind !== 'ancestor')) return true
          // The ancestor-only pass reads the text as shell (its cd followed). It holds only when a shell is what runs
          // the file; another interpreter changes directory in its own language, which this reading does not see.
          return hits.length > 0 && (!shellRunsOnlyJudge() || !ancestorOnlyHolds(text) || dirChangeInScript(text))
        }
        if (both(judge)) return true
        // ...and at every directory a later segment moves to before the file runs (`cd <dir> && sh s.sh`, Dani #2546):
        // a relative name in the script resolves there. A protected name there is denied; a directory on the way to
        // one counts only for a shell run (a file another program reads as data, a message the kanban tool sends,
        // names the install root's subdirectories without running them). A later cd that cannot be followed is read as
        // its inline form is (PATHGLOBSPLIT1105).
        const judgeLater = () => {
          const hits = text ? hitsIn(text, ctx) : []
          if (hits[0]) scriptDetail = { file: targets[0], name: hits[0].word }
          if (hits.some((h) => h.kind !== 'ancestor')) return true
          return hits.length > 0 && shellRunsOnlyLater() && (!ancestorOnlyHolds(text) || dirChangeInScript(text))
        }
        // GATEOPENFORMS1118: a later directory change that cannot be followed (`cd $D && sh s.sh`) is an unknown
        // directory: the text is read there as a command run after such a cd is (WRITEGATERELPATH1115)
        if ((laterCwds(k) ?? [null]).some((cwd) => atCwd(cwd, judgeLater))) return true
      }
      // The text a shell runs itself gets the same reading: its -c code, or, when it names no script file, its heredoc
      // and what is piped into it (`sh -c 'rm -rf scripts'` at the root removes a protected directory's parent).
      if (SHELL_RUNNERS.has(name)) {
        const ci = words.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.value))
        const code = ci > 0 ? (words[ci + 1]?.value ?? '')
          : words.slice(1).every((w) => w.value.startsWith('-')) ? [pipedInText(k), ...seg.bodies].filter(Boolean).join('\n') : ''
        if (code && (taintedIn(code) || both(() => shellTextDenied(code)))) return true
      }
    }
    // UNKCWDEXTRACT1121: after a directory change the gate cannot follow, a target-less extract lands in an unknown
    // directory -- possibly the install root or scripts/ -- so it is denied in either branch below (fail closed, as
    // WRITEGATERELPATH1115 reads a relative word after such a cd); behind a wrapper and in a shell's code too (review N2, N3)
    if (words && words.length) {
      const bemenet = [pipedInText(segs.indexOf(seg)), ...seg.bodies].filter(Boolean).join('\n')
      if (extractDenied(words, bemenet, 0, [own, bemenet].join('\n'))) return true
    }
    if (!rawHits.length && !usesTainted) {
      if (words && words.length && writesIntoCwd(words, name) && (cwdReaches(ctx.cwd) || (!!ctx.altCwd && cwdReaches(ctx.altCwd)))) return true
      moveCwd(ownMove, seg, ctx, cwdReaches)
      continue
    }
    if (!words || !words.length) return true
    // an output redirect onto a protected path (or onto a word built at run time)
    for (const r of words.redirects) {
      if (r.value === '/dev/null') continue
      if (both(() => ['exact', 'under', 'unresolved'].includes(classifyWord(r.value, ctx)))) return true
      if (usesTainted && /\$/.test(r.value)) return true
    }
    // an assignment carries the path to a later word (`F=<path>; cp x $F`): the
    // name is tainted, and a later segment that uses it is judged as naming it
    if (words.every((w) => ASSIGN_RX.test(w.value)) || /^(?:export|local|declare|readonly|typeset)$/.test(words[0].value)) {
      for (const w of words) { const m = ASSIGN_RX.exec(w.value); if (m) tainted.add(m[1]) }
      continue
    }
    const hits = hitsBoth(dataResidue(view, words, name, { surface: 'security' }))
    if (!hits.length && !usesTainted) { moveCwd(ownMove, seg, ctx, cwdReaches); continue } // only message data names it
    if (READERS.has(name) || isReadOnlyFsCommand(words, name)) {
      // ...but not as the file list of a pipe into a program that acts on it (xargs rm)
      const next = segs[segs.indexOf(seg) + 1]
      if ((seg.sep === '|' || seg.sep === '|&') && next) {
        const nw = shellWords(next.own)
        const nn = nw ? commandName(nw) : ''
        if (!nw || !(READERS.has(nn) || isReadOnlyFsCommand(nw, nn))) return true
      }
      moveCwd(ownMove, seg, ctx, cwdReaches)
      continue
    }
    if (name === 'git' && gitIsRead(words)) continue
    // PLUGINCODEWRITE1104: a `cp` whose DESTINATION (its last operand) is no protected path only reads the protected
    // sources it names (copying a shared skill into one's own directory). A link-making or target-directory flag
    // (-l, -s, -t, --link, --symbolic-link, --target-directory) keeps the deny: the copy would share the protected file.
    if (!usesTainted && name === 'cp' && cpOnlyReadsProtected(words, ctx)) { moveCwd(ownMove, seg, ctx, cwdReaches); continue }
    const hitWords = new Set(hits.map((h) => h.word))
    if (!usesTainted && isExecOf(words, name, hitWords)) continue
    if (!usesTainted && hits.every((h) => h.kind === 'ancestor') && !DIR_CHANGERS.has(name)) continue
    return true
  }
  // (A path inside a $(...) is not lost to the parser: keepSubst above keeps
  // that substitution as written, and its segment then fails to parse.)
  return false
}

// Native file tools: the target, resolved against the payload cwd.
export function fileToolDeny(toolInput, opts = {}) {
  const raw = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
  if (!raw) return null
  if (nameForms(raw).some((f) => DB_FILE_NAME_RX.test(f))) return 'db'
  const ctx = { root: opts.root ?? INSTALL_ROOT, cwd: opts.cwd ? resolve(String(opts.cwd)) : process.cwd(), subAgent: opts.subAgent === true, projectDir: opts.projectDir ?? null, configDir: opts.configDir ?? null }
  const c = classifyWord(raw, ctx)
  return c === 'exact' || c === 'under' || c === 'unresolved' ? 'install-file' : null
}

// `claude mcp add|add-json|add-from-claude-desktop|remove` (ENVRELAXMCPCFG1104, Dani 68088, Samu 68092): the CLI
// writes an MCP server list itself, so no path appears in the command. A sub-agent may not run it, for any --scope;
// the main agent may. The invocation is found by the child-claude guard's own parser (a `claude` at a segment's start,
// after env assignments and wrappers). Not seen (stated limit, Dani 68129): a `claude` not at a segment's start --
// started from a script, inside `bash -c`/`sh -c`, through `xargs`, as `$(which claude)` or from a variable
// (`C=claude; $C`) -- or as `npx @anthropic-ai/claude-code`. The same class holds for the other text gates; the
// shell-code recursion is separate, wider work.
const CLAUDE_MCP_WRITE_SUBS = new Set(['add', 'add-json', 'add-from-claude-desktop', 'remove'])
export function claudeMcpListWrite(command) {
  return claudeInvocations(String(command ?? '')).some((args) => {
    const i = args.indexOf('mcp')
    return i >= 0 && CLAUDE_MCP_WRITE_SUBS.has(args[i + 1])
  })
}

// `claude plugin|plugins ...` (PLUGINCODEWRITE1104, Samu 68214 D4): an ALLOWLIST, so an alias or a later subcommand is
// denied too. A sub-agent may run only `list`, `validate`, `marketplace list` and any `-h`/`--help`; everything else
// (install, uninstall, enable, disable, update, marketplace add/remove/update, ...) is denied, also with a throwaway
// CLAUDE_CONFIG_DIR (the tmp dir can be a symlink onto a guarded tree in the same command: a conditional allow would
// be a TOCTOU; the main agent runs such a probe, Samu 68247). Also a `claude` started with `--plugin-dir` or with a
// `--settings` that names plugins or marketplaces loads code the gate never saw. Same parser and the same stated
// limit as claudeMcpListWrite (a `claude` not at a segment's start is not seen).
const CLAUDE_PLUGIN_READS = new Set(['list', 'validate'])
export function claudePluginWrite(command) {
  return claudeInvocations(String(command ?? '')).some((args) => {
    if (args.some((a) => a === '--plugin-dir' || a.startsWith('--plugin-dir='))) return true
    const si = args.findIndex((a) => a === '--settings' || a.startsWith('--settings='))
    if (si >= 0) {
      const v = args[si].startsWith('--settings=') ? args[si].slice(11) : (args[si + 1] ?? '')
      if (/enabledPlugins|extraKnownMarketplaces|pluginDirs?/.test(v) || !v) return true
    }
    const i = args.findIndex((a) => a === 'plugin' || a === 'plugins')
    if (i < 0) return false
    const rest = args.slice(i + 1)
    if (rest.includes('-h') || rest.includes('--help')) return false
    const sub = rest.find((a) => !a.startsWith('-'))
    if (!sub) return false // `claude plugin` alone prints help
    if (CLAUDE_PLUGIN_READS.has(sub)) return false
    if (sub === 'marketplace') {
      const sub2 = rest.slice(rest.indexOf('marketplace') + 1).find((a) => !a.startsWith('-'))
      return sub2 !== 'list'
    }
    return true
  })
}

// --- MCP tools (MCPWRITEGATE1104) -------------------------------------------------------------------------------
// An MCP tool reaches local paths through its own arguments (mcp-file-targets.mjs names them). Each one is judged on
// this gate's own engine:
//   a written file              -- as the native Write branch judges its file_path (fileToolDeny);
//   a mover's path, or a directory a file lands in under a name the call does not fix
//                               -- also when it is a protected path's ANCESTOR (a whole tree moves; an unnamed file
//                                  can land on a protected name). Unlike classifyWord's own ancestor rule, this one
//                                  is not limited to the install root: ~/.gitconfig and ~/.claude.json count too.
// A relative path is measured against the payload cwd AND the project dir: an MCP server resolves it against the cwd
// it was started in, which the Bash tool's `cd` does not move. Either one landing on a protected path denies.
// The 'other' class (read, send) is judged for a SUB-AGENT only, and only as a file (D1, Samu 68033).

// Is `raw`, as a directory or a moved tree, a protected path, inside one, or above one?
function dirTargetDeny(raw, opts) {
  if (nameForms(raw).some((f) => DB_FILE_NAME_RX.test(f))) return 'db'
  const ctx = { root: opts.root ?? INSTALL_ROOT, cwd: opts.cwd ? resolve(String(opts.cwd)) : process.cwd(), subAgent: opts.subAgent === true, projectDir: opts.projectDir ?? null, configDir: opts.configDir ?? null }
  const c = classifyWord(raw, ctx)
  if (c) return 'install-file' // exact, under, unresolved, or an ancestor inside the root
  const w = String(raw)
  const abs = resolve(ctx.cwd, w === '~' || w.startsWith('~/') ? expandHome(w === '~' ? '~/' : w) : w)
  const key = pathKey(abs)
  const { list } = installTargets(ctx.root, ctx.subAgent, ctx.projectDir, ctx.configDir)
  for (const t of list) {
    if (t.pattern) {
      if (ownedByCaller(t, key)) continue
      // agents/*/x: the directory is the pattern's parent or above it (one `*` per segment)
      for (let i = 0; i < key.length; i++) {
        const K = normalizePathSegments(key[i])
        const T = normalizePathSegments(t.key[i] ?? t.key[0])
        if (K.length < T.length && K.every((seg, x) => T[x] === '*' ? seg !== '' : T[x] === seg)) return 'install-file'
      }
      continue
    }
    if (sameKey(key, t.key) || underKey(t.key, key)) return 'install-file'
  }
  return null
}

function mcpVerdict(m, opts) {
  const cwd = opts.cwd ? resolve(String(opts.cwd)) : process.cwd()
  const bases = [...new Set([cwd, opts.projectDir ? resolve(String(opts.projectDir)) : null].filter(Boolean))]
  let worst = null
  for (const t of m.targets) {
    for (const base of bases) {
      const o = { ...opts, cwd: base }
      const r = m.cls === 'other' ? fileToolDeny({ file_path: t.path }, o)
        : t.dir ? dirTargetDeny(t.path, o) // a mover's paths come marked dir (mcp-file-targets.mjs)
        : fileToolDeny({ file_path: t.path }, o)
      if (r === 'db') return 'db'
      if (r) worst = r
    }
  }
  // A base INSIDE a guarded directory (Dani 68255): there every bare name is a path into it, so the bare leaves the
  // classifier left out are judged as files too. Outside one (the usual case) this costs nothing.
  if (m.bare?.length) {
    for (const base of bases) {
      const ctx = { root: opts.root ?? INSTALL_ROOT, subAgent: opts.subAgent === true, projectDir: opts.projectDir ?? null, configDir: opts.configDir ?? null }
      const key = pathKey(base)
      if (!installTargets(ctx.root, ctx.subAgent, ctx.projectDir, ctx.configDir).list.some((t) => t.dir
        && (t.pattern ? ['exact', 'under'].includes(patternRel(key, t)) : underKey(key, t.key)))) continue
      for (const b of m.bare) {
        const r = fileToolDeny({ file_path: b }, { ...opts, cwd: base })
        if (r === 'db') return 'db'
        if (r) worst = r
      }
    }
  }
  return worst
}

export function mcpDecision(toolName, toolInput, opts = {}) {
  const m = mcpFileTargets(toolName, toolInput)
  if (!m) return null
  if (m.dbNamed) return { deny: true, reason: 'db' } // the DB by name, any class, any caller (as the native tools)
  if (m.cls !== 'other' && (m.missingPath || m.truncated)) return { deny: true, reason: 'mcp-path' }
  if (m.cls === 'other' && opts.subAgent !== true) return { deny: false }
  const r = mcpVerdict(m, opts)
  if (!r) return { deny: false }
  if (r === 'db') return { deny: true, reason: 'db' }
  if (opts.subAgent === true && !mcpVerdict(m, { ...opts, subAgent: false })) return { deny: true, reason: 'mcp-subagent-file' }
  return { deny: true, reason: 'mcp-install-file' }
}

// Refs #2974, #2975: how deep a shell code inside a shell code is still read (bash -c "sh -c '...'"); deeper denies.
const SHELL_CODE_DEPTH = 8

function decide(toolName, toolInput, opts = {}, depth = 0) {
  const name = String(toolName ?? '')
  if (/^mcp__/i.test(name)) return mcpDecision(name, toolInput, opts) ?? { deny: false }
  // A deny that only the sub-agent list gives gets its own message (ENVRELAXGATE1104).
  const subOnly = () => opts.subAgent === true
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const r = fileToolDeny(toolInput, opts)
    if (r === 'install-file' && subOnly() && !fileToolDeny(toolInput, { ...opts, subAgent: false })) return { deny: true, reason: 'subagent-file' }
    return r ? { deny: true, reason: r } : { deny: false }
  }
  if (name === 'Bash') {
    const command = String(toolInput?.command ?? '')
    if (subOnly() && claudeMcpListWrite(command)) return { deny: true, reason: 'subagent-file' }
    if (subOnly() && claudePluginWrite(command)) return { deny: true, reason: 'subagent-file' }
    if (scheduleSurfaceDeny(command, { surface: 'security', projectRoot: opts.root ?? INSTALL_ROOT })) return { deny: true, reason: 'db' }
    scriptDetail = null
    // VARDEFDB1121: a variable that is definitely a literal here is read as that literal (W=/abs; git -C $W)
    const paths = substituteDefiniteCommand(command)
    const file = installFileDeny(paths, opts)
    if (file === true && subOnly() && !installFileDeny(paths, { ...opts, subAgent: false })) return { deny: true, reason: 'subagent-file' }
    if (file) return { deny: true, reason: file === 'git' ? 'git' : 'install-file' }
    // Refs #2974, #2975: the code this command hands to a shell (sh/bash -c, eval, trap, a shell reading a heredoc or a
    // here-string, source) runs as a command of its own, so it is judged as one, with every rule above: the file-level
    // database rule (#2974) and a `cd` to an unknown directory read as the install (#2975) reach it too. It is judged in
    // the caller's cwd. This only adds denies: the outer command was already judged and passed.
    const codes = shellCodeStrings(command, { strictStdin: true })
    if (codes.length && depth >= SHELL_CODE_DEPTH) return { deny: true, reason: 'install-file' }
    for (const code of codes) {
      const inner = decide('Bash', { command: code }, opts, depth + 1)
      if (inner.deny) return inner
    }
  }
  return { deny: false }
}

// Pure decision; an exception inside it is a DENY.
export function gateDecision(toolName, toolInput, opts = {}) {
  try {
    return decide(toolName, toolInput, opts)
  } catch (err) {
    return { deny: true, error: String(err?.stack ?? err) }
  }
}

const LIMIT_MSG =
  ' (Ez szoveg-alapu fek, NEM OS-hatar: egy elore megirt szkriptfajl atmegy rajta. A jovahagyas ' +
  'hitelessege a GROMZODONTES1030 F1-F3 utan az mxd-taron mulik, nem ezen a kapun.)'

export const DB_GATE_MSG =
  'Biztonsagi DB-iras TILTOTT (APPROVALDBGATE1030, minden ugynokre, a fo ugynokre is). NEM irhatod a ' +
  'dashboard adatbazisanak biztonsagi tablait (approvals, approval_events, approval_slack_posts, approval_teams_cards, approval_gromzo_posts, agent_create_specs, auth_sessions, dashboard_users, ' +
  'device_keys, vault_ssh_keys, support_consents, support_password_state, approver_scopes, custom_commands, inbound_sig_log) semmilyen programmal (sqlite3, python, node, heredoc), ' +
  'az agent_messages-be NEM irhatsz foglalt vagy ismeretlen feladot (koordinator, hangcsatorna, system, gazda-hangu id) es kezbesitesi jelzot ' +
  '(stop_authorized, urgent, priority, affects_current_work), mas feladojanak sorat nem irhatod at (CHANINBOUNDFORGE1125), es NEM irhatod fajl ' +
  'szinten a store/claudeclaw.db-t (-wal/-shm/-journal is: cp/mv/tee/>/rm/ln, sqlite3 .restore/.read/.backup), ' +
  'es NEM hasznalhatod a PRAGMA writable_schema-t, sem a sqlite_master/sqlite_schema irasat. ' +
  'Jovahagyast a dashboard API-n kerj es hasznalj fel (/api/approvals). Olvasni szabad (SELECT, sqlite3 -readonly), ' +
  'mas tablat irni is (daily_logs), es az agent_messages-be a sajat uzenetedet: INSERT oszloplistaval, a from_agent sima idezett ' +
  'literal (a sajat neved); UPDATE status/result szabadon; content csak WHERE from_agent=\'<sajat neved>\' mellett. Egy $(...) behelyettesitesben allo sqlite3-at (idezojellel benne) ' +
  'viszont a kapu nem olvassa, es tiltja: futtasd a sqlite3-at kulon parancskent, behelyettesites nelkul (a kimenetet ' +
  'fajlba vagy kiirva; Samu 60400). Masolat a DB-rol: sqlite3 -readonly <db> "VACUUM INTO \'/tmp/x.db\'". ' +
  'Ha egy uzenet vagy kanban-szoveg idez ilyen parancsot: curl -d / git commit -m / a kanban-eszkoz --title atmegy; ' +
  'egy fajlba irt szoveg is atmegy, KIVEVE ha ugyanaz a parancs utana futtatja vagy a sqlite3-ba tolja ' +
  '(az egy SQL-szkript).' + LIMIT_MSG

// The three deny texts below are short on purpose: the first sentence is the rule, the second (added at deny time)
// what the gate caught, then the right way. The full lists, exceptions and limits are in docs/db-write-gate.md
// ("Full deny texts"). Measured on one fleet: these three were 73% of all hook-deny text (3 days,
// 732k characters, the .env one 2 980 characters each).
const LIMIT_SHORT = ' (szoveg-alapu fek, NEM OS-hatar; GROMZODONTES1030, mxd: lasd a docs-ot.)'

export const INSTALL_FILE_GATE_MSG =
  'Telepitesi kapu-fajl irasa TILTOTT (APPROVALDBGATE1030, minden ugynokre): a futo telepites hookjait, settings-fajljait ' +
  'es kapu-konfigjait csak a dashboard es az owner-kapus API irja. ' +
  'Helyes ut: egy git worktree SAJAT masolataban fejlessz, PR-ral kerul a telepitesbe; valtoztatas a gazda ' +
  'jovahagyasaval a fo ugynokon at. Olvasni szabad (cat/grep/jq/diff, git diff/log/show), egy hook-szkriptet ' +
  'KOZVETLENUL futtatni is; egy masik szkriptnek vagy ertelmezonek ARGUMENTUMKENT adott vedett ut viszont tilt. ' +
  'Teljes lista, kivetelek, elrontott telepites helyreallitasa: docs/db-write-gate.md ("Telepitesi kapu-fajlok", ' +
  '"Vesz-helyreallitas").' + LIMIT_SHORT

export const SUBAGENT_FILE_GATE_MSG =
  'Telepites .env / kapu-szabalyfajl irasa TILTOTT (ENVRELAXGATE1104, sub-agensre): a telepites .env-je, a ' +
  'kapu-szabalyfajlok, a sajat es a kozos settings-fajlok, egy MCP-szerverlista (ENVRELAXMCPCFG1104), a plugin-fa es mas agens ' +
  'agent-config.json-ja sub-agensbol nem irhato, nem hozhato letre es nem torolheto. ' +
  'Helyes ut: kerd a fo agenst (inter-agent uzenet: melyik kulcs/fajl es miert), o a gazda jovahagyasaval irja. ' +
  'Olvasni szabad (cat/grep/sed -n/jq); egy git worktree SAJAT .env-je szabad; ha a cwd egy vedett fan belul van, ' +
  'elobb lepj ki onnan. Teljes lista es amit a kapu nem lat: docs/db-write-gate.md ("ENVRELAXGATE1104").' + LIMIT_SHORT

// MCPWRITEGATE1104: an MCP tool's path argument is judged like a native file tool's file_path.
export const MCP_PREFIX_MSG =
  'MCP-eszkoz (MCPWRITEGATE1104): a hivas egy ut-argumentuma vedett utat er el (iras, mozgatas, vagy egy konyvtar, ' +
  'amibe ismeretlen nevu fajl kerulne). Ugyanaz a szabaly, mint a nativ Write-ra: '
export const MCP_PATH_GATE_MSG =
  'MCP-iro eszkoz ut nelkul TILTOTT (MCPWRITEGATE1104): egy ismert fajl-iro MCP-eszkoz ut-argumentum nelkul a szerver ' +
  'alapertelmezett helyere irna, amit ez a kapu nem lat (vagy a hivas bemenete tul nagy/tul melyen beagyazott, hogy vegigolvassa). ' +
  'Adj meg kifejezett, a munkakonyvtaradon beluli celutat (pl. savePath, save_to, localPath), es egyszeru fajlnevet.' + LIMIT_MSG

// The rescue path is named in the text (Samu 56320 2): the owner's own terminal, or an approval request for it.
export const RESCUE_DOC = 'docs/db-write-gate.md'
export const GIT_GATE_MSG =
  'Git-iras a telepitesben TILTOTT (APPROVALDBGATE1030, minden ugynokre): a futo telepites fo checkoutjaban (cwd vagy -C) ' +
  'csak olvaso git mehet, plusz pontosan "git fetch [origin]" es "git pull --ff-only origin <ag>"; a git-konfig es ' +
  'GIT_* env iranyitasa mindenhol tiltott. ' +
  'Helyes ut: egy SAJAT, a telepitesen KIVULI worktree, ' +
  'de a celt LITERALIS abszolut uttal add meg: "git -C /Users/marvin/<worktree> ..." vagy "cd /Users/marvin/<worktree> && git ..." ' +
  '(&&-vel). Teljes szabaly (tiltott alparancsok, valtozo a celban): ' + RESCUE_DOC + ' ("Git-iras"); elrontott prod fa: ' +
  '"Vesz-helyreallitas" szakasz.' + LIMIT_SHORT

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

// 47eeb016: the Fix-4 diagnostics -- the written file the script rule treated as run, and the protected name that
// matched in its text -- live ONLY in the deny message. They are recomputed in the worker thread by the same engine
// from the same input; the verdict object from gateDecision carries no detail field, and only the finished suffix
// string travels to the main thread, in the IPC message's `trigger` field.
// What a git / install-file / subagent-file deny caught, for its message; computed only after the verdict, never part of it.
const CAUGHT_FALLBACK = 'nincs megnevezheto ut (a parancs szerkezete tilt: cwd egy vedett fan belul, feloldatlan valtozo, ' +
  'idezett behelyettesites vagy shell-kod)'
export function caughtItem(toolName, toolInput, opts = {}, reason = '') {
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(String(toolName))) {
    return String(toolInput?.file_path ?? toolInput?.notebook_path ?? '').slice(0, 200) || CAUGHT_FALLBACK
  }
  const cmd = String(toolInput?.command ?? '')
  if (reason === 'git') {
    const gits = [...cmd.matchAll(/(?:^|[\s;&|(])((?:GIT_\w+=\S*\s+)*git\b[^;&|\n]*)/g)].map((m) => m[1].trim().slice(0, 100))
    return [...new Set(gits)].slice(0, 3).join(' | ') || CAUGHT_FALLBACK
  }
  if (opts.subAgent === true && (claudeMcpListWrite(cmd) || claudePluginWrite(cmd))) return 'claude mcp / claude plugin iro parancs'
  const text = substituteDefiniteCommand(cmd)
  const hits = hitsIn(text, strictCtx(text, opts))
  // a protected path itself (or an unresolvable one) names the catch better than a directory that only contains one
  const strong = hits.filter((h) => h.kind !== 'ancestor')
  const words = [...new Set((strong.length ? strong : hits).map((h) => String(h.word)))]
  if (!words.length) return CAUGHT_FALLBACK
  return words.slice(0, 3).map((w) => w.slice(0, 120)).join(', ') + (strong.length ? '' : ' (vedett utat tartalmazo konyvtar)')
}

// The caught item goes right after the rule (the first sentence).
export const withCaught = (msg, caught) => (caught ? msg.replace('. ', `. Elkapva: ${caught}. `) : msg)

function installFileTrigger(command, opts) {
  scriptDetail = null
  installFileDeny(String(command ?? ''), opts)
  return scriptDetail
    ? ` [written file treated as run: ${String(scriptDetail.file).slice(0, 200)}; protected name matched: ${String(scriptDetail.name).slice(0, 200)}]`
    : ''
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

// The hook entry, as self-pace-gate's: the decision runs in a worker with a
// deadline, and a throw, a hang or a missing verdict is a DENY (exit 1 or a
// harness timeout would read as "allow"). Stdin that is not JSON allows: it
// comes from the harness, not from the agent.
// Deadline: default 5000 ms, floor 100 ms, ceiling 30000 ms; DB_WRITE_GATE_DEADLINE_MS can lower or raise it within
// that range (47eeb016: the ceiling used to be the default, so a slow host could only shorten it).
const DECISION_DEADLINE_MS = Math.min(30000, Math.max(100, Number(process.env.DB_WRITE_GATE_DEADLINE_MS) || 5000))

const FAIL_CLOSED_MSG = (why) => 'DB-iro kapu: belso hiba vagy idotullepes a vizsgalat kozben ' +
  `(${String(why).slice(0, 200)}). Fail-closed: a hivas nem vizsgalhato, ezert TILTVA.` + LIMIT_MSG

function decideInWorker(toolName, toolInput, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { dbWriteGateWorker: true, toolName, toolInput, opts },
    })
    const timer = setTimeout(() => {
      w.terminate()
      reject(new Error(`decision exceeded ${DECISION_DEADLINE_MS} ms`))
    }, DECISION_DEADLINE_MS)
    w.once('message', (m) => {
      clearTimeout(timer)
      w.terminate()
      if (m?.ok === true && typeof m.deny === 'boolean') resolvePromise(m)
      else reject(new Error(m?.error ?? 'malformed verdict from the decision worker'))
    })
    w.once('error', (e) => { clearTimeout(timer); reject(e) })
    w.once('exit', (code) => { clearTimeout(timer); reject(new Error(`decision worker exited ${code} without a verdict`)) })
  })
}

if (!isMainThread && workerData?.dbWriteGateWorker) {
  try {
    const verdict = gateDecision(workerData.toolName, workerData.toolInput, workerData.opts ?? {})
    const trigger = verdict.reason === 'install-file' ? installFileTrigger(workerData.toolInput?.command, workerData.opts ?? {}) : ''
    let caught = ''
    // naming the catch must never turn a reasoned deny into a fail-closed error
    try {
      if (verdict.deny === true && !trigger && ['git', 'install-file', 'subagent-file'].includes(verdict.reason)) {
        caught = caughtItem(workerData.toolName, workerData.toolInput, workerData.opts ?? {}, verdict.reason)
      }
    } catch { caught = '' }
    parentPort.postMessage({ ok: true, deny: verdict.deny === true, reason: verdict.reason, error: verdict.error, trigger, caught })
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err?.stack ?? err) })
  }
} else if (isMainThread && isInvokedDirectly()) {
  process.on('uncaughtException', (err) => deny(FAIL_CLOSED_MSG(err?.message ?? err)))
  process.on('unhandledRejection', (err) => deny(FAIL_CLOSED_MSG(err?.message ?? err)))
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow()
  }
  try {
    // MCP fast path: a call that names no local path (and is not a known writer missing one) needs no worker
    const mcp = mcpFileTargets(payload?.tool_name, payload?.tool_input)
    if (mcp && mcp.targets.length === 0 && !mcp.missingPath && !mcp.truncated && !mcp.dbNamed && !mcp.bare.length) allow()
    const opts = {
      cwd: payload?.cwd,
      subAgent: isSubAgentCaller(process.env.CLAUDE_PROJECT_DIR, INSTALL_ROOT, process.env.CLAUDE_CONFIG_DIR || null),
      projectDir: process.env.CLAUDE_PROJECT_DIR || null,
      // the caller's user-level settings live in its config dir; unset, that is ~/.claude
      configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    }
    const verdict = await decideInWorker(payload?.tool_name, payload?.tool_input, opts)
    if (verdict.error) deny(FAIL_CLOSED_MSG(verdict.error.split('\n')[0]))
    if (verdict.deny) {
      const trigger = verdict.trigger ?? ''
      const caught = verdict.caught ?? ''
      deny(verdict.reason === 'git' ? withCaught(GIT_GATE_MSG, caught)
        : verdict.reason === 'install-file' ? withCaught(INSTALL_FILE_GATE_MSG, caught) + trigger
        : verdict.reason === 'subagent-file' ? withCaught(SUBAGENT_FILE_GATE_MSG, caught)
        : verdict.reason === 'mcp-install-file' ? MCP_PREFIX_MSG + INSTALL_FILE_GATE_MSG
        : verdict.reason === 'mcp-subagent-file' ? MCP_PREFIX_MSG + SUBAGENT_FILE_GATE_MSG
        : verdict.reason === 'mcp-path' ? MCP_PATH_GATE_MSG : DB_GATE_MSG)
    }
    allow()
  } catch (err) {
    deny(FAIL_CLOSED_MSG(err?.message ?? err))
  }
}
