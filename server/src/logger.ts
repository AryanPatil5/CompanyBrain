// Structured logger for Phase 0 (ADR-T8 scaffold)
// Provides correlation ID support and structured JSON logging

import { randomUUID } from 'node:crypto';

interface LogEntry {
  timestamp: string;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  correlationId?: string;
  workspaceId?: string;
  userId?: string;
  [key: string]: any;
}

interface Logger {
  trace(message: string, meta?: Record<string, any>): void;
  debug(message: string, meta?: Record<string, any>): void;
  info(message: string, meta?: Record<string, any>): void;
  warn(message: string, meta?: Record<string, any>): void;
  error(message: string, meta?: Record<string, any>): void;
  fatal(message: string, meta?: Record<string, any>): void;
}

class StructuredLogger implements Logger {
  private correlationId?: string;
  private workspaceId?: string;
  private userId?: string;

  constructor() {
    this.correlationId = randomUUID();
  }

  setCorrelationId(correlationId: string): void {
    this.correlationId = correlationId;
  }

  setWorkspaceId(workspaceId: string): void {
    this.workspaceId = workspaceId;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  private log(level: LogEntry['level'], message: string, meta?: Record<string, any>): void {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      correlationId: this.correlationId,
      workspaceId: this.workspaceId,
      userId: this.userId,
      ...meta,
    };

    // Output structured JSON to stdout
    console.log(JSON.stringify(logEntry));
  }

  trace(message: string, meta?: Record<string, any>): void {
    this.log('trace', message, meta);
  }

  debug(message: string, meta?: Record<string, any>): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, any>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, any>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, any>): void {
    this.log('error', message, meta);
  }

  fatal(message: string, meta?: Record<string, any>): void {
    this.log('fatal', message, meta);
  }
}

// Global logger instance
const logger = new StructuredLogger();

export { logger, StructuredLogger, type Logger };