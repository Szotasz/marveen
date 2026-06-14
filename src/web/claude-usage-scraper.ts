/**
 * Headless Playwright scraper for claude.ai/settings/usage.
 *
 * Uses a persistent browser profile so the user only has to sign in once
 * (headed mode). Subsequent calls run headless against the stored session.
 *
 * SECURITY: no credentials, cookies, or session tokens are written to this
 * file or to any log. The persistent profile directory is gitignored and
 * lives outside the project root.
 */

import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

const USAGE_URL = 'https://claude.ai/settings/usage'

// Profile dir: env override or ~/.claude/claude-usage-profile (gitignored)
function profileDir(): string {
  return process.env.CLAUDE_USAGE_PROFILE_DIR ?? join(homedir(), '.claude', 'claude-usage-profile')
}

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

/** Parse a percentage string like "35%" → 35. Returns null if unparseable. */
function parsePct(s: string | null | undefined): number | null {
  if (!s) return null
  const m = s.match(/(\d+(?:\.\d+)?)/)
  if (!m) return null
  const v = parseFloat(m[1])
  return isNaN(v) ? null : Math.min(100, Math.max(0, v))
}

/**
 * Scrape usage percentages and reset times from claude.ai/settings/usage.
 * Returns null if not logged in or page structure has changed.
 *
 * headed=true opens a visible browser window (for first-time login).
 */
export async function scrapeClaudeUsage(headed = false): Promise<ClaudeUsageData | null> {
  const dir = profileDir()
  mkdirSync(dir, { recursive: true })

  const browser = await chromium.launchPersistentContext(dir, {
    headless: !headed,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  try {
    const page = browser.pages()[0] ?? await browser.newPage()

    await page.goto(USAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

    const onLoginPage = () => page.url().includes('/login') || page.url().includes('/auth')

    if (onLoginPage()) {
      if (!headed) {
        // Headless: no user present to log in — bail immediately.
        logger.info('claude-usage: not logged in (headless), skipping')
        return null
      }
      // Headed: wait up to 5 minutes for the user to complete login and land
      // on the usage page. The browser window stays open so they can sign in.
      logger.info('claude-usage: not logged in — waiting for user to sign in (headed, up to 5 min)')
      try {
        await page.waitForURL('**/settings/usage**', { timeout: 5 * 60 * 1000 })
      } catch {
        logger.warn('claude-usage: login wait timed out after 5 minutes')
        return null
      }
    }

    // Allow JS to render the usage data after navigation settles
    await page.waitForTimeout(3000)

    // --- Strategy 1: aria progressbar values ---
    const result = await page.evaluate(() => {
      function pctFromBar(bar: Element): number | null {
        const now = bar.getAttribute('aria-valuenow')
        const max = bar.getAttribute('aria-valuemax') ?? '100'
        if (now == null) return null
        return Math.round((parseFloat(now) / parseFloat(max)) * 100)
      }

      function nearbyText(el: Element, radius = 200): string {
        const parent = el.closest('[class]') ?? el.parentElement
        return parent?.textContent ?? ''
      }

      const bars = Array.from(document.querySelectorAll('[role="progressbar"]'))
      let sessionPct: number | null = null
      let weeklyPct: number | null = null

      for (const bar of bars) {
        const ctx = nearbyText(bar).toLowerCase()
        const pct = pctFromBar(bar)
        if (pct == null) continue
        if (ctx.includes('session') && sessionPct == null) sessionPct = pct
        else if ((ctx.includes('week') || ctx.includes('all models')) && weeklyPct == null) weeklyPct = pct
        else if (sessionPct == null) sessionPct = pct
        else if (weeklyPct == null) weeklyPct = pct
      }

      // --- Strategy 2: text extraction ---
      if (sessionPct == null || weeklyPct == null) {
        const body = document.body.innerText
        // Look for "X% used" or "X%" near section headings
        const sessionM = body.match(/current session[^0-9]*(\d+(?:\.\d+)?)\s*%/i)
          ?? body.match(/(\d+(?:\.\d+)?)\s*%[^]*?current session/i)
        const weeklyM = body.match(/weekly[^0-9]*(\d+(?:\.\d+)?)\s*%/i)
          ?? body.match(/all models[^0-9]*(\d+(?:\.\d+)?)\s*%/i)
          ?? body.match(/(\d+(?:\.\d+)?)\s*%[^]*?weekly/i)

        if (sessionPct == null && sessionM) sessionPct = parseFloat(sessionM[1])
        if (weeklyPct == null && weeklyM) weeklyPct = parseFloat(weeklyM[1])
      }

      // --- Reset times: look for countdown/reset text ---
      function parseResetMs(keyword: string): number {
        const body = document.body.innerText
        // "Resets in 2h 15m" / "resets at HH:MM" / ISO date strings
        const re = new RegExp(keyword + '[^\\n]{0,120}reset[s]?[^\\n]{0,80}', 'i')
        const m = re.exec(body)
        const ctx = m ? m[0] : body

        // "in Xh Ym"
        const inM = ctx.match(/in\s+(\d+)\s*h(?:ours?)?\s*(?:(\d+)\s*m(?:in)?)?/i)
        if (inM) {
          const h = parseInt(inM[1] || '0')
          const min = parseInt(inM[2] || '0')
          return Date.now() + (h * 3600 + min * 60) * 1000
        }
        // "at HH:MM" today/tomorrow
        const atM = ctx.match(/at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
        if (atM) {
          const now = new Date()
          let h = parseInt(atM[1])
          const min = parseInt(atM[2])
          if (atM[3]?.toUpperCase() === 'PM' && h < 12) h += 12
          if (atM[3]?.toUpperCase() === 'AM' && h === 12) h = 0
          const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min)
          if (t.getTime() < Date.now()) t.setDate(t.getDate() + 1)
          return t.getTime()
        }
        return 0
      }

      const sessionResetAt = parseResetMs('session') || (Date.now() + 5 * 3600 * 1000)
      const weeklyResetAt = parseResetMs('week') || (Date.now() + 7 * 24 * 3600 * 1000)

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
    await browser.close()
  }
}
