// Rotation decision without an Opus turn (work/local-model-routing/SPEC.md
// 4.4, task type rotationDecision). The decision was already code
// (decideRotationAction via scripts/claude-plan-rotate-check.ts); the seeded
// heartbeat spent a main-agent LLM turn every 10 minutes only to read that
// script's stdout and, rarely, curl POST /api/claude-plans/rotate. Here the
// dashboard runs the same script as a subprocess (async: it calls
// usage-collect.py synchronously, which must not block the event loop) and
// carries out the stdout contract itself, in the same order the prompt
// demanded (buildRotationHeartbeatPrompt):
//   - empty output: nothing, silently -- the common case, zero model calls;
//   - ROTATE: tell the owner FIRST, then POST /rotate with { targetPlanId };
//     a non-200 / ok:false answer is relayed verbatim, never retried this tick;
//   - NO_ALTERNATIVE: tell the owner, call nothing;
//   - FLEET_ROTATE / FLEET_SKIPPED / FLEET_FAILED: relay, with failed= called out;
//   - any other line: ignored, never interpreted.
// Only when the check itself cannot run (spawn error, non-zero exit, timeout)
// does the configured fallback apply: 'opus' fires the old heartbeat turn.

export type RotateLineKind = 'ROTATE' | 'NO_ALTERNATIVE' | 'FLEET_ROTATE' | 'FLEET_SKIPPED' | 'FLEET_FAILED'
const KINDS: readonly RotateLineKind[] = ['ROTATE', 'NO_ALTERNATIVE', 'FLEET_ROTATE', 'FLEET_SKIPPED', 'FLEET_FAILED']

export interface RotateLine {
  kind: RotateLineKind
  fields: Record<string, string>
  raw: string
}

/** key=value pairs; a value runs until the next " key=" (labels may hold spaces). */
export function parseRotateFields(rest: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z][A-Za-z0-9_]*)=(.*?)(?=\s+[A-Za-z][A-Za-z0-9_]*=|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rest)) !== null) out[m[1]] = m[2].trim()
  return out
}

export function parseRotateCheckOutput(stdout: string): RotateLine[] {
  const out: RotateLine[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const sp = line.indexOf(' ')
    const head = sp < 0 ? line : line.slice(0, sp)
    if (!(KINDS as readonly string[]).includes(head)) continue
    out.push({ kind: head as RotateLineKind, fields: parseRotateFields(sp < 0 ? '' : line.slice(sp + 1)), raw: line })
  }
  return out
}

export interface RotationDeps {
  runCheck: () => Promise<{ ok: boolean; stdout: string; detail: string }>
  notifyOwner: (text: string) => Promise<{ sent: boolean }>
  postRotate: (targetPlanId: string) => Promise<{ status: number; body: unknown }>
  /** The configured fallback for rotationDecision when the check cannot run. */
  fallback: 'skip' | 'opus'
  /** Fires the task the old way (an Opus heartbeat turn). */
  fallbackRun: () => Promise<unknown>
}

export type RotationOutcome =
  | { kind: 'quiet' }
  | { kind: 'acted'; lines: RotateLineKind[]; rotateStatus?: number }
  | { kind: 'check-failed'; fallback: 'skip' | 'opus'; detail: string }

function rotateText(f: Record<string, string>): string {
  const weekly = f.sevenDayPct ? `, heti ${f.sevenDayPct}%` : ''
  return `\u{1F504} Claude-plan váltás: ${f.currentLabel ?? '?'} (${f.currentPct ?? '?'}%${weekly}, ${f.trigger ?? '?'}, reset ${f.resetsInMin ?? '?'} perc múlva) helyett ${f.targetLabel ?? f.target ?? '?'}. A fő session most újraindul.`
}

function noAltText(f: Record<string, string>): string {
  return `\u{26A0}\u{FE0F} A jelenlegi Claude-plan (${f.currentLabel ?? '?'}) ${f.currentPct ?? '?'}%-on áll (${f.trigger ?? '?'}, reset ${f.resetsInMin ?? '?'} perc múlva), és nincs olyan regisztrált plan, amire váltani lehetne.`
}

function fleetText(l: RotateLine): string {
  if (l.kind !== 'FLEET_ROTATE') {
    return `Flotta-rotáció (${l.kind}, ${l.fields.label ?? l.fields.plan ?? '?'}): ${l.fields.reason ?? 'ismeretlen ok'}.`
  }
  const failed = (l.fields.failed ?? '').trim()
  const base = `Flotta-rotáció (${l.fields.label ?? l.fields.plan ?? '?'}): újraindítva: ${l.fields.restarted || '-'}.`
  return failed && failed !== '-'
    ? `${base} NEM indult újra, beavatkozás kell: ${failed}.`
    : base
}

function bodyError(body: unknown): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') return (body as { error: string }).error
  try { return JSON.stringify(body).slice(0, 300) } catch { return String(body) }
}

export async function runRotationDecision(deps: RotationDeps): Promise<RotationOutcome> {
  const check = await deps.runCheck()
  if (!check.ok) {
    if (deps.fallback === 'opus') await deps.fallbackRun()
    return { kind: 'check-failed', fallback: deps.fallback, detail: check.detail }
  }
  const lines = parseRotateCheckOutput(check.stdout)
  if (lines.length === 0) return { kind: 'quiet' }

  let rotateStatus: number | undefined
  let rotatedThisTick = false
  for (const l of lines) {
    if (l.kind === 'ROTATE') {
      // One rotation per tick: a second ROTATE line would restart the main agent twice.
      if (rotatedThisTick || !l.fields.target) continue
      rotatedThisTick = true
      await deps.notifyOwner(rotateText(l.fields))
      const r = await deps.postRotate(l.fields.target)
      rotateStatus = r.status
      const ok = r.status === 200 && !!r.body && typeof r.body === 'object' && (r.body as { ok?: unknown }).ok === true
      if (!ok) await deps.notifyOwner(`\u{1F534} A Claude-plan váltás nem sikerült (HTTP ${r.status}): ${bodyError(r.body)}`)
    } else if (l.kind === 'NO_ALTERNATIVE') {
      await deps.notifyOwner(noAltText(l.fields))
    } else {
      await deps.notifyOwner(fleetText(l))
    }
  }
  return { kind: 'acted', lines: lines.map((l) => l.kind), rotateStatus }
}
