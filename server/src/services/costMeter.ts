// Cost meter for Phase 0 (ADR-T12 scaffold pulled forward)
// Provides cost tracking and quota enforcement for AI model usage

import { getKeyProvider } from './security/keyProvider.js';

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

export class CostMeter {
  private records: CostRecord[] = [];
  private keyProvider = getKeyProvider();

  /**
   * Record AI usage cost for a workspace
   * Computes cost based on provider, model, and token usage
   */
  async recordUsage(
    workspaceId: string,
    resource: string,
    period: Timestamp,
    units: number,
    costPerUnitCents: number,
    alertThreshold?: number
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
    await this.checkQuotaExceeded(workspaceId, costCents, period);
  }

  /**
   * Check if workspace has exceeded cost quotas
   */
  private async checkQuotaExceeded(
    workspaceId: string,
    costCents: number,
    period: Timestamp
  ): Promise<void> {
    // Get per-workspace quota from key provider or default to environment variable
    const quotaKey = `COST_QUOTA_${workspaceId.toUpperCase()}`;
    const quotaCents = parseInt(process.env[quotaKey] || '0', 10);
    
    if (quotaCents > 0 && costCents > quotaCents) {
      const provider = getKeyProvider();
      await provider.storeCredential(
        `COST_QUOTA_EXCEEDED_${workspaceId}`, 
        `Cost exceeded quota: ${costCents} > ${quotaCents} cents`
      );
      
      console.warn(
        `[CostMeter] Workspace ${workspaceId} exceeded cost quota: ${costCents} > ${quotaCents} cents`
      );
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
    return require('crypto').randomUUID();
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