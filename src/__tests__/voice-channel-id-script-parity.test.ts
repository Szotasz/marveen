// VOICECHANNELID1022: scripts/migrate-main-agent-id.sh reserves the voice channel
// id it resolves from .env, and the dashboard reserves the one config.ts
// resolves. If the two read .env differently (an "export" prefix, a trailing
// comment, quoting, whitespace) they reserve different ids, and the migration
// can hand the main agent the id the dashboard treats as the voice channel. So
// the script's resolver is run here, verbatim, against the dashboard's on the
// same .env files, and the two must agree on every one.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { FIXED_RESERVED_AGENT_IDS } from '../web/sanitize.js'

const savedDir = process.env.CLAUDECLAW_ENV_DIR
afterAll(() => {
  if (savedDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedDir
  vi.resetModules()
})

const SCRIPT = readFileSync(join(PROJECT_ROOT, 'scripts', 'migrate-main-agent-id.sh'), 'utf-8')
const OPEN = 'resolve_voice_channel_id() {\n  python3 - "$@" <<\'PYEOF\'\n'
const RESOLVER = (() => {
  const start = SCRIPT.indexOf(OPEN)
  if (start === -1) throw new Error('resolve_voice_channel_id not found in the migration script')
  const body = SCRIPT.slice(start + OPEN.length)
  return body.slice(0, body.indexOf('\nPYEOF\n') + 1)
})()
const work = mkdtempSync(join(tmpdir(), 'voice-id-parity-'))
const resolverPath = join(work, 'resolver.py')
writeFileSync(resolverPath, RESOLVER)

function scriptResolves(envDir: string): string | null {
  // The same arguments the script passes: the .env path, its fixed list, the agents dir.
  const out = execFileSync('python3', ['-I', resolverPath, join(envDir, '.env'), FIXED_RESERVED_AGENT_IDS.join(' '), join(PROJECT_ROOT, 'agents')], { encoding: 'utf-8' })
  return out === '' ? null : out
}

async function dashboardResolves(envDir: string): Promise<string | null> {
  process.env.CLAUDECLAW_ENV_DIR = envDir
  vi.resetModules()
  return (await import('../config.js')).VOICE_CHANNEL_ID
}

let n = 0
function envDirWith(content: string): string {
  const dir = join(work, `case-${n++}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.env'), content)
  return dir
}

// [label, .env content, the id both must resolve (null = lane off)]
const CASES: [string, string, string | null][] = [
  ['empty .env', '', 'hanna'],
  ['plain value', 'VOICE_CHANNEL_ID=voice-relay\n', 'voice-relay'],
  ['export prefix: not the key the dashboard reads', 'export VOICE_CHANNEL_ID=voice-relay\n', 'hanna'],
  ['trailing comment: part of the value, so invalid', 'VOICE_CHANNEL_ID=voice-relay  # the relay\n', 'hanna'],
  ['double quotes stripped', 'VOICE_CHANNEL_ID="voice-relay"\n', 'voice-relay'],
  ['single quotes stripped', "VOICE_CHANNEL_ID='voice-relay'\n", 'voice-relay'],
  ['mismatched quotes kept, so invalid', 'VOICE_CHANNEL_ID=\'voice-relay"\n', 'hanna'],
  ['an unclosed quote kept, so invalid', 'VOICE_CHANNEL_ID="voice-relay\n', 'hanna'],
  ['whitespace around key and value', '   VOICE_CHANNEL_ID   =   voice-relay   \n', 'voice-relay'],
  ['whitespace inside the quotes', 'VOICE_CHANNEL_ID=" voice-relay "\n', 'voice-relay'],
  ['tabs and a CRLF line end', '\tVOICE_CHANNEL_ID=\tvoice-relay\r\n', 'voice-relay'],
  ['a lone CR does not end a line (parseEnvContent splits on LF only)', 'OWNER_NAME=x\rVOICE_CHANNEL_ID=voice-relay\n', 'hanna'],
  ['no-break spaces (JS trim strips them)', 'VOICE_CHANNEL_ID= voice-relay \n', 'voice-relay'],
  ['a BOM before the first key', '﻿VOICE_CHANNEL_ID=voice-relay\n', 'voice-relay'],
  ['a commented-out line', '# VOICE_CHANNEL_ID=voice-relay\n', 'hanna'],
  ['the last assignment wins', 'VOICE_CHANNEL_ID=first-relay\nVOICE_CHANNEL_ID=second-relay\n', 'second-relay'],
  ['an empty value', 'VOICE_CHANNEL_ID=\n', 'hanna'],
  ['not canonical', 'VOICE_CHANNEL_ID=Voice_Relay\n', 'hanna'],
  ['a fixed reserved id', 'VOICE_CHANNEL_ID=system\n', 'hanna'],
  ['the main agent id', 'MAIN_AGENT_ID=voice-relay\nVOICE_CHANNEL_ID=voice-relay\n', 'hanna'],
  ['an empty main agent id', 'MAIN_AGENT_ID=\nVOICE_CHANNEL_ID=voice-relay\n', 'voice-relay'],
  ["the owner's name", 'OWNER_NAME=voice-relay\nVOICE_CHANNEL_ID=voice-relay\n', 'hanna'],
  ['a SYSTEM_SENDER_IDS entry', 'SYSTEM_SENDER_IDS=cortex, voice-relay\nVOICE_CHANNEL_ID=voice-relay\n', 'hanna'],
  ['default collides with the main agent: lane off', 'MAIN_AGENT_ID=hanna\n', null],
  ['default collides with the owner after an invalid value: lane off', 'OWNER_NAME=hanna\nVOICE_CHANNEL_ID=Bad\n', null],
  ['default collides with a sanitized system sender: lane off', 'SYSTEM_SENDER_IDS=@hanna.\n', null],
  ['a free configured id survives a default collision', 'MAIN_AGENT_ID=hanna\nVOICE_CHANNEL_ID=voice-relay\n', 'voice-relay'],
]

describe('the migration script resolves the same voice channel id as the dashboard', () => {
  it.each(CASES)('%s', async (_label, content, expected) => {
    const dir = envDirWith(content)
    const dashboard = await dashboardResolves(dir)
    expect(dashboard).toBe(expected)
    expect(scriptResolves(dir)).toBe(dashboard)
  })

  it('a missing .env reads as empty on both sides', async () => {
    const dir = join(work, 'no-env')
    mkdirSync(dir, { recursive: true })
    expect(await dashboardResolves(dir)).toBe('hanna')
    expect(scriptResolves(dir)).toBe('hanna')
  })
})
