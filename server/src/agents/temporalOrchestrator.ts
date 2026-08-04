import { runAgentTaskWorkflow } from '../workflows/agentWorkflow.js';
import { ExecutionResult, WorkflowContext } from './types.js';

export interface TemporalWorkflowOptions {
  userQuery: string;
  context: WorkflowContext;
  workflowId?: string;
  maxRetryAttempts?: number;
}

export class TemporalWorkflowOrchestrator {
  public async executeWorkflow(options: TemporalWorkflowOptions): Promise<ExecutionResult> {
    return runAgentTaskWorkflow({
      userQuery: options.userQuery,
      context: options.context,
      workflowId: options.workflowId,
    });
  }
}

export const temporalOrchestrator = new TemporalWorkflowOrchestrator();
