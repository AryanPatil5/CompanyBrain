// Correlation ID middleware for Phase 0 (ADR-T8 scaffold)
// Preserves an incoming x-correlation-id (or x-request-id), generates one
// when absent, echoes it on the response, and propagates it to the logger
// via AsyncLocalStorage so every structured log in the request path carries
// the same correlationId.

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithCorrelationId } from '../logger.js';

export const generateCorrelationId = (): string => {
  return randomUUID();
};

export const extractCorrelationId = (
  headers: Record<string, string | string[] | undefined>
): string => {
  const incoming =
    (Array.isArray(headers['x-correlation-id'])
      ? headers['x-correlation-id'][0]
      : headers['x-correlation-id']) ||
    (Array.isArray(headers['x-request-id'])
      ? headers['x-request-id'][0]
      : headers['x-request-id']);
  return incoming || generateCorrelationId();
};

export const correlationIdMiddleware = (): ((req: Request, res: Response, next: NextFunction) => void) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const correlationId = extractCorrelationId(req.headers as Record<string, string | string[] | undefined>);
    const workspaceId =
      (Array.isArray(req.headers['x-workspace-id'])
        ? req.headers['x-workspace-id'][0]
        : req.headers['x-workspace-id']) || undefined;

    (req as any).correlationId = correlationId;
    (res as any).correlationId = correlationId;

    res.setHeader('x-correlation-id', correlationId);

    runWithCorrelationId(correlationId, () => next(), workspaceId ? { workspaceId } : undefined);
  };
};
