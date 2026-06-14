#!/usr/bin/env node
/**
 * claude-usage MCP server (stdio transport)
 *
 * Exposes one tool: get_usage
 *   Returns: { sessionPct, weeklyPct, sessionResetAt, weeklyResetAt, fetchedAt }
 *   scraped from claude.ai/settings/usage using a persistent Playwright profile.
 *
 * Register in an agent's .mcp.json:
 *   "claude-usage": {
 *     "command": "node",
 *     "args": ["/abs/path/to/marveen/dist/scripts/claude-usage-mcp.js"],
 *     "env": { "CLAUDE_USAGE_PROFILE_DIR": "/abs/path/to/profile" }
 *   }
 *
 * First-time login: run with CLAUDE_USAGE_HEADED=1 to open a visible browser,
 * sign in once, then subsequent calls run headless.
 *
 * SECURITY: no credentials, tokens or cookies are written to this file or
 * to any log output. The profile directory is gitignored.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { scrapeClaudeUsage, readUsageCache } from '../src/web/claude-usage-scraper.js'

const server = new Server(
  { name: 'claude-usage', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_usage',
      description: 'Fetch current claude.ai session and weekly usage percentages and reset times.',
      inputSchema: {
        type: 'object',
        properties: {
          force_refresh: {
            type: 'boolean',
            description: 'Skip cache and scrape fresh data even if cache is valid.',
          },
        },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'get_usage') {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool' }) }] }
  }

  const forceRefresh = (req.params.arguments as Record<string, unknown>)?.force_refresh === true
  const headed = process.env.CLAUDE_USAGE_HEADED === '1'

  let data = forceRefresh ? null : readUsageCache()
  if (!data) {
    data = await scrapeClaudeUsage(headed)
  }

  if (!data) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'not_available', message: 'claude.ai usage data unavailable — run with CLAUDE_USAGE_HEADED=1 to sign in' }),
      }],
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
