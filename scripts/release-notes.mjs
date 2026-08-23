#!/usr/bin/env node
/**
 * release-notes.mjs
 *
 * Extracts the release notes for a given version from CHANGELOG.md and
 * prints them to stdout.  Exits 1 if the version is not found.
 *
 * Usage:
 *   node scripts/release-notes.mjs 1.34.0
 *   node scripts/release-notes.mjs Unreleased
 *
 * Typical pipe:
 *   gh release create v1.34.0 --notes "$(node scripts/release-notes.mjs 1.34.0)"
 */

import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (!version) {
  console.error('Usage: release-notes.mjs <version|Unreleased>')
  process.exit(1)
}

const changelogPath = 'CHANGELOG.md'
let content
try {
  content = readFileSync(changelogPath, 'utf-8')
} catch {
  console.error(`Cannot read ${changelogPath}`)
  process.exit(1)
}

// Find the section for the requested version.
const lines = content.split('\n')
const headerRe = /^## \[([^\]]+)\]/

let inSection = false
const out = []

for (const line of lines) {
  const m = headerRe.exec(line)
  if (m) {
    if (inSection) break          // next version section starts -- stop
    if (m[1] === version) {
      inSection = true
      continue                    // skip the header line itself
    }
  } else if (inSection) {
    out.push(line)
  }
}

if (!inSection) {
  console.error(`Version [${version}] not found in ${changelogPath}`)
  process.exit(1)
}

// Trim leading/trailing blank lines.
let start = 0
let end = out.length - 1
while (start <= end && out[start].trim() === '') start++
while (end >= start && out[end].trim() === '') end--

const notes = out.slice(start, end + 1).join('\n')

if (!notes) {
  console.error(`[${version}] section exists but is empty in ${changelogPath}`)
  process.exit(1)
}

process.stdout.write(notes + '\n')
