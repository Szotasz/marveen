// GROMZOAGENTPICK1101 (Samu 64526, Dani 64485): reading an agent's picture for Gromzo. The file lives in the
// agent's own directory, so the reader never follows a symlink, checks the size before reading and the magic
// bytes itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GROMZO_AVATAR_MAX_BYTES, avatarProblem, imageKind, readAgentAvatar } from '../web/gromzo-avatar.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)])

let root = ''
let dir = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gromzo-avatar-'))
  dir = join(root, 'agent')
  mkdirSync(dir)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('readAgentAvatar', () => {
  it('a PNG or a JPEG is read whole', () => {
    writeFileSync(join(dir, 'avatar.png'), PNG)
    expect(readAgentAvatar(dir)).toEqual({ ok: true, bytes: PNG })
    rmSync(join(dir, 'avatar.png'))
    writeFileSync(join(dir, 'avatar.jpg'), JPG)
    expect(readAgentAvatar(dir)).toEqual({ ok: true, bytes: JPG })
    expect(avatarProblem(dir)).toBeNull()
  })

  it('no picture: no_avatar', () => {
    expect(readAgentAvatar(dir)).toEqual({ ok: false, code: 'no_avatar' })
    expect(avatarProblem(dir)).toBe('no_avatar')
  })

  it('a symlink is never followed, even to a valid PNG elsewhere', () => {
    const outside = join(root, 'secret.png')
    writeFileSync(outside, PNG)
    symlinkSync(outside, join(dir, 'avatar.png'))
    expect(readAgentAvatar(dir)).toEqual({ ok: false, code: 'avatar_not_a_file' })
    expect(avatarProblem(dir)).toBe('avatar_not_a_file')
  })

  it('a directory named avatar.png is not a file', () => {
    mkdirSync(join(dir, 'avatar.png'))
    expect(readAgentAvatar(dir)).toEqual({ ok: false, code: 'avatar_not_a_file' })
  })

  it('larger than mxd allows (2 MB): avatar_too_large, judged by the size before any read', () => {
    writeFileSync(join(dir, 'avatar.png'), PNG)
    truncateSync(join(dir, 'avatar.png'), GROMZO_AVATAR_MAX_BYTES + 1) // sparse: the size says it, the bytes are not read
    expect(readAgentAvatar(dir)).toEqual({ ok: false, code: 'avatar_too_large' })
    expect(avatarProblem(dir)).toBe('avatar_too_large')
  })

  it('exactly 2 MB is fine', () => {
    writeFileSync(join(dir, 'avatar.png'), PNG)
    truncateSync(join(dir, 'avatar.png'), GROMZO_AVATAR_MAX_BYTES)
    const r = readAgentAvatar(dir)
    expect(r.ok).toBe(true)
    expect(r.ok && r.bytes.length).toBe(GROMZO_AVATAR_MAX_BYTES)
  })

  it('a webp (the dashboard allows it, mxd does not) or wrong magic bytes: avatar_format', () => {
    writeFileSync(join(dir, 'avatar.webp'), Buffer.from('RIFF0000WEBPVP8 '))
    expect(readAgentAvatar(dir)).toEqual({ ok: false, code: 'avatar_format' })
    expect(avatarProblem(dir)).toBe('avatar_format') // the list warns without reading the file
    rmSync(join(dir, 'avatar.webp'))
    writeFileSync(join(dir, 'avatar.png'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    expect(readAgentAvatar(dir)).toEqual({ ok: false, code: 'avatar_format' })
  })

  it('imageKind: PNG, JPEG, and nothing else; too short or too long is nothing', () => {
    expect(imageKind(PNG)).toBe('png')
    expect(imageKind(JPG)).toBe('jpg')
    expect(imageKind(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull()
    expect(imageKind(Buffer.alloc(GROMZO_AVATAR_MAX_BYTES + 1, 0xff))).toBeNull()
  })
})
