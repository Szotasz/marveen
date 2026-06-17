import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveFile } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleStatic(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path } = ctx

  if (path === '/' || path === '/index.html') { serveFile(req, res, join(webDir, 'index.html')); return true }
  if (path === '/style.css') { serveFile(req, res, join(webDir, 'style.css')); return true }
  if (path === '/app.js') { serveFile(req, res, join(webDir, 'app.js')); return true }
  if (path === '/manifest.json') { serveFile(req, res, join(webDir, 'manifest.json')); return true }
  if (path === '/sw.js') { serveFile(req, res, join(webDir, 'sw.js')); return true }

  if (path.startsWith('/avatars/')) {
    const avatarFile = path.replace('/avatars/', '')
    const avatarPath = join(webDir, 'avatars', avatarFile)
    if (existsSync(avatarPath)) { serveFile(req, res, avatarPath); return true }
    res.writeHead(404); res.end()
    return true
  }

  if (path.startsWith('/icons/')) {
    const iconFile = path.replace('/icons/', '')
    const iconPath = join(webDir, 'icons', iconFile)
    if (existsSync(iconPath)) { serveFile(req, res, iconPath); return true }
    res.writeHead(404); res.end()
    return true
  }

  return false
}
