import { readFileSync } from 'node:fs'
import { readBody, json, methodNotAllowed } from '../http-helpers.js'
import { bashSandboxAgents, sandboxWritePaths } from '../bash-sandbox.js'
import { renderHtmlToPdf, resolveRenderPaths, writeRenderedPdf } from '../pdf-render.js'
import type { RouteContext } from './types.js'

// POST /api/pdf/render {agent, html_path, pdf_path} (BASHSANDBOX1022): the PDF route for an agent
// whose Bash runs in the sandbox, where headless Chrome cannot start (see pdf-render.ts).
//
// NOT AUTHENTICATION: `agent` is self-declared -- the fleet shares one Bearer token, so any caller
// can name any agent. The field grants nothing beyond what follows from it: the agent must be on
// the owner's BASH_SANDBOX_AGENTS list, and the HTML is read from, and the PDF written to, that
// agent's sandbox write roots only. Naming another listed agent lets a caller drop a PDF into that
// agent's roots, nothing more; Chrome renders with its network shut and no file:// access either way.
const FIELDS = ['agent', 'html_path', 'pdf_path'] as const
const MAX_BODY_BYTES = 8 * 1024

export async function tryHandlePdfRender(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/pdf/render') return false
  if (ctx.method !== 'POST') { methodNotAllowed(ctx.res, ctx.method, ['POST']); return true }
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse((await readBody(ctx.req, { maxBytes: MAX_BODY_BYTES })).toString() || 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { json(ctx.res, { error: 'Body must be a JSON object' }, 400); return true }
    body = parsed as Record<string, unknown>
  } catch {
    json(ctx.res, { error: `Body must be valid JSON of at most ${MAX_BODY_BYTES} bytes` }, 400); return true
  }
  const unknown = Object.keys(body).filter((k) => !(FIELDS as readonly string[]).includes(k))
  if (unknown.length) { json(ctx.res, { error: `Unknown field(s): ${unknown.join(', ')}. Accepted: ${FIELDS.join(', ')}` }, 400); return true }
  const agent = typeof body.agent === 'string' ? body.agent.trim().toLowerCase() : ''
  if (!bashSandboxAgents().has(agent)) { json(ctx.res, { error: 'agent is not on BASH_SANDBOX_AGENTS' }, 403); return true }
  let roots: string[]
  try { roots = sandboxWritePaths(agent) } catch (e) {
    json(ctx.res, { error: e instanceof Error ? e.message : String(e) }, 500); return true
  }
  const paths = resolveRenderPaths(roots, body.html_path, body.pdf_path)
  if ('error' in paths) { json(ctx.res, { error: paths.error }, 400); return true }
  // Read once, here: what Chrome renders is exactly what was checked, not what the path holds later.
  const r = await renderHtmlToPdf(readFileSync(paths.html))
  if (!r.ok) { json(ctx.res, { error: r.error }, r.busy ? 429 : 500); return true }
  const w = writeRenderedPdf(roots, paths.pdf, r.pdf)
  if (!w.ok) { json(ctx.res, { error: w.error }, 400); return true }
  json(ctx.res, { ok: true, pdf_path: w.pdf, bytes: r.pdf.length })
  return true
}
