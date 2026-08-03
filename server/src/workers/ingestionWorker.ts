import { Worker, type Job } from 'bullmq';
import { redisConnection } from '../queue/ingestionQueue.js';
import { supabase } from '../config/supabase.js';
import {
  crawlSlackHistory,
  crawlGithubPostMortems,
  crawlLinearIncidents,
  crawlZendeskTickets,
  crawlEmailInbox,
  crawlDatabaseLogs,
} from '../services/crawler.js';
import { parseDocument } from '../services/parsers/documentParser.js';

export interface IngestionJobData {
  job_name: 'crawl_slack' | 'crawl_github' | 'crawl_linear' | 'crawl_zendesk' | 'crawl_email' | 'crawl_db' | 'all';
  workspace_id: string;
  requested_by?: string;
  inbox?: string;
  target_system?: string;
}

let workerInstance: Worker<IngestionJobData> | null = null;

async function logJobLifecycle(params: {
  jobId: string;
  jobName: string;
  workspaceId: string;
  status: 'started' | 'completed' | 'failed';
  result?: any;
  error?: string;
}) {
  try {
    const { jobId, jobName, workspaceId, status, result, error } = params;

    // Log lifecycle to execution_logs audit table
    await supabase.from('execution_logs').insert({
      workspace_id: workspaceId,
      step_execution_id: jobId,
      sop_id: null,
      target_system: `crawler:${jobName}`,
      status: status === 'completed' ? 'success' : status === 'failed' ? 'failed' : 'pending',
      input_payload: { jobName, jobId },
      output_payload: result || { error: error || null },
      error_message: error || null,
      executed_at: new Date().toISOString(),
    });

    if (status === 'failed') {
      await supabase.from('ingestion_failures').insert({
        workspace_id: workspaceId,
        source: jobName,
        external_id: jobId,
        error_reason: error || 'Worker execution failed',
      });
    }
  } catch (logErr) {
    console.warn('[IngestionWorker Warning] Failed to write audit log:', logErr);
  }
}

export function createIngestionWorker(): Worker<IngestionJobData> {
  const worker = new Worker<IngestionJobData>(
    'IngestionQueue',
    async (job: Job<IngestionJobData>) => {
      const { job_name, workspace_id, inbox, target_system } = job.data;
      console.log(`[IngestionWorker] Processing job ${job.id} (${job_name}) for workspace ${workspace_id}...`);

      await job.updateProgress(10);
      await logJobLifecycle({ jobId: job.id!, jobName: job_name, workspaceId: workspace_id, status: 'started' });

      let result: any = null;

      switch (job_name) {
        case 'crawl_slack': {
          result = await crawlSlackHistory();
          await job.updateProgress(100);
          break;
        }
        case 'crawl_github': {
          result = await crawlGithubPostMortems();
          await job.updateProgress(100);
          break;
        }
        case 'crawl_linear': {
          result = await crawlLinearIncidents();
          await job.updateProgress(100);
          break;
        }
        case 'crawl_zendesk': {
          result = await crawlZendeskTickets();
          await job.updateProgress(100);
          break;
        }
        case 'crawl_email': {
          const targetInbox = inbox || process.env.OPS_INBOX_EMAIL || 'ops-support@company.com';
          result = await crawlEmailInbox(targetInbox, workspace_id);
          await job.updateProgress(100);
          break;
        }
        case 'crawl_db': {
          result = await crawlDatabaseLogs();
          await job.updateProgress(100);
          break;
        }
        case 'all': {
          await job.updateProgress(20);
          const slack = await crawlSlackHistory();
          await job.updateProgress(40);
          const github = await crawlGithubPostMortems();
          await job.updateProgress(60);
          const linear = await crawlLinearIncidents();
          await job.updateProgress(80);
          const zendesk = await crawlZendeskTickets();
          const email = await crawlEmailInbox(inbox || 'ops-support@company.com', workspace_id);
          const db = await crawlDatabaseLogs();
          await job.updateProgress(100);
          result = { slack, github, linear, zendesk, email, db };
          break;
        }
        default: {
          throw new Error(`Unsupported job_name: ${job_name}`);
        }
      }

      await logJobLifecycle({
        jobId: job.id!,
        jobName: job_name,
        workspaceId: workspace_id,
        status: 'completed',
        result,
      });

      return result;
    },
    {
      connection: redisConnection,
      concurrency: 2, // Cap concurrency to 2 parallel workers for Apple Silicon memory optimization
    }
  );

  worker.on('completed', (job) => {
    console.log(`[IngestionWorker] Job ${job.id} (${job.name}) completed successfully.`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[IngestionWorker] Job ${job?.id} (${job?.name}) failed:`, err.message);
    if (job) {
      void logJobLifecycle({
        jobId: job.id!,
        jobName: job.data.job_name,
        workspaceId: job.data.workspace_id,
        status: 'failed',
        error: err.message,
      });
    }
  });

  worker.on('error', (err) => {
    if ((err as any).code === 'ECONNREFUSED') {
      // Suppress spammy offline warning during dev tests
    } else {
      console.error('[IngestionWorker Error]:', err);
    }
  });

  return worker;
}

export function startIngestionWorker(): Worker<IngestionJobData> {
  if (!workerInstance) {
    console.log('[IngestionWorker] Starting BullMQ Ingestion Worker (Concurrency: 2)...');
    workerInstance = createIngestionWorker();
  }
  return workerInstance;
}

export async function stopIngestionWorker(): Promise<void> {
  if (workerInstance) {
    console.log('[IngestionWorker] Stopping BullMQ Ingestion Worker...');
    await workerInstance.close();
    workerInstance = null;
  }
}
