// Migration runner (ADR-T1): applies server/supabase/*.sql in filename order
// against a Postgres DSN, tracking applied state in `schema_migrations`
// (version text pk, applied_at timestamptz, checksum text) so re-runs are
// no-ops. Each migration file runs in its own transaction; checksum-differing
// re-applies are refused; duplicate version numbers are rejected before any
// SQL runs.
//
// CLIs:
//   npm run migrate             apply pending migrations (default)
//   npm run migrate:status      print applied/pending state
//   npm run migrate:rollback    drop the ledger row for the last-applied
//                               migration (re-applies on next migrate; SQL is
//                               NOT reversed — migrations are additive)
//
// DATABASE_URL defaults to the local docker-compose Postgres.

import pg from 'pg';
import { pathToFileURL } from 'node:url';
import {
  assertNoDuplicateVersions,
  discoverMigrations,
  type MigrationFile,
} from './migrations.js';

const DEFAULT_DATABASE_URL =
  'postgresql://brain_user:brain_password@localhost:5432/company_brain';

interface MigrationRecord {
  version: string;
  appliedAt: string;
  checksum: string | null;
}

function databaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  return client;
}

/**
 * Creates the ledger with the ratified contract
 * (schema_migrations(version pk, applied_at, checksum)) and adopts a legacy
 * ledger created by the Phase 0 runner, which used a `filename` primary key.
 * Legacy rows keep their values (version = filename) and get NULL checksums,
 * backfilled by the runner on the next run.
 */
async function ensureLedger(client: pg.Client): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now(),
      checksum text
    )
  `);

  const { rows } = await client.query<{ column_name: string }>(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'schema_migrations'
  `);
  const columns = new Set(rows.map((r) => r.column_name));

  if (columns.has('filename') && !columns.has('version')) {
    console.log('[migrate] Adopting legacy schema_migrations ledger (filename -> version)');
    await client.query('alter table schema_migrations rename column filename to version');
    await client.query('alter table schema_migrations add column if not exists checksum text');
  }
}

/**
 * Local/dev Postgres (the docker-compose pgvector image) has no Supabase
 * runtime, but several migrations reference `auth.users`, `auth.uid()`, and
 * Supabase's standard roles (`supabase_auth_admin`, `authenticated`, `anon`).
 * Create minimal stand-ins only when absent, so the same migration set applies
 * to a Supabase project (everything already exists — all no-ops) and to
 * vanilla Postgres.
 */
async function ensureSupabaseCompatibility(client: pg.Client): Promise<void> {
  await client.query('create schema if not exists auth');
  await client.query('create table if not exists auth.users (id uuid primary key)');
  for (const role of ['supabase_auth_admin', 'authenticated', 'anon', 'service_role']) {
    await client.query(
      `
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${role}') then
          create role "${role}" nologin;
        end if;
      end $$
      `,
    );
  }
  await client.query(`
    do $$ begin
      if not exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'auth' and p.proname = 'uid'
      ) then
        create function auth.uid() returns uuid language sql stable as 'select null::uuid';
      end if;
    end $$
  `);
}

async function loadApplied(client: pg.Client): Promise<Map<string, MigrationRecord>> {
  const { rows } = await client.query<MigrationRecord>(`
    select version, applied_at as "appliedAt", checksum
    from schema_migrations
  `);
  return new Map(rows.map((r) => [r.version, r]));
}

/**
 * Applies every pending migration in order. Returns { applied, skipped, adopted }
 * where `adopted` counts previously-applied rows that were missing a checksum
 * (legacy ledger) and were backfilled.
 */
export async function runMigrations(
  client: pg.Client,
  files: MigrationFile[],
): Promise<{ applied: number; skipped: number; adopted: number }> {
  const applied = await loadApplied(client);
  let appliedCount = 0;
  let skippedCount = 0;
  let adoptedCount = 0;

  for (const file of files) {
    const record = applied.get(file.filename);
    if (record) {
      if (record.checksum === null) {
        await client.query(
          'update schema_migrations set checksum = $1 where version = $2',
          [file.checksum, file.filename],
        );
        adoptedCount += 1;
        console.log(`[migrate] ADOPTED (backfilled checksum): ${file.filename}`);
      } else if (record.checksum !== file.checksum) {
        throw new Error(
          `Checksum mismatch for already-applied migration ${file.filename}: ` +
            `file content changed since it was applied (recorded ${record.checksum}, file ${file.checksum}). ` +
            `Migrations are additive (ADR-T1) — never edit an applied file; author a new numbered migration.`,
        );
      } else {
        console.log(`[migrate] SKIP (already applied): ${file.filename}`);
        skippedCount += 1;
      }
      continue;
    }

    await client.query('begin');
    try {
      await client.query(file.sql);
      await client.query(
        'insert into schema_migrations (version, applied_at, checksum) values ($1, now(), $2)',
        [file.filename, file.checksum],
      );
      await client.query('commit');
      console.log(`[migrate] APPLIED: ${file.filename}`);
      appliedCount += 1;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw new Error(`Migration failed: ${file.filename}\n${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }

  return { applied: appliedCount, skipped: skippedCount, adopted: adoptedCount };
}

export async function printMigrationStatus(client: pg.Client, files: MigrationFile[]): Promise<void> {
  const applied = await loadApplied(client);
  const onDisk = new Set(files.map((f) => f.filename));
  const pending = files.filter((f) => !applied.has(f.filename));

  console.log('\n[migrate] Applied migrations:');
  let appliedSeen = 0;
  for (const file of files) {
    const record = applied.get(file.filename);
    if (!record) continue;
    appliedSeen += 1;
    const checksum = record.checksum ? record.checksum.slice(0, 12) : '(legacy, no checksum)';
    console.log(`  [applied ] ${file.filename}  (${record.appliedAt}, sha256:${checksum})`);
  }
  for (const record of applied.values()) {
    if (!onDisk.has(record.version)) {
      console.log(`  [orphaned] ${record.version}  (file no longer on disk)`);
    }
  }
  if (appliedSeen === 0) console.log('  (none)');

  console.log('\n[migrate] Pending migrations:');
  if (pending.length === 0) {
    console.log('  (none — schema is up to date)');
  } else {
    for (const file of pending) {
      console.log(`  [pending ] ${file.filename}  (sha256:${file.checksum.slice(0, 12)})`);
    }
  }
  console.log(
    `\n[migrate] Status: ${appliedSeen} applied, ${pending.length} pending, ${files.length} on disk.`,
  );
}

/**
 * Deletes the ledger row of the most recently applied migration. SQL is NOT
 * reversed — next `npm run migrate` re-applies it. Exists for recovering from
 * a bad apply without hand-editing the ledger.
 */
export async function rollbackLastMigration(client: pg.Client): Promise<void> {
  const { rows } = await client.query<MigrationRecord>(`
    select version, applied_at as "appliedAt", checksum
    from schema_migrations
    order by applied_at desc
    limit 1
  `);
  const last = rows[0];
  if (!last) {
    console.log('[migrate] Nothing to roll back — no applied migrations.');
    return;
  }
  await client.query('delete from schema_migrations where version = $1', [last.version]);
  console.log(
    `[migrate] Rolled back ledger row for ${last.version} (applied ${last.appliedAt}). ` +
      `The migration's SQL was NOT reversed (additive policy, ADR-T1); ` +
      `the next migrate run will re-apply it.`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'migrate';
  const files = discoverMigrations();
  assertNoDuplicateVersions(files);

  const client = await connect();
  try {
    console.log(`[migrate] Connected to ${new URL(databaseUrl()).host} (${files.length} migrations on disk)`);
    await ensureLedger(client);
    await ensureSupabaseCompatibility(client);

    switch (command) {
      case 'migrate': {
        const { applied, skipped, adopted } = await runMigrations(client, files);
        console.log(
          `[migrate] Done: ${applied} applied, ${skipped} already applied, ${adopted} legacy checksums backfilled.`,
        );
        break;
      }
      case 'status': {
        await printMigrationStatus(client, files);
        break;
      }
      case 'rollback-last': {
        await rollbackLastMigration(client);
        break;
      }
      default: {
        console.error(`[migrate] Unknown command "${command}" (expected: migrate | status | rollback-last)`);
        process.exitCode = 2;
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[migrate] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
