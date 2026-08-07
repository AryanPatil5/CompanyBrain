// Phase 0 Task 11: ordered, idempotent SQL migration runner.
// Applies server/supabase/*.sql in filename order against a Postgres DSN
// (Supabase direct/pooler connection or local dev Postgres) and tracks applied
// state in a `schema_migrations` table so re-runs are no-ops.
//
// Usage: DATABASE_URL=postgresql://... npm run migrate
// (defaults to the local docker-compose Postgres from docker-compose.yml)
//
// Phase 1 (MASTER_ROADMAP.md) extends this into the full migration pipeline:
// transactions-per-file, repair policy, rollback-last, status CLI, and
// migrations-on-ephemeral-Postgres CI. The runner here already fails loudly
// with the exact file name when a migration cannot be applied.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://brain_user:brain_password@localhost:5432/company_brain';

async function main() {
  const allFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  // Base schema files (create_*.sql) predate the numbered set and are applied
  // first, in the dependency order the manual Supabase workflow uses
  // (create_skills_sops must precede create_raw_threads which references it).
  const BASE_ORDER = ['create_skills_sops.sql', 'create_raw_threads_and_citations.sql'];
  const baseFiles = allFiles
    .filter((f) => !/^\d+_/.test(f))
    .sort((a, b) => {
      const ia = BASE_ORDER.indexOf(a);
      const ib = BASE_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
  const numberedFiles = allFiles
    .filter((f) => /^\d+_/.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const files = [...baseFiles, ...numberedFiles];

  if (files.length === 0) {
    console.error(`[migrate] No migration files found in ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    console.log(`[migrate] Connected (database: ${client.database ?? 'unknown'})`);

    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const { rows } = await client.query('select filename from schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    let appliedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] SKIP (already applied): ${file}`);
        skippedCount++;
        continue;
      }

      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

      // Dedicated connection per migration: a failed statement aborts the
      // connection state, so each file runs in its own transaction.
      const tx = new pg.Client({ connectionString: DATABASE_URL });
      try {
        await tx.connect();
        await tx.query('begin');
        await tx.query(sql);
        await tx.query('insert into schema_migrations (filename) values ($1)', [file]);
        await tx.query('commit');
        console.log(`[migrate] APPLIED: ${file}`);
        appliedCount++;
      } catch (err) {
        await tx.query('rollback').catch(() => {});
        throw new Error(`Migration failed: ${file}\n${err.message}`, { cause: err });
      } finally {
        await tx.end().catch(() => {});
      }
    }

    console.log(
      `[migrate] Done: ${appliedCount} applied, ${skippedCount} already applied, ${files.length} total.`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[migrate] FATAL: ${err.message}`);
  process.exit(1);
});
