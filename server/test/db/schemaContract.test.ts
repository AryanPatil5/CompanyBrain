// Code↔schema contract test (Phase 1, closes the schema-drift bug class).
//
// Every `supabase.from('<table>')` reference in server/src must resolve to a
// table the migration set actually creates, and every statically identifiable
// column reference (select/eq/in/is/ilike/not/or/order filters, insert/update/
// upsert payload keys) must resolve to a column that migration set defines.
// Fully hermetic: parses server/supabase/*.sql, scans server/src — no DB.
//
// This suite exists precisely because `execution_logs` was written with 8
// columns migration 003 never defined; 033_execution_logs_alignment.sql fixes
// the drift and this test keeps it fixed.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase');
const SRC_DIR = join(ROOT, 'src');

let passed = 0;
let failed = 0;
let success = true;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ SCHEMA CONTRACT TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ SCHEMA CONTRACT TEST FAILED: ${name}`, extra ?? '');
  }
}

function collectIdentifiers(sql: string): { tables: Map<string, string[]> } {
  const tables = new Map<string, string[]>();
  const lower = sql.toLowerCase();

  // create table [if not exists] [schema.]name ( ... ) — handle uppercase
  // (029 uses CREATE TABLE IF NOT EXISTS usage_meters ().
  for (const m of lower.matchAll(/create table(?: if not exists)?\s+(?:([a-z_]+)\.)?([a-z_]+)\s*\(/g)) {
    const name = m[2];
    if (tables.has(name)) continue;
    const start = (m.index ?? 0) + m[0].length;
    const block = sql.slice(start);
    const cols: string[] = [];
    let depth = 0;
    for (let i = 0; i < block.length; i++) {
      const ch = block[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    const body = block.slice(0, block.lastIndexOf(')')).split('\n');
    for (const rawLine of body) {
      const line = rawLine.trim();
      if (!line || line.startsWith(')')) continue;
      const stripped = line.replace(/,$/, '').trim();
      if (/^(constraint|unique|primary\s+key|foreign\s+key|check|index|exclude|like)\b/i.test(stripped)) continue;
      const col = stripped.split(/\s+/)[0];
      if (col && /^[a-z_][a-z0-9_]*$/.test(col)) cols.push(col);
    }
    tables.set(name, cols);
  }

  // alter table [schema.]name [ ... add column [if not exists] col ... ]
  // — capture the statement span so multi-column statements (004, 031, 033)
  // register EVERY added column, and so `add column` on its own line (031)
  // is still found.
  for (const m of lower.matchAll(/alter table(?: if not exists)?\s+(?:([a-z_]+)\.)?([a-z_]+)\b/g)) {
    const name = m[2];
    const statementEnd = sql.indexOf(';', m.index ?? 0);
    const span = lower.slice(m.index ?? 0, statementEnd === -1 ? undefined : statementEnd);
    for (const cm of span.matchAll(/add column(?: if not exists)?\s+([a-z_]+)/g)) {
      const col = cm[1];
      const existing = tables.get(name) ?? [];
      if (!existing.includes(col)) existing.push(col);
      tables.set(name, existing);
    }
  }

  return { tables };
}

interface Ref {
  table: string;
  columns: string[];
  source: string;
}

function collectRefs(): Ref[] {
  const refs: Ref[] = [];
  const tableRegex = /\.from\('([a-z_]+)'\)/g;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) readFile(full);
    }
  }

  function readFile(file: string): void {
    const content = readFileSync(file, 'utf8');
    for (const m of content.matchAll(tableRegex)) {
      const table = m[1];
      const ref: Ref = { table, columns: [], source: file };
      refs.push(ref);
      // Walk the query chain from the .from() call: each statement is on its
      // own line until the terminating ';' or a new .from(.
      const cursor = (m.index ?? 0) + m[0].length;
      // chain terminates at the first ';' that is NOT inside a string,
      // template literal, or comment (e.g. join('; ') must not end it)
      let quote: "'" | '"' | '`' | null = null;
      let lineComment = false;
      let chainEnd = -1;
      for (let i = cursor; i < content.length; i++) {
        const ch = content[i];
        const next = content[i + 1];
        if (lineComment) {
          if (ch === '\n') lineComment = false;
          continue;
        }
        if (quote) {
          if (ch === '\\') {
            i++;
            continue;
          }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '/' && next === '/') {
          lineComment = true;
          i++;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          quote = ch;
          continue;
        }
        if (ch === ';') {
          chainEnd = i;
          break;
        }
      }
      const chain = content.slice(cursor, chainEnd === -1 ? undefined : chainEnd);

      // Embedded-resource select: .select('*, rel!inner(a, b)') — a/b are
      // columns of the RELATED table rel, not of the queried table.
      for (const sm of chain.matchAll(/\.select\(\s*'([^']*)'\s*(?:,\s*\{[^}]*\})?\)/g)) {
        const body = sm[1];
        // split on top-level commas (embedded lists are parenthesized)
        let depth = 0;
        let buf = '';
        const parts: string[] = [];
        for (const ch of body) {
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          if (ch === ',' && depth === 0) {
            parts.push(buf);
            buf = '';
          } else buf += ch;
        }
        parts.push(buf);
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed || trimmed === '*') continue;
          const embed = trimmed.match(/^([a-z_]+)!(?:inner|left|right|full)\((.*)\)$/);
          if (embed) {
            const rel = embed[1];
            for (const inner of embed[2].split(',')) {
              const innerCol = inner.trim().split(/\s+as\s+/i)[0].trim();
              if (innerCol) ref.columns.push(`${rel}.${innerCol}`);
            }
            continue;
          }
          const plain = trimmed.split(/\s+as\s+/i)[0].trim();
          if (/^[a-z_][a-z0-9_]*$/.test(plain)) ref.columns.push(plain);
        }
      }

      // Filter/order refs: .eq('col', ...) or dotted .eq('rel.col', ...)
      for (const fm of chain.matchAll(/\.(?:eq|in|is|ilike|not|gte|lte|gt|lt|order)\(\s*'([^']+)'\s*,/g)) {
        const path = fm[1];
        if (path.includes('.')) ref.columns.push(path);
        else ref.columns.push(path);
      }
      // .or('col.eq.x,...')
      for (const om of chain.matchAll(/\.or\(\s*'([^']+)'\s*(?:,|\))/g)) {
        for (const part of om[1].split(',')) {
          const sep = part.trim().indexOf('.');
          if (sep > 0) ref.columns.push(part.trim().slice(0, sep));
        }
      }
      // insert/update/upsert payload keys — top-level only: strip string
      // literals and template literals, then brace-count to depth 1.
      for (const pm of chain.matchAll(/\.(?:insert|update|upsert)\(\s*(\{)/g)) {
        const start = (pm.index ?? 0) + pm[0].length - 1;
        let depth = 0;
        let end = start;
        for (; end < chain.length; end++) {
          if (chain[end] === '{') depth++;
          else if (chain[end] === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        const raw = chain
          .slice(start, end + 1)
          .replace(/`[^`]*`/g, '')
          .replace(/'(?:[^'\\]|\\.)*'/g, '')
          .replace(/"(?:[^"\\]|\\.)*"/g, '');
        // depth-aware key extraction: only keys at depth 1 (top level)
        let d = 0;
        let i = 0;
        while (i < raw.length) {
          const ch = raw[i];
          if (ch === '{') d++;
          else if (ch === '}') d--;
          if (d === 1) {
            const km = /^[a-z_][a-z0-9_]*/.exec(raw.slice(i));
            if (km && /^\s*:/.test(raw.slice(i + km[0].length))) {
              ref.columns.push(km[0]);
              i += km[0].length;
            }
          }
          i++;
        }
      }
      // normalize duplicates
      const seen = new Set<string>();
      ref.columns = ref.columns.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
    }
  }

  walk(SRC_DIR);
  return refs;
}

export async function runSchemaContractTest(): Promise<boolean> {
  passed = 0;
  failed = 0;
  success = true;

  const { tables } = { tables: new Map<string, string[]>() };
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    const { tables: fileTables } = collectIdentifiers(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    for (const [name, cols] of fileTables) {
      const existing = tables.get(name) ?? [];
      const merged = new Set([...existing, ...cols]);
      tables.set(name, [...merged]);
    }
  }

  const refs = collectRefs();
  const tableNames = new Set(tables.keys());
  const missingTables = new Set<string>();
  for (const ref of refs) {
    if (!tableNames.has(ref.table)) {
      missingTables.add(ref.table);
    }
  }
  check(
    `every table referenced in server/src exists in the migration set (${refs.length} references, ${tableNames.size} tables)`,
    missingTables.size === 0,
    [...missingTables],
  );

  const columnViolations: string[] = [];
  for (const ref of refs) {
    for (const col of ref.columns) {
      // Dotted refs ('.eq('rel.col')', embedded select 'rel!inner(col)')
      // resolve against the relation table; plain refs against the query table.
      const [target, colName] = col.includes('.')
        ? [col.split('.')[0], col.split('.').slice(1).join('.')]
        : [ref.table, col];
      const definedCols = tables.get(target);
      if (!definedCols || !definedCols.includes(colName)) {
        columnViolations.push(`${ref.source}: ${col} (resolved as ${target}.${colName})`);
      }
    }
  }
  check(
    'every statically identifiable column reference resolves to a defined column',
    columnViolations.length === 0,
    columnViolations.slice(0, 20),
  );

  // Regression guard for the specific Phase 0 drift: worker writes into
  // execution_logs must match the aligned schema (migration 033).
  const workerCols = [
    'workspace_id',
    'step_execution_id',
    'target_system',
    'status',
    'input_payload',
    'output_payload',
    'error_message',
    'executed_at',
  ];
  const definedExecutionLogs = tables.get('execution_logs') ?? [];
  const missingWorkerCols = workerCols.filter((c) => !definedExecutionLogs.includes(c));
  check(
    'execution_logs exposes every column the ingestion/github workers write (033 alignment)',
    missingWorkerCols.length === 0,
    missingWorkerCols,
  );

  // New Phase 1 tables present.
  check('idempotency_keys table exists (034)', tableNames.has('idempotency_keys'));
  check('idempotency_keys columns resolve', (tables.get('idempotency_keys') ?? []).length >= 8);

  console.log(`\nSchema contract suite: ${passed} passed, ${failed} failed.`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSchemaContractTest().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
