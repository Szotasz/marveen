import { describe, it, expect, vi, beforeEach } from 'vitest'

// FEDDRIVE829: the federation privacy guard must see the drive folder WHERE
// IT IS ACTUALLY SET. #1061 turns OWNER_DRIVE_FOLDER into a dashboard registry
// key; an operator who sets it there never touches .env, the config-module
// constant stays '', empty needles are skipped -- and the real folder id
// leaks to federated peers. Fail direction: OPEN, on the privacy chokepoint.
//
// The gate order this protects (owner-approved form, TG 15288): THIS fix
// lands first, #1061 merges after. On the pre-#1061 tree the registry key
// does not exist and getEffectiveSettingValue THROWS -- the guard must then
// fall back to the env constant (old behaviour), never crash and never skip.
//
// NEGATIVE CONTROL (performed and reverted, results in the PR): with the
// guard reverted to the bare OWNER_DRIVE_FOLDER constant, the override-only
// test below goes RED (returns null -- the leak shape).

const mockGet = vi.fn<(key: string) => string | number>()
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => mockGet(key),
}))

import { containsPrivateData, effectiveOwnerDriveFolder } from '../web/federation/capabilities.js'

const FOLDER_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz12345'

beforeEach(() => {
  mockGet.mockReset()
})

describe('FEDDRIVE829: the drive-folder needle is the EFFECTIVE value', () => {
  it('an override-only folder id (env constant empty) IS caught by the guard', () => {
    // The post-#1061 world: dashboard override set, .env untouched. This is
    // the exact fail-open the card describes -- on the pre-fix guard this
    // returns null and the folder id ships to peers.
    mockGet.mockReturnValue(FOLDER_ID)
    expect(containsPrivateData(`results land in folder ${FOLDER_ID} weekly`)).toBe('drive folder')
  })

  it('pre-#1061 tree: an unknown registry key falls back to the env constant, never crashes', () => {
    // getEffectiveSettingValue throws on unregistered keys -- today's tree.
    mockGet.mockImplementation(() => { throw new Error('Unknown setting key: OWNER_DRIVE_FOLDER') })
    // Env constant in the test environment is '' -- resolver returns it...
    expect(effectiveOwnerDriveFolder()).toBe('')
    // ...and the guard still works end to end (empty needle skipped, clean
    // text passes, no exception escapes the chokepoint).
    expect(containsPrivateData('Video editing and rendering workflows.')).toBeNull()
  })

  it('an empty effective value keeps the fresh-install behaviour (no reject-everything)', () => {
    mockGet.mockReturnValue('')
    expect(effectiveOwnerDriveFolder()).toBe('')
    expect(containsPrivateData('A clean capability sentence.')).toBeNull()
  })

  it('the resolver asks for exactly the OWNER_DRIVE_FOLDER key', () => {
    // A typo'd key would throw (unknown key) and silently degrade to the env
    // constant forever -- the fallback would mask it. Pin the key string.
    mockGet.mockReturnValue('x')
    effectiveOwnerDriveFolder()
    expect(mockGet).toHaveBeenCalledWith('OWNER_DRIVE_FOLDER')
  })
})
