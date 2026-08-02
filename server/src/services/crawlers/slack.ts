import dotenv from 'dotenv';
import { supabase } from '../../config/supabase.js';
import { extractSOPFromThread } from '../extractor.js';
import { createVersion } from '../freshness.js';
import { generateEmbedding } from '../embeddings.js';

dotenv.config();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN || '';

export interface SlackMessage {
  user: string;
  text: string;
  ts?: string;
  reply_count?: number;
}

export interface SlackThread {
  thread_ts: string;
  channel: string;
  reply_count: number;
  messages: SlackMessage[];
}

export interface SlackCrawlResult {
  source: 'slack';
  channel: string;
  threads_crawled: number;
  sops_extracted: number;
  status: 'success' | 'skipped' | 'error';
}

/**
 * Text pattern heuristics for high-value operational procedures, post-mortems, and runbooks
 */
const SOP_SIGNAL_PATTERNS = [
  /resolution:/i,
  /mitigation:/i,
  /rollback:/i,
  /root\s*cause:/i,
  /\[P0\]/i,
  /\[P1\]/i,
  /sop:/i,
  /procedure:/i,
  /runbook:/i,
  /workaround:/i,
  /incident\s*override/i,
];

/**
 * Evaluates a Slack thread to determine if it is a high-confidence SOP candidate.
 * Heuristic rules:
 * 1. Thread message / reply count must be >= 4 (indicates active multi-turn problem solving).
 * 2. Thread text content must match explicit operational keywords ('resolution:', 'mitigation:', 'rollback:', '[P0]', '[P1]', etc.).
 */
export function isSOPCandidateSlackThread(thread: SlackThread): boolean {
  const totalReplies = thread.reply_count || thread.messages?.length || 0;
  if (totalReplies < 4) {
    return false;
  }

  const fullText = (thread.messages || []).map((m) => m.text || '').join(' ');
  return SOP_SIGNAL_PATTERNS.some((pattern) => pattern.test(fullText));
}

/**
 * Filters a collection of Slack threads down to high-confidence SOP candidates.
 */
export async function processSlackThreadCandidates(threads: SlackThread[]): Promise<SlackThread[]> {
  return threads.filter(isSOPCandidateSlackThread);
}

/**
 * Checks if a Slack thread ts has already been processed in `crawled_sources`.
 */
async function isSlackThreadCrawled(threadTs: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('crawled_sources')
      .select('id')
      .eq('source', 'slack')
      .eq('external_id', threadTs)
      .single();
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Marks a Slack thread ts as processed in `crawled_sources`.
 */
async function markSlackThreadCrawled(threadTs: string, channelId: string): Promise<void> {
  try {
    await supabase.from('crawled_sources').insert({
      source: 'slack',
      external_id: threadTs,
      target: channelId,
    });
  } catch (err) {
    console.warn('[Slack Crawler] Failed to record deduplication entry:', err);
  }
}

/**
 * Crawls historical Slack message threads in an incident/ops channel using Slack Web API.
 */
export async function crawlSlackHistory(
  channelId: string = process.env.SLACK_INCIDENT_CHANNEL_ID || 'C0123456789',
  workspaceId: string = '00000000-0000-0000-0000-000000000000'
): Promise<SlackCrawlResult> {
  if (!SLACK_BOT_TOKEN) {
    console.log('[INFO] [Slack Crawler] SLACK_BOT_TOKEN not configured. Skipping active Slack history sweep.');
    return { source: 'slack', channel: channelId, threads_crawled: 0, sops_extracted: 0, status: 'skipped' };
  }

  console.log(`[INFO] [Slack Crawler] Sweeping channel history for Slack channel: ${channelId}...`);

  let threadsCrawled = 0;
  let sopsExtracted = 0;

  try {
    // 1. Fetch channel message history via Slack Web API (conversations.history)
    const historyUrl = `https://slack.com/api/conversations.history?channel=${channelId}&limit=50`;
    const response = await fetch(historyUrl, {
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      console.warn(`[WARN] [Slack Crawler] Web API error (${response.status}): ${await response.text()}`);
      return { source: 'slack', channel: channelId, threads_crawled: 0, sops_extracted: 0, status: 'error' };
    }

    const data = (await response.json()) as any;
    if (!data.ok) {
      console.warn(`[WARN] [Slack Crawler] Slack API error: ${data.error || 'Unknown error'}`);
      return { source: 'slack', channel: channelId, threads_crawled: 0, sops_extracted: 0, status: 'error' };
    }

    const messages = (data.messages || []) as any[];
    // Filter to parent messages that have replies
    const parentMessages = messages.filter((m) => m.reply_count && m.reply_count >= 3);

    console.log(`[INFO] [Slack Crawler] Found ${parentMessages.length} parent threads with replies in ${channelId}.`);

    for (const parent of parentMessages) {
      const threadTs = `slack_${channelId}_${parent.ts}`;

      // Deduplication check
      if (await isSlackThreadCrawled(threadTs)) {
        continue;
      }

      threadsCrawled++;

      // 2. Fetch full thread reply messages via conversations.replies
      let threadMessages: SlackMessage[] = [];
      try {
        const repliesUrl = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${parent.ts}`;
        const repliesRes = await fetch(repliesUrl, {
          headers: {
            'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });

        if (repliesRes.ok) {
          const repliesData = (await repliesRes.json()) as any;
          if (repliesData.ok && Array.isArray(repliesData.messages)) {
            threadMessages = repliesData.messages.map((m: any) => ({
              user: m.user || m.username || 'slack_user',
              text: m.text || '',
              ts: m.ts,
            }));
          }
        }
      } catch (replyErr) {
        console.warn(`[WARN] [Slack Crawler] Failed to fetch replies for thread ${parent.ts}:`, replyErr);
        threadMessages = [{ user: parent.user || 'slack_user', text: parent.text || '', ts: parent.ts }];
      }

      const threadObj: SlackThread = {
        thread_ts: parent.ts,
        channel: channelId,
        reply_count: parent.reply_count || threadMessages.length,
        messages: threadMessages,
      };

      // 3. Evaluate heuristic filter (>= 4 messages & operational keywords)
      if (!isSOPCandidateSlackThread(threadObj)) {
        await markSlackThreadCrawled(threadTs, channelId);
        continue;
      }

      // 4. Extract SOP via LLM
      try {
        const extractedSOP = await extractSOPFromThread(threadMessages, workspaceId, 'slack');

        if (extractedSOP && extractedSOP.is_valid_sop && extractedSOP.confidence_score >= 0.4) {
          const sopEmbedding = await generateEmbedding(`${extractedSOP.title}: ${extractedSOP.trigger_condition}`);

          const insertPayload: Record<string, any> = {
            workspace_id: workspaceId,
            title: extractedSOP.title,
            category: extractedSOP.category || 'Operations',
            trigger_condition: extractedSOP.trigger_condition,
            preconditions: extractedSOP.preconditions,
            execution_steps: extractedSOP.execution_steps,
            risk_level: extractedSOP.risk_level || 'High',
            requires_human_gate: extractedSOP.requires_human_gate || true,
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
            await createVersion(sopData.id, 'slack_crawler', 'initial_extraction');
            sopsExtracted++;
            console.log(`[SUCCESS] [Slack Crawler] Extracted SOP "${sopData.title}" from Slack thread ${parent.ts}`);
          }
        }
      } catch (extractErr) {
        console.warn(`[WARN] [Slack Crawler] Extraction skipped for thread ${parent.ts}:`, (extractErr as Error).message);
      }

      // Mark as processed in deduplication table
      await markSlackThreadCrawled(threadTs, channelId);
    }

    return { source: 'slack', channel: channelId, threads_crawled: threadsCrawled, sops_extracted: sopsExtracted, status: 'success' };
  } catch (err) {
    console.error('[ERROR] [Slack Crawler] Error during crawl execution:', err);
    return { source: 'slack', channel: channelId, threads_crawled: threadsCrawled, sops_extracted: sopsExtracted, status: 'error' };
  }
}
