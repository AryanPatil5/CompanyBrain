import { logger } from '../logger.js';
import { Redis } from 'ioredis';
import dotenv from 'dotenv';
import { ExecutionResult } from './types.js';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const agentRedisClient = new Redis(REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
  retryStrategy: () => null,
});

agentRedisClient.on('error', (err) => {
  if ((err as any).code === 'ECONNREFUSED') {
    // Suppress warning during offline local dev tests
  } else {
    logger.error('[PersistentStore Redis Error]:', err);
  }
});

// In-memory fallback state map for environments where Redis is offline
const inMemoryStore = new Map<string, any>();

/**
 * Stores a multi-agent workflow execution state in Redis (or in-memory fallback) with TTL.
 */
export async function saveWorkflowState(
  workflowId: string,
  state: ExecutionResult | any,
  ttlSeconds: number = 86400
): Promise<void> {
  const key = `agent_workflow:${workflowId}`;
  const serialized = JSON.stringify(state);

  inMemoryStore.set(key, state);

  try {
    try {
  if (agentRedisClient.status === "wait") {
    await agentRedisClient.connect();
  }

  if (agentRedisClient.status === "ready") {
    await agentRedisClient.setex(key, ttlSeconds, serialized);
  }
} catch {
  // Redis unavailable. In-memory state is already saved.
}
  } catch {
    // Redis offline fallback
  }
}

/**
 * Retrieves a multi-agent workflow execution state from Redis (or in-memory fallback).
 */
export async function getWorkflowState(workflowId: string): Promise<ExecutionResult | any | null> {
  const key = `agent_workflow:${workflowId}`;

  try {
    const data = await agentRedisClient.get(key);
    if (data) {
      return JSON.parse(data);
    }
  } catch {
    // Redis offline fallback
  }

  return inMemoryStore.get(key) || null;
}

/**
 * Updates the status and output payload for a specific step within an active workflow state.
 */
export async function updateStepStatus(
  workflowId: string,
  stepId: string,
  status: 'pending' | 'success' | 'error' | 'skipped' | string,
  output?: any
): Promise<void> {
  const currentState = await getWorkflowState(workflowId);
  if (!currentState) return;

  if (Array.isArray(currentState.executed_steps)) {
    const existingIndex = currentState.executed_steps.findIndex((s: any) => s.step_id === stepId);
    if (existingIndex >= 0) {
      currentState.executed_steps[existingIndex].outcome = status;
      if (output !== undefined) currentState.executed_steps[existingIndex].response_data = output;
    } else {
      currentState.executed_steps.push({
        step_id: stepId,
        outcome: status,
        response_data: output,
      });
    }
  }

  await saveWorkflowState(workflowId, currentState);
}
