// ROUTEPIN1109: a static inventory of the dashboard's state-changing /api handlers and whether each one is behind an
// owner gate. Used by route-owner-pin.test.ts.
//
// What counts as a handler: an `if` in src/web/routes/*.ts whose condition tests `method === 'POST' | 'PUT' | 'DELETE'
// | 'PATCH'`. Its route key is the path it tests (a `path === '/api/...'` literal, or the match variable it tests,
// such as `<kanbanCardMatch>`), or, for a bare method test nested in a path branch, the nearest enclosing branch's.
//
// What counts as gated: an owner-gate call (OWNER_GATES, plus every function in the scanned files that calls one,
// to a fixpoint) that runs before the handler's work:
//   - in the handler's own condition or block;
//   - as a top-level statement of an enclosing branch's block, before the handler;
//   - in an earlier `if` of the same function whose condition names the handler's path literal (a guard placed
//     ahead of several handlers, as in migrate.ts).
// The scan is deliberately simple. It cannot prove a gate is correct; it makes a NEW unguarded state-changing route
// visible, which is what the pin test needs.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// Predicates only: refuseOwner just writes the 403, so a block that calls it without asking a predicate (a guard
// whose condition was switched off) is not a gate.
export const OWNER_GATES = ['mayActAsOwner', 'mayActAsOwnerOrFirstRun', 'isOwnerSession'] as const
const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

export interface ScannedRoute {
  /** `<file> <METHOD[|METHOD]> <path key>`, the key the pin table uses. */
  key: string
  file: string
  line: number
  methods: string[]
  pathKey: string
  gated: boolean
}

function calledNames(node: ts.Node): Set<string> {
  const out = new Set<string>()
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression
      if (ts.isIdentifier(e)) out.add(e.text)
      else if (ts.isPropertyAccessExpression(e)) out.add(e.name.text)
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return out
}

function methodsIn(expr: ts.Expression): string[] {
  const ms = new Set<string>()
  const walk = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && n.left.getText() === 'method' && ts.isStringLiteral(n.right)) ms.add(n.right.text)
    ts.forEachChild(n, walk)
  }
  walk(expr)
  return [...ms]
}

function pathLiteralsIn(expr: ts.Node): string[] {
  const out: string[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && n.left.getText() === 'path' && ts.isStringLiteral(n.right)) out.push(n.right.text)
    ts.forEachChild(n, walk)
  }
  walk(expr)
  return out
}

/** The path a condition tests: a `path === '...'` literal, else the first identifier that names a match. */
function pathKeyOf(expr: ts.Expression): string | null {
  const lits = pathLiteralsIn(expr)
  if (lits.length) return lits.join('|')
  let found: string | null = null
  const walk = (n: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(n) && /Match$|^match$|^m$|^hit$/.test(n.text)) { found = `<${n.text}>`; return }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'startsWith'
      && n.expression.expression.getText() === 'path' && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      found = `${n.arguments[0].text}*`
      return
    }
    ts.forEachChild(n, walk)
  }
  walk(expr)
  return found
}

function gateSet(sources: ts.SourceFile[]): Set<string> {
  const bodies = new Map<string, ts.Node>()
  for (const sf of sources) {
    const walk = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) bodies.set(n.name.text, n.body)
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
        && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) bodies.set(n.name.text, n.initializer.body)
      ts.forEachChild(n, walk)
    }
    walk(sf)
  }
  const gates = new Set<string>(OWNER_GATES)
  for (let changed = true; changed;) {
    changed = false
    for (const [name, body] of bodies) {
      // A route dispatcher calls gates somewhere inside; it is not itself a gate.
      if (gates.has(name) || /^(tryHandle|handle)[A-Z]/.test(name)) continue
      for (const c of calledNames(body)) if (gates.has(c)) { gates.add(name); changed = true; break }
    }
  }
  return gates
}

const callsGate = (n: ts.Node, gates: Set<string>): boolean => [...calledNames(n)].some((c) => gates.has(c))

function enclosingFunction(n: ts.Node): ts.Node | undefined {
  let p = n.parent
  while (p && !ts.isFunctionLike(p)) p = p.parent
  return p
}

export function scanRoutes(repoRoot: string): { routes: ScannedRoute[]; gates: string[] } {
  const dir = join(repoRoot, 'src', 'web', 'routes')
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()
  const sources = files.map((f) => ts.createSourceFile(f, readFileSync(join(dir, f), 'utf8'), ts.ScriptTarget.Latest, true))
  // Gate helpers can live outside the route files (skill-quarantine.ts, auth-device-keys.ts, ...).
  const webDir = join(repoRoot, 'src', 'web')
  const helpers = readdirSync(webDir).filter((f) => f.endsWith('.ts'))
    .map((f) => ts.createSourceFile(f, readFileSync(join(webDir, f), 'utf8'), ts.ScriptTarget.Latest, true))
  const gates = gateSet([...sources, ...helpers])
  const routes: ScannedRoute[] = []

  for (const sf of sources) {
    // Guards: earlier ifs that name path literals and call a gate (in the condition or the block).
    const guards: Array<{ fn: ts.Node | undefined; pos: number; paths: string[] }> = []
    const collect = (n: ts.Node): void => {
      if (ts.isIfStatement(n)) {
        const paths = pathLiteralsIn(n.expression)
        if (paths.length && (callsGate(n.expression, gates) || callsGate(n.thenStatement, gates))) {
          guards.push({ fn: enclosingFunction(n), pos: n.getStart(), paths })
        }
      }
      ts.forEachChild(n, collect)
    }
    collect(sf)

    const visit = (n: ts.Node, ancestors: ts.IfStatement[]): void => {
      if (ts.isIfStatement(n)) {
        const methods = methodsIn(n.expression).filter((m) => MUTATING.has(m)).sort()
        if (methods.length) {
          let pathKey = pathKeyOf(n.expression)
          for (let i = ancestors.length - 1; !pathKey && i >= 0; i--) pathKey = pathKeyOf(ancestors[i]!.expression)
          const start = n.getStart()
          let gated = callsGate(n.expression, gates) || callsGate(n.thenStatement, gates)
          // An enclosing branch whose top-level statements gate before this handler.
          for (const a of ancestors) {
            if (gated) break
            if (callsGate(a.expression, gates)) { gated = true; break }
            const block = a.thenStatement
            if (ts.isBlock(block)) {
              for (const st of block.statements) {
                if (st.getStart() >= start) break
                if (!st.getText().includes(n.getText()) && callsGate(st, gates) && !ts.isIfStatement(st)) { gated = true; break }
                if (ts.isIfStatement(st) && !methodsIn(st.expression).length && callsGate(st, gates)) { gated = true; break }
              }
            }
          }
          // A guard earlier in the same function that names this path.
          if (!gated) {
            const fn = enclosingFunction(n)
            const lits = pathLiteralsIn(n.expression)
            gated = guards.some((g) => g.fn === fn && g.pos < start && lits.some((l) => g.paths.includes(l)))
          }
          const line = sf.getLineAndCharacterOfPosition(start).line + 1
          const base = `${sf.fileName} ${methods.join('|')} ${pathKey ?? '?'}`
          const seen = routes.filter((r) => r.key === base || r.key.startsWith(`${base} #`)).length
          const key = seen === 0 ? base : `${base} #${seen + 1}`
          routes.push({ key, file: sf.fileName, line, methods, pathKey: pathKey ?? '?', gated })
        }
        visit(n.expression, ancestors)
        visit(n.thenStatement, [...ancestors, n])
        if (n.elseStatement) visit(n.elseStatement, ancestors)
        return
      }
      ts.forEachChild(n, (c) => visit(c, ancestors))
    }
    visit(sf, [])
  }
  return { routes, gates: [...gates].sort() }
}
