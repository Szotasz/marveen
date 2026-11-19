// DOCKERHTTPS1119 (Ábel's TOTP run 81266, Samu 81271): the break-glass CLI did not run in the Docker image
// ("tsx: not found": the image prunes dev dependencies, and tsc compiled src/ only). The CLI now lives in src/, so the
// image's `npm run build` puts it at dist/dashboard-user-cli.js and `node` runs it; scripts/dashboard-user.ts is a
// wrapper, so `npm run dashboard-user` on a native install is unchanged. tsx stays a dev dependency.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('the break-glass CLI runs without a TypeScript runner', () => {
  it('lives under src/, which tsc compiles to dist/', () => {
    expect(existsSync(join(ROOT, 'src', 'dashboard-user-cli.ts'))).toBe(true)
    const tsconfig = JSON.parse(read('tsconfig.json')) as { compilerOptions: { rootDir: string; outDir: string }; include: string[] }
    expect(tsconfig.compilerOptions.rootDir).toBe('src')
    expect(tsconfig.compilerOptions.outDir).toBe('dist')
    expect(tsconfig.include).toContain('src/**/*')
    // its imports stay inside src/ (a ../ import would leave rootDir and break the build)
    expect(read('src/dashboard-user-cli.ts')).not.toMatch(/from '\.\.\//)
  })

  it('the native npm script and its wrapper are unchanged in effect; tsx is not a runtime dependency', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> }
    expect(pkg.scripts['dashboard-user']).toBe('tsx scripts/dashboard-user.ts')
    expect(read('scripts/dashboard-user.ts')).toContain("import '../src/dashboard-user-cli.js'")
    expect(pkg.dependencies.tsx).toBeUndefined()
  })

  it('the Docker doc names the in-container commands, and the CLI has them', () => {
    const doc = read('docs/docker.md')
    const cli = read('src/dashboard-user-cli.ts')
    for (const cmd of ['totp:off', 'reset-password']) {
      expect(doc).toContain(`docker compose exec marveen node dist/dashboard-user-cli.js ${cmd} <username>`)
      expect(cli).toContain(`case '${cmd}':`)
    }
  })
})
