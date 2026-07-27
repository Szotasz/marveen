import type { RouteContext } from './types.js'

type Handler = (ctx: RouteContext) => Promise<boolean>

/**
 * RouteDispatcher: ordered chain of tryHandle* functions.
 *
 * Each handler returns true to claim the request, false to pass.
 * Handlers that need extra args (e.g. webDir) are wrapped in closures at
 * registration time so dispatch() has a uniform (ctx) => Promise<boolean>
 * interface.
 *
 * Usage:
 *   const d = new RouteDispatcher()
 *     .add(tryHandleAuth)
 *     .add(ctx => tryHandleAgents(ctx, WEB_DIR))
 *   if (await d.dispatch(ctx)) return
 */
export class RouteDispatcher {
  private readonly handlers: Handler[] = []

  add(handler: Handler): this {
    this.handlers.push(handler)
    return this
  }

  async dispatch(ctx: RouteContext): Promise<boolean> {
    for (const handler of this.handlers) {
      if (await handler(ctx)) return true
    }
    return false
  }
}
