#!/usr/bin/env node
/**
 * generate-changelog.mjs
 *
 * Reads conventional commits since the last git tag and updates the
 * [Unreleased] section of CHANGELOG.md.
 *
 * With --release <version>, promotes [Unreleased] to that version
 * header and resets [Unreleased] to empty.  Also updates package.json.
 *
 * Usage:
 *   node scripts/generate-changelog.mjs
 *   node scripts/generate-changelog.mjs --release 1.34.0
 *   node scripts/generate-changelog.mjs --since v1.32.0   # explicit base tag
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

// Commit scopes that are considered API-facing (get [API] label).
const API_SCOPES = new Set(['api', 'openapi', 'sdk', 'sdk-gen', 'versioning'])

const TYPE_TO_SECTION = {
  feat:     'Added',
  fix:      'Fixed',
  refactor: 'Changed',
  perf:     'Changed',
  docs:     'Documentation',
  chore:    'Infrastructure',
  test:     'Infrastructure',
  style:    'Infrastructure',
  build:    'Infrastructure',
  ci:       'Infrastructure',
}

const SECTION_ORDER = ['Added', 'Fixed', 'Changed', 'Documentation', 'Infrastructure']

// ---------------------------------------------------------------------------

function parseConventionalCommit(subject) {
  const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject)
  if (!m) return null
  return { type: m[1], scope: m[2] ?? '', breaking: m[3] === '!', description: m[4] }
}

function isApiScope(scope) {
  return API_SCOPES.has(scope) || scope.startsWith('api')
}

function getLastTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

function getCommitSubjects(since) {
  const rangeArgs = since ? [`${since}..HEAD`] : ['HEAD']
  const raw = execFileSync(
    'git', ['log', ...rangeArgs, '--no-merges', '--format=%s'],
    { encoding: 'utf-8' }
  ).trim()
  return raw ? raw.split('\n') : []
}

function buildSections(subjects) {
  const sections = {}
  for (const subject of subjects) {
    const parsed = parseConventionalCommit(subject)
    if (!parsed) continue
    // Skip "chore(release): vX.Y.Z" commits -- they are changelog noise.
    if (parsed.type === 'chore' && /^v?\d+\.\d+/.test(parsed.description)) continue
    const section = TYPE_TO_SECTION[parsed.type] ?? 'Changed'
    if (!sections[section]) sections[section] = []
    const apiTag = isApiScope(parsed.scope) ? '**[API]** ' : ''
    const breakTag = parsed.breaking ? '**BREAKING** ' : ''
    sections[section].push(`- ${breakTag}${apiTag}${parsed.description}`)
  }
  return sections
}

function formatUnreleasedBlock(sections) {
  const lines = []
  for (const sec of SECTION_ORDER) {
    if (!sections[sec]?.length) continue
    lines.push(`### ${sec}`, '', ...sections[sec], '')
  }
  // Trim trailing blank lines from the block (one will be added by serialiser).
  while (lines.length && lines.at(-1) === '') lines.pop()
  return lines
}

// ---------------------------------------------------------------------------
// CHANGELOG parser / serialiser (line-based, preserves hand-written content)
// ---------------------------------------------------------------------------

function parseChangelog(content) {
  const lines = content.split('\n')
  const preamble = []
  const versionSections = []  // [{version, header, lines}]

  let current = null
  for (const line of lines) {
    const m = /^## \[([^\]]+)\](.*)$/.exec(line)
    if (m) {
      if (current) versionSections.push(current)
      current = { version: m[1], header: line, lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (current) versionSections.push(current)
  return { preamble, versionSections }
}

function serializeChangelog({ preamble, versionSections }) {
  const parts = [preamble.join('\n')]
  for (const { header, lines } of versionSections) {
    parts.push(header)
    parts.push(lines.join('\n'))
  }
  return parts.join('\n')
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const releaseIdx = args.indexOf('--release')
const releaseVersion = releaseIdx >= 0 ? (args[releaseIdx + 1] ?? null) : null
const sinceIdx = args.indexOf('--since')
const sinceTag = sinceIdx >= 0 ? (args[sinceIdx + 1] ?? null) : null

const changelogPath = 'CHANGELOG.md'
let changelogContent
try {
  changelogContent = readFileSync(changelogPath, 'utf-8')
} catch {
  changelogContent = [
    '# Changelog',
    '',
    'All notable changes to this project are documented in this file.',
    'Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), SemVer.',
    '',
  ].join('\n')
}

const baseTag = sinceTag ?? getLastTag()
const subjects = getCommitSubjects(baseTag)
const sections = buildSections(subjects)
const blockLines = formatUnreleasedBlock(sections)

const { preamble, versionSections } = parseChangelog(changelogContent)

const unreleasedIdx = versionSections.findIndex(s => s.version === 'Unreleased')

if (releaseVersion) {
  if (!releaseVersion.match(/^\d+\.\d+\.\d+$/)) {
    console.error(`Invalid version format: ${releaseVersion}  (expected X.Y.Z)`)
    process.exit(1)
  }

  // Build new [Unreleased] (empty -- will be filled on next run)
  const newUnreleased = { version: 'Unreleased', header: '## [Unreleased]', lines: ['', ''] }

  // Convert existing [Unreleased] to version entry
  if (unreleasedIdx >= 0) {
    const existing = versionSections[unreleasedIdx]
    versionSections.splice(unreleasedIdx, 1,
      newUnreleased,
      {
        version: releaseVersion,
        header: `## [${releaseVersion}] - ${today()}`,
        lines: existing.lines,
      }
    )
  } else {
    // No [Unreleased] -- insert a fresh one plus the generated version block
    versionSections.unshift(
      newUnreleased,
      {
        version: releaseVersion,
        header: `## [${releaseVersion}] - ${today()}`,
        lines: ['', ...blockLines, ''],
      }
    )
  }

  // Bump package.json
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
  const prev = pkg.version
  pkg.version = releaseVersion
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

  writeFileSync(changelogPath, serializeChangelog({ preamble, versionSections }))
  console.log(`Released [${releaseVersion}] (was ${prev}).  package.json updated.`)
} else {
  // Update [Unreleased] in-place (or insert it).
  const updatedLines = ['', ...blockLines, '']
  if (unreleasedIdx >= 0) {
    versionSections[unreleasedIdx].lines = updatedLines
  } else {
    versionSections.unshift({ version: 'Unreleased', header: '## [Unreleased]', lines: updatedLines })
  }

  writeFileSync(changelogPath, serializeChangelog({ preamble, versionSections }))
  const count = Object.values(sections).reduce((s, a) => s + a.length, 0)
  console.log(`[Unreleased] updated: ${count} entries from ${subjects.length} commits since ${baseTag ?? 'beginning'}.`)
}
