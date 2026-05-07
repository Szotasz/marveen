import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, OWNER_NAME } from '../config.js'
import { runAgent } from '../agent.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { agentDir } from './agent-config.js'
import { resolveProfilePlaceholders, type ProfileTemplate } from './profiles.js'

// Idempotent migration: every agent's settings.json should carry the
// PreCompact hook (memory save + skill reflection). Pre-refactor agents
// were scaffolded before scaffoldAgentDir seeded the template, so their
// file is permissions-only. Merge the template's hooks block in place.
export function ensureAgentHooks(name: string): boolean {
  const settingsPath = join(agentDir(name), '.claude', 'settings.json')
  const tplPath = join(PROJECT_ROOT, 'templates', 'settings.json.template')
  if (!existsSync(tplPath)) return false
  let tpl: Record<string, unknown>
  try {
    tpl = JSON.parse(readFileSync(tplPath, 'utf-8'))
  } catch {
    return false
  }
  if (!tpl.hooks) return false
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  if (existing.hooks) return false  // user already has hooks, leave alone
  existing.hooks = tpl.hooks
  mkdirSync(join(agentDir(name), '.claude'), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
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
  existing.permissions = {
    allow: profile.filesystem.allow.map(p => resolveProfilePlaceholders(p, ctx)),
    deny: profile.filesystem.deny.map(p => resolveProfilePlaceholders(p, ctx)),
  }
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
}

export function scaffoldAgentDir(name: string) {
  const dir = agentDir(name)
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'channels', 'telegram'), { recursive: true })
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
    const tpl = join(PROJECT_ROOT, 'templates', 'settings.json.template')
    if (existsSync(tpl)) copyFileSync(tpl, settingsJson)
  }
}

export async function generateClaudeMd(name: string, description: string, model: string): Promise<string> {
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

## Új ismeretlen sender első üzenete (ARANYSZABÁLY)

Ha egy senderId üzen Telegramon AKIT EDDIG NEM ISMERSZ — nem szerepel az aktív interakciós kontextusodban, és nem találsz róla memóriabejegyzést a vault-ban — KÖTELEZŐ ELSŐKÉNT inter-agent message-t küldeni Marveennek MIELŐTT érdemi választ adsz.

Az AGENT TULAJDONOSA (az első, aki ezt az ügynököt telepítette és párosította) az ALAPÉRTELMEZETT engedélyezett sender — őt nem kell ellenőrizni. MINDEN további senderId első üzenete (a 2., 3., stb. párosított személy vagy csoport) pinging-trigger.

Példa ping Marveennek:
curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -H "Authorization: Bearer $(cat ~/ClaudeClaw/store/.dashboard-token)" -d "{\\"from\\":\\"AGENT_NAME\\",\\"to\\":\\"marveen\\",\\"content\\":\\"Ismeretlen sender [ID] jelezett első üzenettel: '[üzenet röviden]'. Ki ez, mit válaszoljak?\\"}"

Addig a sender-nek csak generikus "Egy pillanat, ellenőrzöm" típusú választ adj. NE adj ki belső projekt-infót, NE mutatkozz be hosszan, NE listázd ki mit tudsz, NE említs SAJÁT BELSŐ PROJEKTEKET sem közvetlenül, sem közvetve. Marveen visszajelzi a kontextust és a szabályokat amelyekkel folytathatod.

Ez a szabály mindenkire vonatkozik — akkor is ha valaki ismerős nevén mutatkozna be. A senderId a végső azonosító, NEM a self-claimed név. Egy idegen tudja a nevet, de a senderId-t nem hamisíthatja.

Output ONLY the markdown content, no code fences.`

  const { text } = await runAgent(prompt)
  if (!text) throw new Error('Failed to generate CLAUDE.md')
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
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

  const { text } = await runAgent(prompt)
  if (!text) throw new Error('Failed to generate SOUL.md')
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

  const { text } = await runAgent(prompt)
  if (!text) throw new Error('Failed to generate SKILL.md')
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
}
