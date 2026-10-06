// Settings -> Claude plans: token-mode add/edit form. The API (#1304) takes a
// raw `token` on POST/PUT, but the dashboard form only ever sent configDir, so
// a token-mode plan could not be created from the UI at all. This pins
// (1) the real, shipped buildClaudePlanRequestBody() against the route's
// contract (evaluated from web/app.js, not a copy), and (2) the wiring that
// has no functional test: password-type, never-prefilled token input, edit
// keeps the stored token, and a fresh token triggers the probe route.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

function extractFn(name: string): string {
  const re = new RegExp(`(?:async )?function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(APP)
  if (!m) throw new Error(`${name} missing from web/app.js`)
  let depth = 0
  for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
  }
  throw new Error(`${name}: unbalanced braces`)
}

type Built = { error?: string; body?: Record<string, unknown>; sendsNewToken?: boolean }
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const build = new Function(`${extractFn('buildClaudePlanRequestBody')}; return buildClaudePlanRequestBody`)() as (
  fields: Record<string, unknown>, editing: Record<string, unknown> | null,
) => Built

// Assembled at runtime so the fixture never matches the repo's secret-shape gate.
const FAKE = ['sk', 'ant', 'oat01', 'FAKE', 'test', 'token'].join('-')
const base = { id: 'personal-2', label: 'Second Pro', planType: 'personal', channelsAllowed: true }

describe('buildClaudePlanRequestBody (token-mode form -> route contract)', () => {
  it('add in token mode sends the raw token and no configDir', () => {
    const r = build({ ...base, mode: 'token', token: `  ${FAKE}  `, configDir: '~/.claude-x' }, null)
    expect(r.error).toBeUndefined()
    expect(r.body).toEqual({ ...base, token: FAKE })
    expect(r.body).not.toHaveProperty('configDir')
    expect(r.sendsNewToken).toBe(true)
  })

  it('add in token mode with an empty token is rejected client-side', () => {
    expect(build({ ...base, mode: 'token', token: '   ' }, null).error).toBe('settings.claude_plans.form.error_token_required')
  })

  it('add in config-dir mode sends configDir and never a token, even if one was typed', () => {
    const r = build({ ...base, mode: 'configDir', configDir: ' ~/.claude-second ', token: FAKE }, null)
    expect(r.body).toEqual({ ...base, configDir: '~/.claude-second' })
    expect(r.sendsNewToken).toBe(false)
  })

  it('config-dir mode without a path is rejected', () => {
    expect(build({ ...base, mode: 'configDir', configDir: '' }, null).error).toBe('settings.claude_plans.form.error_config_dir_required')
  })

  it('id and label are required', () => {
    expect(build({ ...base, id: '', mode: 'token', token: FAKE }, null).error).toBe('settings.claude_plans.form.error_required')
    expect(build({ ...base, label: ' ', mode: 'token', token: FAKE }, null).error).toBe('settings.claude_plans.form.error_required')
  })

  it('edit of a token plan with an empty token keeps the stored one via its own tokenSecretId', () => {
    const editing = { id: 'personal-2', tokenSecretId: 'claude-plan-token-personal-2' }
    const r = build({ ...base, id: 'ignored', label: 'Renamed', mode: 'token', token: '' }, editing)
    expect(r.body).toEqual({ ...base, label: 'Renamed', tokenSecretId: 'claude-plan-token-personal-2' })
    expect(r.body).not.toHaveProperty('token')
    expect(r.sendsNewToken).toBe(false)
  })

  it('edit with a new token replaces it (token only, no tokenSecretId -> not ambiguous)', () => {
    const editing = { id: 'personal-2', tokenSecretId: 'claude-plan-token-personal-2' }
    const r = build({ ...base, mode: 'token', token: FAKE }, editing)
    expect(r.body).toEqual({ ...base, token: FAKE })
    expect(r.sendsNewToken).toBe(true)
  })

  it('switching a config-dir plan to token mode on edit requires a token', () => {
    const editing = { id: 'personal-2', configDir: '/Users/x/.claude-second' }
    expect(build({ ...base, mode: 'token', token: '' }, editing).error).toBe('settings.claude_plans.form.error_token_required')
  })

  it('the id of the edited plan is authoritative, not the (disabled) id field', () => {
    const r = build({ ...base, id: 'other', mode: 'configDir', configDir: '~/.c' }, { id: 'personal-2', configDir: '/x' })
    expect(r.body?.id).toBe('personal-2')
  })
})

describe('Claude plans form wiring', () => {
  const panel = extractFn('renderClaudePlansPanel')
  const save = extractFn('saveClaudePlan')
  const edit = extractFn('editClaudePlan')

  it('token input is a password field with autocomplete off', () => {
    expect(panel).toMatch(/id="cpFormToken"[^>]*type="password"/)
    expect(panel).toMatch(/id="cpFormToken"[^>]*autocomplete="off"/)
    expect(panel).toContain('id="cpFormMode"')
  })

  it('edit never pre-fills the token field', () => {
    expect(edit).toContain("document.getElementById('cpFormToken').value = ''")
    expect(edit).not.toMatch(/cpFormToken'\)\.value = plan/)
  })

  it('save uses POST for add and PUT on the plan id for edit', () => {
    expect(save).toContain("editing ? 'PUT' : 'POST'")
    expect(save).toContain('`/api/claude-plans/${encodeURIComponent(editing.id)}`')
  })

  it('a freshly saved token triggers the existing probe route', () => {
    expect(save).toMatch(/built\.sendsNewToken[\s\S]*probeClaudePlan\(savedId/)
    expect(extractFn('probeClaudePlan')).toContain('/probe`')
  })
})
