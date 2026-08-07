import { logger } from '../logger.js';
import { supabase } from '../config/supabase.js';

export interface AuditEvent {
  eventId: string;
  timestamp: string;
  workspaceId: string;
  userId: string;
  action: string;
  targetResource: string;
  status: 'SUCCESS' | 'DENIED' | 'FLAGGED' | string;
  metadata?: Record<string, any>;
}

/**
 * Enterprise SIEM Audit Logger
 * Formats agent actions, tool executions, security policy validations, and human approval events
 * as structured JSON lines for SIEM streaming (Splunk, Datadog) and database persistence.
 */
export function logAuditEvent(event: Omit<AuditEvent, 'eventId' | 'timestamp'>): AuditEvent {
  const fullEvent: AuditEvent = {
    eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    workspaceId: event.workspaceId || '00000000-0000-0000-0000-000000000000',
    userId: event.userId || 'system',
    action: event.action,
    targetResource: event.targetResource,
    status: event.status,
    metadata: event.metadata || {},
  };

  // 1. SIEM Structured JSON Output to stdout
  logger.info(`[AUDIT_STREAM] ${JSON.stringify(fullEvent)}`);

  // 2. Asynchronous Database Persistence to audit_logs / execution_logs table
  void (async () => {
    try {
      await supabase.from('execution_logs').insert({
        workspace_id: fullEvent.workspaceId,
        agent_id: fullEvent.userId,
        target_system: fullEvent.targetResource,
        status: fullEvent.status.toLowerCase(),
        input_payload: { action: fullEvent.action, metadata: fullEvent.metadata },
        output_payload: { eventId: fullEvent.eventId },
        executed_at: fullEvent.timestamp,
      });
    } catch (dbErr) {
      logger.warn('[AuditLogger Warning] Failed to write audit log to database:', dbErr);
    }
  })();

  return fullEvent;
}
