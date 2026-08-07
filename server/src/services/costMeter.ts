// Cost meter for Phase 0 (ADR-T12 scaffold pulled forward).
// - Every successful LLM request records provider, model, token counts,
//   estimated cost, latency, workspaceId, correlationId, timestamp.
// - Records persist into the `usage_meters` table (best effort: persistence
//   failures are logged and NEVER fail the caller).
// - No billing logic, no budget enforcement, no dashboards — that is Phase 9.

import { randomUUID } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { logger, getCorrelationContext } from '../logger.js';
import { withTimeout } from './health.js';

export interface CostRecord {
  id: string;
  workspaceId: string;
  resource: string;
  period: Timestamp;
  units: number;
  costCents: number;
  alertThreshold?: number;
}

export type Timestamp = {
  seconds: number;
  nanos: number;
};

export interface UsageDetail {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  correlationId?: string;
}

export interface UsageRecord extends UsageDetail {
  workspaceId: string;
}

export interface WorkspaceUsageSummary {
  workspaceId: string;
  requests: number;
  totalTokens: number;
  totalCostCents: number;
  byProvider: Record<string, { requests: number; tokens: number; costCents: number }>;
  byResource: Record<string, { requests: number; units: number; costCents: number }>;
}

export interface QuotaStatus {
  workspaceId: string;
  quotaCents: number;
  usageCents: number;
  allowed: boolean;
  reason?: 'quota_exceeded';
}

const PERSIST_TIMEOUT_MS = 2000;

// Estimated token pricing in cents per 1M tokens, keyed by model substring.
// Estimation only — not billing. Unknown models fall back to the default row.
const PRICING_PER_MILLION_CENTS: Array<{ match: RegExp; inputCents: number; outputCents: number }> = [
  { match: /gemini/i, inputCents: 125, outputCents: 500 },
  { match: /deepseek|v4-flash|flash/i, inputCents: 15, outputCents: 60 },
  { match: /gpt-4o|gpt-4\.1/i, inputCents: 250, outputCents: 1000 },
  { match: /gpt-4/i, inputCents: 3000, outputCents: 6000 },
  { match: /gpt-3\.5|turbo/i, inputCents: 50, outputCents: 150 },
  { match: /claude-3-5-haiku|claude-3-haiku/i, inputCents: 80, outputCents: 400 },
  { match: /claude-3-5-sonnet|claude-3-sonnet/i, inputCents: 300, outputCents: 1500 },
  { match: /llama/i, inputCents: 20, outputCents: 80 },
];

const DEFAULT_INPUT_CENTS = 50;
const DEFAULT_OUTPUT_CENTS = 150;

export function estimateCostCents(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  if (provider === 'ollama') return 0;
  const row = PRICING_PER_MILLION_CENTS.find((entry) => entry.match.test(model)) || null;
  const inputCents = row ? row.inputCents : DEFAULT_INPUT_CENTS;
  const outputCents = row ? row.outputCents : DEFAULT_OUTPUT_CENTS;
  return Math.round((promptTokens * inputCents + completionTokens * outputCents) / 1_000_000);
}

function nowTimestamp(): Timestamp {
  return { seconds: Math.floor(Date.now() / 1000), nanos: 0 };
}

function toIso(period: Timestamp): string {
  return new Date(period.seconds * 1000 + period.nanos / 1_000_000).toISOString();
}

export interface UsageRow {
  resource: string;
  units: number;
  costCents: number;
  provider?: string | null;
  model?: string | null;
}

export interface PersistRow {
  workspace_id: string;
  resource: string;
  period: string;
  units: number;
  cost_cents: number;
  alert_threshold: number | null;
  provider?: string | null;
  model?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  latency_ms?: number | null;
  correlation_id?: string | null;
}

export interface UsageStore {
  persist(row: PersistRow): Promise<void>;
  query(workspaceId: string, since?: string): Promise<UsageRow[]>;
}

const supabaseUsageStore: UsageStore = {
  async persist(row: PersistRow): Promise<void> {
    try {
      await withTimeout(PERSIST_TIMEOUT_MS, (async () => {
        const { error } = await supabase.from('usage_meters').insert(row);
        if (error) throw error;
      })());
    } catch (err) {
      // Graceful degradation: fall back to the minimal row (pre-031 schema) so
      // persistence survives until the detail columns are deployed.
      const minimal = {
        workspace_id: row.workspace_id,
        resource: row.resource,
        period: row.period,
        units: row.units,
        cost_cents: row.cost_cents,
        alert_threshold: row.alert_threshold,
      };
      try {
        await withTimeout(PERSIST_TIMEOUT_MS, (async () => {
          const { error } = await supabase.from('usage_meters').insert(minimal);
          if (error) throw error;
        })());
        logger.warn('cost_meter_persist_fallback_minimal', {
          workspaceId: row.workspace_id,
          resource: row.resource,
          message: (err as Error).message,
        });
      } catch (fallbackErr) {
        logger.error('cost_meter_persist_failed', {
          workspaceId: row.workspace_id,
          resource: row.resource,
          message: (fallbackErr as Error).message,
        });
      }
    }
  },

  async query(workspaceId: string, since?: string): Promise<UsageRow[]> {
    let query = supabase
      .from('usage_meters')
      .select('resource, units, cost_cents, provider, model')
      .eq('workspace_id', workspaceId);
    if (since) {
      query = query.gte('period', since);
    }
    const { data, error } = await withTimeout(PERSIST_TIMEOUT_MS, Promise.resolve(query));
    if (error) throw error;
    if (!data) return [];
    return data.map((row: any) => ({
      resource: (row.resource as string) || 'unknown',
      units: Number(row.units) || 0,
      costCents: Number(row.cost_cents) || 0,
      provider: (row.provider as string) ?? null,
      model: (row.model as string) ?? null,
    }));
  },
};

let usageStore: UsageStore = supabaseUsageStore;

/**
 * Test-only seam: swap the persistence backend (e.g. an in-memory store) so
 * unit tests never touch live infrastructure. Pass null to restore Supabase.
 */
export function setUsageStoreForTest(store: UsageStore | null): void {
  usageStore = store ?? supabaseUsageStore;
}

async function persistUsage(
  workspaceId: string,
  resource: string,
  period: Timestamp,
  units: number,
  costCents: number,
  alertThreshold: number | undefined,
  detail?: UsageDetail
): Promise<void> {
  const base: PersistRow = {
    workspace_id: workspaceId,
    resource,
    period: toIso(period),
    units,
    cost_cents: costCents,
    alert_threshold: alertThreshold ?? null,
  };

  try {
    if (detail) {
      base.provider = detail.provider;
      base.model = detail.model;
      base.prompt_tokens = detail.promptTokens;
      base.completion_tokens = detail.completionTokens;
      base.total_tokens = detail.totalTokens;
      base.latency_ms = detail.latencyMs;
      base.correlation_id = detail.correlationId ?? null;
    }
    await usageStore.persist(base);
  } catch (err) {
    logger.error('cost_meter_record_failed', {
      workspaceId,
      resource,
      message: (err as Error).message,
    });
  }
}

export class CostMeter {
  private records: CostRecord[] = [];

  /**
   * Record AI usage cost for a workspace. Persists to usage_meters (best
   * effort — failures are logged, never thrown). In-memory records power
   * getWorkspaceCost/getTotalCost/getCostByResource.
   */
  async recordUsage(
    workspaceId: string,
    resource: string,
    period: Timestamp,
    units: number,
    costPerUnitCents: number,
    alertThreshold?: number,
    detail?: UsageDetail
  ): Promise<void> {
    const costCents = Math.round(units * costPerUnitCents);

    const record: CostRecord = {
      id: this.generateId(),
      workspaceId,
      resource,
      period,
      units,
      costCents,
      alertThreshold,
    };

    this.records.push(record);

    try {
      await persistUsage(workspaceId, resource, period, units, costCents, alertThreshold, detail);
    } catch (err) {
      // persistUsage never throws, but keep the caller safe regardless.
      logger.error('cost_meter_record_failed', {
        workspaceId,
        resource,
        message: (err as Error).message,
      });
    }
  }

  /**
   * Get total cost for workspace within a time period
   */
  getWorkspaceCost(
    workspaceId: string,
    period: Timestamp,
    periodType: 'hourly' | 'daily' | 'monthly'
  ): number {
    const filterFn = this.getPeriodFilter(period, periodType);
    return this.records
      .filter(record => record.workspaceId === workspaceId && filterFn(record))
      .reduce((sum, record) => sum + record.costCents, 0);
  }

  /**
   * Get cost for all workspaces
   */
  getTotalCost(period: Timestamp, periodType: 'hourly' | 'daily' | 'monthly'): number {
    const filterFn = this.getPeriodFilter(period, periodType);
    return this.records
      .filter(filterFn)
      .reduce((sum, record) => sum + record.costCents, 0);
  }

  /**
   * Get cost by resource type
   */
  getCostByResource(
    workspaceId: string,
    period: Timestamp,
    periodType: 'hourly' | 'daily' | 'monthly'
  ): Record<string, number> {
    const filterFn = this.getPeriodFilter(period, periodType);
    const costByResource: Record<string, number> = {};

    for (const record of this.records) {
      if (record.workspaceId === workspaceId && filterFn(record)) {
        costByResource[record.resource] = (costByResource[record.resource] || 0) + record.costCents;
      }
    }

    return costByResource;
  }

  /**
   * Generate a unique identifier for cost records
   */
  private generateId(): string {
    return randomUUID();
  }

  /**
   * Period filtering function based on period type
   */
  private getPeriodFilter(
    period: Timestamp,
    periodType: 'hourly' | 'daily' | 'monthly'
  ): (record: CostRecord) => boolean {
    switch (periodType) {
      case 'hourly':
        return (record) => {
          const recordPeriodSeconds = record.period.seconds;
          const targetPeriodSeconds = period.seconds;
          return Math.floor(recordPeriodSeconds / 3600) === Math.floor(targetPeriodSeconds / 3600);
        };
      case 'daily':
        return (record) => {
          const recordPeriodSeconds = record.period.seconds;
          const targetPeriodSeconds = period.seconds;
          const recordDay = Math.floor(recordPeriodSeconds / 86400);
          const targetDay = Math.floor(targetPeriodSeconds / 86400);
          return recordDay === targetDay;
        };
      case 'monthly':
        return (record) => {
          const recordPeriodSeconds = record.period.seconds;
          const targetPeriodSeconds = period.seconds;
          const recordYear = new Date(recordPeriodSeconds * 1000).getUTCFullYear();
          const recordMonth = new Date(recordPeriodSeconds * 1000).getUTCMonth();
          const targetYear = new Date(targetPeriodSeconds * 1000).getUTCFullYear();
          const targetMonth = new Date(targetPeriodSeconds * 1000).getUTCMonth();
          return recordYear === targetYear && recordMonth === targetMonth;
        };
      default:
        return () => true;
    }
  }
}

/**
 * Global cost meter instance
 */
export const costMeter = new CostMeter();

/**
 * Record usage for a single LLM request (Phase 0 Task 10 clean API).
 * Computes the estimated cost, persists into usage_meters, and never throws:
 * any persistence failure is logged and swallowed so the user request is
 * never impacted.
 */
export async function recordUsage(usage: UsageRecord): Promise<void> {
  try {
    const costCents = estimateCostCents(usage.provider, usage.model, usage.promptTokens, usage.completionTokens);
    const resource = `llm:${usage.provider}:${usage.model}`.slice(0, 100);
    const detail: UsageDetail = { ...usage };
    const totalTokens = usage.totalTokens > 0 ? usage.totalTokens : usage.promptTokens + usage.completionTokens;
    const perUnitCents = totalTokens > 0 ? costCents / totalTokens : 0;

    await costMeter.recordUsage(
      usage.workspaceId,
      resource,
      nowTimestamp(),
      totalTokens,
      perUnitCents,
      undefined,
      detail
    );
  } catch (err) {
    logger.error('cost_meter_record_usage_failed', {
      workspaceId: usage.workspaceId,
      provider: usage.provider,
      model: usage.model,
      message: (err as Error).message,
    });
  }
}

/**
 * Summarize recorded usage for a workspace (Phase 0 Task 10 clean API).
 * Bounded and failure-tolerant: on persistence errors returns an empty
 * summary rather than throwing.
 */
export async function getWorkspaceUsage(
  workspaceId: string,
  opts?: { since?: string }
): Promise<WorkspaceUsageSummary> {
  const empty: WorkspaceUsageSummary = {
    workspaceId,
    requests: 0,
    totalTokens: 0,
    totalCostCents: 0,
    byProvider: {},
    byResource: {},
  };

  try {
    const rows = await usageStore.query(workspaceId, opts?.since);
    if (rows.length === 0) return empty;

    const summary: WorkspaceUsageSummary = { ...empty, requests: rows.length };
    for (const row of rows) {
      const resource = row.resource;
      const provider = row.provider || providerFromResource(resource);

      summary.totalTokens += row.units;
      summary.totalCostCents += row.costCents;

      const byResource = summary.byResource[resource] || { requests: 0, units: 0, costCents: 0 };
      byResource.requests += 1;
      byResource.units += row.units;
      byResource.costCents += row.costCents;
      summary.byResource[resource] = byResource;

      const byProvider = summary.byProvider[provider] || { requests: 0, tokens: 0, costCents: 0 };
      byProvider.requests += 1;
      byProvider.tokens += row.units;
      byProvider.costCents += row.costCents;
      summary.byProvider[provider] = byProvider;
    }
    return summary;
  } catch (err) {
    logger.warn('cost_meter_get_usage_failed', {
      workspaceId,
      message: (err as Error).message,
    });
    return empty;
  }
}

function providerFromResource(resource: string): string {
  const parts = resource.split(':');
  return parts.length >= 2 ? parts[1] : resource;
}

/**
 * Report-only quota check (Phase 0 Task 10 clean API). Reads the legacy
 * per-workspace env quota (COST_QUOTA_<WORKSPACE_UPPER>); zero/unset means
 * no quota (always allowed). Reports status — it never blocks or enforces.
 */
export async function checkQuota(workspaceId: string): Promise<QuotaStatus> {
  const normalized = workspaceId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const quotaKey = `COST_QUOTA_${normalized}`;
  const quotaCents = parseInt(process.env[quotaKey] || '0', 10);
  const usage = await getWorkspaceUsage(workspaceId);

  return {
    workspaceId,
    quotaCents,
    usageCents: usage.totalCostCents,
    allowed: quotaCents === 0 || usage.totalCostCents < quotaCents,
    ...(quotaCents > 0 && usage.totalCostCents >= quotaCents ? { reason: 'quota_exceeded' as const } : {}),
  };
}

/**
 * Build a UsageRecord from a completed LLM request using the ambient
 * correlation context (correlationId/workspaceId from the request path).
 */
export function usageFromContext(
  provider: string,
  model: string,
  tokens: { promptTokens: number; completionTokens: number; totalTokens: number },
  latencyMs: number,
  workspaceId?: string
): UsageRecord {
  const context = getCorrelationContext();
  return {
    provider,
    model,
    ...tokens,
    latencyMs,
    workspaceId: workspaceId || context.workspaceId || 'system',
    correlationId: context.correlationId || randomUUID(),
  };
}
