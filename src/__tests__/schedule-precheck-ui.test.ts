// The schedule editor sets a task's preCheck and preCheckTimeoutSeconds, so the owner can wire a pre-check from the
// dashboard login. Both are owner fields (OWNEREXEC1109): the server refuses a change without an owner session
// (owner-gate-exec-fields.test.ts), and the editor sends them only when changed, so a plain edit of a task that has a
// pre-check needs no owner. web/app.js has no browser harness here, so this pins the wiring.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')
const app = read('web/app.js')
const between = (from: string, to: string) => {
  const a = app.indexOf(from)
  const b = app.indexOf(to, a)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return app.slice(a, b)
}

describe('schedule editor: preCheck and preCheckTimeoutSeconds', () => {
  it('the modal has both inputs, in a group hidden until a task is edited', () => {
    const html = read('web/index.html')
    const group = html.slice(html.indexOf('<div id="schedulePreCheckGroup" hidden>'), html.indexOf('</div>', html.indexOf('id="schedulePreCheckGroup"')))
    expect(group).toContain('id="schedulePreCheck"')
    expect(group).toContain('id="schedulePreCheckTimeout"')
    expect(group).toContain('min="1" max="60"')
  })

  it('edit fills both from the task and records them as the default; reset clears and hides', () => {
    const edit = between('function openEditSchedule(task)', '// Save schedule (create or update)')
    expect(edit).toContain("preCheckEl.value = preCheckEl.defaultValue = typeof task.preCheck === 'string' ? task.preCheck : ''")
    expect(edit).toContain("preCheckTimeoutEl.value = preCheckTimeoutEl.defaultValue = task.preCheckTimeoutSeconds ?? ''")
    expect(edit).toContain("document.getElementById('schedulePreCheckGroup').hidden = false")
    const reset = between('function resetScheduleForm()', 'function getScheduleCron()')
    expect(reset).toContain("el.value = el.defaultValue = ''")
    expect(reset).toContain("document.getElementById('schedulePreCheckGroup').hidden = true")
  })

  it('save sends each field only when it changed, an emptied one as null', () => {
    const save = between("saveScheduleBtn.addEventListener('click'", 'closeModal(scheduleModalOverlay)')
    expect(save).toContain('if (preCheckEl.value.trim() !== preCheckEl.defaultValue) advanced.preCheck = preCheckEl.value.trim() || null')
    expect(save).toContain('if (preCheckTimeoutEl.value.trim() !== preCheckTimeoutEl.defaultValue) {')
    expect(save).toContain('advanced.preCheckTimeoutSeconds = preCheckTimeoutEl.value.trim() ? Number(preCheckTimeoutEl.value) : null')
    // the PUT body carries `advanced`
    expect(save).toContain('body: JSON.stringify({ description, prompt, schedule, agent, type, ...advanced })')
  })

  it('both placeholders exist in both language files', () => {
    for (const lang of ['hu', 'en']) {
      const src = read(`web/lang/${lang}.js`)
      expect(src, lang).toContain("'schedules.modal.precheck_ph':")
      expect(src, lang).toContain("'schedules.modal.precheck_timeout_ph':")
    }
  })
})
