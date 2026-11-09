// The idea detail's subtitle showed "Sales · () => t('ideas.status.new')": STATUS_LABELS holds functions, and the
// detail put the function itself into the text instead of calling it, as the list does.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const DETAIL = (() => {
  const i = APP.indexOf('async function openIdeaDetail(')
  const j = i < 0 ? -1 : APP.indexOf("document.getElementById('ideaDetailMeta')", i)
  return i < 0 || j < 0 ? '' : APP.slice(i, j)
})()
const LABELS = APP.split('\n').find(l => l.startsWith('const STATUS_LABELS = {')) ?? ''

describe('the idea detail names the status', () => {
  it('the parts were found', () => {
    expect(DETAIL).not.toBe('')
    expect(LABELS).not.toBe('')
  })

  it('the label is called, not put into the text as a function', () => {
    expect(DETAIL).not.toContain('const statusLabel = STATUS_LABELS[idea.status] || idea.status')
    // run the shipped lines: a function label gives its text, an unknown status its own name
    const t = (k: string) => `T(${k})`
    const label = (status: string) => new Function('t', 'idea', `${LABELS}\n${DETAIL.slice(DETAIL.indexOf('  const statusLabelFn'), DETAIL.indexOf('  document.getElementById', DETAIL.indexOf('  const statusLabelFn')))}\nreturn statusLabel`)(t, { status })
    expect(label('new')).toBe('T(ideas.status.new)')
    expect(label('odd')).toBe('odd')
  })
})
