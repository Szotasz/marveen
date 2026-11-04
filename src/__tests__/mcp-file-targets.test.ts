// MCPWRITEGATE1104: the pure classifier both path gates use for MCP tools. The class comes from the TOOL name, never
// the server name (Dani 68004); the path candidates are every string leaf, with no key list.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs module, no types
import { parseMcpName, toolClass, mcpFileTargets } from '../../scripts/hooks/mcp-file-targets.mjs'

describe('parseMcpName', () => {
  it.each([
    ['mcp__Filesystem__write_file', 'Filesystem', 'write_file'],
    ['mcp__plugin_telegram_telegram__reply', 'plugin_telegram_telegram', 'reply'],
    ['mcp__server-gmail-autoauth-mcp__download_attachment', 'server-gmail-autoauth-mcp', 'download_attachment'],
    ['MCP__FILESYSTEM__WRITE_FILE', 'FILESYSTEM', 'WRITE_FILE'],
    ['mcp__a__b__c', 'a__b', 'c'],
  ])('%s', (name, server, tool) => {
    expect(parseMcpName(name)).toEqual({ server, tool })
  })
  it.each(['Write', 'mcp__', 'mcp__x', 'mcp__x__', 'xmcp__a__b'])('not an MCP tool name: %s', (name) => {
    expect(parseMcpName(name)).toBeNull()
  })
})

describe('toolClass: from the tool name only', () => {
  it.each([
    ['write_file', 'writer'], ['edit_file', 'writer'], ['saveDocument', 'writer'], ['downloadFile', 'writer'],
    ['meshy_download_model', 'writer'], ['export-report', 'writer'], ['create_directory', 'writer'], ['createFolder', 'writer'],
    ['move_file', 'mover'], ['renameItem', 'mover'], ['copyFile', 'mover'], ['delete_path', 'mover'], ['rm', 'mover'],
    ['read_file', 'other'], ['search_emails', 'other'], ['reply', 'other'], ['create_event', 'other'], ['create_draft', 'other'],
  ])('%s -> %s', (tool, cls) => {
    expect(toolClass(tool)).toBe(cls)
  })
})

describe('mcpFileTargets', () => {
  it('a non-MCP tool is not this module\'s', () => {
    expect(mcpFileTargets('Write', { file_path: '/x' })).toBeNull()
  })
  it('every string leaf that looks like a path, at any depth, whatever its key', () => {
    const m = mcpFileTargets('mcp__any__save', { opts: { deep: { where: '/a/b.json' } }, list: ['~/c', 'plain'], uri: 'file:///d%20e/f' })
    expect(m.targets.map((t: { path: string }) => t.path).sort()).toEqual(['/a/b.json', '/d e/f', 'plain', '~/c']) // a writer: a bare leaf too
    expect(m.cls).toBe('writer')
  })
  it('a writer: every whitespace-free leaf is a relative-path candidate, a bare name too (Dani 68192 (2))', () => {
    const m = mcpFileTargets('mcp__notes__save_note', { filename: '.mcp.json', title: 'two words', dir: 'store/x' })
    expect(m.targets.map((t: { path: string }) => t.path).sort()).toEqual(['.mcp.json', 'store/x'])
  })
  it('the other class: a bare name is not a candidate, a slash is', () => {
    const m = mcpFileTargets('mcp__x__search', { q: 'hello', p: 'a/b' })
    expect(m.targets.map((t: { path: string }) => t.path)).toEqual(['a/b'])
  })
  it.each([['create_file', 'writer'], ['update_file', 'writer'], ['replace_in_file', 'writer'], ['insertText', 'writer'],
    ['set_contents', 'writer']])('Dani 68192 (1): %s -> %s', (tool, cls) => {
    expect(toolClass(tool)).toBe(cls)
  })
  it('a known mover\'s own keys are directory targets (Dani 68192 (3))', () => {
    const m = mcpFileTargets('mcp__fs__move_file', { source: 'store', destination: 'x' })
    expect(m.targets).toContainEqual({ path: 'store', dir: true })
    expect(m.targets.filter((t: { dir: boolean }) => !t.dir)).toEqual([])
  })
  it('a leaf naming the dashboard DB is flagged, whatever the class', () => {
    expect(mcpFileTargets('mcp__sqlite__read_query', { db: 'store/claudeclaw.db', q: 'select 1' }).dbNamed).toBe(true)
    expect(mcpFileTargets('mcp__x__search', { q: 'claudeclaw.db-wal' }).dbNamed).toBe(true)
    expect(mcpFileTargets('mcp__x__search', { q: 'about claudeclaw.db files' }).dbNamed).toBe(false)
  })
  it('for the other class, prose (whitespace) is not a path; a lone path is', () => {
    const m = mcpFileTargets('mcp__plugin_telegram_telegram__reply', { text: 'see store/x.json now', files: ['/tmp/a.png'] })
    expect(m.cls).toBe('other')
    expect(m.targets.map((t: { path: string }) => t.path)).toEqual(['/tmp/a.png'])
  })
  it('a mover\'s paths are directory targets (the gates also deny an ancestor)', () => {
    const m = mcpFileTargets('mcp__fs__move_file', { source: '/a', destination: '/b' })
    expect(m.cls).toBe('mover')
    expect(m.targets.filter((t: { dir: boolean }) => t.dir).map((t: { path: string }) => t.path).sort()).toEqual(['/a', '/b'])
  })
  it('a download into a directory: the directory is a dir target, a given name is joined (a ../ name too)', () => {
    const a = mcpFileTargets('mcp__gmail__download_attachment', { messageId: '1', attachmentId: '2', savePath: '/d' })
    expect(a.targets).toContainEqual({ path: '/d', dir: true })
    expect(a.missingPath).toBe(false)
    const b = mcpFileTargets('mcp__gmail__download_attachment', { messageId: '1', attachmentId: '2', savePath: '/d/', filename: '../x/y.json' })
    expect(b.targets).toContainEqual({ path: '/d/../x/y.json', dir: false })
  })
  it('meshy: save_to is a file, and its directory receives the textures under their own names', () => {
    const m = mcpFileTargets('mcp__meshy__meshy_download_model', { task_id: 't', save_to: '/a/b/m.glb' })
    expect(m.targets).toContainEqual({ path: '/a/b/m.glb', dir: false })
    expect(m.targets).toContainEqual({ path: '/a/b', dir: true })
  })
  it.each([
    ['mcp__gmail__download_attachment', { messageId: '1', attachmentId: '2' }],
    ['mcp__drive__downloadFile', { fileId: 'x' }],
    ['mcp__meshy__meshy_download_model', { task_id: 't' }],
    ['mcp__Filesystem__write_file', { content: 'x' }],
  ])('a known writer with its path argument missing: missingPath (%s)', (name, input) => {
    expect(mcpFileTargets(name, input).missingPath).toBe(true)
  })
  it('an unknown writer without a path is NOT missingPath (no local file named)', () => {
    const m = mcpFileTargets('mcp__cal__create_event', { summary: 'x' })
    expect(m.missingPath).toBe(false)
    expect(m.targets).toEqual([])
  })
  it('the walk is bounded: too deep or too many leaves is reported, not silently cut', () => {
    let deep: Record<string, unknown> = { p: '/x' }
    for (let i = 0; i < 10; i++) deep = { d: deep }
    expect(mcpFileTargets('mcp__x__write_a', deep).truncated).toBe(true)
    expect(mcpFileTargets('mcp__x__write_a', { list: Array.from({ length: 300 }, (_, i) => `/p${i}`) }).truncated).toBe(true)
    expect(mcpFileTargets('mcp__x__write_a', { a: '/x' }).truncated).toBe(false)
  })
})
