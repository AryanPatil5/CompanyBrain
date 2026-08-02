import dotenv from 'dotenv';
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

/**
 * Background Crawler Worker Service
 * 
 * Periodically polls historical team communications across Slack channels,
 * GitHub post-mortem issues/PRs, Linear incident tickets, Zendesk tickets, Email shared inboxes,
 * and Database query logs to pull tacit knowledge into Company Brain SOP drafts.
 * Also performs recurring staleness sweeps via markStaleSOPs().
 */

let crawlerTimer: NodeJS.Timeout | null = null;
const CRAWL_INTERVAL_MS = parseInt(process.env.CRAWL_INTERVAL_MS || '3600000', 10); // Default: every 1 hour (3600000ms)

/**
 * Executes a single complete crawler cycle across all 6 active historical sources & staleness sweep.
 */
export async function runCrawlCycle(): Promise<void> {
  console.log('[INFO] [Crawler Worker] Running background historical knowledge crawl cycle across Slack, GitHub, Linear, Zendesk, Email & Database...');
  try {
    const slackRes = await crawlSlackHistory();
    const githubRes = await crawlGithubPostMortems();
    const linearRes = await crawlLinearIncidents();
    const zendeskRes = await crawlZendeskTickets();
    const emailRes = await crawlEmailInbox();
    const dbRes = await crawlDatabaseLogs();

    // Perform background knowledge freshness & staleness sweep (30-day threshold)
    const staleCount = await markStaleSOPs(30);

    console.log('[INFO] [Crawler Worker] Background crawl cycle & staleness sweep complete:', {
      slack: slackRes.status,
      github: githubRes.status,
      linear: linearRes.status,
      zendesk: zendeskRes.status,
      email: emailRes.status,
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

  // Run initial crawl cycle asynchronously on startup
  void runCrawlCycle();

  // Schedule recurring polling loop
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
