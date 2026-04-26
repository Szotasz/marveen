import { resolve, sep } from 'node:path'

// NFD + combining-mark strip so Hungarian input like "etrendiro" decays
// to "etrendiro" instead of silently losing every accented character
// and producing "trendr".
export function sanitizeAgentName(raw: string): string {
  return raw.trim().toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

// Same rules as sanitizeAgentName -- used for skill names to prevent path traversal.
export function sanitizeSkillName(raw: string): string {
  return sanitizeAgentName(raw)
}

export function sanitizeScheduleName(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Joins segments and verifies the resolved path stays inside `base`. Throws on escape.
export function safeJoin(base: string, ...parts: string[]): string {
  const resolvedBase = resolve(base)
  const target = resolve(base, ...parts)
  if (target !== resolvedBase && !target.startsWith(resolvedBase + sep)) {
    throw new Error(`Path traversal rejected: ${parts.join('/')}`)
  }
  return target
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
