// The Slack smoke-test button on the Channels tab calls the endpoint with the agent's name.
// It used to put the whole agent object into the URL (`encodeURIComponent(currentAgent)`), so the
// request went to /api/agents/%5Bobject%20Object%5D/... and the server always answered
// "Agent not found": the button never ran the smoke test.
// The real handler runs here and the URL it fetches is checked.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')

const HANDLER = (() => {
  const i = APP.indexOf("document.getElementById('chSmokeTestBtn').addEventListener('click', ")
  if (i < 0) return ''
  const start = APP.indexOf('async () => {', i)
  let depth = 0
  for (let j = APP.indexOf('{', start); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1)
  }
  return ''
})()

async function urlFor(agent: { name: string }): Promise<string[]> {
  const urls: string[] = []
  const btn = { disabled: false, textContent: 'label' }
  const handler = new Function('currentAgent', 'document', 't', 'fetch', 'showToast', 'showSmokeTestResult', `return ${HANDLER}`)(
    agent, { getElementById: () => btn }, (k: string) => k,
    async (url: string) => { urls.push(url); return { ok: true, json: async () => ({ ok: true, output: 'OK' }) } },
    () => {}, () => {},
  ) as () => Promise<void>
  await handler()
  return urls
}

describe('the Slack smoke-test button', () => {
  it('was found', () => {
    expect(HANDLER).not.toBe('')
  })

  it("calls the endpoint with the agent's name, not the agent object", async () => {
    expect(await urlFor({ name: 'anna' })).toEqual(['/api/agents/anna/channels/slack/smoke-test'])
  })

  it('encodes the name', async () => {
    expect(await urlFor({ name: 'a b' })).toEqual(['/api/agents/a%20b/channels/slack/smoke-test'])
  })
})
