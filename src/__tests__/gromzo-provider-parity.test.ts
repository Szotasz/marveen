// GROMZONOPROVIDER1108 (EGM review, impl 6 / zoom-out 1): every shell map of the channel provider must give `gromzo`
// its own answer. Each `case` is sliced out of the shipped script and RUN with every provider value; for gromzo the
// result must be the gromzo one, never the `*)` telegram fallback (which would start the Telegram plugin again, the
// loop this card removes). The TS side is held by the compiler: every Record<ChannelProviderType, ...> must name gromzo.
// Known drift, reported not fixed here: `whatsapp` exists only in the shell maps, `googlechat` only in the TS union.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(__dirname, '..', '..')
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8')

/** The `case ... esac` that starts at `start` (an exact line prefix), with its own closing esac. */
function sliceCase(text: string, start: string): string {
  const a = text.indexOf(start)
  if (a < 0) throw new Error(`case not found: ${start}`)
  const b = text.indexOf('\nesac', a)
  if (b < 0) throw new Error(`esac not found after: ${start}`)
  return text.slice(a, b + '\nesac'.length)
}
function runCase(block: string, provider: string, out: string): string {
  const r = spawnSync('bash', ['-c', `CHANNEL_PROVIDER='${provider}'\n_smg_provider='${provider}'\n${block}\nprintf '%s' "${out}"`], { encoding: 'utf8' })
  return r.stdout
}

// fallback: what an unknown value gets -- 'telegram' (the GH #846 fallback) or 'name' (the value itself, the plugin-dir
// segment maps); either way gromzo must NOT get it, since /gromzo would never match the gromzo-channel plugin dir.
const MAPS: { file: string; start: string; out: string; gromzo: string; fallback?: 'name' }[] = [
  { file: 'scripts/channels.sh', start: 'resolve_plugin_ids() {\n  case "$1" in', out: '$PLUGIN_ID', gromzo: 'gromzo-channel@gromzo-local' },
  { file: 'scripts/channels.sh', start: 'case "$CHANNEL_PROVIDER" in\n  slack)    STATE_ENV_VAR=', out: '$STATE_ENV_VAR', gromzo: 'GROMZO_STATE_DIR' },
  { file: 'scripts/channels.sh', start: 'case "$CHANNEL_PROVIDER" in\n  slack) PLUGIN_SEG=', out: '$PLUGIN_SEG', gromzo: '/gromzo-channel', fallback: 'name' },
  { file: 'scripts/channel-watchdog.sh', start: 'case "$CHANNEL_PROVIDER" in\n  slack)    PRIMARY_PLUGIN_ID=', out: '$PRIMARY_PLUGIN_ID', gromzo: 'gromzo-channel@gromzo-local' },
  { file: 'scripts/channel-watchdog.sh', start: 'case "$CHANNEL_PROVIDER" in\n  slack)    STATE_ENV_VAR=', out: '$STATE_ENV_VAR', gromzo: 'GROMZO_STATE_DIR' },
  { file: 'scripts/stuck-modal-guard.sh', start: 'case "$_smg_provider" in', out: '$_smg_default', gromzo: 'plugin:gromzo-channel@gromzo-local' },
  { file: 'scripts/channel-keepalive-probe.sh', start: 'case "$CHANNEL_PROVIDER" in\n  gromzo) PROBE_PLUGIN_SEG=', out: '$PROBE_PLUGIN_SEG', gromzo: 'gromzo-channel', fallback: 'name' },
]

describe('every shell provider map has an explicit gromzo branch (never the telegram fallback)', () => {
  for (const m of MAPS) {
    it(`${m.file}: ${m.out}`, () => {
      // resolve_plugin_ids is a function: call it
      const text = src(m.file)
      const block = m.start.startsWith('resolve_plugin_ids')
        ? `${text.slice(text.indexOf(m.start), text.indexOf('\n}\n', text.indexOf(m.start)) + 3)}resolve_plugin_ids "$CHANNEL_PROVIDER"`
        : sliceCase(text, m.start)
      const g = runCase(block, 'gromzo', m.out)
      const tg = runCase(block, 'telegram', m.out)
      expect(g).toBe(m.gromzo)
      expect(g).not.toBe(tg)
      // positive control: an unknown value still lands on the fallback, so the instrument can tell
      const unknown = runCase(block, 'no-such-provider', m.out)
      if (m.fallback === 'name') {
        expect(unknown).toContain('no-such-provider')
        expect(g).not.toContain('/gromzo/')
        expect(g).not.toBe(unknown.replace('no-such-provider', 'gromzo'))
      } else {
        expect(unknown).toBe(tg)
      }
    })
  }

  it('the launch helpers the maps feed: one `main_gromzo_primary_ready` in the shell twin, its TS twin exported', () => {
    expect(src('scripts/main-gromzo-launch.sh')).toMatch(/^main_gromzo_primary_ready\(\) \{/m)
    expect(src('src/web/main-gromzo-launch.ts')).toMatch(/export function mainGromzoPrimaryReady\(/)
  })

  it('the keepalive probe greps the gromzo-channel segment, not the provider name', () => {
    expect(src('scripts/channel-keepalive-probe.sh')).toContain('grep -F "/${PROBE_PLUGIN_SEG}/"')
  })

  it('morning-briefing turns the Gromzo plugin off for its one-shot run too', () => {
    expect(src('scripts/morning-briefing.sh')).toContain('"gromzo-channel@gromzo-local":false')
  })
})
