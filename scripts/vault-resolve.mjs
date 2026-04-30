#!/usr/bin/env node
// Resolve vault secret IDs to plaintext values.
// Reads "ENV_VAR=secret_id" lines from stdin, outputs "ENV_VAR=value" lines.
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

// Dynamic import from compiled dist
const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))

const input = await new Promise(resolve => {
  let data = ''
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', chunk => { data += chunk })
  process.stdin.on('end', () => resolve(data))
})

for (const line of input.trim().split('\n')) {
  if (!line.trim()) continue
  const eq = line.indexOf('=')
  if (eq < 0) continue
  const envVar = line.slice(0, eq)
  const secretId = line.slice(eq + 1)
  const value = getSecret(secretId)
  if (value !== null) {
    process.stdout.write(`${envVar}=${value}\n`)
  }
}
