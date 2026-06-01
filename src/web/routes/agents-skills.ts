import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, rmSync, statSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { agentDir } from '../agent-config.js'
import { generateSkillMd } from '../agent-scaffold.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json } from '../http-helpers.js'
import { sanitizeAgentName, sanitizeSkillName, safeJoin } from '../sanitize.js'
import type { RouteContext } from './types.js'

// Marveen's skills live at the global ~/.claude/skills/ path (shared with
// the operator's Claude Code install); sub-agents under their own
// agents/<name>/.claude/skills/. agentDir(MAIN_AGENT_ID) points at the
// non-existent agents/marveen/ folder so we must branch here.
function skillsRootFor(name: string): string {
  return name === MAIN_AGENT_ID
    ? join(homedir(), '.claude', 'skills')
    : join(agentDir(name), '.claude', 'skills')
}
function agentExistsFor(name: string): boolean {
  return name === MAIN_AGENT_ID || existsSync(agentDir(name))
}

// Pull the `description:` field out of a skill's SKILL.md YAML frontmatter so
// the dashboard can show what each skill does. Best-effort: single-line value,
// quotes trimmed, capped so a malformed file can't bloat the response.
function readSkillDescription(skillDir: string): string {
  try {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
    const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const block = fm ? fm[1] : md.slice(0, 600)
    const m = block.match(/^description:\s*(.+)$/m)
    if (!m) return ''
    return m[1].trim().replace(/^["']|["']$/g, '').slice(0, 300)
  } catch {
    return ''
  }
}

type AgentSkill = {
  name: string
  hasSkillMd: boolean
  description: string
  source: 'agent' | 'global'
  deletable: boolean
}

// List the skill directories under `dir`, tagging each with where it came from
// and whether it can be deleted from this agent's view.
function scanSkillDir(dir: string, source: 'agent' | 'global', deletable: boolean): AgentSkill[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => { try { return statSync(join(dir, f)).isDirectory() } catch { return false } })
    .map((f) => ({
      name: f,
      hasSkillMd: existsSync(join(dir, f, 'SKILL.md')),
      description: readSkillDescription(join(dir, f)),
      source,
      deletable,
    }))
}

export async function tryHandleAgentsSkills(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  const skillImportMatch = path.match(/^\/api\/agents\/([^/]+)\/skills\/import$/)
  if (skillImportMatch && method === 'POST') {
    const name = sanitizeAgentName(decodeURIComponent(skillImportMatch[1]))
    if (!name) { json(res, { error: 'Invalid agent name' }, 400); return true }
    if (!agentExistsFor(name)) { json(res, { error: 'Agent not found' }, 404); return true }

    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''
    const { file } = parseMultipart(body, contentType)
    if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }

    const skillsDir = skillsRootFor(name)
    mkdirSync(skillsDir, { recursive: true })

    const tmpPath = join(skillsDir, `_import_${randomUUID()}.zip`)
    const before = new Set(readdirSync(skillsDir))
    try {
      writeFileSync(tmpPath, file.data)
      const listOutput = execSync(`unzip -Z1 "${tmpPath}" 2>&1`, { timeout: 5000, encoding: 'utf-8' })
      const entries = listOutput.split('\n').map((l) => l.trim()).filter(Boolean)
      for (const entry of entries) {
        if (entry.includes('..') || entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry)) {
          unlinkSync(tmpPath)
          json(res, { error: 'Invalid skill file: path traversal detected' }, 400)
          return true
        }
      }
      execSync(`unzip -o "${tmpPath}" -d "${skillsDir}"`, { timeout: 10000 })
      unlinkSync(tmpPath)

      const after = readdirSync(skillsDir).filter((f) => !before.has(f))
      const rejectSymlinks = (dir: string): boolean => {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry)
          const st = lstatSync(p)
          if (st.isSymbolicLink()) return true
          if (st.isDirectory() && rejectSymlinks(p)) return true
        }
        return false
      }
      const tainted: string[] = []
      for (const f of after) {
        const p = join(skillsDir, f)
        try {
          if (lstatSync(p).isSymbolicLink() || (statSync(p).isDirectory() && rejectSymlinks(p))) {
            tainted.push(f)
          }
        } catch { /* ignored */ }
      }
      if (tainted.length > 0) {
        for (const f of after) {
          try { rmSync(join(skillsDir, f), { recursive: true, force: true }) } catch { /* best effort */ }
        }
        json(res, { error: 'Invalid skill file: symlink entries rejected' }, 400)
        return true
      }

      const extracted = after.filter(f => {
        const p = join(skillsDir, f)
        try { return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md')) } catch { return false }
      })
      if (extracted.length === 0) {
        for (const f of after) {
          try { rmSync(join(skillsDir, f), { recursive: true, force: true }) } catch { /* best effort */ }
        }
        json(res, { error: 'No valid skill (SKILL.md) found in archive' }, 400)
        return true
      }

      logger.info({ name, skills: extracted }, 'Skill(s) imported')
      json(res, { ok: true, imported: extracted })
      return true
    } catch (err) {
      try { unlinkSync(tmpPath) } catch { /* ignored */ }
      try {
        const leftover = readdirSync(skillsDir).filter(f => !before.has(f))
        for (const f of leftover) {
          try { rmSync(join(skillsDir, f), { recursive: true, force: true }) } catch { /* best effort */ }
        }
      } catch { /* dir gone or unreadable; nothing to do */ }
      logger.error({ err }, 'Failed to import skill')
      json(res, { error: 'Failed to extract .skill file' }, 500)
      return true
    }
  }

  const skillActionMatch = path.match(/^\/api\/agents\/([^/]+)\/skills\/([^/]+)$/)
  if (skillActionMatch && method === 'DELETE') {
    const name = sanitizeAgentName(decodeURIComponent(skillActionMatch[1]))
    const skillName = sanitizeSkillName(decodeURIComponent(skillActionMatch[2]))
    if (!name || !skillName) { json(res, { error: 'Invalid agent or skill name' }, 400); return true }
    if (!agentExistsFor(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    let skillDir: string
    try {
      skillDir = safeJoin(skillsRootFor(name), skillName)
    } catch {
      json(res, { error: 'Invalid skill path' }, 400)
      return true
    }
    if (!existsSync(skillDir)) { json(res, { error: 'Skill not found' }, 404); return true }
    rmSync(skillDir, { recursive: true, force: true })
    json(res, { ok: true })
    return true
  }

  const skillsMatch = path.match(/^\/api\/agents\/([^/]+)\/skills$/)
  if (skillsMatch && method === 'GET') {
    const name = decodeURIComponent(skillsMatch[1])
    if (!agentExistsFor(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    const globalRoot = join(homedir(), '.claude', 'skills')
    let skills: AgentSkill[]
    if (name === MAIN_AGENT_ID) {
      // The main agent's skill root IS the global ~/.claude/skills dir; these
      // skills physically live there and are deletable from this view.
      skills = scanSkillDir(skillsRootFor(name), 'global', true)
    } else {
      // Sub-agents own a small agents/<name>/.claude/skills set (deletable) but
      // at runtime ALSO inherit every global ~/.claude/skills entry. The old
      // endpoint only scanned the agent-local dir, so the tab looked empty even
      // though the agent had ~36 inherited skills available. List both; the
      // inherited ones are not deletable from a single agent's view (they are
      // shared) and a local skill shadows a global one of the same name.
      const local = scanSkillDir(skillsRootFor(name), 'agent', true)
      const localNames = new Set(local.map((s) => s.name))
      const inherited = scanSkillDir(globalRoot, 'global', false).filter((s) => !localNames.has(s.name))
      skills = [...local, ...inherited]
    }
    json(res, skills)
    return true
  }

  if (skillsMatch && method === 'POST') {
    const agentName = decodeURIComponent(skillsMatch[1])
    if (!agentExistsFor(agentName)) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const { name: rawSkillName, description } = JSON.parse(body.toString()) as { name: string; description: string }
    const skillName = sanitizeSkillName(rawSkillName || '')
    if (!skillName) { json(res, { error: 'Skill name is required' }, 400); return true }
    if (!description) { json(res, { error: 'Skill description is required' }, 400); return true }

    const skillDir = join(skillsRootFor(agentName), skillName)
    if (existsSync(skillDir)) { json(res, { error: 'Skill already exists' }, 409); return true }
    mkdirSync(skillDir, { recursive: true })

    try {
      const skillMd = await generateSkillMd(skillName, description)
      atomicWriteFileSync(join(skillDir, 'SKILL.md'), skillMd)
    } catch (err) {
      rmSync(skillDir, { recursive: true, force: true })
      json(res, { error: 'Failed to generate skill' }, 500)
      return true
    }

    json(res, { ok: true, name: skillName })
    return true
  }

  return false
}
