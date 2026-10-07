// Card 4edaf0a1: the presentation-mode switch (plan 19030, points 2 and 5).
//
//   GET  /api/presentation-mode  -> { on, untilAt, events: the newest 20 }
//   POST /api/presentation-mode  {action: "on"|"off", minutes?: 1..240 (default 60), actor, reason?}
//
// Only the listed actors may switch (PRESENTATION_WRITER_ACTORS): any other actor is a
// 403 and NO row. minutes must be an integer in 1..240: 0, 241, a fraction or a string
// is a 400 and NO row (no silent clamping). Every accepted switch is exactly one event
// row (with the auth lane) and exactly one line to the main agent. A new "on" while ON
// replaces the lapse time with a new event. The global /api bearer gate applies.
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  appendPresentationModeEvent,
  getPresentationModeState,
  listPresentationModeEvents,
  PRESENTATION_DEFAULT_MINUTES,
  PRESENTATION_MAX_MINUTES,
} from '../../db.js'
import { notifyPresentationSwitch, PRESENTATION_WRITER_ACTORS } from '../presentation-mode.js'
import type { RouteContext } from './types.js'

export async function tryHandlePresentationMode(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/presentation-mode') return false

  if (method === 'GET') {
    const state = getPresentationModeState()
    json(res, { on: state.on, untilAt: state.untilAt, events: listPresentationModeEvents(20) })
    return true
  }
  if (method !== 'POST') {
    json(res, { error: 'Method not allowed' }, 405)
    return true
  }

  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse((await readBody(req)).toString() || '{}')
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    json(res, { error: 'invalid JSON body' }, 400)
    return true
  }

  const actor = typeof body.actor === 'string' ? body.actor : ''
  if (!PRESENTATION_WRITER_ACTORS.includes(actor)) {
    logger.warn({ actor: actor.slice(0, 60), authKind: ctx.auth?.kind ?? 'none' }, 'presentation mode: switch refused, actor not on the writer list')
    json(res, { error: 'actor is not allowed to switch the presentation mode' }, 403)
    return true
  }
  const action = body.action
  if (action !== 'on' && action !== 'off') {
    json(res, { error: 'action must be "on" or "off"' }, 400)
    return true
  }

  let untilAt: number | null = null
  if (action === 'on') {
    const minutes = body.minutes === undefined ? PRESENTATION_DEFAULT_MINUTES : body.minutes
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > PRESENTATION_MAX_MINUTES) {
      json(res, { error: `minutes must be an integer between 1 and ${PRESENTATION_MAX_MINUTES}` }, 400)
      return true
    }
    untilAt = Math.floor(Date.now() / 1000) + minutes * 60
  }

  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : null
  const ev = appendPresentationModeEvent({
    action,
    untilAt,
    actor,
    authKind: ctx.auth?.kind ?? null,
    authDevice: ctx.auth?.device ?? null,
    reason,
  })
  notifyPresentationSwitch(ev)
  const state = getPresentationModeState()
  json(res, { ok: true, on: state.on, untilAt: state.untilAt, event: ev })
  return true
}
