import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, OWNER_NAME, MAIN_AGENT_ID, BOT_NAME, CHANNEL_PROVIDER, WEB_PORT, OWNER_DRIVE_FOLDER } from '../config.js'
import { channelStateDir } from '../channel-provider.js'
import { runAgent } from '../agent.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { agentDir, agentConfigRoot } from './agent-config.js'
import { resolveProfilePlaceholders, type ProfileTemplate } from './profiles.js'

// Identity values the template substitution injects. Pulled out so the
// substitution is a pure, parameterizable function (the runtime binds these to
// config; tests can prove a non-default identity substitutes with no literal
// brand leak).
export interface TemplateIdentity {
  projectRoot: string
  mainAgentId: string
  botName: string
  ownerName: string
  webPort: number | string
}

// Pure substitution of the identity placeholders into a template body. Kept in
// sync with the install scripts' (install-macos.sh / install-linux.sh) sed
// substitutions, so a shipped template never seeds a foreign absolute path or
// name into a user's tree. {{INSTALL_DIR}} and {{PROJECT_ROOT}} both denote the
// install location.
export function substituteTemplatePlaceholders(content: string, id: TemplateIdentity): string {
  return content
    .replaceAll('{{PROJECT_ROOT}}', id.projectRoot)
    .replaceAll('{{INSTALL_DIR}}', id.projectRoot)
    .replaceAll('{{MAIN_AGENT_ID}}', id.mainAgentId)
    .replaceAll('{{BOT_NAME}}', id.botName)
    .replaceAll('{{OWNER_NAME}}', id.ownerName)
    .replaceAll('{{WEB_PORT}}', String(id.webPort))
}

export function resolveTemplatePlaceholders(content: string): string {
  return substituteTemplatePlaceholders(content, {
    projectRoot: PROJECT_ROOT,
    mainAgentId: MAIN_AGENT_ID,
    botName: BOT_NAME,
    ownerName: OWNER_NAME,
    webPort: WEB_PORT,
  })
}

// Return the settings.json path for an agent.
// The main agent's settings live at ~/.claude/settings.json (not inside agents/).
function agentSettingsPath(name: string): string {
  if (name === MAIN_AGENT_ID) return join(homedir(), '.claude', 'settings.json')
  return join(agentDir(name), '.claude', 'settings.json')
}

// Idempotent migration: every agent's settings.json should carry the
// PreCompact hook (memory save + skill reflection). Pre-refactor agents
// were scaffolded before scaffoldAgentDir seeded the template, so their
// file is permissions-only. Merge the template's hooks block in place.
// Also handles the main agent (MAIN_AGENT_ID) whose settings.json is at
// ~/.claude/settings.json -- voice hook is added alongside existing hooks.
export function ensureAgentHooks(name: string): boolean {
  const settingsPath = agentSettingsPath(name)
  const tplPath = join(PROJECT_ROOT, 'templates', 'settings.json.template')
  if (!existsSync(tplPath)) return false
  let tpl: Record<string, unknown>
  try {
    const raw = resolveTemplatePlaceholders(readFileSync(tplPath, 'utf-8'))
    tpl = JSON.parse(raw)
  } catch {
    return false
  }
  if (!tpl.hooks) return false
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  const tplHooks = tpl.hooks as Record<string, unknown>
  type HookEntry = { hooks?: Array<{ command?: string; timeout?: number; [k: string]: unknown }> }
  if (existing.hooks) {
    // Merge strategy:
    //   1. If a hook event is entirely missing: add it wholesale.
    //   2. If the event exists: add any template hook commands not yet present
    //      as a new hook group entry (preserves existing hooks like telegram_progress.py).
    //   3. Sync the timeout of any command hook whose command matches but timeout differs.
    const existingHooks = existing.hooks as Record<string, unknown>
    let changed = false
    for (const [event, handlers] of Object.entries(tplHooks)) {
      if (!existingHooks[event]) {
        existingHooks[event] = handlers
        changed = true
      } else {
        const tplEntries = handlers as HookEntry[]
        const existEntries = existingHooks[event] as HookEntry[]
        // Collect all command strings already present in this event's hook groups.
        const existingCommands = new Set(
          existEntries.flatMap((e) => (e.hooks ?? []).map((h) => h.command).filter(Boolean)),
        )
        for (const tplEntry of tplEntries) {
          // Add hooks that are missing (as a new group entry, preserving sibling hooks).
          const newHooks = (tplEntry.hooks ?? []).filter(
            (h) => h.command && !existingCommands.has(h.command),
          )
          if (newHooks.length > 0) {
            existEntries.push({ ...tplEntry, hooks: newHooks })
            changed = true
          }
          // Sync timeouts for hooks that already exist with a stale timeout.
          for (const tplHook of tplEntry.hooks ?? []) {
            if (!tplHook.command || tplHook.timeout == null) continue
            for (const existEntry of existEntries) {
              for (const existHook of existEntry.hooks ?? []) {
                if (existHook.command === tplHook.command && existHook.timeout !== tplHook.timeout) {
                  existHook.timeout = tplHook.timeout
                  changed = true
                }
              }
            }
          }
        }
      }
    }
    if (!changed) return false
  } else {
    existing.hooks = tplHooks
  }
  // For the main agent, ~/.claude already exists; sub-agents need the dir created.
  if (name !== MAIN_AGENT_ID) mkdirSync(join(agentDir(name), '.claude'), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
  return true
}

// Idempotent migration: ensure the staleness-guard UserPromptSubmit hook is
// present. Unlike ensureAgentHooks (which seeds the WHOLE hooks block only for
// hook-less agents), this MERGES a single UserPromptSubmit entry into an agent
// that already has other hooks -- so the guard reaches the existing fleet, not
// just freshly-scaffolded agents. The guard warns the agent when an inbound
// <channel ts="..."> message was delivered long after it was sent (a lagged /
// re-delivered message that may be stale), so it re-confirms before irreversible
// actions. Re-running is a no-op once the entry exists (matched by command path).
const STALENESS_HOOK_CMD = `python3 ${join(PROJECT_ROOT, 'scripts', 'hooks', 'staleness-guard.py')}`

export function ensureAgentStalenessHook(name: string): boolean {
  // agentSettingsPath() maps MAIN_AGENT_ID to ~/.claude/settings.json; using
  // agentDir() directly here would create a spurious agents/<main> dir and make
  // the main agent show up as a phantom "down" agent on the dashboard.
  const settingsPath = agentSettingsPath(name)
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { return false }
  }
  const hooks = (settings.hooks && typeof settings.hooks === 'object')
    ? settings.hooks as Record<string, unknown>
    : {}
  const ups = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit as unknown[] : []
  // Idempotency: already wired if any command entry references the guard script.
  const already = JSON.stringify(ups).includes('staleness-guard.py')
  if (already) return false
  ups.push({ hooks: [{ type: 'command', command: STALENESS_HOOK_CMD, timeout: 10 }] })
  hooks.UserPromptSubmit = ups
  settings.hooks = hooks
  // Main agent's ~/.claude already exists; only sub-agent dirs need creating.
  if (name !== MAIN_AGENT_ID) mkdirSync(join(agentDir(name), '.claude'), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return true
}

export function writeAgentSettingsFromProfile(name: string, profile: ProfileTemplate): void {
  const agentRoot = agentDir(name)
  const settingsDir = join(agentRoot, '.claude')
  const settingsPath = join(settingsDir, 'settings.json')
  mkdirSync(settingsDir, { recursive: true })
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  const ctx = { HOME: homedir(), AGENT_DIR: agentRoot }
  const denyList = profile.filesystem.deny.map(p => resolveProfilePlaceholders(p, ctx))
  // Self-pace tool-name deny: every sub-agent (NOT the main agent) is denied the
  // Claude Code runtime self-scheduling tools. A whole-tool-name deny IS enforced
  // even under --dangerously-skip-permissions (deny is checked BEFORE the bypass
  // allow), so this is a fail-closed layer; the self-pace-gate hook below covers
  // the Bash escape routes a name-deny cannot reach. (2026-06-26 autonom-kor fix.)
  if (agentGetsGovernanceGates(name)) denyList.push(...SELF_PACE_TOOL_DENY)
  existing.permissions = {
    allow: profile.filesystem.allow.map(p => resolveProfilePlaceholders(p, ctx)),
    deny: denyList,
  }
  // Governance hard-gates: every sub-agent (NOT the main agent) gets PreToolUse
  // hooks. Re-applied on every spawn (this function regenerates settings.json),
  // so they survive respawns. (a) email-send block -- outbound email routes
  // through the main agent. (b) self-pace block -- no ScheduleWakeup/Cron*/Bash
  // self-injection. The MAIN_AGENT_ID is exempt from both. Merge/deploy is NOT
  // gated: the operator authorizes those autonomously (so test/deploy runs are
  // never blocked); the actual incident vector -- an agent answering its OWN
  // posed question -- is covered by the self-pace block + the #0 CLAUDE.md doctrine.
  if (agentGetsEmailGate(name)) injectEmailSendGate(existing)
  if (agentGetsGovernanceGates(name)) injectSelfPaceGate(existing)
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
}

// Which agents are subject to the email-send hard-gate: every agent EXCEPT the
// main agent (MAIN_AGENT_ID, e.g. Marveen). Name-agnostic -- keyed on the
// configured main-agent id, not a hardcoded 'marveen', so a customer install
// gates its own sub-agents and exempts its own owner (distribution-hardcode
// rule). Pure + exported so the main-exempt guarantee is unit-testable.
export function agentGetsEmailGate(name: string): boolean {
  return name !== MAIN_AGENT_ID
}

// Idempotently wire the email-send-gate PreToolUse hook into a settings.json
// object. A deny-list rule alone would NOT enforce this: permissive profiles
// launch with --dangerously-skip-permissions, which bypasses allow/deny --
// hooks run regardless of permission mode. Name-agnostic so a customer install
// gates its own sub-agents (the caller's MAIN_AGENT_ID guard exempts the owner).
export function injectEmailSendGate(existing: Record<string, unknown>): void {
  const hooks = (existing.hooks && typeof existing.hooks === 'object'
    ? existing.hooks
    : (existing.hooks = {})) as Record<string, unknown>
  const command = `node ${join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs')}`
  const entry = {
    matcher: 'Bash|send_email',
    hooks: [{ type: 'command', command, timeout: 10 }],
  }
  const prev = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : []
  // Drop any prior email-gate entry (respawn re-runs this) before re-adding, so
  // the hook never accumulates duplicates; other PreToolUse entries are kept.
  hooks.PreToolUse = [
    ...prev.filter((e) => !JSON.stringify(e).includes('email-send-gate.mjs')),
    entry,
  ]
}

// Claude Code runtime self-scheduling tool names denied for sub-agents (fail-
// closed, enforced even under --dangerously-skip-permissions). The Bash escape
// routes are covered by the self-pace-gate hook, which a name-deny cannot reach.
const SELF_PACE_TOOL_DENY = ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']

// Which agents are subject to the self-pace gate: every agent EXCEPT the main
// agent (same name-agnostic main-exempt rule as the email gate). Pure + exported
// so the main-exempt guarantee is unit-testable.
export function agentGetsGovernanceGates(name: string): boolean {
  return name !== MAIN_AGENT_ID
}

// Idempotently wire the self-pace-gate PreToolUse hook (blocks ScheduleWakeup /
// Cron* / RemoteTrigger + the Bash self-injection routes). Same shape + dedupe
// discipline as injectEmailSendGate.
export function injectSelfPaceGate(existing: Record<string, unknown>): void {
  const hooks = (existing.hooks && typeof existing.hooks === 'object'
    ? existing.hooks
    : (existing.hooks = {})) as Record<string, unknown>
  const command = `node ${join(PROJECT_ROOT, 'scripts', 'self-pace-gate.mjs')}`
  const entry = {
    // Write|Edit|NotebookEdit are included so the gate actually fires on the
    // native-file route to the self-schedule store (gateDecision blocks a Write
    // to scheduled_tasks.json); a Bash-only matcher would leave that route open.
    matcher: 'ScheduleWakeup|CronCreate|CronDelete|CronList|RemoteTrigger|Bash|Write|Edit|NotebookEdit',
    hooks: [{ type: 'command', command, timeout: 10 }],
  }
  const prev = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : []
  hooks.PreToolUse = [
    ...prev.filter((e) => !JSON.stringify(e).includes('self-pace-gate.mjs')),
    entry,
  ]
}

// Copy the repo's `scheduled-tasks/<task>/task-config.json` to the
// destination with the `agent` field rewritten to the host's
// MAIN_AGENT_ID. The repo-side configs ship with `"agent": "marveen"`
// hardcoded (canonical default in src/config.ts) so a non-marveen
// install would otherwise scaffold tasks bound to an agent that does
// not exist and the scheduler would fire silently into the void on
// every tick. All other files in the task directory (SKILL.md, etc.)
// are byte-identical copies as before.
//
// The rewrite is conservative: it only touches the `agent` field, and
// only when the parsed JSON has one. A malformed task-config.json
// falls back to copyFileSync so the seed does not lose its file --
// the operator can then inspect and fix the JSON, rather than the
// scaffold silently dropping the task.
function copyTaskConfigWithAgentRewrite(srcPath: string, destPath: string): void {
  try {
    const raw = readFileSync(srcPath, 'utf-8')
    const cfg = JSON.parse(raw) as Record<string, unknown>
    if (typeof cfg.agent === 'string') {
      cfg.agent = MAIN_AGENT_ID
    }
    atomicWriteFileSync(destPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch {
    // Malformed or unreadable: fall back to a byte copy so the file is
    // still seeded and the operator gets a chance to fix it.
    copyFileSync(srcPath, destPath)
  }
}

export function ensureDefaultScheduledTasks(): void {
  const repoTasks = join(PROJECT_ROOT, 'scheduled-tasks')
  if (!existsSync(repoTasks)) return
  const destRoot = join(homedir(), '.claude', 'scheduled-tasks')
  mkdirSync(destRoot, { recursive: true })

  for (const taskName of readdirSync(repoTasks)) {
    const src = join(repoTasks, taskName)
    const dest = join(destRoot, taskName)
    if (!statSync(src).isDirectory()) continue
    if (existsSync(dest)) continue
    mkdirSync(dest, { recursive: true })
    for (const file of readdirSync(src)) {
      const srcFile = join(src, file)
      const destFile = join(dest, file)
      // Seeded task dirs are flat; skip any nested directory rather than
      // letting readFileSync/copyFileSync throw EISDIR and abort the whole
      // seed for every remaining task.
      if (statSync(srcFile).isDirectory()) continue
      if (file === 'task-config.json') {
        copyTaskConfigWithAgentRewrite(srcFile, destFile)
      } else {
        // Substitute the identity placeholders (same set the install scripts
        // sed) so a template's SKILL.md never seeds a foreign absolute path or
        // name into the user's task. Binary/unreadable -> fall back to a copy.
        try {
          writeFileSync(destFile, resolveTemplatePlaceholders(readFileSync(srcFile, 'utf-8')))
        } catch {
          copyFileSync(srcFile, destFile)
        }
      }
    }
  }
}

export function scaffoldAgentDir(name: string) {
  const dir = agentDir(name)
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true })
  mkdirSync(channelStateDir(CHANNEL_PROVIDER, dir), { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })

  // Initialize empty files if they don't exist
  const memoryMd = join(dir, 'memory', 'MEMORY.md')
  if (!existsSync(memoryMd)) writeFileSync(memoryMd, '')
  const mcpJson = join(dir, '.mcp.json')
  if (!existsSync(mcpJson)) {
    // Copy shared MCP config so agents get access to common tools (e.g. aiam-blog)
    const sharedMcp = join(PROJECT_ROOT, '.mcp.json')
    if (existsSync(sharedMcp)) {
      copyFileSync(sharedMcp, mcpJson)
    } else {
      // Valid empty shape -- `claude /doctor` rejects plain "{}"
      atomicWriteFileSync(mcpJson, JSON.stringify({ mcpServers: {} }, null, 2))
    }
  }
  // Seed settings.json from template so the agent gets the PreCompact
  // hook (memory save + skill reflection) out of the box. Only if the
  // file doesn't exist yet -- user edits and later profile writes stay.
  const settingsJson = join(dir, '.claude', 'settings.json')
  if (!existsSync(settingsJson)) {
    const tplPath = join(PROJECT_ROOT, 'templates', 'settings.json.template')
    if (existsSync(tplPath)) {
      const resolved = resolveTemplatePlaceholders(readFileSync(tplPath, 'utf-8'))
      atomicWriteFileSync(settingsJson, resolved)
    }
  }
}

export async function generateClaudeMd(name: string, description: string, model: string): Promise<string> {
  // Distribution-safe default-drive line: only emit a concrete folder when this
  // install has one configured (OWNER_DRIVE_FOLDER). A fresh install with no
  // configured folder tells the agent to ask the owner instead of baking in
  // some other install's drive id.
  const driveDefault = OWNER_DRIVE_FOLDER
    ? `Ha nincs MÁS kijelölve, az ALAPÉRTELMEZETT közös meghajtó: https://drive.google.com/drive/folders/${OWNER_DRIVE_FOLDER} - ide írj, rendezett almappákba.`
    : `Ha nincs kijelölt közös meghajtó, MIELŐTT bárhova írsz, kérd el ${OWNER_NAME}-tól a megfelelő Drive mappát.`
  const prompt = `You are creating the CLAUDE.md (project instructions) file for an AI agent.
Agent name: ${name}
Description of what the agent should do: ${description}
Model: ${model}

Generate a comprehensive CLAUDE.md that includes:
- Clear role and responsibilities based on the description above
- Behavioral guidelines
- Communication style
- Language rules (Hungarian with ${OWNER_NAME}, English for code/technical)
- Tool usage guidelines relevant to the agent's role
- Any domain-specific instructions

The owner's name is ${OWNER_NAME}. Use this exact name everywhere the CLAUDE.md
refers to the owner/user. Do not substitute or invent any other name.

IMPORTANT FORMATTING RULES:
- Write ALL Hungarian text with proper accents (á, é, í, ó, ö, ő, ú, ü, ű). NEVER write Hungarian without accents.
- The agent's first line description should reflect what the user typed as description, in Hungarian with accents.
- Never use em dash (—), only simple hyphen (-).

IMPORTANT: The CLAUDE.md MUST include the following sections at the end (copy them exactly, replacing AGENT_NAME with ${name}):

## Memoria rendszer

A memoria 3 retegbol all (hot/warm/cold) + napi naplo.

### Tier-ek:
- **hot**: Aktiv feladatok, pending dontesek, ami MOST tortenik
- **warm**: Stabil konfig, preferenciák, projekt kontextus (ritkán változik)
- **cold**: Hosszútávú tanulságok, történeti döntések, archívum
- **shared**: Más ágenseknek is releváns információk

### NINCS MENTAL NOTE! Ha meg kell jegyezni -> AZONNAL mentsd:

Minden /api/* végpont Bearer tokenes: a token a store/.dashboard-token fájlban.

Memória mentés:
curl -s -X POST http://localhost:3420/api/memories -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d '{"agent_id":"AGENT_NAME","content":"MIT","category":"CATEGORY","keywords":"kulcsszo1, kulcsszo2"}'

Napi napló (append-only):
curl -s -X POST http://localhost:3420/api/daily-log -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d '{"agent_id":"AGENT_NAME","content":"## HH:MM -- Tema\nMi tortent, mi lett az eredmeny"}'

Keresés (mielőtt válaszolsz, nézd meg van-e releváns emlék):
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:3420/api/memories?agent=AGENT_NAME&q=KULCSSZO&category=warm"

## Ütemezett feladatok

Az ütemezett feladatok a ~/.claude/scheduled-tasks/ mappában élnek, fájl-alapúak (SKILL.md + task-config.json). A schedule runner 60 másodpercenként ellenőrzi és a te tmux session-ödbe küldi a promptot.

Feladat létrehozása API-n keresztül:
curl -s -X POST http://localhost:3420/api/schedules -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d '{"name": "feladat-nev", "description": "Rövid leírás", "prompt": "A részletes prompt", "schedule": "0 8 * * *", "agent": "AGENT_NAME", "type": "heartbeat"}'

Típusok: task (mindig szól az eredménnyel) vagy heartbeat (csak fontosnál szól).
Cron formátum: perc óra nap hónap hétnapja (pl. 0 8 * * * = minden nap 8:00).
NE írd közvetlenül az SQLite scheduled_tasks táblát - az egy régi API.

## Öntanulás és Skill rendszer

Te egy önfejlesztő ágens vagy. A munkád során tanulsz, és újrafelhasználható skill-eket hozol létre.

### Skill-ek helye
- Globális: ~/.claude/skills/ (minden ágens számára elérhető)
- Egyéni: a te munkakönyvtárad .claude/skills/ mappája

### Automatikus skill generálás
Komplex feladatok után (5+ tool hívás, hiba utáni recovery, user korrekció, többlépéses workflow) automatikusan hozz létre SKILL.md fájlt:

mkdir -p ~/.claude/skills/SKILL-NEV
A SKILL.md tartalmazzon YAML frontmatter-t (name, description), majd szekciókat: Mikor használd, Eljárás, Buktatók, Ellenőrzés.

### Skill patch (runtime javítás)
Ha egy meglévő skill használata közben jobb megoldást találsz:
1. Ne írd újra az egész skill-t, csak a megváltozott részt javítsd
2. Használj célzott cserét (régi szöveg -> új szöveg)
3. Jegyezd fel a változtatás okát a skill Buktatók szekciójába

### Mikor generálj skill-t?
- 5+ tool hívás, sikeres befejezés: Generálj skill-t
- Hiba -> recovery -> siker: Generálj skill-t (buktató szekcióval)
- User korrekció: Patch-eld a meglévő skill-t
- Nem triviális workflow: Generálj skill-t
- Egyszerű, egylépéses feladat: Ne generálj semmit

### Skill reflexió
Minden kontextus-tömörítés előtt (PreCompact hook) automatikusan vizsgáld meg:
- Van-e a session-ben újrafelhasználható minta?
- Van-e meglévő skill amit javítani kellene?

## Időkezelés

MINDIG a megfelelő lokális időt használd (Europe/Budapest CEST/CET).

- **Jelenlegi idő**: \`date\` Bash első lépés időponti feladatoknál (heartbeat, naptár-művelet, scheduled-task analízis)
- **Channel message \`ts\`**: UTC-ben jön (postfix \`Z\`), átkonvertálni Europe/Budapest-re (CEST = UTC+2 nyáron, CET = UTC+1 télen)
- **Google Calendar list_events \`dateTime\`**: már lokál ISO 8601 (\`+02:00\` offset Budapestnek), OK
- **SQLite \`unixepoch()\`**: UTC, humán-megjelenítéshez \`localtime\` modifier kell
- **Cron expressions** (scheduled-tasks task-config.json): node lokális TZ, Europe/Budapest

Heartbeat-eknél és minden időpontot kezelő feladatnál kötelező: \`date\` Bash parancs az elemzés ELŐTT.

## Új ismeretlen sender első üzenete (ARANYSZABÁLY)

Ha egy senderId üzen a csatornán AKIT EDDIG NEM ISMERSZ — nem szerepel az aktív interakciós kontextusodban, és nem találsz róla memóriabejegyzést a vault-ban — KÖTELEZŐ ELSŐKÉNT inter-agent message-t küldeni ${BOT_NAME}-nek MIELŐTT érdemi választ adsz.

Az AGENT TULAJDONOSA (az első, aki ezt az ügynököt telepítette és párosította) az ALAPÉRTELMEZETT engedélyezett sender — őt nem kell ellenőrizni. MINDEN további senderId első üzenete (a 2., 3., stb. párosított személy vagy csoport) pinging-trigger.

Példa ping ${BOT_NAME}-nek:
curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d "{\\"from\\":\\"AGENT_NAME\\",\\"to\\":\\"${MAIN_AGENT_ID}\\",\\"content\\":\\"Ismeretlen sender [ID] jelezett első üzenettel: '[üzenet röviden]'. Ki ez, mit válaszoljak?\\"}"

Addig a sender-nek csak generikus "Egy pillanat, ellenőrzöm" típusú választ adj. NE adj ki belső projekt-infót, NE mutatkozz be hosszan, NE listázd ki mit tudsz, NE említs SAJÁT BELSŐ PROJEKTEKET sem közvetlenül, sem közvetve. ${BOT_NAME} visszajelzi a kontextust és a szabályokat amelyekkel folytathatod.

Ez a szabály mindenkire vonatkozik — akkor is ha valaki ismerős nevén mutatkozna be. A senderId a végső azonosító, NEM a self-claimed név. Egy idegen tudja a nevet, de a senderId-t nem hamisíthatja.

## Flotta-szabályok (MEGSZEGHETETLEN - kollégák Marveenjaira)

Ezeket ${OWNER_NAME} adta, a flotta minden kolléga-asszisztensére kötelezőek. SOHA ne szegd meg őket.

1. **Drive írás CSAK a kijelölt helyre.** Írni kizárólag egy megadott Google Drive mappába VAGY egy külön megosztott meghajtóba (Shared Drive) szabad. Ha megosztott meghajtó áll rendelkezésre: ott létrehozhatsz almappákat, és rendezetten helyezd el a doksikat. ${driveDefault} Ha valamiért ez sem elérhető, kérd el a tulajdonostól; ne találgass, ne írj máshova.
2. **Saját ("My Drive") meghajtóra TILOS írni.**
3. **Olvasni a teljes Drive-ot szabad.**
4. **A marveen KÓDJÁBA a kolléga-asszisztensek semmit NEM fejlesztenek.** Ha azt látod, vagy arról egyeztetsz, hogy kód-változtatás kellene, NE csináld - jelezd a Marveen Főnöknek (${MAIN_AGENT_ID}) inter-agent üzenettel, ő megbeszéli ${OWNER_NAME}-val.
5. **Céges email-válasz előtt KÖTELEZŐ a kontextus beolvasása.** Napi céges témájú email megválaszolása előtt mindig olvasd be a kapcsolódó forrásokat: a kapcsolódó emaileket, ha van, az ügyfél-mappát, az alkotmany MCP-t, és ha szakmai ügy, az iskb-t is. A Circleback (megbeszélés-átiratok) szintén kulcsfontosságú - rengeteg infó a meetingeken hangzik el.
6. **Eredmény-fájlok a közös Drive mappába.** Az elkészült eredmény-fájlokat külön kérés nélkül is a közösen használt Drive mappába tedd (lásd 1. szabály).
7. **Login-automatizálás / külső credential / futtatható szkript -> ELŐBB szólj a Főnöknek.** Mielőtt bármilyen külső szolgáltatásba automatikus bejelentkezést, jelszó-/credential-kezelést, vagy futtatható szkriptet (pl. Playwright/böngésző-automatizálás, scraper, login-szkript) írsz vagy futtatsz, jelezd a Marveen Főnöknek (${MAIN_AGENT_ID}) inter-agent üzenettel - ő koordinálja és ${OWNER_NAME}-val egyezteti (a 4. szabály szellemében). Credential-t SOHA ne égess nyersen kódba; ha titok kell, kérd a Főnöktől a biztonságos tárolás módját.

Output ONLY the markdown content, no code fences.`

  const { text, error } = await runAgent(prompt)
  if (!text) throw new Error(error ? blockedHint('CLAUDE.md', error) : noOutputHint('CLAUDE.md'))
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
}

// Shared "Claude Code returned nothing" message for the three generators below.
// Issue #179: the bare "Failed to generate <file>" message left VPS operators
// chasing the wrong thread when the actual cause was an unauthenticated Claude
// Code CLI on the host. Always surface the diagnostic command sequence.
function noOutputHint(target: string): string {
  return (
    `Failed to generate ${target}: the Claude Code CLI returned no output. ` +
    `Most likely cause: the CLI on this host is not authenticated. ` +
    `Verify with: \`claude --version\`, then \`claude /login\` (or set ` +
    `ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN). ` +
    `If that succeeds and the error persists, run \`claude --print "ping"\` ` +
    `from this directory to confirm headless invocation works.`
  )
}

// Issue #209: distinct from noOutputHint -- here the SDK returned a result that
// was a usage-policy (AUP) block or an API/execution error, NOT empty output.
// runAgent already refused to propagate the block text as content; we surface
// the structured reason so the operator does not chase an auth red herring.
function blockedHint(target: string, reason: string): string {
  return (
    `Failed to generate ${target}: the model returned a blocked/errored result ` +
    `(not generated content), so it was not written to avoid corrupting the file. ` +
    `Reason: ${reason}. If this is an AUP block, rephrase the request or try a ` +
    `different model; the prior conversation/session is unaffected.`
  )
}

export async function generateSoulMd(name: string, description: string): Promise<string> {
  const prompt = `You are creating the SOUL.md (personality definition) for an AI agent.
Agent name: ${name}
Description: ${description}

Generate a personality definition that includes:
- Core personality traits
- Communication tone and style
- How it addresses the user (whose name is ${OWNER_NAME} -- use this name, not any other)
- Unique quirks or characteristics
- What it should avoid

Make the personality distinctive but professional.
Output ONLY the markdown content, no code fences.`

  const { text, error } = await runAgent(prompt)
  if (!text) throw new Error(error ? blockedHint('SOUL.md', error) : noOutputHint('SOUL.md'))
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
}

export async function generateSkillMd(skillName: string, description: string): Promise<string> {
  const prompt = `You are creating a SKILL.md file for a Claude Code skill. Follow this exact format:

Skill name: ${skillName}
What the user described: ${description}

Generate a SKILL.md with this structure:

1. YAML frontmatter (between --- delimiters):
   - name: ${skillName}
   - description: A comprehensive description that includes what the skill does AND specific contexts for when to use it. Be "pushy" - include multiple trigger phrases. Example: instead of "Creates reports" write "Creates detailed reports. Use this skill whenever the user mentions reports, summaries, data analysis, dashboards, metrics overview, or wants to compile information into a structured document."

2. Body with these sections:
   - # [Skill Name] - main heading
   - ## Purpose - what this skill does and why
   - ## When to use - specific triggers and contexts
   - ## Instructions - step-by-step guide for Claude
   - ## Output format - what the output should look like
   - ## Examples - 1-2 concrete examples with Input/Output
   - ## Language rules - Hungarian with ${OWNER_NAME} (the user), English for code/technical
   - ## What to avoid - common pitfalls

Keep the body under 200 lines. Be specific and actionable. The owner's name is ${OWNER_NAME}; use only this name when referring to the user.
Output ONLY the markdown content, no code fences.`

  const { text, error } = await runAgent(prompt)
  if (!text) throw new Error(error ? blockedHint('SKILL.md', error) : noOutputHint('SKILL.md'))
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
}
