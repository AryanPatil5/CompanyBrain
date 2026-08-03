export type WorkflowStatus =
  | 'IDLE'
  | 'PLANNING'
  | 'AUDITING'
  | 'AWAITING_APPROVAL'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'PAUSED';

export interface StateTransitionResult {
  success: boolean;
  from: WorkflowStatus;
  to: WorkflowStatus;
  error?: string;
}

export const ALLOWED_STATE_TRANSITIONS: Record<WorkflowStatus, Set<WorkflowStatus>> = {
  IDLE: new Set(['PLANNING', 'FAILED']),
  PLANNING: new Set(['AUDITING', 'FAILED']),
  AUDITING: new Set(['AWAITING_APPROVAL', 'EXECUTING', 'FAILED']),
  AWAITING_APPROVAL: new Set(['EXECUTING', 'FAILED', 'PAUSED']),
  PAUSED: new Set(['EXECUTING', 'AWAITING_APPROVAL', 'FAILED']),
  EXECUTING: new Set(['COMPLETED', 'FAILED', 'PAUSED']),
  COMPLETED: new Set(['IDLE']),
  FAILED: new Set(['IDLE', 'PLANNING']),
};

/**
 * Validates and governs deterministic state transitions for multi-agent execution workflows.
 */
export function transitionState(
  currentStatus: WorkflowStatus,
  targetStatus: WorkflowStatus
): StateTransitionResult {
  if (currentStatus === targetStatus) {
    return {
      success: true,
      from: currentStatus,
      to: targetStatus,
    };
  }

  const allowedTargets = ALLOWED_STATE_TRANSITIONS[currentStatus];

  if (!allowedTargets || !allowedTargets.has(targetStatus)) {
    const validNextStates = allowedTargets ? Array.from(allowedTargets).join(', ') : 'None';
    return {
      success: false,
      from: currentStatus,
      to: targetStatus,
      error: `Illegal state transition from "${currentStatus}" to "${targetStatus}". Allowed next states: [${validNextStates}]`,
    };
  }

  return {
    success: true,
    from: currentStatus,
    to: targetStatus,
  };
}
