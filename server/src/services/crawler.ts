import dotenv from 'dotenv';
import { supabase } from '../config/supabase.js';
import { crawlSlackHistory, isSOPCandidateSlackThread, processSlackThreadCandidates, type SlackThread } from './crawlers/slack.js';
import { crawlGithubPostMortems } from './crawlers/github.js';
import { crawlLinearIncidents } from './crawlers/linear.js';
import { crawlEmailInbox } from './crawlers/email.js';
import { crawlDatabaseLogs } from './crawlers/database.js';
import { crawlZendeskTickets } from './crawlers/zendesk.js';
import { markStaleSOPs } from './freshness.js';

dotenv.config();

export {
  crawlSlackHistory,
  crawlGithubPostMortems,
  crawlLinearIncidents,
  crawlEmailInbox,
  crawlDatabaseLogs,
  crawlZendeskTickets,
  isSOPCandidateSlackThread,
  processSlackThreadCandidates,
  type SlackThread,
};

let crawlerTimer: NodeJS.Timeout | null = null;
const CRAWL_INTERVAL_MS = parseInt(process.env.CRAWL_INTERVAL_MS || '3600000', 10); // Default: every 1 hour (3600000ms)

/**
 * Executes a single complete crawler cycle across all active historical sources per workspace & staleness sweep.
 */
export async function runCrawlCycle(): Promise<void> {
  console.log('[INFO] [Crawler Worker] Running background historical knowledge crawl cycle across Slack, GitHub, Linear, Zendesk, Email & Database...');
  try {
    const slackRes = await crawlSlackHistory();
    const githubRes = await crawlGithubPostMortems();
    const linearRes = await crawlLinearIncidents();
    const zendeskRes = await crawlZendeskTickets();
    const dbRes = await crawlDatabaseLogs();

    // Query all connected workspace IDs for Gmail crawling (Gap M)
    const { data: credentials } = await supabase
      .from('integration_credentials')
      .select('workspace_id')
      .eq('provider', 'gmail')
      .eq('status', 'connected');

    const targetWorkspaces = credentials && credentials.length > 0
      ? Array.from(new Set(credentials.map((c) => c.workspace_id)))
      : ['00000000-0000-0000-0000-000000000000'];

    let totalEmailCrawled = 0;
    let totalEmailSOPs = 0;

    for (const wsId of targetWorkspaces) {
      const emailRes = await crawlEmailInbox(process.env.OPS_INBOX_EMAIL || 'ops-support@company.com', wsId);
      totalEmailCrawled += emailRes.threads_crawled;
      totalEmailSOPs += emailRes.sops_extracted;
    }

    // Perform background knowledge freshness & staleness sweep (30-day threshold)
    const staleCount = await markStaleSOPs(30);

    console.log('[INFO] [Crawler Worker] Background crawl cycle & staleness sweep complete:', {
      slack: slackRes.status,
      github: githubRes.status,
      linear: linearRes.status,
      zendesk: zendeskRes.status,
      email: { crawled: totalEmailCrawled, sops: totalEmailSOPs },
      database: dbRes.status,
      stale_sops_marked: staleCount,
    });
  } catch (err) {
    console.error('[ERROR] [Crawler Worker] Failures during crawl cycle:', err);
  }
}

/**
 * Starts the periodic background crawler worker on server boot.
 */
export function startCrawlerWorker(): void {
  if (crawlerTimer) return;
  console.log(`[INFO] [Crawler Worker] Initializing active crawler worker (Recurring interval: ${CRAWL_INTERVAL_MS}ms)...`);

  void runCrawlCycle();

  crawlerTimer = setInterval(() => {
    void runCrawlCycle();
  }, CRAWL_INTERVAL_MS);
}

/**
 * Stops the background crawler worker cleanly on process shutdown.
 */
export function stopCrawlerWorker(): void {
  if (crawlerTimer) {
    clearInterval(crawlerTimer);
    crawlerTimer = null;
    console.log('[INFO] [Crawler Worker] Background crawler worker stopped.');
  }
}
