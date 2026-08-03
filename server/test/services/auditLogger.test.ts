import { logAuditEvent, AuditEvent } from '../../src/services/auditLogger.js';

export async function runAuditLoggerTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running SIEM Structured Audit Logger Test     ');
  console.log('=================================================');

  const eventInput = {
    workspaceId: '00000000-0000-0000-0000-000000000000',
    userId: 'agent_runner_01',
    action: 'EXECUTE_SOP_STEP',
    targetResource: 'sys_stripe',
    status: 'SUCCESS' as const,
    metadata: { step_number: 1, amount_cents: 5000 },
  };

  // 1. Log Audit Event
  const loggedEvent: AuditEvent = logAuditEvent(eventInput);

  if (!loggedEvent.eventId || !loggedEvent.timestamp) {
    console.error('❌ AUDIT LOGGER TEST FAILED: Generated event missing eventId or timestamp!', loggedEvent);
    return false;
  }

  if (loggedEvent.action !== 'EXECUTE_SOP_STEP' || loggedEvent.targetResource !== 'sys_stripe') {
    console.error('❌ AUDIT LOGGER TEST FAILED: Event payload fields mismatch!', loggedEvent);
    return false;
  }

  console.log(`✅ AUDIT LOGGER TEST PASSED: Successfully generated SIEM audit log event (${loggedEvent.eventId}) with status "${loggedEvent.status}".`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAuditLoggerTest().then((success) => {
    if (!success) process.exit(1);
  });
}
