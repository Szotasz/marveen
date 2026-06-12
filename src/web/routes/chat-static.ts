// Static serving for the chat app SPA (web-chat/) under /chat/. Kept apart
// from the dashboard's web/ assets: the chat subdomain proxy only needs to
// forward /chat/ and /chat-api/ (and redirect / -> /chat/), so the admin
// dashboard's HTML never appears on the colleague-facing origin. Whitelisted
// filenames instead of path-joining user input -- no traversal surface.
import { join } from 'node:path'
import { CHAT_APP_ENABLED } from '../../config.js'
import { serveFile, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const FILES: Record<string, string> = {
  '/chat': 'index.html',
  '/chat/': 'index.html',
  '/chat/index.html': 'index.html',
  '/chat/app.js': 'app.js',
  '/chat/style.css': 'style.css',
}

export async function tryHandleChatStatic(ctx: RouteContext, chatWebDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (!(path in FILES)) return false
  if (!CHAT_APP_ENABLED) {
    json(res, { error: 'Chat app is not enabled' }, 404)
    return true
  }
  if (method !== 'GET' && method !== 'HEAD') return false
  serveFile(req, res, join(chatWebDir, FILES[path]))
  return true
}
