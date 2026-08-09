// Migration discovery, ordering, and checksum helpers for the migration
// runner (ADR-T1). Pure logic — no database access — so the ordering and
// duplicate-number guards are unit-testable without infrastructure.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationFile {
  /** File name on disk, e.g. '029_foundation_hardening.sql'. Also the ledger version key. */
  filename: string;
  /** Numeric prefix for numbered files; null for base (create_*) files. */
  version: string | null;
  /** sha256 hex digest of the raw file content. */
  checksum: string;
  sql: string;
}

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'supabase',
);

const NUMBERED_PREFIX = /^(\d+)_/;

// Base schema files predate the numbered set and are applied first, in the
// dependency order the original manual Supabase workflow used
// (create_skills_sops must precede create_raw_threads_and_citations, which
// references it).
const BASE_ORDER = [
  'create_skills_sops.sql',
  'create_raw_threads_and_citations.sql',
];

export function computeChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** Extracts the numeric prefix ('029') from a migration filename, or null for base files. */
export function migrationVersionOf(filename: string): string | null {
  const match = NUMBERED_PREFIX.exec(filename);
  return match ? match[1] : null;
}

/**
 * Lists every SQL file in the migrations directory in apply order:
 * base (create_*) files first in BASE_ORDER, then numbered files sorted by
 * their numeric prefix (ties broken by filename so duplicate numbers are
 * adjacent and detectable).
 */
export function discoverMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const numbered: MigrationFile[] = [];
  const base: MigrationFile[] = [];

  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith('.sql')) continue;
    const sql = readFileSync(join(dir, filename), 'utf8');
    const file: MigrationFile = {
      filename,
      version: migrationVersionOf(filename),
      checksum: computeChecksum(sql),
      sql,
    };
    if (file.version === null) base.push(file);
    else numbered.push(file);
  }

  base.sort((a, b) => {
    const ia = BASE_ORDER.indexOf(a.filename);
    const ib = BASE_ORDER.indexOf(b.filename);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.filename.localeCompare(b.filename);
  });

  numbered.sort((a, b) => {
    const na = Number(a.version);
    const nb = Number(b.version);
    return na - nb || a.filename.localeCompare(b.filename);
  });

  return [...base, ...numbered];
}

/**
 * Fails loudly when two files share a numeric prefix (e.g. the historical
 * 030_github_connector + 030_retire_apache_age collision). Duplicate numbers
 * make ordering ambiguous, so the runner refuses to proceed until they are
 * resolved by renumbering.
 */
export function assertNoDuplicateVersions(files: MigrationFile[]): void {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const file of files) {
    if (file.version === null) continue;
    const prior = seen.get(file.version);
    if (prior) {
      duplicates.push(`${file.version}: ${prior} and ${file.filename} share a numeric version`);
    } else {
      seen.set(file.version, file.filename);
    }
  }
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate migration version(s) detected — renumber before migrating:\n  ${duplicates.join('\n  ')}`,
    );
  }
}
