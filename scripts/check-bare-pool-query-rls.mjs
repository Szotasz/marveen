#!/usr/bin/env node
// Extended check-definer-force-rls: also flags bare pool.query() calls against FORCE RLS
// tables in application source code. This converts a CLAUDE.md standing rule into a
// merge-time enforcement — a protection that relies on memory is not a protection.
//
// Card: extends check-definer-force-rls.mjs (card 9959f705 / fa7279a6)
// Usage: node scripts/check-bare-pool-query-rls.mjs [--source-only] [--migrations-only]
// Exit code 1 if any problem found (CI-ready), 0 if clean.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Configuration ----

// Try to locate the suite root — check common locations
function findSuiteRoot() {
  const candidates = [
    join(__dirname, "..", "..", "..", "agents", "fullstackfejleszto", "deliverables", "suite"),
    join(__dirname, "..", "..", "fullstackfejleszto", "deliverables", "suite"),
    join(process.cwd()),
  ];
  for (const c of candidates) {
    const migrationsDir = join(c, "apps", "api", "db", "migrations");
    if (existsSync(migrationsDir)) return c;
  }
  return null;
}

const SUITE_ROOT = findSuiteRoot();
if (!SUITE_ROOT) {
  console.error("ERROR: Cannot find suite root (tried multiple locations).");
  console.error("Run from the suite directory or a sibling agent directory.");
  process.exit(2);
}

const MIGRATIONS_DIR = join(SUITE_ROOT, "apps", "api", "db", "migrations");
const SOURCE_DIRS = [
  join(SUITE_ROOT, "apps", "api", "src"),
  join(SUITE_ROOT, "packages"),
];

// SQL keywords that are NOT table names
const SQL_KEYWORDS = new Set([
  "select", "from", "where", "set", "values", "order", "group", "limit",
  "offset", "having", "as", "on", "and", "or", "not", "null", "true",
  "false", "current_timestamp", "now", "unnest", "array", "insert", "into",
  "update", "delete", "create", "alter", "drop", "table", "index", "join",
  "left", "right", "inner", "outer", "cross", "full", "natural", "using",
  "exists", "case", "when", "then", "else", "end", "cast", "coalesce",
  "count", "sum", "avg", "min", "max", "distinct", "all", "any", "some",
  "between", "like", "in", "is", "for", "return", "returns", "begin",
  "declare", "execute", "format", "function", "language", "security",
  "definer", "invoker", "row", "level", "force", "enable", "disable",
  "policy", "with", "check", "option", "default", "primary", "key",
  "foreign", "references", "constraint", "unique", "cascade", "restrict",
  "asc", "desc", "nulls", "first", "last", "type", "enum", "if", "loop",
  "each", "next", "recursive", "materialized", "temporary", "temp",
  "pg_catalog", "information_schema", "pg_temp", "to_char", "to_date",
  "extract", "date_trunc", "generate_series", "string_agg", "array_agg",
  "json_agg", "jsonb_agg", "row_number", "rank", "dense_rank", "lag",
  "lead", "over", "partition", "window", "interval", "text", "integer",
  "bigint", "boolean", "timestamp", "timestamptz", "date", "numeric",
  "uuid", "jsonb", "json", "bytea", "void", "int", "varchar", "char",
]);

// Tables known to NOT have a tenant dimension (product-wide config, etc.)
const NON_TENANT_TABLES = new Set([
  "mk_tax_rule_profile",
  "mk_accountant_users",
  "tenants",
  "sites",
  "tenant_nav_credentials",  // may not exist yet
  "nav_sync_log",            // may not exist yet
]);

// ---- Part 1: Migration walking (from check-definer-force-rls.mjs) ----

function loadMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function extractForceStateChanges(sql) {
  const changes = [];

  // Literal statements: ALTER TABLE <name> [NO] FORCE ROW LEVEL SECURITY
  const literalRe = /ALTER TABLE\s+(\w+)\s+(NO\s+)?FORCE ROW LEVEL SECURITY/gi;
  let m;
  while ((m = literalRe.exec(sql)) !== null) {
    changes.push({ table: m[1].toLowerCase(), force: !m[2] });
  }

  // FOREACH loop pattern (0001_init.sql style)
  const foreachRe = /FOREACH\s+(\w+)\s+IN ARRAY ARRAY\[([^\]]*)\][\s\S]*?END LOOP/gi;
  let fl;
  while ((fl = foreachRe.exec(sql)) !== null) {
    const [loopBlock, , arrayContents] = fl;
    const tables = [...arrayContents.matchAll(/'([^']+)'/g)].map((x) => x[1].toLowerCase());
    const execRe = new RegExp(
      `EXECUTE\\s+format\\(\\s*['"]ALTER TABLE %I\\s+(NO\\s+)?FORCE ROW LEVEL SECURITY`,
      "gi",
    );
    let em;
    while ((em = execRe.exec(loopBlock)) !== null) {
      const force = !em[1];
      for (const table of tables) changes.push({ table, force });
    }
  }

  // FOR...IN SELECT unnest(ARRAY[...]) pattern (Dora style)
  const forSelectUnnestRe = /FOR\s+\w+\s+IN\s+SELECT\s+unnest\s*\(\s*ARRAY\s*\[([^\]]*)\][\s\S]*?END LOOP/gi;
  let fs;
  while ((fs = forSelectUnnestRe.exec(sql)) !== null) {
    const [loopBlock, arrayContents] = fs;
    const tables = [...arrayContents.matchAll(/'([^']+)'/g)].map((x) => x[1].toLowerCase());
    const execRe = new RegExp(
      `EXECUTE\\s+format\\(\\s*['"]ALTER TABLE %I\\s+(NO\\s+)?FORCE ROW LEVEL SECURITY`,
      "gi",
    );
    let em;
    while ((em = execRe.exec(loopBlock)) !== null) {
      const force = !em[1];
      for (const table of tables) changes.push({ table, force });
    }
  }

  // CREATE TABLE ... WITH (force_row_level_security = true) — Postgres 15+ syntax
  const createForceRe = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)[\s\S]*?force_row_level_security\s*=\s*true/gi;
  let cf;
  while ((cf = createForceRe.exec(sql)) !== null) {
    changes.push({ table: cf[1].toLowerCase(), force: true });
  }

  // ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY (single statement)
  const enableForceRe = /ALTER TABLE\s+(\w+)\s+ENABLE ROW LEVEL SECURITY\s*;\s*\n\s*ALTER TABLE\s+\1\s+FORCE ROW LEVEL SECURITY/gi;
  // Already covered by literalRe which matches each ALTER TABLE individually

  return changes;
}

function buildForceState() {
  const files = loadMigrationFiles();
  const forceState = new Map();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const { table, force } of extractForceStateChanges(sql)) {
      forceState.set(table, force);
    }
  }

  return { forceState, fileCount: files.length };
}

// ---- Part 2: Source-code scanning for bare pool.query() ----

function extractTableNamesFromSQL(sql) {
  const tables = new Set();

  // Normalize: collapse whitespace, remove comments
  const normalized = sql
    .replace(/--[^\n]*/g, "")       // line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\s+/g, " ")
    .toLowerCase();

  // FROM/JOIN/INTO/UPDATE patterns
  const fromRe = /\b(?:from|join|into|update)\s+(\w+)/gi;
  let m;
  while ((m = fromRe.exec(normalized)) !== null) {
    const table = m[1];
    if (!SQL_KEYWORDS.has(table) && !table.startsWith("pg_")) {
      tables.add(table);
    }
  }

  return [...tables];
}

function findBarePoolQueries(filePath, forceState) {
  const content = readFileSync(filePath, "utf8");
  const problems = [];
  const relPath = relative(SUITE_ROOT, filePath);

  // Find pool.query( or pool.query ( or db.query( calls
  // We look for: <var>.query( and then check if <var> is 'pool' or 'db'
  // and that withTenant/withWorkspace is NOT nearby

  // Strategy: find all .query( calls, then analyze context
  const queryRe = /\.query\s*\(\s*(?:[`'"])/g;
  let m;
  while ((m = queryRe.exec(content)) !== null) {
    const dotPos = m.index;
    const parenPos = dotPos + ".query".length;

    // Find the object name before .query
    const before = content.slice(Math.max(0, dotPos - 30), dotPos);
    // Extract the last word before .query
    const objMatch = before.match(/(\w+)\s*$/);
    if (!objMatch) continue;
    const objName = objMatch[1];

    // Only check 'pool' and 'db' — these are the direct connection objects
    if (objName !== "pool" && objName !== "db") continue;

    // Check if this is inside a withTenant() or withWorkspace() wrapper
    // Look for withTenant/withWorkspace in the ~200 chars before the match
    const contextBefore = content.slice(Math.max(0, dotPos - 200), dotPos);
    if (/\bwithTenant\s*\(/.test(contextBefore) || /\bwithWorkspace\s*\(/.test(contextBefore)) {
      continue;
    }

    // Also check: is this a SECURITY DEFINER function context?
    // (marked with comments like "// SECURITY DEFINER login — allowed to bypass")
    if (/SECURITY DEFINER.*(?:login|lookup|allowed|bypass)/i.test(contextBefore)) {
      continue;
    }

    // Check for suppression marker on the same line or preceding line
    // Format: // rls-bypass: <reason>  OR  /* rls-bypass: <reason> */
    const lineStart = content.lastIndexOf("\n", dotPos) + 1;
    const prevLineStart = lineStart > 0 ? content.lastIndexOf("\n", lineStart - 2) + 1 : 0;
    const currentLine = content.slice(lineStart, content.indexOf("\n", dotPos)).trim();
    const prevLine = content.slice(prevLineStart, lineStart - 1).trim();
    if (/rls-bypass\s*:/i.test(currentLine) || /rls-bypass\s*:/i.test(prevLine)) {
      continue;
    }

    // Extract the SQL string argument — skip whitespace between ( and opening quote
    let sqlStart = parenPos + 1; // after .query(
    while (sqlStart < content.length && /\s/.test(content[sqlStart])) sqlStart++;
    const quoteChar = content[sqlStart];
    if (quoteChar !== "'" && quoteChar !== '"' && quoteChar !== "`") continue;

    let sqlEnd = sqlStart + 1;
    let depth = 1;
    if (quoteChar === "`") {
      // Template literal — handle nesting
      while (depth > 0 && sqlEnd < content.length) {
        if (content[sqlEnd] === "`" && content[sqlEnd - 1] !== "\\") {
          depth--;
          if (depth === 0) break;
        }
        if (content[sqlEnd] === "$" && content[sqlEnd + 1] === "{") {
          // Skip interpolated expression
          let braceDepth = 1;
          sqlEnd += 2;
          while (braceDepth > 0 && sqlEnd < content.length) {
            if (content[sqlEnd] === "{") braceDepth++;
            if (content[sqlEnd] === "}") braceDepth--;
            sqlEnd++;
          }
          continue;
        }
        sqlEnd++;
      }
    } else {
      while (sqlEnd < content.length) {
        if (content[sqlEnd] === quoteChar && content[sqlEnd - 1] !== "\\") break;
        sqlEnd++;
      }
    }

    const sqlStr = content.slice(sqlStart + 1, sqlEnd);
    const tables = extractTableNamesFromSQL(sqlStr);
    const forcedTables = tables.filter(
      (t) => forceState.get(t) === true && !NON_TENANT_TABLES.has(t),
    );

    if (forcedTables.length > 0) {
      const lineNum = content.slice(0, dotPos).split("\n").length;
      problems.push({
        file: relPath,
        line: lineNum,
        tables: forcedTables,
        snippet: sqlStr.replace(/\s+/g, " ").slice(0, 100),
      });
    }
  }

  return problems;
}

function scanSourceFiles(forceState) {
  const allProblems = [];
  let filesScanned = 0;

  for (const srcDir of SOURCE_DIRS) {
    if (!existsSync(srcDir)) continue;
    walkDir(srcDir, (filePath) => {
      if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx") && !filePath.endsWith(".js")) return;
      // Skip test files, node_modules, dist
      if (filePath.includes("node_modules") || filePath.includes("/dist/")) return;
      if (/\.test\.(ts|tsx|js)$/.test(filePath) || /\.spec\.(ts|tsx|js)$/.test(filePath)) return;

      filesScanned++;
      const problems = findBarePoolQueries(filePath, forceState);
      allProblems.push(...problems);
    });
  }

  return { problems: allProblems, filesScanned };
}

function walkDir(dir, callback) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
        walkDir(fullPath, callback);
      } else if (entry.isFile()) {
        callback(fullPath);
      }
    }
  } catch {
    // Permission errors, missing dirs — skip
  }
}

// ---- Part 3: Main ----

function main() {
  const args = process.argv.slice(2);
  const sourceOnly = args.includes("--source-only");
  const migrationsOnly = args.includes("--migrations-only");

  console.error(`Suite root: ${SUITE_ROOT}`);
  console.error(`Migrations dir: ${relative(process.cwd(), MIGRATIONS_DIR)}`);

  let exitCode = 0;

  // Build FORCE RLS state from migrations
  const { forceState, fileCount } = buildForceState();

  const forcedTables = [...forceState.entries()].filter(([, f]) => f).map(([t]) => t);
  console.error(`Migrations: ${fileCount} files, ${forcedTables.length} tables with FORCE RLS`);
  if (forcedTables.length > 0) {
    console.error(`  FORCE RLS tables: ${forcedTables.sort().join(", ")}`);
  }

  // Part A: Source-code scan for bare pool.query() against FORCE RLS tables
  if (!migrationsOnly) {
    const { problems, filesScanned } = scanSourceFiles(forceState);

    if (problems.length === 0) {
      console.log(`OK: ${filesScanned} source files scanned, no bare pool.query() against FORCE RLS tables.`);
    } else {
      console.error(`\nFOUND ${problems.length} bare pool.query() call(s) targeting FORCE RLS table(s):\n`);
      for (const p of problems) {
        console.error(`  ${p.file}:${p.line} — table(s): ${p.tables.join(", ")}`);
        console.error(`    SQL: ${p.snippet}`);
        console.error(`    Fix: wrap in withTenant(req, () => pool.query(...)) or add withTenant() preHandler`);
      }
      exitCode = 1;
    }
  }

  // Part B: Existing SECURITY DEFINER check (delegated to original linter)
  if (!sourceOnly) {
    const originalLinter = join(SUITE_ROOT, "scripts", "check-definer-force-rls.mjs");
    if (existsSync(originalLinter)) {
      console.error(`\nRunning migration-level SECURITY DEFINER check: ${relative(process.cwd(), originalLinter)}`);
      // We could import and call main(), but it's simpler to just note this is a separate check
      console.error("  (run scripts/check-definer-force-rls.mjs separately for SECURITY DEFINER check)");
    }
  }

  process.exit(exitCode);
}

main();
