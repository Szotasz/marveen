import { createReadStream, existsSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, rmSync, statSync, lstatSync } from 'node:fs'
import { join, sep, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { logger } from '../../logger.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { AGENTS_BASE_DIR, listAgentNames, readFileOr, agentDir } from '../agent-config.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../../config.js'
import { generateSkillMd } from '../agent-scaffold.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json } from '../http-helpers.js'
import { sanitizeSkillName, shellEscape } from '../sanitize.js'
import type { RouteContext } from './types.js'

function parseFrontmatterField(content: string, field: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return ''
  const fm = fmMatch[1]
  const line = fm.match(new RegExp(`^${field}:\\s*(.+)`, 'im'))
  if (!line) return ''
  let val = line[1].trim()
  if (val.startsWith('"')) {
    const q = val.match(/^"(.*)"/)
    return q ? q[1].trim() : val.replace(/^"|"$/g, '').trim()
  }
  if (val.startsWith("'")) {
    const q = val.match(/^'(.*)'/)
    return q ? q[1].trim() : val.replace(/^'|'$/g, '').trim()
  }
  return val
}

function parseSkillDescription(content: string): string {
  return parseFrontmatterField(content, 'description')
}

function parseSkillKeywords(content: string): string[] {
  const raw = parseFrontmatterField(content, 'keywords')
  if (!raw) return []
  return raw.split(',').map(k => k.trim()).filter(Boolean)
}

function getSkillAgents(skillDirName: string): string[] {
  const agents: string[] = []
  for (const agentName of listAgentNames()) {
    const agentSkillDir = join(AGENTS_BASE_DIR, agentName, '.claude', 'skills', skillDirName)
    if (existsSync(agentSkillDir)) agents.push(agentName)
  }
  return agents
}

export async function tryHandleSkills(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/skills' && method === 'GET') {
    type SkillEntry = {
      name: string
      label: string
      description: string
      agents: string[]
      keywords: string[]
      path: string
      mtime: number
      source: 'user' | 'plugin'
      pluginPackage?: string
    }
    const skills: SkillEntry[] = []

    const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    if (existsSync(USER_SKILLS_DIR)) {
      const SKIP_DIRS = new Set(['skills', 'temp_skills', 'tmp_skills', '.skill-index.md'])
      const dirs = readdirSync(USER_SKILLS_DIR).filter(f => {
        if (SKIP_DIRS.has(f)) return false
        if (f.startsWith('.')) return false
        try { return statSync(join(USER_SKILLS_DIR, f)).isDirectory() } catch { return false }
      })
      // Global user skills are available to every agent via shared HOME --
      // no per-agent copy exists. Show all fleet agent names as coverage.
      const allAgents = listAgentNames()
      for (const dir of dirs) {
        const skillMdPath = join(USER_SKILLS_DIR, dir, 'SKILL.md')
        if (!existsSync(skillMdPath)) continue
        const content = readFileOr(skillMdPath, '')
        let mtime = 0
        try { mtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
        skills.push({
          name: dir,
          label: dir,
          description: parseSkillDescription(content),
          keywords: parseSkillKeywords(content),
          agents: allAgents,
          path: join(USER_SKILLS_DIR, dir),
          mtime,
          source: 'user',
        })
      }
    }

    const PLUGINS_CACHE_DIR = join(homedir(), '.claude', 'plugins', 'cache')
    if (existsSync(PLUGINS_CACHE_DIR)) {
      const walkForSkills = (dir: string, depth: number, packagePath: string[]): void => {
        if (depth > 4) return
        let entries: string[] = []
        try { entries = readdirSync(dir) } catch { return }
        if (entries.includes('skills')) {
          const skillsDir = join(dir, 'skills')
          let skillDirs: string[] = []
          try { skillDirs = readdirSync(skillsDir) } catch { /* no-op */ }
          for (const sd of skillDirs) {
            if (sd.startsWith('.')) continue
            const skillDirPath = join(skillsDir, sd)
            try { if (!statSync(skillDirPath).isDirectory()) continue } catch { continue }
            const skillMdPath = join(skillDirPath, 'SKILL.md')
            if (!existsSync(skillMdPath)) continue
            const pluginPackage = packagePath.join('/')
            // Treat segments that look like a version (semver, v-prefix, rc/beta/etc.)
            // as the version, and the segment before them as the plugin id.
            const VERSION_LIKE = /^(?:\d|v\d|(?:rc|beta|alpha|pre|snapshot)(?:[.\-_]|\d|$))/i
            const lastIdx = packagePath.length - 1
            let shortPluginIdx = lastIdx
            if (lastIdx >= 1 && VERSION_LIKE.test(packagePath[lastIdx] || '')) {
              shortPluginIdx = lastIdx - 1
            }
            const shortPlugin = packagePath[shortPluginIdx] || 'plugin'
            const pluginContent = readFileOr(skillMdPath, '')
            let pluginMtime = 0
            try { pluginMtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
            skills.push({
              name: pluginPackage ? `${pluginPackage}:${sd}` : sd,
              label: `${shortPlugin}:${sd}`,
              description: parseSkillDescription(pluginContent),
              keywords: parseSkillKeywords(pluginContent),
              agents: [],
              path: skillDirPath,
              mtime: pluginMtime,
              source: 'plugin',
              pluginPackage,
            })
          }
          return
        }
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === 'skills') continue
          const next = join(dir, entry)
          try {
            if (!statSync(next).isDirectory()) continue
          } catch { continue }
          walkForSkills(next, depth + 1, packagePath.concat(entry))
        }
      }
      walkForSkills(PLUGINS_CACHE_DIR, 0, [])
    }

    skills.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'user' ? -1 : 1
      return (a.label || a.name).localeCompare(b.label || b.name)
    })
    json(res, skills)
    return true
  }

  // Return all local (agent-specific) skills across the whole fleet.
  // Must be matched before /:name so "local" is not treated as a skill name.
  if (path === '/api/skills/local' && method === 'GET') {
    type LocalSkillEntry = {
      name: string
      label: string
      agentId: string
      description: string
      keywords: string[]
      mtime: number
      source: 'agent'
    }
    const result: LocalSkillEntry[] = []
    // Prepend MAIN_AGENT_ID explicitly: listAgentNames() scans AGENTS_BASE_DIR
    // subdirectories, so the main agent (which lives in PROJECT_ROOT, not under
    // agents/<id>/) is never returned by that call.
    const subAgentNames = listAgentNames()
    const allAgentNames = subAgentNames.includes(MAIN_AGENT_ID)
      ? subAgentNames
      : [MAIN_AGENT_ID, ...subAgentNames]
    for (const agentName of allAgentNames) {
      // The main agent's local skills live at PROJECT_ROOT/.claude/skills (not
      // under agents/<id>/, which does not exist). Same pattern as CLAUDE.md path
      // resolution in ensureAutonomySection.
      const skillsDir = agentName === MAIN_AGENT_ID
        ? join(PROJECT_ROOT, '.claude', 'skills')
        : join(agentDir(agentName), '.claude', 'skills')
      if (!existsSync(skillsDir)) continue
      let entries: string[] = []
      try { entries = readdirSync(skillsDir) } catch { continue }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue
        const skillDirPath = join(skillsDir, entry)
        try { if (!statSync(skillDirPath).isDirectory()) continue } catch { continue }
        const skillMdPath = join(skillDirPath, 'SKILL.md')
        if (!existsSync(skillMdPath)) continue
        const content = readFileOr(skillMdPath, '')
        let mtime = 0
        try { mtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
        result.push({
          name: entry,
          label: entry,
          agentId: agentName,
          description: parseSkillDescription(content),
          keywords: parseSkillKeywords(content),
          mtime,
          source: 'agent',
        })
      }
    }
    result.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.name.localeCompare(b.name))
    json(res, result)
    return true
  }

  // Export must be matched before the generic /:name detail route, otherwise
  // the detail handler intercepts GET /api/skills/export as skillName="export".
  if (path === '/api/skills/export' && method === 'GET') {
    const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    if (!existsSync(USER_SKILLS_DIR)) {
      json(res, { error: 'No user skills directory' }, 404)
      return true
    }
    const tmpZip = join(tmpdir(), `skills-export-${randomUUID()}.zip`)
    try {
      execSync(
        `cd ${shellEscape(USER_SKILLS_DIR)} && zip -r ${shellEscape(tmpZip)} . --include "*/SKILL.md" --include "*/references/*"`,
        { timeout: 15000 }
      )
      const stat = statSync(tmpZip)
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', 'attachment; filename="skills-export.zip"')
      res.setHeader('Content-Length', stat.size)
      const stream = createReadStream(tmpZip)
      stream.on('end', () => { try { unlinkSync(tmpZip) } catch { /* no-op */ } })
      stream.on('error', () => { try { unlinkSync(tmpZip) } catch { /* no-op */ } })
      stream.pipe(res)
    } catch (err) {
      try { unlinkSync(tmpZip) } catch { /* no-op */ }
      logger.error({ err }, 'Skills export failed')
      json(res, { error: 'Export failed' }, 500)
    }
    return true
  }

  const globalSkillDetailMatch = path.match(/^\/api\/skills\/([^/]+)$/)
  if (globalSkillDetailMatch && method === 'GET') {
    const skillName = decodeURIComponent(globalSkillDetailMatch[1])

    // When ?agent=<id> is supplied, resolve from that agent's local skills dir.
    const agentParam = ctx.url.searchParams.get('agent')
    if (agentParam) {
      const validAgentIds = new Set([MAIN_AGENT_ID, ...listAgentNames()])
      if (!validAgentIds.has(agentParam)) {
        json(res, { error: 'Skill not found' }, 404)
        return true
      }
      const agentSkillsRoot = agentParam === MAIN_AGENT_ID
        ? join(PROJECT_ROOT, '.claude', 'skills')
        : join(agentDir(agentParam), '.claude', 'skills')
      const skillDir = join(agentSkillsRoot, skillName)
      if (!skillDir.startsWith(agentSkillsRoot + sep)) {
        json(res, { error: 'Skill not found' }, 404)
        return true
      }
      const skillMdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(skillMdPath)) { json(res, { error: 'Skill not found' }, 404); return true }
      const content = readFileOr(skillMdPath, '')
      const files: string[] = []
      try { for (const entry of readdirSync(skillDir)) files.push(entry) } catch { /* no-op */ }
      let agentDetailMtime = 0
      try { agentDetailMtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
      json(res, {
        name: skillName,
        description: parseSkillDescription(content),
        keywords: parseSkillKeywords(content),
        content,
        agents: [],
        agentId: agentParam,
        path: skillDir,
        mtime: agentDetailMtime,
        files,
        source: 'agent',
      })
      return true
    }

    if (skillName.includes(':')) {
      const lastColon = skillName.lastIndexOf(':')
      const pluginPath = skillName.slice(0, lastColon)
      const skillBasename = skillName.slice(lastColon + 1)
      const PLUGINS_CACHE_DIR = join(homedir(), '.claude', 'plugins', 'cache')
      const skillDir = join(PLUGINS_CACHE_DIR, ...pluginPath.split('/'), 'skills', skillBasename)
      if (!skillDir.startsWith(PLUGINS_CACHE_DIR + sep)) {
        json(res, { error: 'Skill not found' }, 404)
        return true
      }
      const skillMdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(skillMdPath)) { json(res, { error: 'Skill not found' }, 404); return true }
      const content = readFileOr(skillMdPath, '')
      const files: string[] = []
      try { for (const entry of readdirSync(skillDir)) files.push(entry) } catch { /* no-op */ }
      let pluginDetailMtime = 0
      try { pluginDetailMtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
      json(res, {
        name: skillName,
        description: parseSkillDescription(content),
        keywords: parseSkillKeywords(content),
        content,
        agents: [],
        path: skillDir,
        mtime: pluginDetailMtime,
        files,
        source: 'plugin',
        pluginPackage: pluginPath,
      })
      return true
    }

    const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    const skillDir = join(GLOBAL_SKILLS_DIR, skillName)
    if (!skillDir.startsWith(GLOBAL_SKILLS_DIR + sep)) {
      json(res, { error: 'Skill not found' }, 404)
      return true
    }
    if (!existsSync(skillDir)) { json(res, { error: 'Skill not found' }, 404); return true }

    const skillMdPath = join(skillDir, 'SKILL.md')
    const content = readFileOr(skillMdPath, '')
    const description = parseSkillDescription(content)
    const keywords = parseSkillKeywords(content)
    let userDetailMtime = 0
    try { userDetailMtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }

    const files: string[] = []
    try {
      for (const entry of readdirSync(skillDir)) files.push(entry)
    } catch { /* empty */ }

    json(res, {
      name: skillName,
      description,
      keywords,
      content,
      agents: getSkillAgents(skillName),
      path: skillDir,
      mtime: userDetailMtime,
      files,
      source: 'user',
    })
    return true
  }

  if (path === '/api/skills' && method === 'POST') {
    const body = await readBody(req)
    const { name: rawSkillName, description } = JSON.parse(body.toString()) as { name: string; description: string }
    const skillName = sanitizeSkillName(rawSkillName || '')
    if (!skillName) { json(res, { error: 'Skill name is required' }, 400); return true }
    if (!description) { json(res, { error: 'Skill description is required' }, 400); return true }

    const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    const skillDir = join(GLOBAL_SKILLS_DIR, skillName)
    if (!skillDir.startsWith(GLOBAL_SKILLS_DIR + sep)) {
      json(res, { error: 'Invalid skill name' }, 400)
      return true
    }
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

  if (path === '/api/skills/import' && method === 'POST') {
    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''
    const { file } = parseMultipart(body, contentType)
    if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }

    const skillsDir = join(homedir(), '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })

    const tmpPath = join(skillsDir, `_import_${randomUUID()}.zip`)
    const before = new Set(readdirSync(skillsDir))
    try {
      writeFileSync(tmpPath, file.data)
      const listOutput = execSync(`unzip -Z1 "${tmpPath}" 2>&1`, { timeout: 5000, encoding: 'utf-8' })
      const entries = listOutput.split('\n').map(l => l.trim()).filter(Boolean)
      for (const entry of entries) {
        if (entry.includes('..') || entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry)) {
          unlinkSync(tmpPath)
          json(res, { error: 'Invalid skill file: path traversal detected' }, 400)
          return true
        }
      }
      const topLevel = new Set<string>()
      for (const entry of entries) {
        const seg = entry.split('/')[0]
        if (seg) topLevel.add(seg)
      }
      for (const td of topLevel) {
        if (before.has(td)) {
          unlinkSync(tmpPath)
          json(res, {
            error: `Skill already exists: ${td}. Delete it first if you want to overwrite.`,
          }, 409)
          return true
        }
      }
      execSync(`unzip -o "${tmpPath}" -d "${skillsDir}"`, { timeout: 10000 })
      unlinkSync(tmpPath)

      const after = readdirSync(skillsDir).filter(f => !before.has(f))
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

      logger.info({ skills: extracted }, 'Global skill(s) imported')
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
      logger.error({ err }, 'Failed to import global skill')
      json(res, { error: 'Failed to extract .skill file' }, 500)
      return true
    }
  }

  const globalSkillAssignMatch = path.match(/^\/api\/skills\/([^/]+)\/assign$/)
  if (globalSkillAssignMatch && method === 'POST') {
    const skillName = decodeURIComponent(globalSkillAssignMatch[1])
    const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    const globalSkillDir = join(GLOBAL_SKILLS_DIR, skillName)

    if (!globalSkillDir.startsWith(GLOBAL_SKILLS_DIR + sep)) {
      json(res, { error: 'Skill not found' }, 404)
      return true
    }

    if (!existsSync(globalSkillDir)) { json(res, { error: 'Skill not found' }, 404); return true }

    const body = await readBody(req)
    const { agents: targetAgents } = JSON.parse(body.toString()) as { agents: string[] }

    const allAgentNames = listAgentNames()

    for (const agentName of targetAgents) {
      if (!allAgentNames.includes(agentName)) continue
      const agentSkillsDir = join(AGENTS_BASE_DIR, agentName, '.claude', 'skills')
      mkdirSync(agentSkillsDir, { recursive: true })
      const destDir = join(agentSkillsDir, skillName)
      if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
      execSync(`cp -r ${shellEscape(globalSkillDir)} ${shellEscape(destDir)}`, { timeout: 10000 })
    }

    for (const agentName of allAgentNames) {
      if (targetAgents.includes(agentName)) continue
      const agentSkillDir = join(AGENTS_BASE_DIR, agentName, '.claude', 'skills', skillName)
      if (existsSync(agentSkillDir)) {
        rmSync(agentSkillDir, { recursive: true, force: true })
      }
    }

    logger.info({ skillName, agents: targetAgents }, 'Skill assignment updated')
    json(res, { ok: true })
    return true
  }

  const globalSkillPutMatch = path.match(/^\/api\/skills\/([^/]+)$/)
  if (globalSkillPutMatch && method === 'PUT') {
    const skillName = decodeURIComponent(globalSkillPutMatch[1])
    if (skillName.includes(':')) {
      json(res, { error: 'Plugin skills cannot be edited' }, 403)
      return true
    }

    const agentPutParam = ctx.url.searchParams.get('agent')
    if (agentPutParam) {
      const validPutAgentIds = new Set([MAIN_AGENT_ID, ...listAgentNames()])
      if (!validPutAgentIds.has(agentPutParam)) {
        json(res, { error: 'Skill not found' }, 404)
        return true
      }
      const agentSkillsRoot = agentPutParam === MAIN_AGENT_ID
        ? join(PROJECT_ROOT, '.claude', 'skills')
        : join(agentDir(agentPutParam), '.claude', 'skills')
      const skillDir = join(agentSkillsRoot, skillName)
      if (!skillDir.startsWith(agentSkillsRoot + sep)) {
        json(res, { error: 'Invalid skill name' }, 400)
        return true
      }
      if (!existsSync(skillDir)) { json(res, { error: 'Skill not found' }, 404); return true }
      const skillMdPath = join(skillDir, 'SKILL.md')
      const body = await readBody(req)
      const { content } = JSON.parse(body.toString()) as { content: string }
      if (typeof content !== 'string') { json(res, { error: 'content is required' }, 400); return true }
      atomicWriteFileSync(skillMdPath, content)
      logger.info({ skillName, agentId: agentPutParam }, 'Agent-local skill updated via dashboard')
      json(res, { ok: true })
      return true
    }

    const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    const skillDir = join(GLOBAL_SKILLS_DIR, skillName)
    if (!skillDir.startsWith(GLOBAL_SKILLS_DIR + sep)) {
      json(res, { error: 'Invalid skill name' }, 400)
      return true
    }
    if (!existsSync(skillDir)) { json(res, { error: 'Skill not found' }, 404); return true }
    const skillMdPath = join(skillDir, 'SKILL.md')
    const body = await readBody(req)
    const { content } = JSON.parse(body.toString()) as { content: string }
    if (typeof content !== 'string') { json(res, { error: 'content is required' }, 400); return true }
    atomicWriteFileSync(skillMdPath, content)
    logger.info({ skillName }, 'Skill updated via dashboard')
    json(res, { ok: true })
    return true
  }

  return false
}
