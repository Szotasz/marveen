import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { saveAgentMemory } from '../../db.js'
import { MAIN_AGENT_ID, OLLAMA_URL } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleMigrate(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/migrate/scan' && method === 'POST') {
    const body = await readBody(req)
    const { sourcePath } = JSON.parse(body.toString()) as { sourcePath: string; sourceType: string }

    if (!sourcePath?.trim()) { json(res, { error: 'Útvonal megadása kötelező' }, 400); return true }
    if (!existsSync(sourcePath)) { json(res, { error: 'A megadott útvonal nem létezik' }, 404); return true }

    const findings: { type: string; path: string; name: string; size: number }[] = []

    const addFinding = (type: string, filePath: string) => {
      if (existsSync(filePath)) {
        const stat = statSync(filePath)
        findings.push({ type, path: filePath, name: filePath.split('/').pop() || '', size: stat.size })
      }
    }

    const knownFiles = [
      { pattern: 'MEMORY.md', type: 'memory-cold' },
      { pattern: 'memory/hot/HOT_MEMORY.md', type: 'memory-hot' },
      { pattern: 'memory/warm/WARM_MEMORY.md', type: 'memory-warm' },
      { pattern: 'SOUL.md', type: 'personality' },
      { pattern: 'USER.md', type: 'profile' },
      { pattern: 'HEARTBEAT.md', type: 'heartbeat' },
      { pattern: 'AGENTS.md', type: 'config' },
      { pattern: 'TOOLS.md', type: 'config' },
      { pattern: 'CLAUDE.md', type: 'config' },
    ]

    for (const kf of knownFiles) {
      addFinding(kf.type, join(sourcePath, kf.pattern))
    }

    try {
      const scanDirs = ['memory', 'memories', 'bank', 'notes', '']
      for (const dir of scanDirs) {
        const scanPath = dir ? join(sourcePath, dir) : sourcePath
        if (!existsSync(scanPath)) continue
        const files = readdirSync(scanPath).filter(f =>
          (f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json')) &&
          !['package.json', 'tsconfig.json', 'package-lock.json', '.mcp.json'].includes(f)
        )
        for (const f of files) {
          const fullPath = join(scanPath, f)
          if (findings.some(fi => fi.path === fullPath)) continue
          try {
            const stat = statSync(fullPath)
            if (stat.isFile() && stat.size > 20) {
              const lower = f.toLowerCase()
              let type = 'memory'
              if (lower.includes('soul') || lower.includes('personality')) type = 'personality'
              else if (lower.includes('user') || lower.includes('profile')) type = 'profile'
              else if (lower.includes('heartbeat')) type = 'heartbeat'
              else if (lower.includes('cron') || lower.includes('schedule')) type = 'schedule'
              else if (lower.match(/^\d{4}-\d{2}-\d{2}/)) type = 'daily-log'
              findings.push({ type, path: fullPath, name: f, size: stat.size })
            }
          } catch {}
        }
      }
    } catch {}

    json(res, {
      ok: true,
      sourcePath,
      findings,
      summary: {
        personality: findings.filter(f => f.type === 'personality').length,
        profile: findings.filter(f => f.type === 'profile').length,
        memory: findings.filter(f => f.type.startsWith('memory')).length,
        heartbeat: findings.filter(f => f.type === 'heartbeat').length,
        config: findings.filter(f => f.type === 'config').length,
        dailyLog: findings.filter(f => f.type === 'daily-log').length,
        schedule: findings.filter(f => f.type === 'schedule').length,
        total: findings.length,
      }
    })
    return true
  }

  if (path === '/api/migrate/run' && method === 'POST') {
    const body = await readBody(req)
    const { findings, agentId: targetAgent } = JSON.parse(body.toString()) as {
      findings: { type: string; path: string; name: string }[];
      agentId: string
    }

    const agentId = targetAgent || MAIN_AGENT_ID
    let imported = 0
    const stats = { hot: 0, warm: 0, cold: 0, shared: 0 }
    const details: string[] = []

    for (const f of findings.filter(fi => fi.type === 'personality')) {
      try {
        const content = readFileSync(f.path, 'utf-8').slice(0, 3000)
        saveAgentMemory(agentId, `[Importált személyiség] ${content}`, 'warm', 'személyiség, soul, import', true)
        stats.warm++
        imported++
        details.push(`Személyiség: ${f.name}`)
      } catch {}
    }

    for (const f of findings.filter(fi => fi.type === 'profile')) {
      try {
        const content = readFileSync(f.path, 'utf-8').slice(0, 3000)
        saveAgentMemory(agentId, `[Importált felhasználói profil] ${content}`, 'warm', 'felhasználó, profil, import', true)
        stats.warm++
        imported++
        details.push(`Profil: ${f.name}`)
      } catch {}
    }

    for (const f of findings.filter(fi => fi.type === 'heartbeat')) {
      try {
        const content = readFileSync(f.path, 'utf-8').slice(0, 2000)
        saveAgentMemory(agentId, `[Importált heartbeat konfig] ${content}`, 'warm', 'heartbeat, konfig, import', true)
        stats.warm++
        imported++
        details.push(`Heartbeat: ${f.name}`)
      } catch {}
    }

    const memoryFindings = findings.filter(fi =>
      fi.type.startsWith('memory') || fi.type === 'config' || fi.type === 'daily-log'
    )

    const chunks: string[] = []
    for (const f of memoryFindings) {
      try {
        const content = readFileSync(f.path, 'utf-8')
        const ext = f.name.split('.').pop()?.toLowerCase()
        if (ext === 'json') {
          try {
            const data = JSON.parse(content)
            if (Array.isArray(data)) {
              for (const item of data) {
                const text = typeof item === 'object' ? (item.content || item.text || JSON.stringify(item)) : String(item)
                if (String(text).trim().length > 20) chunks.push(String(text).slice(0, 2000))
              }
            } else if (typeof data === 'object') {
              for (const [k, v] of Object.entries(data)) {
                const text = `${k}: ${v}`
                if (text.length > 20) chunks.push(text.slice(0, 2000))
              }
            }
          } catch { if (content.trim().length > 20) chunks.push(content.slice(0, 2000)) }
        } else {
          const sections = ext === 'md' ? content.split(/\n(?=##?\s)/) : content.split(/\n\n+/)
          for (const section of sections) {
            if (section.trim().length > 20) chunks.push(section.trim().slice(0, 2000))
          }
        }
      } catch {}
    }

    if (chunks.length > 0) {
      let categorizeModel: string | null = null
      try {
        const modelsResp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
        const modelsData = await modelsResp.json() as { models?: { name: string }[] }
        const available = (modelsData.models || []).filter(m => !m.name.includes('embed')).map(m => m.name)
        categorizeModel = available.find(m => m.includes('gemma4')) || available[0] || null
      } catch {}

      for (const chunk of chunks) {
        try {
          let tier = 'warm'
          let keywords = ''

          if (categorizeModel) {
            const catResp = await fetch(`${OLLAMA_URL}/api/generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: categorizeModel,
                prompt: `Categorize this memory. Respond ONLY with JSON:\n{"tier":"warm","keywords":"kw1, kw2"}\nTiers: hot (active/urgent), warm (preferences/config), cold (lessons/archive), shared (multi-agent)\n\nMemory: "${chunk.slice(0, 400)}"`,
                stream: false,
              }),
              signal: AbortSignal.timeout(90000),
            })
            const catData = await catResp.json() as { response?: string }
            const jsonMatch = (catData.response || '').match(/\{[\s\S]*\}/)
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0])
              tier = ['hot', 'warm', 'cold', 'shared'].includes(parsed.tier) ? parsed.tier : 'warm'
              keywords = parsed.keywords || ''
            }
          }

          saveAgentMemory(agentId, chunk, tier, keywords, true)
          stats[tier as keyof typeof stats]++
          imported++

          if (chunks.indexOf(chunk) < chunks.length - 1) {
            await new Promise(r => setTimeout(r, 200))
          }
        } catch {
          saveAgentMemory(agentId, chunk, 'warm', '', true)
          stats.warm++
          imported++
        }
      }

      details.push(`${chunks.length} memória chunk feldolgozva`)
    }

    logger.info({ agentId, imported, stats }, 'Költöztetés kész')
    json(res, { ok: true, imported, stats, details })
    return true
  }

  return false
}
