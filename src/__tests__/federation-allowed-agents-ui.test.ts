// FEDALLOWUI1121: the peer dialog edits allowedAgents. Source contract (the browser check is in the PR description):
// the field exists, both languages carry its strings, the edit dialog prefills it, and both save paths send it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const web = (f: string) => readFileSync(join(__dirname, '../../web', f), 'utf8')
const app = web('app.js')
const save = app.slice(app.indexOf('async function fedSavePeerModal'), app.indexOf('async function fedRemoveAll'))

describe('federation peer dialog: allowedAgents', () => {
  it('has the field in the dialog markup', () => {
    expect(web('index.html')).toMatch(/<input[^>]+id="fedPeerAllowedAgents"/)
  })

  it('both languages carry the label, placeholder and hint', () => {
    for (const f of ['lang/hu.js', 'lang/en.js']) {
      for (const k of ['allowed_label', 'allowed_placeholder', 'allowed_hint']) expect(web(f)).toContain(`'federation.modal.${k}'`)
    }
  })

  it('the edit dialog prefills the peer list', () => {
    expect(app).toMatch(/getElementById\('fedPeerAllowedAgents'\)\.value = peer && Array\.isArray\(peer\.allowedAgents\)/)
  })

  it('add sends the list only when filled; edit sends the list or null to clear it', () => {
    expect(save).toContain('if (allowed.length) body.allowedAgents = allowed')
    expect(save).toContain('body.allowedAgents = allowed.length ? allowed : null')
  })
})
