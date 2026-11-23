#!/usr/bin/env node
// CARD 2436459e -- MCP shim for the dashboard relay
// (codexSandbox=relay).
//
// MCP stdio server (newline-delimited JSON-RPC over stdin/stdout) that Codex
// starts outside the command sandbox (measured on Codex 0.163.0, Linux).
// It reads ONLY two env vars
// (MARVEEN_AGENT_NAME, MARVEEN_RELAY_DIR), does NO network access and reads NO
// token: every dashboard call becomes a request file under the relay dir that
// the daemon OUTSIDE the sandbox (relay.mjs) services, so no secret ever
// reaches the sandbox. The spool lives under store/, which the relay profile
// hides from the sandbox. Plain node, no npm dependencies.

import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const AGENT = process.env.MARVEEN_AGENT_NAME ?? ''
const RELAY_DIR = process.env.MARVEEN_RELAY_DIR ?? ''
const RELAY_POLL_MS = 200
const RELAY_DEADLINE_MS = 60_000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

// The same 8 tools as before: marveen_telegram_reply was removed (the dashboard has no
// POST /api/telegram/reply route) and marveen_kanban_move added. Otherwise verbatim. Identity
// fields (author, agent_id, from) are FORCED to MARVEEN_AGENT_NAME at dispatch
// time exactly as the real server does -- args are never trusted for them.
const TOOLS = [
  {
    "name": "marveen_kanban_query",
    "title": "Marveen kanban: query cards",
    "description": "List kanban cards via GET /api/kanban. Returns only the cards assigned to you. Optional ?limit= and ?status= filters mirror the dashboard. The route has NO default limit: omit `limit` and ALL your cards come back.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 500,
          "description": "Cap on returned cards. NO DEFAULT -- omit it to get every card. Truncation is silent (HTTP 200, no total in the body), so if you do pass one, compare the returned count to it: equal means the set was cut and the cards you needed may be the missing ones."
        },
        "status": {
          "type": "string",
          "description": "Optional status filter (planned, in_progress, done, ...)."
        }
      }
    }
  },
  {
    "name": "marveen_kanban_comment_post",
    "title": "Marveen kanban: post a comment",
    "description": "POST /api/kanban/{card_id}/comments. The author is forced to MARVEEN_AGENT_NAME at runtime.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "card_id": {
          "type": "string",
          "minLength": 1,
          "description": "Target kanban card id."
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "description": "Comment body."
        }
      },
      "required": [
        "card_id",
        "content"
      ]
    }
  },
  {
    "name": "marveen_kanban_move",
    "title": "Marveen kanban: move a card",
    "description": "POST /api/kanban/{card_id}/move -- change the status of one of YOUR cards (assignee = you). The actor is forced to MARVEEN_AGENT_NAME. Moving to done without evidence lands the card in testing.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "card_id": {
          "type": "string",
          "minLength": 1,
          "description": "Target kanban card id."
        },
        "status": {
          "type": "string",
          "enum": [
            "planned",
            "in_progress",
            "waiting",
            "done"
          ],
          "description": "New status."
        },
        "expected_status": {
          "type": "string",
          "enum": [
            "planned",
            "in_progress",
            "waiting",
            "done"
          ],
          "description": "Optional: only move if the card currently has this status."
        },
        "evidence": {
          "type": "string",
          "description": "Optional evidence text (needed to land in done)."
        }
      },
      "required": [
        "card_id",
        "status"
      ]
    }
  },
  {
    "name": "marveen_memory_save",
    "title": "Marveen memory: save",
    "description": "POST /api/memories. agent_id is forced to MARVEEN_AGENT_NAME (audit-honest substitute identity). A save that repeats one of your own live memories (same text, or at least 80% the same words) is refused with 409 and names the existing row in duplicate_of; nothing is saved then.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "content": {
          "type": "string",
          "minLength": 1,
          "description": "Memory body."
        },
        "category": {
          "type": "string",
          "description": "Memory tier (hot/warm/cold/shared). Optional; the route defaults to 'warm' (routes/memories.ts) -- an omitted category is NOT 'unfiled'."
        },
        "keywords": {
          "type": "string",
          "description": "Comma-separated keyword list. Optional."
        },
        "supersedes": {
          "type": "array",
          "items": {
            "type": "integer"
          },
          "description": "Ids of YOUR OWN earlier memories this one replaces (a changed rule or decision). They are retracted automatically and the new row records it. Optional."
        },
        "allow_duplicate": {
          "type": "boolean",
          "description": "Set true ONLY when this is genuinely new information that the server refused as a duplicate of one of your own memories (409, see duplicate_of). If it replaces the old memory, use supersedes instead. Optional."
        }
      },
      "required": [
        "content"
      ]
    }
  },
  {
    "name": "marveen_memory_search",
    "title": "Marveen memory: search",
    "description": "GET /api/memories?q=...&category=... (always your own memories; agent is forced to MARVEEN_AGENT_NAME) -- read across hot/warm/cold tiers (M3 Opció A consent). The route pages: it defaults to 50 rows and hard-caps at 200, so a short answer may be a cut page rather than a small store.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "q": {
          "type": "string",
          "description": "Keyword search (prefix match). The words are ANDed first: a real match contains EVERY word. Only if no memory holds every word is the search retried with the words ORed, and then the answer carries a [RELAXED MATCH] block: those rows hold only SOME of the words, so they are near-misses, NOT a recall -- never read them as \"this is already stored\". An answer without that block is a real match. To learn whether something specific is stored, search one distinctive word at a time."
        },
        "category": {
          "type": "string",
          "description": "Tier filter (hot/warm/cold/shared)."
        },
        "mode": {
          "type": "string",
          "enum": [
            "hybrid",
            "fts"
          ],
          "description": "Default \"hybrid\": keywords + meaning (multilingual embedding), finds a rule even when you phrase it differently. \"fts\": keywords only, for exact tokens such as a card id."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 200,
          "description": "Rows per page. Route default 50, hard cap 200 (a larger value is clamped, not honoured). On a plain agent listing (agent set, no q) the route reports the full size in X-Total-Count and this wrapper echoes it as structuredContent.truncation -- read that before concluding a memory does not exist."
        }
      }
    }
  },
  {
    "name": "marveen_memory_retract",
    "title": "Marveen memory: retract",
    "description": "POST /api/memories/{id}/retract -- take back one of YOUR OWN memories. A SHARED memory is loaded into every agent's context at every start, as background truth rather than as your claim, so a wrong one keeps arriving until it is withdrawn; saving a correction beside it does NOT stop the original. This is NOT a delete: the row survives and an explicit search still finds it (the original has historical value), but it stops being broadcast at session start. Only the author may retract; the answer distinguishes 'retracted' from 'already_retracted', and returns 403 if the memory is not yours, 404 if there is no such id.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "integer",
          "minimum": 1,
          "description": "The memory id to withdraw (from marveen_memory_search)."
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "marveen_daily_log_append",
    "title": "Marveen daily log: append",
    "description": "POST /api/daily-log. agent_id is forced to MARVEEN_AGENT_NAME.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "content": {
          "type": "string",
          "minLength": 1,
          "description": "Log entry body (markdown ok)."
        }
      },
      "required": [
        "content"
      ]
    }
  },
  {
    "name": "marveen_inter_agent_message",
    "title": "Marveen inter-agent message",
    "description": "POST /api/messages. from is forced to MARVEEN_AGENT_NAME (audit-honest substitute identity).",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "to": {
          "type": "string",
          "minLength": 1,
          "description": "Target agent name."
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "description": "Message body."
        }
      },
      "required": [
        "to",
        "content"
      ]
    }
  }
]

// ---- JSON-RPC plumbing ------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function replyResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

// ---- relay transport --------------------------------------------------------

let relaySequence = 0

// One dashboard call = one request file answered by one response file. Returns
// the parsed response object, or null when the daemon did not answer within
// 60s (the outcome the tool result then reports as 'relay timeout').
async function callRelay(method, path, body) {
  if (!RELAY_DIR) throw new Error('MARVEEN_RELAY_DIR is not set')
  const id = `shim-${Date.now()}-${++relaySequence}`
  const requestPath = join(RELAY_DIR, 'requests', `${id}.json`)
  const responsePath = join(RELAY_DIR, 'responses', `${id}.json`)
  // The daemon only picks up names ending in .json, so it never sees a partly written request.
  const tmpPath = `${requestPath}.tmp.${process.pid}`
  // Only a successful exclusive open makes the temp file ours; no error code is trusted to say so.
  let owned = false
  try {
    const fd = openSync(tmpPath, 'wx')
    owned = true
    try {
      writeFileSync(fd, JSON.stringify({ id, method, path, body }))
    } catch (error) {
      try { closeSync(fd) } catch { /* The write error is the one to report. */ }
      throw error
    }
    closeSync(fd)
    renameSync(tmpPath, requestPath)
  } catch (error) {
    if (owned) {
      try { unlinkSync(tmpPath) } catch { /* Best-effort cleanup. */ }
    }
    throw error
  }
  const deadline = Date.now() + RELAY_DEADLINE_MS
  for (;;) {
    if (existsSync(responsePath)) {
      const raw = readFileSync(responsePath, 'utf-8')
      // The shim is outside the command sandbox, so unlink normally succeeds.
      try {
        unlinkSync(responsePath)
      } catch { /* The daemon's RESPONSE_TTL_MS sweep is the fallback for uncollected responses. */ }
      return JSON.parse(raw)
    }
    if (Date.now() >= deadline) return null
    await sleep(RELAY_POLL_MS)
  }
}

// ---- per-tool mapping -------------------------------------------------------

class InvalidParamsError extends Error {}

const invalid = message => new InvalidParamsError(message)

// Each handler maps tool args to { method, path, body? } for the relay.
// Identity fields are FORCED to AGENT, never taken from args.
const TOOL_HANDLERS = {
  marveen_kanban_query(a) {
    const params = new URLSearchParams()
    if (Number.isInteger(a.limit)) params.set('limit', String(a.limit))
    if (nonEmptyString(a.status)) params.set('status', a.status)
    const query = params.toString()
    return { method: 'GET', path: query ? `/api/kanban?${query}` : '/api/kanban' }
  },

  marveen_kanban_comment_post(a) {
    if (!nonEmptyString(a.card_id) || !nonEmptyString(a.content)) throw invalid('card_id and content required')
    return {
      method: 'POST',
      path: `/api/kanban/${encodeURIComponent(a.card_id)}/comments`,
      body: { author: AGENT, content: String(a.content) },
    }
  },

  marveen_kanban_move(a) {
    if (!nonEmptyString(a.card_id) || !nonEmptyString(a.status)) throw invalid('card_id and status required')
    return {
      method: 'POST',
      path: `/api/kanban/${encodeURIComponent(a.card_id)}/move`,
      body: {
        status: a.status,
        actor: AGENT,
        ...(a.expected_status ? { expected_status: a.expected_status } : {}),
        ...(a.evidence ? { evidence: String(a.evidence) } : {}),
      },
    }
  },

  marveen_memory_save(a) {
    if (!nonEmptyString(a.content)) throw invalid('content required')
    const body = { agent_id: AGENT, content: String(a.content) }
    if (nonEmptyString(a.category)) body.category = a.category
    if (nonEmptyString(a.keywords)) body.keywords = a.keywords
    if (Array.isArray(a.supersedes) && a.supersedes.length) body.supersedes = a.supersedes.filter(value => Number.isInteger(value))
    if (a.allow_duplicate === true) body.allow_duplicate = true
    return { method: 'POST', path: '/api/memories', body }
  },

  marveen_memory_search(a) {
    const params = new URLSearchParams()
    params.set('agent', AGENT)
    if (nonEmptyString(a.q)) {
      params.set('q', a.q)
      params.set('mode', a.mode === 'fts' ? 'fts' : 'hybrid')
    }
    if (nonEmptyString(a.category)) params.set('category', a.category)
    if (Number.isInteger(a.limit)) params.set('limit', String(a.limit))
    return { method: 'GET', path: `/api/memories?${params.toString()}` }
  },

  marveen_memory_retract(a) {
    if (!Number.isInteger(a.id) || a.id < 1) throw invalid('id (integer >= 1) required')
    return { method: 'POST', path: `/api/memories/${a.id}/retract`, body: { agent_id: AGENT } }
  },

  marveen_daily_log_append(a) {
    if (!nonEmptyString(a.content)) throw invalid('content required')
    return { method: 'POST', path: '/api/daily-log', body: { agent_id: AGENT, content: String(a.content) } }
  },

  marveen_inter_agent_message(a) {
    if (!nonEmptyString(a.to) || !nonEmptyString(a.content)) throw invalid('to and content required')
    return { method: 'POST', path: '/api/messages', body: { from: AGENT, to: String(a.to), content: String(a.content) } }
  },
}

async function handleToolCall(id, params) {
  const plain = params !== null && typeof params === 'object' && !Array.isArray(params)
  const name = plain ? params.name : undefined
  const rawArgs = plain && params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}
  const handler = TOOL_HANDLERS[name]
  if (!handler) {
    replyError(id, -32601, `Unknown tool: ${name}`)
    return
  }
  let plan
  try {
    plan = handler(rawArgs)
  } catch (err) {
    replyError(id, err instanceof InvalidParamsError ? -32602 : -32603, err instanceof Error ? err.message : String(err))
    return
  }
  const response = await callRelay(plan.method, plan.path, plan.body)
  if (response === null) {
    replyResult(id, { isError: true, content: [{ type: 'text', text: 'relay timeout' }] })
    return
  }
  if (response.status >= 200 && response.status <= 299 && !response.error) {
    replyResult(id, { content: [{ type: 'text', text: JSON.stringify(response.body) }] })
    return
  }
  replyResult(id, {
    isError: true,
    content: [{ type: 'text', text: `relay ${response.status}: ${response.error || JSON.stringify(response.body)}` }],
  })
}

// ---- protocol dispatch ------------------------------------------------------

async function handleMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return
  // A notification (no id) never gets a response -- including
  // 'notifications/initialized'.
  if (message.id === undefined || message.id === null) return
  const { id, method } = message
  if (method === 'initialize') {
    replyResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'marveen-dashboard-relay-shim', version: '1.0.0' },
    })
    return
  }
  if (method === 'tools/list') {
    replyResult(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    await handleToolCall(id, message.params)
    return
  }
  replyError(id, -32601, `Method not found: ${method}`)
}

let stdinBuffer = ''
const messageQueue = []
const messageWaiters = []

function dispatchQueued() {
  while (messageQueue.length && messageWaiters.length) messageWaiters.shift()(messageQueue.shift())
}

function nextMessage() {
  return new Promise(resolve => {
    messageWaiters.push(resolve)
    dispatchQueued()
  })
}

process.stdin.setEncoding('utf-8')
// The client shutting us down closes stdin; a stdio server exits with it.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('data', chunk => {
  stdinBuffer += chunk
  let newline
  while ((newline = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, newline).trim()
    stdinBuffer = stdinBuffer.slice(newline + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue // not a JSON-RPC frame: nothing to answer
    }
    messageQueue.push(message)
    dispatchQueued()
  }
})

for (;;) {
  const message = await nextMessage()
  try {
    await handleMessage(message)
  } catch (err) {
    // A dispatcher bug must not kill the stdio server mid-conversation.
    if (message && message.id !== undefined && message.id !== null) {
      replyError(message.id, -32603, err instanceof Error ? err.message : String(err))
    }
  }
}
