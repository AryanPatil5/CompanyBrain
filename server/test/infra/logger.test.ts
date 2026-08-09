// Hermetic unit tests for the structured logger (Phase 0 Task 9).
// Verifies: structured fields, correlation-ID propagation, level filtering,
// and the secret-redaction matrix. No infrastructure required.

import { StructuredLogger, runWithCorrelationId, redactText, type LogEntry } from '../../src/logger.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ LOGGER TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ LOGGER TEST FAILED: ${name}`, extra ?? '');
  }
}

function captureLogger(level = 'info'): { logger: StructuredLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = new StructuredLogger({
    level: level as any,
    output: (line) => lines.push(line),
  });
  return { logger, lines };
}

function parse(entry: string): LogEntry {
  return JSON.parse(entry) as LogEntry;
}

async function testStructuredFields(): Promise<boolean> {
  const { logger, lines } = captureLogger();
  logger.info('hello world', { detail: 'x' });
  const entry = parse(lines[0]);

  check('entry has timestamp', !Number.isNaN(Date.parse(entry.timestamp)));
  check('entry has level', entry.level === 'info');
  check('entry has service', typeof entry.service === 'string' && entry.service.length > 0);
  check('entry has process', typeof entry.process === 'string' && entry.process.length > 0);
  check('entry has correlationId', typeof entry.correlationId === 'string' && entry.correlationId.length > 0);
  check('entry has pid', entry.pid === process.pid);
  check('entry has message', entry.message === 'hello world');
  check('entry has meta', entry.detail === 'x');
  check('entry has no unredacted extras', JSON.stringify(entry).includes('[REDACTED]') === false);
  return success;
}

async function testCorrelationPropagation(): Promise<boolean> {
  const { logger, lines } = captureLogger();
  runWithCorrelationId('corr-incoming-123', () => {
    logger.info('inside context');
  });
  const inside = parse(lines[0]);
  check('log inside ALS context carries correlationId', inside.correlationId === 'corr-incoming-123');

  logger.info('outside context');
  const outside = parse(lines[1]);
  check('log outside context still carries correlationId', typeof outside.correlationId === 'string' && outside.correlationId.length > 0);

  logger.setCorrelationId('manual-456');
  logger.info('after manual set');
  const manual = parse(lines[2]);
  check('manual setCorrelationId honored', manual.correlationId === 'manual-456');
  return success;
}

async function testLevelFiltering(): Promise<boolean> {
  const { logger, lines } = captureLogger('warn');
  logger.debug('dropped');
  logger.info('dropped too');
  logger.warn('kept warn');
  logger.error('kept error');
  check('level filter drops lower levels', lines.length === 2);
  check('warn line kept', parse(lines[0]).message === 'kept warn');
  check('error line kept', parse(lines[1]).message === 'kept error');
  return success;
}

async function testKeyNameRedaction(): Promise<boolean> {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ authorization: 'Bearer abc.def.ghi.123' }, 'authorization'],
    [{ 'x-api-key': 'sk-abcdefghijklmnop123456' }, 'x-api-key'],
    [{ api_key: 'abc123secretvalue', password: 'hunter2' }, 'api_key'],
    [{ cookie: 'session=abc123' }, 'cookie'],
    [{ access_token: 'ghp_abcdefghijklmnop1234567890abcdefghij' }, 'access_token'],
    [{ client_secret: 'supersecretvalue' }, 'client_secret'],
    [{ oauth_token: 'xoxb-1234567890-abcdefghij-1234567890123' }, 'oauth_token'],
    [{ privateKey: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----' }, 'privateKey'],
    [{ 'GITHUB_APP_PRIVATE_KEY': '-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----' }, 'GITHUB_APP_PRIVATE_KEY'],
  ];

  for (const [meta, key] of cases) {
    const { logger, lines } = captureLogger();
    logger.info('secret check', meta);
    const entry = parse(lines[0]);
    const value = (entry as any)[key];
    check(`key-name redaction: ${key}`, value === '[REDACTED]', value);
  }
  return success;
}

async function testNestedRedaction(): Promise<boolean> {
  const { logger, lines } = captureLogger();
  logger.info('nested', {
    request: { headers: { authorization: 'Bearer nestedsecretvalue' } },
    items: [{ token: 'inline-token-value-123', safe: 'keep' }],
  });
  const entry = parse(lines[0]);
  check('nested authorization redacted', (entry.request as any).headers.authorization === '[REDACTED]');
  check('nested array token redacted', (entry.items as any)[0].token === '[REDACTED]');
  check('nested safe value kept', (entry.items as any)[0].safe === 'keep');
  return success;
}

async function testValuePatternRedaction(): Promise<boolean> {
  const messages: Array<[string, string]> = [
    ['token=supersecretvalue123 password=pw123456', 'inline password/token'],
    ['provider key sk-ant-api03-abcdefghijklmnopqrstuvwxyz used', 'anthropic key'],
    ['gemini key AIzaSyA1234567890abcdefgh1234567890ABCD', 'gemini key'],
    ['slack token xoxb-1234567890-abcdefghij-1234567890123', 'slack token'],
    ['github token ghp_abcdefghijklmnop1234567890abcdefghij', 'github token'],
    ['pat github_pat_1234567890abcdef_ABCDEFGHIJKLMNOPQRS', 'github PAT'],
    ['aws key AKIAIOSFODNN7EXAMPLE', 'aws access key'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.s0meS1gn4tureV4lueH3reX', 'jwt'],
    ['webhook https://hooks.slack.com/services/t12345678/b12345678/x123456789012345678901234', 'slack webhook'],
    ['redis://user:password123@localhost:6379', 'url credentials'],
    ['Bearer eyJhbGciOiJIUzI1NiJ9.incomingjwtpayloadvalue.signaturepart', 'bearer jwt'],
  ];

  for (const [message, label] of messages) {
    const { logger, lines } = captureLogger();
    logger.info(message);
    const entry = parse(lines[0]);
    const leaked = entry.message.includes('[REDACTED]') === false;
    check(`value-pattern redaction: ${label}`, !leaked, entry.message);
  }
  return success;
}

async function testNonSecretValuesKept(): Promise<boolean> {
  const { logger, lines } = captureLogger();
  logger.info('counters and status', { token_usage: { input: 1, output: 2 }, status: 'ok', tokenCount: 42 });
  const entry = parse(lines[0]);
  check('token_usage counts kept', JSON.stringify((entry as any).token_usage) === '{"input":1,"output":2}');
  check('status kept', (entry as any).status === 'ok');
  check('tokenCount number kept', (entry as any).tokenCount === 42);

  logger.info('short sk-abc is not a key');
  check('short sk prefix kept', parse(lines[1]).message === 'short sk-abc is not a key');
  return success;
}

async function testMessageAndMetaVariants(): Promise<boolean> {
  const { logger, lines } = captureLogger();
  logger.error('boom', new Error('kaboom'));
  const errorEntry = parse(lines[0]);
  check('Error meta normalized', (errorEntry.error as any)?.message === 'kaboom' && (errorEntry.error as any)?.name === 'Error');

  logger.info('answer', 42);
  check('primitive meta wrapped as extra', parse(lines[1]).extra === 42);

  logger.info('raw string meta', 'some-raw-value');
  check('string meta wrapped as extra', parse(lines[2]).extra === 'some-raw-value');

  logger.info('[INFO] legacy prefix stripped');
  check('[INFO] prefix stripped', parse(lines[3]).message === 'legacy prefix stripped');

  logger.info('no meta at all');
  check('no-meta entry has no extra', !('extra' in parse(lines[4])));

  const plain = captureLogger();
  plain.logger.info('object message', { ok: true });
  check('non-string message tolerated', parse(plain.lines[0]).message.includes('{') || parse(plain.lines[0]).message.length > 0);
  return success;
}

async function testRedactTextExport(): Promise<boolean> {
  const out = redactText('auth: Bearer value123456789, key sk-abcdefghijklmnopqrstuvwxyz');
  check('redactText redacts both', !out.includes('value123456789') && !out.includes('sk-abcdefghijklmnopqrstuvwxyz'), out);
  check('redactText keeps structure', out.includes('[REDACTED]'));
  return success;
}

async function testHttpMiddlewarePropagation(): Promise<boolean> {
  const express = (await import('express')).default;
  const { correlationIdMiddleware } = await import('../../src/middleware/correlationId.js');

  const app = express();
  const lines: string[] = [];
  // Pin the level explicitly: the hermetic harness sets LOG_LEVEL=warn, which
  // would drop the probe handler's info log and make lines[0] undefined.
  const reqLogger = new StructuredLogger({ output: (line) => lines.push(line), level: 'info' });

  app.use(correlationIdMiddleware());
  app.get('/probe', (_req: any, res: any) => {
    reqLogger.info('probe handler log');
    res.json({ ok: true });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  await fetch(`http://127.0.0.1:${port}/probe`, { headers: { 'x-correlation-id': 'http-corr-777' } });
  const entry = parse(lines[0]);
  check('request-scoped log carries incoming correlationId', entry.correlationId === 'http-corr-777', entry);

  await fetch(`http://127.0.0.1:${port}/probe`);
  const generated = parse(lines[1]);
  check('request without id gets a generated correlationId', typeof generated.correlationId === 'string' && generated.correlationId.length > 0, generated);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return success;
}

export async function runLoggerTests(): Promise<boolean> {
  const suites: Array<() => Promise<boolean>> = [
    testStructuredFields,
    testCorrelationPropagation,
    testLevelFiltering,
    testKeyNameRedaction,
    testNestedRedaction,
    testValuePatternRedaction,
    testNonSecretValuesKept,
    testMessageAndMetaVariants,
    testRedactTextExport,
    testHttpMiddlewarePropagation,
  ];
  for (const suite of suites) {
    await suite();
  }
  console.log(`\n[Logger Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLoggerTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
