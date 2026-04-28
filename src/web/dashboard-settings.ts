import { existsSync, statSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { readFileOr } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

const SETTINGS_PATH = join(PROJECT_ROOT, 'store', 'dashboard-settings.json')

interface DashboardSettings {
  externalProjectPaths?: string[]
}

function read(): DashboardSettings {
  try { return JSON.parse(readFileOr(SETTINGS_PATH, '{}')) }
  catch { return {} }
}

function write(s: DashboardSettings): void {
  atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + '\n')
}

export function getExternalProjectPaths(): string[] {
  return read().externalProjectPaths || []
}

export function addExternalProjectPath(raw: string): { paths: string[], error?: string } {
  if (!raw || !isAbsolute(raw)) return { paths: getExternalProjectPaths(), error: 'Absolute path required' }
  const p = resolve(raw)
  if (!existsSync(p) || !statSync(p).isDirectory()) return { paths: getExternalProjectPaths(), error: 'Directory does not exist' }
  const s = read()
  const list = s.externalProjectPaths || []
  if (list.includes(p)) return { paths: list }
  list.push(p)
  s.externalProjectPaths = list
  write(s)
  return { paths: list }
}

export function removeExternalProjectPath(raw: string): string[] {
  const p = resolve(raw)
  const s = read()
  s.externalProjectPaths = (s.externalProjectPaths || []).filter(x => x !== p)
  write(s)
  return s.externalProjectPaths
}
