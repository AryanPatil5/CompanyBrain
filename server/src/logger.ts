// Structured JSON logger for Phase 0 (ADR-T8 scaffold).
// - Every entry: timestamp, level, service, process, correlationId, pid.
// - Correlation IDs propagate through AsyncLocalStorage context (set by the
//   correlation-id middleware); a default ID is generated when absent.
// - Secrets are redacted by key name and by value pattern (Bearer tokens,
//   API keys, passwords, cookies, OAuth tokens, provider keys, Slack/GitHub
//   tokens, JWTs, AWS keys, PEM blocks). No secret may ever reach stdout.
// - Writes raw JSON to stdout (never console.*), filtered by LOG_LEVEL.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  process: string;
  correlationId: string;
  pid: number;
  message: string;
  [key: string]: unknown;
}

interface LogContext {
  correlationId?: string;
  workspaceId?: string;
  userId?: string;
  agentId?: string;
}

export interface LoggerOptions {
  level?: LogLevel;
  output?: (line: string) => void;
  service?: string;
  process?: string;
}

interface Logger {
  trace(message: unknown, meta?: unknown): void;
  debug(message: unknown, meta?: unknown): void;
  info(message: unknown, meta?: unknown): void;
  warn(message: unknown, meta?: unknown): void;
  error(message: unknown, meta?: unknown): void;
  fatal(message: unknown, meta?: unknown): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'company-brain-server';
const PROCESS_NAMES = process.env.PROCESSES || 'default';

const asyncStore = new AsyncLocalStorage<LogContext>();

export function runWithCorrelationId<T>(
  correlationId: string,
  fn: () => T,
  context?: Omit<LogContext, 'correlationId'>
): T {
  return asyncStore.run({ correlationId, ...context }, fn);
}

export function getCorrelationContext(): LogContext {
  return asyncStore.getStore() || {};
}

const REDACTED = '[REDACTED]';

// Keys matching these normalized names have their values redacted regardless
// of casing/spacing (e.g. accessToken, api_key, x-api-key, vaultSecretKey).
const SECRET_NORMALIZED_KEYS = new Set([
  'authorization',
  'auth',
  'apikey',
  'xapikey',
  'xapi',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'userpassword',
  'temporarypassword',
  'secret',
  'secrets',
  'secretkey',
  'vaultsecret',
  'vaultkey',
  'vaultsecretkey',
  'masterkey',
  'kmsmasterkey',
  'encryptionkey',
  'token',
  'tokens',
  'accesstoken',
  'accesstokens',
  'refreshtoken',
  'oauthtoken',
  'idtoken',
  'authtoken',
  'authtokens',
  'sessiontoken',
  'csrftoken',
  'signedtoken',
  'bearer',
  'bearertoken',
  'clientsecret',
  'signingsecret',
  'webhooksecret',
  'privatekey',
  'privatepem',
  'cookie',
  'cookies',
  'setcookie',
  'session',
  'sessionid',
  'credentials',
  'slacktoken',
  'githubtoken',
  'supabaseservicerolekey',
  'supabaseanonkey',
  'openrouterapikey',
  'openrouterkey',
  'geminiapikey',
  'anthropicapikey',
  'openiaikey',
  'openaiapikey',
  'ssn',
  'creditcard',
  'creditcardnumber',
]);

// Value patterns applied to every string (message and meta values).
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /bearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /basic\s+[a-z0-9+/=]{8,}/gi,
  /sk-[a-z0-9_-]{8,}/gi,
  /aiza[0-9a-z_-]{20,}/gi,
  /gh[pousr]_[a-z0-9]{20,}/gi,
  /github_pat_[a-z0-9_]{20,}/gi,
  /xox[baprs]-[a-z0-9-]{10,}/gi,
  /xapp-[a-z0-9-]{10,}/gi,
  /hooks\.slack\.com\/services\/[a-z0-9]+\/[a-z0-9]+\/[a-z0-9]+/gi,
  /eyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/gi,
  /\b(?:akia|asia)[0-9a-z]{16}\b/gi,
  /-----begin [a-z ]*private key-----[\s\S]*?-----end [a-z ]*private key-----/gi,
  /(?:password|passwd|pwd|api[_-]?key|secret|token|client[_-]?secret)[\s]*[:=][\s]*["']?[^\s"',}\\]{6,}/gi,
  /\/\/[^:\s/]+:[^@\s/]+@/g,
];

export function redactText(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key: string): boolean {
  return SECRET_NORMALIZED_KEYS.has(normalizeKey(key));
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && isSecretKey(key)) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') return redactObject(value as Record<string, unknown>);
  return value;
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = redactValue(value, key);
  }
  return out;
}

function normalizeMeta(meta: unknown): Record<string, unknown> | undefined {
  if (meta === undefined || meta === null) return undefined;
  if (meta instanceof Error) {
    return { error: { name: meta.name, message: meta.message, stack: meta.stack } };
  }
  if (Array.isArray(meta) || typeof meta !== 'object') {
    return { extra: meta };
  }
  return meta as Record<string, unknown>;
}

export class StructuredLogger implements Logger {
  private readonly level: LogLevel;
  private readonly output: (line: string) => void;
  private readonly service: string;
  private readonly process: string;
  private defaultCorrelationId: string;
  private defaultWorkspaceId?: string;
  private defaultUserId?: string;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level || (process.env.LOG_LEVEL as LogLevel) || 'info';
    this.output = options.output || ((line) => process.stdout.write(`${line}\n`));
    this.service = options.service || SERVICE_NAME;
    this.process = options.process || PROCESS_NAMES;
    this.defaultCorrelationId = randomUUID();
  }

  setCorrelationId(correlationId: string): void {
    const context = asyncStore.getStore();
    if (context) context.correlationId = correlationId;
    else this.defaultCorrelationId = correlationId;
  }

  serviceName(): string {
    return this.service;
  }

  setWorkspaceId(workspaceId: string): void {
    const context = asyncStore.getStore();
    if (context) context.workspaceId = workspaceId;
    else this.defaultWorkspaceId = workspaceId;
  }

  setUserId(userId: string): void {
    const context = asyncStore.getStore();
    if (context) context.userId = userId;
    else this.defaultUserId = userId;
  }

  private log(level: LogLevel, message: unknown, meta?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const context = getCorrelationContext();
    const rawMessage = message instanceof Error ? message.message : typeof message === 'string' ? message : JSON.stringify(message);
    const safeMeta = normalizeMeta(meta);

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      process: this.process,
      correlationId: context.correlationId || this.defaultCorrelationId,
      pid: process.pid,
      message: redactText(rawMessage.replace(/^\[(INFO|WARN|ERROR|DEBUG|FATAL)\]\s*/i, '')),
    };

    if (context.workspaceId || this.defaultWorkspaceId) entry.workspaceId = context.workspaceId || this.defaultWorkspaceId;
    if (context.userId || this.defaultUserId) entry.userId = context.userId || this.defaultUserId;

    if (safeMeta) {
      const redacted = redactObject(safeMeta);
      for (const [key, value] of Object.entries(redacted)) {
        if (key !== 'timestamp' && key !== 'level' && key !== 'service' && key !== 'process' && key !== 'correlationId' && key !== 'pid' && key !== 'message') {
          entry[key] = value;
        }
      }
    }

    this.output(JSON.stringify(entry));
  }

  trace(message: unknown, meta?: unknown): void {
    this.log('trace', message, meta);
  }

  debug(message: unknown, meta?: unknown): void {
    this.log('debug', message, meta);
  }

  info(message: unknown, meta?: unknown): void {
    this.log('info', message, meta);
  }

  warn(message: unknown, meta?: unknown): void {
    this.log('warn', message, meta);
  }

  error(message: unknown, meta?: unknown): void {
    this.log('error', message, meta);
  }

  fatal(message: unknown, meta?: unknown): void {
    this.log('fatal', message, meta);
  }
}

export const logger = new StructuredLogger();
