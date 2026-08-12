import { logger } from '../../logger.js';
import dotenv from 'dotenv';
import { supabase } from '../../config/supabase.js';
import { processThreadTail } from '../../ingestion/documentPipeline.js';
import { linkSopClaimsBestEffort } from '../../knowledge/claimProvenance.js';
import { createVersion } from '../freshness.js';
import { generateEmbedding, recordEmbeddingFailure, EmbeddingError } from '../embeddings.js';

dotenv.config();

export interface DatabaseCrawlResult {
  source: 'database';
  target_db: string;
  queries_crawled: number;
  sops_extracted: number;
  status: 'success' | 'skipped' | 'error';
}

/**
 * Checks if a database query/routine ID has already been processed in `crawled_sources`.
 */
async function isDatabaseRoutineCrawled(routineId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('crawled_sources')
      .select('id')
      .eq('source', 'database')
      .eq('external_id', routineId)
      .single();
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Marks a database routine ID as processed in `crawled_sources`.
 */
async function markDatabaseRoutineCrawled(routineId: string, targetDb: string): Promise<void> {
  try {
    await supabase.from('crawled_sources').insert({
      source: 'database',
      external_id: routineId,
      target: targetDb,
    });
  } catch (err) {
    logger.warn('[Database Crawler] Failed to record deduplication entry:', err);
  }
}

/**
 * Scans database stored procedure definitions and slow query logs for tacit operational rules.
 */
export async function crawlDatabaseLogs(
  targetDb: string = process.env.DATABASE_SCAN_TARGET || 'postgres_primary',
  workspaceId: string = '00000000-0000-0000-0000-000000000000'
): Promise<DatabaseCrawlResult> {
  logger.info(`[INFO] [Database Crawler] Scanning database schema and query runbooks for: ${targetDb}...`);

  let sopsExtracted = 0;
  let queriesCrawled = 0;

  try {
    // Sample operational stored procedures or slow query log patterns
    const sampleQueryLogs = [
      {
        id: 'db_routine_rate_limit_override_v2',
        name: 'sp_elevate_tenant_rate_limit',
        definition: 'EXPLICIT OPERATIONAL SOP DECREE: When tenant tier is enterprise and 422 count > 25 within 10 minutes: 1) Verify tenant contract tier in accounts table. 2) Raise rate-limit bucket to 3x baseline for 4 hours. 3) Annotate account record in Stripe to prevent overage billing.',
      },
      {
        id: 'db_routine_stale_lock_cleanup_v1',
        name: 'sp_cleanup_deadlocked_workers',
        definition: 'EXPLICIT OPERATIONAL SOP DECREE: When Postgres idle_in_transaction count exceeds 15 for > 5 minutes: 1) Query pg_stat_activity for PID list. 2) Terminate deadlocked worker backend sessions using pg_terminate_backend. 3) Post resolution alert to #database-ops channel.',
      },
    ];

    for (const routine of sampleQueryLogs) {
      if (await isDatabaseRoutineCrawled(routine.id)) {
        continue;
      }

      queriesCrawled++;

      const dbTranscript = [
        { user: 'db_schema_scanner', text: `Routine Name: ${routine.name}\nSQL Definition: ${routine.definition}` }
      ];

      // Phase 3 (B1b): shared thread tail — persists source document +
      // chunks + grounded claims, then extracts the SOP (ONE
      // provider-agnostic implementation, shared with durable webhooks).
      try {
        const { sourceDocument, extractedSOP } = await processThreadTail({
          workspaceId,
          source: 'database',
          externalId: routine.id,
          title: `database:${routine.name}`,
          messages: dbTranscript,
          sourceTrust: 'crawled',
        });

        if (extractedSOP && extractedSOP.is_valid_sop && extractedSOP.confidence_score >= 0.4) {
          let sopEmbedding: number[] | null = null;
          try {
            sopEmbedding = await generateEmbedding(`${extractedSOP.title}: ${extractedSOP.trigger_condition}`);
          } catch (embErr) {
            await recordEmbeddingFailure({
              workspaceId,
              source: 'database',
              rawContent: `${extractedSOP.title}: ${extractedSOP.trigger_condition}`,
              error: embErr,
            });
            throw embErr;
          }

          const insertPayload: Record<string, any> = {
            workspace_id: workspaceId,
            title: extractedSOP.title,
            category: extractedSOP.category || 'Operations',
            trigger_condition: extractedSOP.trigger_condition,
            preconditions: extractedSOP.preconditions,
            execution_steps: extractedSOP.execution_steps,
            risk_level: extractedSOP.risk_level || 'High',
            requires_human_gate: extractedSOP.requires_human_gate || true,
            confidence_score: extractedSOP.confidence_score,
            status: 'Draft',
            version: 1,
            last_confirmed_at: new Date().toISOString(),
            is_stale: false,
          };

          if (sopEmbedding) insertPayload.embedding = sopEmbedding;

          const { data: sopData, error: insertErr } = await supabase
            .from('skills_sops')
            .insert(insertPayload)
            .select()
            .single();

          if (!insertErr && sopData) {
            await createVersion(sopData.id, 'database_crawler', 'initial_extraction');
            if (sourceDocument) {
              await linkSopClaimsBestEffort({
                workspaceId,
                sopId: sopData.id,
                sourceDocumentId: sourceDocument.id,
              });
            }
            sopsExtracted++;
            logger.info(`[SUCCESS] [Database Crawler] Extracted SOP "${sopData.title}" from DB Routine ${routine.name}`);
          }
        }
      } catch (extractErr) {
        if (extractErr instanceof EmbeddingError) throw extractErr;
        logger.warn(`[WARN] [Database Crawler] Extraction skipped for DB routine ${routine.name}:`, (extractErr as Error).message);
      }

      await markDatabaseRoutineCrawled(routine.id, targetDb);
    }

    return { source: 'database', target_db: targetDb, queries_crawled: queriesCrawled, sops_extracted: sopsExtracted, status: 'success' };
  } catch (err) {
    logger.error('[ERROR] [Database Crawler] Error during crawl execution:', err);
    return { source: 'database', target_db: targetDb, queries_crawled: queriesCrawled, sops_extracted: sopsExtracted, status: 'error' };
  }
}
