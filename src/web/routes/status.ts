import { logger } from '../../logger.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleStatus(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/status' && method === 'GET') {
    try {
      const rssResponse = await fetch('https://status.claude.com/history.rss', { signal: AbortSignal.timeout(10000) })
      const rssText = await rssResponse.text()

      const items: any[] = []
      const itemRegex = /<item>([\s\S]*?)<\/item>/g
      let match
      while ((match = itemRegex.exec(rssText)) !== null) {
        const itemXml = match[1]
        const title = itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || ''
        const description = itemXml.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() || ''
        const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || ''
        const link = itemXml.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || ''

        const cleanDesc = description
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&apos;/g, "'")
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

        let status = 'investigating'
        if (cleanDesc.toLowerCase().includes('resolved')) status = 'resolved'
        else if (cleanDesc.toLowerCase().includes('monitoring')) status = 'monitoring'
        else if (cleanDesc.toLowerCase().includes('identified')) status = 'identified'

        items.push({ title, description: cleanDesc, pubDate, link, status })
      }

      let overall = 'operational'
      const activeIncidents = items.filter(i => i.status !== 'resolved')
      if (activeIncidents.length > 0) overall = 'degraded'

      json(res, { overall, incidents: items.slice(0, 15), fetchedAt: Date.now() })
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Claude status')
      json(res, { overall: 'unknown', incidents: [], fetchedAt: Date.now(), error: 'Failed to fetch status' })
    }
    return true
  }

  return false
}
