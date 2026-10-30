import { createReadStream, existsSync, readdirSync, mkdirSync, unlinkSync, rmSync, statSync } from 'node:fs'
import { join, sep, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../../logger.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { AGENTS_BASE_DIR, listAgentNames, readFileOr, agentDir } from '../agent-config.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../../config.js'
import { generateSkillMd } from '../agent-scaffold.js'
import {
  approvePending, getPending, importArchiveToPending, listPending, nameConflict, queueGeneratedSkill, queueProposedSkill, MAX_PROPOSED_SKILL_BYTES, rejectPending, targetRoot,
  type SkillTarget,
} from '../skill-quarantine.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json } from '../http-helpers.js'
import { sanitizeSkillName } from '../sanitize.js'
import { serializeSkillsDir } from '../skills-dir-queue.js'
import type { RouteContext } from './types.js'
import { mayIssueCredentials, OWNER_SESSION_REQUIRED } from './auth.js'

const execFileAsync = promisify(execFile)

// zip and cp run as an argv (no shell) and off the event loop: the synchronous
// shell form froze the whole dashboard for up to its 10-15 s timeout. stdin is
// closed at once, as execSync did.
async function runTool(file: string, args: string[], opts: { cwd?: string; timeout: number }): Promise<void> {
  const pending = execFileAsync(file, args, opts)
  pending.child.stdin?.end()
  await pending
}

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
      // Only the zip itself holds the queue: once it is written, tmpZip is a private copy.
      const stat = await serializeSkillsDir(async () => {
        await runTool('zip', ['-r', tmpZip, '.', '--include', '*/SKILL.md', '--include', '*/references/*'], { cwd: USER_SKILLS_DIR, timeout: 15000 })
        return statSync(tmpZip)
      })
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

  // The approval queue. GET lists every pending skill with its file list, scan
  // report and hash; approve takes the hash the approver was shown.
  if (path === '/api/skills/pending' && method === 'GET') {
    json(res, listPending())
    return true
  }
  const pendingDetailMatch = path.match(/^\/api\/skills\/pending\/([^/]+)$/)
  if (pendingDetailMatch && method === 'GET') {
    let p
    try { p = getPending(decodeURIComponent(pendingDetailMatch[1])) } catch { p = null }
    if (!p) { json(res, { error: 'Pending skill not found' }, 404); return true }
    json(res, p)
    return true
  }
  const pendingActionMatch = path.match(/^\/api\/skills\/pending\/([^/]+)\/(approve|reject)$/)
  if (pendingActionMatch && method === 'POST') {
    // The decision on a quarantined skill is the owner's, never the shared token every agent holds
    // (an agent could otherwise put its own quarantined skill live, fleet-wide). The same predicate
    // as issuing credentials (mayIssueCredentials, #2163): the owner's session, also when the
    // browser sends the stored token alongside it; the bare token only before the first dashboard
    // login exists. Reject is held to the same bar, so an agent cannot discard what is waiting for
    // the owner's review either.
    if (!mayIssueCredentials(ctx.auth, req)) {
      logger.warn({ id: pendingActionMatch[1], action: pendingActionMatch[2], auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'Pending skill decision refused: no owner session')
      json(res, OWNER_SESSION_REQUIRED, 403)
      return true
    }
    const id = decodeURIComponent(pendingActionMatch[1])
    if (pendingActionMatch[2] === 'reject') {
      let ok = false
      try { ok = rejectPending(id) } catch { ok = false }
      if (!ok) { json(res, { error: 'Pending skill not found' }, 404); return true }
      logger.info({ id }, 'Pending skill rejected')
      json(res, { ok: true })
      return true
    }
    const body = await readBody(req)
    let hash: unknown
    try { hash = (JSON.parse(body.toString() || '{}') as { hash?: unknown }).hash } catch { hash = undefined }
    const r = await serializeSkillsDir(() => {
      try { return approvePending(id, hash) } catch { return { ok: false as const, status: 404, error: 'Pending skill not found' } }
    })
    if (!r.ok) { json(res, { error: r.error }, r.status); return true }
    logger.info({ id, name: r.name, path: r.path, auth: ctx.auth?.kind }, 'Pending skill approved and installed')
    json(res, { ok: true, name: r.name })
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

  // D4: an agent proposes a complete SKILL.md for the GLOBAL root. It is queued like a generated
  // skill and waits for the owner's approval; an already-live name is a replacement, whose
  // approval backs the old version up (skill-quarantine.ts). Proposing needs only the dashboard
  // token every agent holds; approving stays owner-only (see the pending routes above).
  if (path === '/api/skills/propose' && method === 'POST') {
    let body: { name?: unknown; skill_md?: unknown; reason?: unknown }
    try { body = JSON.parse((await readBody(req)).toString()) } catch { json(res, { error: 'Invalid JSON body' }, 400); return true }
    const rawName = typeof body?.name === 'string' ? body.name : ''
    const name = sanitizeSkillName(rawName)
    if (!name || name !== rawName) { json(res, { error: 'Invalid skill name (use lowercase letters, digits and hyphens)' }, 400); return true }
    const root = targetRoot({ scope: 'global' })
    if (!join(root, name).startsWith(root + sep)) { json(res, { error: 'Invalid skill name' }, 400); return true }
    const skillMd = body?.skill_md
    if (typeof skillMd !== 'string' || !skillMd.trim()) { json(res, { error: 'skill_md (the full SKILL.md text) is required' }, 400); return true }
    if (Buffer.byteLength(skillMd) > MAX_PROPOSED_SKILL_BYTES) { json(res, { error: `skill_md is over ${MAX_PROPOSED_SKILL_BYTES} bytes` }, 400); return true }
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 2000) : undefined
    const proposedBy = typeof ctx.auth?.agent === 'string' && ctx.auth.agent ? ctx.auth.agent : undefined
    const r = queueProposedSkill(name, skillMd, { proposedBy, reason })
    if (!r.ok) { json(res, { error: r.error }, r.status); return true }
    logger.info({ name, id: r.meta.id, replaces: !!r.meta.replaces, proposedBy }, 'Global skill proposed and queued for approval')
    json(res, { ok: true, name, pending: true, id: r.meta.id, replaces: !!r.meta.replaces })
    return true
  }

  // MARVEENGAPS1020 (b): a generated skill is QUEUED for approval, never written
  // into the global root, which every agent of the fleet loads. See
  // skill-quarantine.ts for what the approver is shown and what is not covered.
  if (path === '/api/skills' && method === 'POST') {
    const body = await readBody(req)
    const { name: rawSkillName, description } = JSON.parse(body.toString()) as { name: string; description: string }
    const skillName = sanitizeSkillName(rawSkillName || '')
    if (!skillName) { json(res, { error: 'Skill name is required' }, 400); return true }
    if (!description) { json(res, { error: 'Skill description is required' }, 400); return true }

    const target: SkillTarget = { scope: 'global' }
    const skillDir = join(targetRoot(target), skillName)
    if (!skillDir.startsWith(targetRoot(target) + sep)) {
      json(res, { error: 'Invalid skill name' }, 400)
      return true
    }
    const clash = nameConflict(target, skillName)
    if (clash === 'live') { json(res, { error: 'Skill already exists' }, 409); return true }
    if (clash === 'pending') { json(res, { error: 'A skill with this name is already waiting for approval' }, 409); return true }

    let skillMd: string
    try {
      skillMd = await generateSkillMd(skillName, description)
    } catch {
      json(res, { error: 'Failed to generate skill' }, 500)
      return true
    }
    const queued = queueGeneratedSkill(target, skillName, skillMd)
    logger.info({ name: skillName, id: queued.id }, 'Global skill generated and queued for approval')
    json(res, { ok: true, name: skillName, pending: true, id: queued.id })
    return true
  }

  if (path === '/api/skills/import' && method === 'POST') {
    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''
    const { file } = parseMultipart(body, contentType)
    if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }
    try {
      const r = importArchiveToPending({ scope: 'global' }, file.data)
      if (!r.ok) { json(res, { error: r.error }, r.status); return true }
      const names = r.queued.map((q) => q.name)
      logger.info({ skills: names }, 'Global skill(s) imported and queued for approval')
      json(res, { ok: true, imported: names, pending: true, ids: r.queued.map((q) => q.id) })
    } catch (err) {
      logger.error({ err }, 'Failed to import global skill')
      json(res, { error: 'Failed to extract .skill file' }, 500)
    }
    return true
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

    await serializeSkillsDir(async () => {
      // Checked again on the queue: a delete queued before this assign may have removed the source.
      if (!existsSync(globalSkillDir)) { json(res, { error: 'Skill not found' }, 404); return }
      const allAgentNames = listAgentNames()

      for (const agentName of targetAgents) {
        if (!allAgentNames.includes(agentName)) continue
        const agentSkillsDir = join(AGENTS_BASE_DIR, agentName, '.claude', 'skills')
        mkdirSync(agentSkillsDir, { recursive: true })
        const destDir = join(agentSkillsDir, skillName)
        if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
        await runTool('cp', ['-r', globalSkillDir, destDir], { timeout: 10000 })
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
    })
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
