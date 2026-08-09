// Hermetic unit tests for the migration discovery/ordering/checksum logic
// (Phase 1 Task 2). No database access — verifies the ordering contract that
// guarantees a clean database can be migrated from zero to latest in one run.

import {
  assertNoDuplicateVersions,
  computeChecksum,
  discoverMigrations,
  migrationVersionOf,
  type MigrationFile,
} from '../../src/db/migrations.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ MIGRATIONS TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ MIGRATIONS TEST FAILED: ${name}`, extra ?? '');
  }
}

const files = discoverMigrations();

check('discovers migrations', files.length >= 25, { count: files.length });

const baseFiles = files.filter((f) => f.version === null);
check('base files come first', baseFiles.length === 2, baseFiles.map((f) => f.filename));

check(
  'create_skills_sops precedes create_raw_threads_and_citations',
  baseFiles[0]?.filename === 'create_skills_sops.sql' &&
    baseFiles[1]?.filename === 'create_raw_threads_and_citations.sql',
  baseFiles.map((f) => f.filename),
);

const numbered = files.filter((f) => f.version !== null);
const prefixes = numbered.map((f) => Number(f.version));
check(
  'numbered migrations are strictly ascending',
  prefixes.every((n, i) => i === 0 || n > prefixes[i - 1]!),
  prefixes,
);

check(
  'migration set starts at 003 (base files precede the numbered set)',
  prefixes[0] === 3,
  prefixes.slice(0, 3),
);

check(
  'no duplicate numeric versions in the current set',
  new Set(prefixes).size === prefixes.length,
  prefixes.filter((n, i) => prefixes.indexOf(n) !== i),
);

check(
  '029 renumbered tail is unambiguous (030_github, 031, 032)',
  ['030_github_connector.sql', '031_usage_meters_detail.sql', '032_retire_apache_age.sql'].every((f) =>
    files.some((m) => m.filename === f),
  ),
);

check('028 band-aid migration removed', !files.some((f) => f.filename === '028_fix_migration_order.sql'));

check('every migration has a checksum', files.every((f) => /^[0-9a-f]{64}$/.test(f.checksum)));

check(
  'checksum is deterministic and content-sensitive',
  computeChecksum('a') === computeChecksum('a') && computeChecksum('a') !== computeChecksum('b'),
);

check(
  'migrationVersionOf parses numbered prefixes',
  migrationVersionOf('029_foundation_hardening.sql') === '029' &&
    migrationVersionOf('create_skills_sops.sql') === null,
);

const duplicateFixture: MigrationFile[] = [
  { filename: '030_github_connector.sql', version: '030', checksum: 'a', sql: '' },
  { filename: '030_retire_apache_age.sql', version: '030', checksum: 'b', sql: '' },
];
let duplicateCaught = false;
try {
  assertNoDuplicateVersions(duplicateFixture);
} catch {
  duplicateCaught = true;
}
check('duplicate version numbers are refused', duplicateCaught);

const uniqueFixture: MigrationFile[] = [
  { filename: '030_github_connector.sql', version: '030', checksum: 'a', sql: '' },
  { filename: '031_usage_meters_detail.sql', version: '031', checksum: 'b', sql: '' },
];
let uniqueAccepted = false;
try {
  assertNoDuplicateVersions(uniqueFixture);
  uniqueAccepted = true;
} catch {
  uniqueAccepted = false;
}
check('unique version numbers pass', uniqueAccepted);

console.log(`\nMIGRATIONS TEST SUMMARY: ${passed} passed, ${failed} failed`);
if (!success) process.exit(1);
