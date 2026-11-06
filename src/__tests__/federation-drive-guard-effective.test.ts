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
// What the install .env holds in a test (the guard also reads the raw .env line, ENVRELAXGATE1104).
// vi.hoisted: config.ts reads .env while the mocked modules load, before a plain const would exist.
const envFile = vi.hoisted(() => ({}) as Record<string, string>)
vi.mock('../env.js', async (orig) => ({
  ...(await orig<typeof import('../env.js')>()),
  readEnvFile: (keys?: string[]) => Object.fromEntries(Object.entries(envFile).filter(([k]) => !keys || keys.includes(k))),
}))

import { containsPrivateData, effectiveOwnerDriveFolder, ownerDriveFolderNeedles } from '../web/federation/capabilities.js'

const FOLDER_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz12345'

beforeEach(() => {
  mockGet.mockReset()
  for (const k of Object.keys(envFile)) delete envFile[k]
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

// Dani's #2504 review: OWNER_DRIVE_FOLDER is overrides-only, so a value only in .env no longer resolves; the guard
// must still catch it (older generated files may carry it). The needles are the union of every known form.
describe('ENVRELAXGATE1104: the drive-folder needles are the UNION of the known forms', () => {
  it('a folder id that stands only in .env (the effective value is empty) is still caught', () => {
    mockGet.mockReturnValue('')
    envFile.OWNER_DRIVE_FOLDER = FOLDER_ID
    expect(containsPrivateData(`results land in folder ${FOLDER_ID} weekly`)).toBe('drive folder')
  })

  it('an override and a different .env value are both needles', () => {
    const OTHER = '9ZyXwVuTsRqPoNmLkJiHgFeDcBa98765'
    mockGet.mockReturnValue(FOLDER_ID)
    envFile.OWNER_DRIVE_FOLDER = OTHER
    expect(ownerDriveFolderNeedles().sort()).toEqual([FOLDER_ID, OTHER].sort())
    expect(containsPrivateData(`see ${OTHER}`)).toBe('drive folder')
    expect(containsPrivateData(`see ${FOLDER_ID}`)).toBe('drive folder')
  })

  it('empty forms add no needle (no reject-everything), and equal forms are one needle', () => {
    mockGet.mockReturnValue('')
    envFile.OWNER_DRIVE_FOLDER = '  '
    expect(ownerDriveFolderNeedles()).toEqual([])
    expect(containsPrivateData('A clean capability sentence.')).toBeNull()
    mockGet.mockReturnValue(FOLDER_ID)
    envFile.OWNER_DRIVE_FOLDER = FOLDER_ID
    expect(ownerDriveFolderNeedles()).toEqual([FOLDER_ID])
  })
})
