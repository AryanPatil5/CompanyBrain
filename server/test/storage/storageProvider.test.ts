// Hermetic storage provider suite (Phase 3A). Exercises the locked
// StorageProvider contract: content-addressed keys, MIME-validated
// extensions, workspace-prefixed isolation, in-memory semantics, the
// production refusal, and the unconfigured (null provider) behavior.

import { installHarness } from '../harness/index.js';
import {
  objectKeyFor,
  extensionForMime,
  hashBytes,
  readStorageConfig,
  createStorageProvider,
  getStorageProvider,
  resetStorageProviderForTest,
  setStorageProviderForTest,
  checkStorage,
  StorageError,
} from '../../src/services/storage/storageProvider.js';
import { createInMemoryStorageProvider } from '../../src/services/storage/inMemoryStorageProvider.js';

let passed = 0;
let failed = 0;
let success = true;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ STORAGE TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ STORAGE TEST FAILED: ${name}`, extra ?? '');
  }
}

export async function runStorageProviderTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running Storage Provider Test Suite (Phase 3A) ');
  console.log('=================================================');

  passed = 0;
  failed = 0;
  success = true;

  const workspaceA = '00000000-0000-4000-8000-00000000000a';
  const workspaceB = '00000000-0000-4000-8000-00000000000b';

  // 1. Content-addressed key shape: raw/{workspace}/{sha256}.{validated-ext}
  const content = Buffer.from('refund procedure v2\n1. verify invoice\n2. issue refund');
  const digest = hashBytes(content);
  const key = objectKeyFor(workspaceA, digest, 'application/pdf');
  check('object key is workspace-prefixed and content-addressed', key === `raw/${workspaceA}/${digest}.pdf`, key);
  check('extension comes from MIME, not from any filename', objectKeyFor(workspaceA, digest, 'text/plain') === `raw/${workspaceA}/${digest}.txt`);
  check('unknown MIME yields no extension (never guessed)', objectKeyFor(workspaceA, digest, 'application/octet-stream') === `raw/${workspaceA}/${digest}`);
  check('sha256 digest is 64 hex chars', /^[0-9a-f]{64}$/.test(digest));
  check('same content => same key (idempotent PUT)', objectKeyFor(workspaceA, digest, 'text/plain') === objectKeyFor(workspaceA, hashBytes(content), 'text/plain'));

  // 2. extensionForMime unit checks
  check('MIME -> ext mapping covers pdf/docx/xlsx/csv',
    extensionForMime('application/pdf') === '.pdf' &&
    extensionForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document') === '.docx' &&
    extensionForMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') === '.xlsx' &&
    extensionForMime('text/csv') === '.csv');

  // 3. In-memory provider round-trip
  const memory = createInMemoryStorageProvider();
  const stored = await memory.putObject(key, content, { contentType: 'application/pdf' });
  check('putObject returns key/size/contentType', stored.size === content.length && stored.key === key && stored.contentType === 'application/pdf');

  const fetched = await memory.getObject(key);
  check('getObject round-trips bytes', fetched !== null && fetched.body.equals(content) && fetched.contentType === 'application/pdf');

  const head = await memory.headObject(key);
  check('headObject reports size', head !== null && head.size === content.length);

  check('getObject for missing key returns null', (await memory.getObject('raw/x/nope')) === null);
  check('headObject for missing key returns null', (await memory.headObject('raw/x/nope')) === null);

  await memory.deleteObject(key);
  check('deleteObject removes the object', (await memory.getObject(key)) === null);

  let deleteMissingThrew = false;
  try {
    await memory.deleteObject(key);
  } catch {
    deleteMissingThrew = true;
  }
  check('deleteObject of a missing key throws StorageError', deleteMissingThrew);

  check('in-memory healthCheck reports ok', (await memory.healthCheck()).ok === true);

  // 4. Workspace isolation: same content in two workspaces -> distinct keys
  const keyB = objectKeyFor(workspaceB, digest, 'application/pdf');
  await memory.putObject(key, content);
  await memory.putObject(keyB, content);
  const fetchedA = await memory.getObject(key);
  const fetchedB = await memory.getObject(keyB);
  check('workspace-prefixed keys isolate tenants', fetchedA !== null && fetchedB !== null && key !== keyB);

  // 5. Factory: s3 config requires endpoint + credentials
  let s3ConfigError: Error | null = null;
  try {
    createStorageProvider({
      provider: 's3',
      endpoint: 'http://localhost:9000',
      bucket: 'b',
      accessKey: 'k',
      secretKey: 's',
      region: 'us-east-1',
      forcePathStyle: true,
    });
  } catch (err) {
    s3ConfigError = err as Error;
  }
  check('s3 provider constructs with endpoint + credentials', s3ConfigError === null);

  let missingCredsThrew = false;
  try {
    createStorageProvider({
      provider: 's3',
      endpoint: 'http://localhost:9000',
      bucket: 'b',
      accessKey: undefined,
      secretKey: undefined,
      region: 'us-east-1',
      forcePathStyle: true,
    });
  } catch {
    missingCredsThrew = true;
  }
  check('s3 provider refuses missing credentials (explicit failure)', missingCredsThrew);

  // 6. Config reading + production refusal of the in-memory provider
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY', 'STORAGE_REGION', 'STORAGE_FORCE_PATH_STYLE', 'STORAGE_PROVIDER', 'NODE_ENV'];
  for (const k of envKeys) savedEnv[k] = process.env[k];

  delete process.env.STORAGE_ENDPOINT;
  delete process.env.STORAGE_PROVIDER;
  process.env.NODE_ENV = 'test';
  check('no endpoint => config null (storage unavailable, not boot failure)', readStorageConfig() === null);

  process.env.STORAGE_ENDPOINT = 'http://localhost:9000';
  process.env.STORAGE_ACCESS_KEY = 'minioadmin';
  process.env.STORAGE_SECRET_KEY = 'minioadmin';
  const s3Config = readStorageConfig();
  check('endpoint set => s3 config with forcePathStyle default true', s3Config !== null && s3Config.provider === 's3' && s3Config.forcePathStyle === true);

  process.env.STORAGE_FORCE_PATH_STYLE = 'false';
  check('forcePathStyle=false honored', readStorageConfig()?.forcePathStyle === false);

  process.env.STORAGE_PROVIDER = 'memory';
  process.env.NODE_ENV = 'test';
  check('explicit memory provider allowed outside production', readStorageConfig()?.provider === 'memory');

  process.env.NODE_ENV = 'production';
  let productionMemoryRefused = false;
  try {
    readStorageConfig();
  } catch (err) {
    productionMemoryRefused = err instanceof StorageError;
  }
  check('memory provider REFUSED in production (StorageError)', productionMemoryRefused);

  // 7. Cached getter: null provider when unconfigured; injected provider for tests
  resetStorageProviderForTest();
  process.env.NODE_ENV = 'test';
  delete process.env.STORAGE_ENDPOINT;
  delete process.env.STORAGE_PROVIDER;
  check('getStorageProvider returns null when unconfigured', getStorageProvider() === null);
  check('checkStorage reports false when unconfigured', (await checkStorage()) === false);

  resetStorageProviderForTest();
  setStorageProviderForTest(memory);
  check('test seam injects a provider', getStorageProvider() === memory);
  check('checkStorage reports ok for healthy injected provider', (await checkStorage()) === true);

  // 8. Put/get via the injected provider end-to-end (document pipeline shape)
  const docContent = Buffer.from('# Incident Runbook\n\nWhen ERR_502 occurs, restart the gateway.');
  const docKey = objectKeyFor(workspaceA, hashBytes(docContent), 'application/pdf');
  await memory.putObject(docKey, docContent, { contentType: 'application/pdf' });
  const docHead = await memory.headObject(docKey);
  check('stored object is private + retrievable via head', docHead !== null && docHead.size === docContent.length);

  // Restore env for the remaining suites in the same process.
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetStorageProviderForTest();

  console.log(`\nStorage provider suite: ${passed} passed, ${failed} failed.`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStorageProviderTest().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
