import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// PERSONAESC1107 seed A follow-up (Dani 73301 (2), Samu 73319): nap-zaro is not idempotent (the daily log is
// append-only), so its step 1 stops when today's log already has a close entry. The entry's title is the language's
// own ("Napzáró" / "Day close"); on the day an install switches language (the update refreshes an untouched task to the
// other language), a guard that looked for its own title only did not see the morning's entry and closed the day twice.
// Both versions' guards accept both titles; the guard one-liner is RUN here, as the agent runs it.
const ROOT = join(__dirname, '..', '..')
const FILES = ['seed-scheduled-tasks/nap-zaro/SKILL.md', 'i18n/en/seed-scheduled-tasks/nap-zaro/SKILL.md']

function guard(file: string): string {
  const line = readFileSync(join(ROOT, file), 'utf-8').split('\n').find((l) => l.includes("MAR_LEFUTOTT") && l.includes('python3 -c'))
  if (!line) throw new Error(`no run-once guard in ${file}`)
  const m = line.match(/python3 -c "(.*)"\s*$/)
  if (!m) throw new Error(`guard shape changed in ${file}`)
  return m[1]
}

const run = (code: string, rows: Array<{ content: string; created_at: number }>) =>
  execFileSync('python3', ['-c', code], { input: JSON.stringify(rows), encoding: 'utf-8' }).trim()

describe('nap-zaro: the run-once guard sees a close entry in either language', () => {
  for (const file of FILES) {
    it(file, () => {
      const code = guard(file)
      expect(run(code, [{ content: '## 07:10 -- reggeli', created_at: 5 }, { content: '## 21:30 -- Napzáró (utolsó bejegyzés óta: 08:00)\n...', created_at: 9 }])).toBe('MAR_LEFUTOTT')
      expect(run(code, [{ content: '## 21:30 -- Day close (since the last entry: 08:00)\n...', created_at: 9 }])).toBe('MAR_LEFUTOTT')
      expect(run(code, [{ content: '## 07:10 -- morning', created_at: 5 }, { content: '## 12:00 -- noon', created_at: 7 }])).toBe('last_ts=7')
      expect(run(code, [])).toBe('last_ts=0')
    })
  }
})
