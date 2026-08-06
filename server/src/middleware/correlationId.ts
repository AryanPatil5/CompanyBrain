// Correlation ID middleware for Phase 0 (ADR-T8 scaffold)
// Adds correlation ID to request context for distributed tracing

import { Request, Response, NextFunction } from 'express';

export const generateCorrelationId = (): string => {
  return require('crypto').randomUUID();
};

export const correlationIdMiddleware = (): ((req: Request, res: Response, next: NextFunction) => void) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Extract correlation ID from request headers
    let correlationId = req.headers['x-correlation-id'] as string || generateCorrelationId();

    // Attach to request and response objects
    (req as any).correlationId = correlationId;
    (res as any).correlationId = correlationId;

    // Add correlation ID to response headers
    res.setHeader('x-correlation-id', correlationId);

    // Attach correlation ID to response object for logging
    res.on('finish', () => {
      if ((res as any).logger) {
        (res as any).logger.setCorrelationId(correlationId);
      }
    });

    next();
  };
};