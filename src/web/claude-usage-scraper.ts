/**
 * CDP-based scraper for claude.ai/settings/usage.
 *
 * Connects to an already-running Chrome instance via the Chrome DevTools
 * Protocol (CDP) instead of launching a separate browser. This bypasses
 * Cloudflare bot-detection because we drive the user's own, already-logged-in
 * Chrome profile.
 *
 * Prerequisites:
 *   Start Chrome with a dedicated profile and the remote debugging port:
 *     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *       --remote-debugging-port=9222 \
 *       --user-data-dir=$HOME/.claude/chrome-cdp-profile \
 *       --no-first-run
 *   Sign in to claude.ai in that window once; subsequent scrapes reuse the session.
 *   Note: Chrome 149+ ignores --remote-debugging-port on the default profile.
 *         A dedicated --user-data-dir is required.
 *
 * SECURITY: no credentials, cookies, or session tokens are written to this
 * file or to any log. The user's Chrome profile is never touched by this code.
 */

import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

const USAGE_URL = 'https://claude.ai/settings/usage'

// CDP endpoint: env override or default debug port
const cdpUrl = (): string => process.env.CLAUDE_USAGE_CDP_URL ?? 'http://127.0.0.1:9222'

const CACHE_PATH = join(STORE_DIR, 'claude-usage.json')
const CACHE_TTL_MS = 14 * 60 * 1000  // 14 minutes — just under the 15-min poll interval

export interface ClaudeUsageData {
  sessionPct: number       // 0–100
  weeklyPct: number        // 0–100
  sessionResetAt: number   // epoch ms
  weeklyResetAt: number    // epoch ms
  fetchedAt: number        // epoch ms
}

export function readUsageCache(): ClaudeUsageData | null {
  try {
    if (!existsSync(CACHE_PATH)) return null
    const raw = readFileSync(CACHE_PATH, 'utf-8')
    const data = JSON.parse(raw) as ClaudeUsageData
    if (Date.now() - data.fetchedAt > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

function writeUsageCache(data: ClaudeUsageData): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(data))
  } catch (err) {
    logger.warn({ err }, 'claude-usage: failed to write cache')
  }
}

/**
 * Scrape usage percentages and reset times from claude.ai/settings/usage
 * by connecting to an already-running Chrome via CDP.
 *
 * Returns null if Chrome is not running on the debug port, if the page
 * structure has changed, or if any other error occurs.
 */
export async function scrapeClaudeUsage(): Promise<ClaudeUsageData | null> {
  const endpoint = cdpUrl()

  // Try to connect — fail gracefully if Chrome isn't running with --remote-debugging-port
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>
  try {
    browser = await chromium.connectOverCDP(endpoint)
  } catch {
    logger.info(
      `claude-usage: Chrome not reachable at ${endpoint} — ` +
      'start Chrome with --remote-debugging-port=9222 (or set CLAUDE_USAGE_CDP_URL)',
    )
    return null
  }

  let ownedPage = false
  let page: Page | null = null

  try {
    const contexts = browser.contexts()
    if (!contexts.length) {
      logger.warn('claude-usage: no browser context available via CDP')
      return null
    }
    const ctx = contexts[0]

    // Reuse an existing /settings/usage tab if one is already open
    for (const p of ctx.pages()) {
      if (p.url().includes('/settings/usage')) {
        page = p
        break
      }
    }

    // Otherwise open a new tab in the user's existing context
    if (!page) {
      page = await ctx.newPage()
      ownedPage = true
    }

    // Navigate to usage page if not already there
    if (!page.url().includes('/settings/usage')) {
      await page.goto(USAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }

    // Wait for the progress bars — this also covers any transient Cloudflare
    // interstitial that runs before the real page content renders.
    await page.waitForSelector('[role="progressbar"]', { timeout: 30000 })

    // --- Extract percentages and reset times from the usage page ---
    const result = await page.evaluate(() => {
      function pctFromBar(bar: Element): number | null {
        const now = bar.getAttribute('aria-valuenow')
        const max = bar.getAttribute('aria-valuemax') ?? '100'
        if (now == null) return null
        return Math.round((parseFloat(now) / parseFloat(max)) * 100)
      }

      // Walk up from a progressbar to find the section container that includes
      // reset-time text. Scoping to each section's subtree is essential to avoid
      // both sections matching the same "in Xh Ym" text from the body.
      function getSectionText(el: Element): string {
        let cur: Element | null = el
        for (let i = 0; i < 8; i++) {
          cur = cur?.parentElement ?? null
          if (!cur) break
          const txt = cur.textContent ?? ''
          if (txt.length > 80 && /reset|session|week/i.test(txt)) return txt
        }
        return el.closest('[class]')?.textContent ?? document.body.innerText
      }

      // Parse a reset timestamp from a section's text.
      // Session format: "Resets in 2h 15m"
      // Weekly format:  "Resets Tue 3:59 PM"
      function parseResetMs(text: string): number {
        // "in Xh Ym" — relative countdown (session)
        const inM = text.match(/in\s+(\d+)\s*h(?:ours?)?\s*(?:(\d+)\s*m(?:in)?)?/i)
        if (inM) {
          const h = parseInt(inM[1] || '0')
          const min = parseInt(inM[2] || '0')
          return Date.now() + (h * 3600 + min * 60) * 1000
        }
        // "Resets Mon 3:59 PM" — day-of-week + time (weekly)
        const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
        const dayM = text.match(/resets?\s+(sun|mon|tue|wed|thu|fri|sat)\w*\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
        if (dayM) {
          const targetDay = dayNames.indexOf(dayM[1].toLowerCase().slice(0, 3))
          let h = parseInt(dayM[2])
          const min = parseInt(dayM[3])
          if (dayM[4]?.toUpperCase() === 'PM' && h < 12) h += 12
          if (dayM[4]?.toUpperCase() === 'AM' && h === 12) h = 0
          const now = new Date()
          const t = new Date(now)
          t.setHours(h, min, 0, 0)
          let daysUntil = (targetDay - now.getDay() + 7) % 7
          if (daysUntil === 0 && t.getTime() <= now.getTime()) daysUntil = 7
          t.setDate(t.getDate() + daysUntil)
          return t.getTime()
        }
        // "at HH:MM" fallback (today/tomorrow)
        const atM = text.match(/at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
        if (atM) {
          const now = new Date()
          let h = parseInt(atM[1])
          const min = parseInt(atM[2])
          if (atM[3]?.toUpperCase() === 'PM' && h < 12) h += 12
          if (atM[3]?.toUpperCase() === 'AM' && h === 12) h = 0
          const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min)
          if (t.getTime() < now.getTime()) t.setDate(t.getDate() + 1)
          return t.getTime()
        }
        return 0
      }

      const bars = Array.from(document.querySelectorAll('[role="progressbar"]'))
      let sessionPct: number | null = null
      let weeklyPct: number | null = null
      let sessionBar: Element | null = null
      let weeklyBar: Element | null = null

      for (const bar of bars) {
        const ctx = (bar.closest('[class]')?.textContent ?? '').toLowerCase()
        const pct = pctFromBar(bar)
        if (pct == null) continue
        if (ctx.includes('session') && sessionBar == null) { sessionPct = pct; sessionBar = bar }
        else if ((ctx.includes('week') || ctx.includes('all models')) && weeklyBar == null) { weeklyPct = pct; weeklyBar = bar }
        else if (sessionBar == null) { sessionPct = pct; sessionBar = bar }
        else if (weeklyBar == null) { weeklyPct = pct; weeklyBar = bar }
      }

      // Text extraction fallback for percentages
      if (sessionPct == null || weeklyPct == null) {
        const body = document.body.innerText
        const sessionM = body.match(/current session[^0-9]*(\d+(?:\.\d+)?)\s*%/i)
          ?? body.match(/(\d+(?:\.\d+)?)\s*%[^]*?current session/i)
        const weeklyM = body.match(/weekly[^0-9]*(\d+(?:\.\d+)?)\s*%/i)
          ?? body.match(/all models[^0-9]*(\d+(?:\.\d+)?)\s*%/i)
          ?? body.match(/(\d+(?:\.\d+)?)\s*%[^]*?weekly/i)
        if (sessionPct == null && sessionM) sessionPct = parseFloat(sessionM[1])
        if (weeklyPct == null && weeklyM) weeklyPct = parseFloat(weeklyM[1])
      }

      // Parse reset times from each section's own DOM subtree, NOT from the
      // full body, to prevent the session "in Xh Ym" from bleeding into the
      // weekly parse (which uses a different format: "Resets Tue 3:59 PM").
      const sessionText = sessionBar ? getSectionText(sessionBar) : document.body.innerText
      const weeklyText = weeklyBar ? getSectionText(weeklyBar) : document.body.innerText
      const sessionResetAt = parseResetMs(sessionText) || (Date.now() + 5 * 3600 * 1000)
      const weeklyResetAt = parseResetMs(weeklyText) || (Date.now() + 7 * 24 * 3600 * 1000)

      return { sessionPct, weeklyPct, sessionResetAt, weeklyResetAt }
    })

    if (result.sessionPct == null && result.weeklyPct == null) {
      logger.warn('claude-usage: could not extract usage data from page')
      return null
    }

    const data: ClaudeUsageData = {
      sessionPct: result.sessionPct ?? 0,
      weeklyPct: result.weeklyPct ?? 0,
      sessionResetAt: result.sessionResetAt,
      weeklyResetAt: result.weeklyResetAt,
      fetchedAt: Date.now(),
    }
    writeUsageCache(data)
    logger.info({ data }, 'claude-usage: scraped successfully')
    return data

  } catch (err) {
    logger.warn({ err }, 'claude-usage: scrape failed')
    return null
  } finally {
    // Close only the page we opened; never close the user's browser.
    if (page && ownedPage) await page.close().catch(() => {})
    // On CDP connections Playwright's browser.close() only disconnects the
    // session — it does NOT shut down the user's Chrome process.
    await browser.close()
  }
}
