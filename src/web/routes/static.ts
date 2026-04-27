import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveFile } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleStatic(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { res, path } = ctx

  if (path === '/' || path === '/index.html') { serveFile(res, join(webDir, 'index.html')); return true }
  if (path === '/style.css') { serveFile(res, join(webDir, 'style.css')); return true }
  if (path === '/app.js') { serveFile(res, join(webDir, 'app.js')); return true }

  if (path.startsWith('/avatars/')) {
    const avatarFile = path.replace('/avatars/', '')
    const avatarPath = join(webDir, 'avatars', avatarFile)
    if (existsSync(avatarPath)) { serveFile(res, avatarPath); return true }
    res.writeHead(404); res.end()
    return true
  }

  return false
}
