// Unit tests: GitHub document mapper — path filtering, README detection,
// and document payload fields (the persisted-metadata contract).

import {
  isIgnoredPath,
  isReadmePath,
  documentTypeFromPath,
  splitFullName,
  mapRepoFile,
  mapIssueLike,
  mapWikiPage,
  type GithubDocumentPayload,
} from '../../../src/connectors/github/mapper.js';

const REQUIRED_FIELDS: Array<keyof GithubDocumentPayload> = [
  'workspaceId',
  'repositoryId',
  'repositoryName',
  'branch',
  'commit',
  'author',
  'url',
  'createdAt',
  'updatedAt',
  'permissions',
  'source',
];

async function runMapperTest(): Promise<boolean> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean): void => {
    if (ok) {
      passed++;
      console.log(`  ✅ ${name}`);
    } else {
      failed++;
      console.log(`  ❌ ${name}`);
    }
  };

  // ─── 1. Ignored paths ───
  const ignored = [
    'node_modules/lodash/index.js',
    'dist/main.js',
    'build/app.js',
    'vendor/lib/utils.js',
    '.git/config',
    'src/assets/logo.png',
    'docs/screenshot.jpg',
    'media/video.mp4',
    'archives/backup.zip',
    'package-lock.json',
    'yarn.lock',
    'bin/tool',
    'public/vendor/legacy.js',
  ];
  check('ignored paths are rejected', ignored.every((p) => isIgnoredPath(p) === true));

  // ─── 2. Indexable paths ───
  const indexable = [
    'src/index.ts',
    'lib/core/parser.go',
    'README.md',
    'docs/architecture.adoc',
    'Makefile',
    'Dockerfile',
    'scripts/deploy.sh',
    'config/settings.yaml',
    'package.json',
    'src/data.csv',
    'LICENSE',
  ];
  check('indexable paths are accepted', indexable.every((p) => isIgnoredPath(p) === false));

  // ─── 3. README detection ───
  check('README.md detected', isReadmePath('README.md') === true);
  check('readme detected (lowercase)', isReadmePath('readme') === true);
  check('README.rst detected', isReadmePath('README.rst') === true);
  check('src/index.ts is not README', isReadmePath('src/index.ts') === false);

  // ─── 4. Document type from path ───
  check('README maps to readme type', documentTypeFromPath('README.md') === 'readme');
  check('code file maps to file type', documentTypeFromPath('src/main.py') === 'file');

  // ─── 5. fullName split ───
  const parts = splitFullName('acme/platform-core');
  check('fullName splits into owner/name', parts.owner === 'acme' && parts.name === 'platform-core');

  // ─── 6. File document carries the full metadata contract ───
  const doc = mapRepoFile({
    workspaceId: 'ws-1',
    repoId: 777,
    fullName: 'acme/platform-core',
    branch: 'main',
    commit: 'abc123',
    commitDate: '2026-01-15T10:00:00Z',
    path: 'src/services/ingest.ts',
    sha: 'blobsha1',
    content: 'export const x = 1;',
    url: 'https://github.com/acme/platform-core/blob/main/src/services/ingest.ts',
    permissions: { admin: true, push: true, pull: true },
  });
  check('file doc has all required fields', REQUIRED_FIELDS.every((f) => doc[f] !== undefined && doc[f] !== ''));
  check('file doc source is github', doc.source === 'github');
  check('file doc type is file', doc.type === 'file');
  check('file doc repositoryId is the numeric repo id', doc.repositoryId === '777');
  check('file doc repositoryName is full name', doc.repositoryName === 'acme/platform-core');
  check('file doc externalId is scoped', doc.externalId === 'acme/platform-core/file/src/services/ingest.ts');

  // ─── 7. Issue-like documents ───
  const issue = mapIssueLike({
    workspaceId: 'ws-1',
    repoId: 777,
    fullName: 'acme/platform-core',
    branch: 'main',
    commit: 'abc123',
    kind: 'issue',
    numberOrTag: 42,
    title: 'Bug: ingestion stalls',
    body: 'Repro steps here.',
    url: 'https://github.com/acme/platform-core/issues/42',
    author: 'alice',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    permissions: { pull: true },
  });
  check('issue doc has all required fields', REQUIRED_FIELDS.every((f) => issue[f] !== undefined && issue[f] !== ''));
  check('issue doc type is issue', issue.type === 'issue');
  check('issue doc externalId is scoped', issue.externalId === 'acme/platform-core/issue/42');

  // ─── 8. Wiki documents ───
  const wiki = mapWikiPage({
    workspaceId: 'ws-1',
    repoId: 777,
    fullName: 'acme/platform-core',
    branch: 'main',
    commit: 'abc123',
    commitDate: '2026-01-15T10:00:00Z',
    path: 'Getting-Started.md',
    content: '# Getting started',
    permissions: { pull: true },
  });
  check('wiki doc has all required fields', REQUIRED_FIELDS.every((f) => wiki[f] !== undefined && wiki[f] !== ''));
  check('wiki doc type is wiki', wiki.type === 'wiki');
  check('wiki doc url is the wiki page url', wiki.url === 'https://github.com/acme/platform-core/wiki/Getting-Started');

  console.log(`\nMapper tests: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMapperTest().then((ok) => process.exit(ok ? 0 : 1));
}

export { runMapperTest };
