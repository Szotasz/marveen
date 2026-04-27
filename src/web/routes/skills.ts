import { existsSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, rmSync, statSync, lstatSync } from 'node:fs'
import { join, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { logger } from '../../logger.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { AGENTS_BASE_DIR, listAgentNames, readFileOr } from '../agent-config.js'
import { generateSkillMd } from '../agent-scaffold.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json } from '../http-helpers.js'
import { sanitizeSkillName, shellEscape } from '../sanitize.js'
import type { RouteContext } from './types.js'

function parseSkillDescription(content: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return ''
  const fm = fmMatch[1]
  const descLine = fm.match(/^description:\s*(.+)/im)
  if (!descLine) return ''
  let val = descLine[1].trim()
  if (val.startsWith('"')) {
    const quoted = val.match(/^"(.*)"/)
    if (quoted) return quoted[1].trim()
    return val.replace(/^"/, '').replace(/"$/, '').trim()
  }
  if (val.startsWith("'")) {
    const quoted = val.match(/^'(.*)'/)
    if (quoted) return quoted[1].trim()
    return val.replace(/^'/, '').replace(/'$/, '').trim()
  }
  return val
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
      path: string
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
      for (const dir of dirs) {
        const skillMdPath = join(USER_SKILLS_DIR, dir, 'SKILL.md')
        if (!existsSync(skillMdPath)) continue
        skills.push({
          name: dir,
          label: dir,
          description: parseSkillDescription(readFileOr(skillMdPath, '')),
          agents: [],
          path: join(USER_SKILLS_DIR, dir),
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
            skills.push({
              name: pluginPackage ? `${pluginPackage}:${sd}` : sd,
              label: `${shortPlugin}:${sd}`,
              description: parseSkillDescription(readFileOr(skillMdPath, '')),
              agents: [],
              path: skillDirPath,
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

  const globalSkillDetailMatch = path.match(/^\/api\/skills\/([^/]+)$/)
  if (globalSkillDetailMatch && method === 'GET') {
    const skillName = decodeURIComponent(globalSkillDetailMatch[1])

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
      json(res, {
        name: skillName,
        description: parseSkillDescription(content),
        content,
        agents: [],
        path: skillDir,
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

    const files: string[] = []
    try {
      for (const entry of readdirSync(skillDir)) files.push(entry)
    } catch { /* empty */ }

    json(res, {
      name: skillName,
      description,
      content,
      agents: getSkillAgents(skillName),
      path: skillDir,
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

  return false
}
