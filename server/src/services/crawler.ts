import dotenv from 'dotenv';
import { crawlSlackHistory, isSOPCandidateSlackThread, processSlackThreadCandidates, type SlackThread } from './crawlers/slack.js';
import { crawlGithubPostMortems } from './crawlers/github.js';
import { crawlLinearIncidents } from './crawlers/linear.js';

dotenv.config();

export {
  crawlSlackHistory,
  crawlGithubPostMortems,
  crawlLinearIncidents,
  isSOPCandidateSlackThread,
  processSlackThreadCandidates,
  type SlackThread,
};

/**
 * Background Crawler Worker Service
 * 
 * Periodically polls historical team communications across Slack channels,
 * GitHub post-mortem issues/PRs, and Linear incident tickets to pull tacit knowledge
 * into Company Brain SOP drafts. Deduplicates processed items using public.crawled_sources.
 */

let crawlerTimer: NodeJS.Timeout | null = null;
const CRAWL_INTERVAL_MS = parseInt(process.env.CRAWL_INTERVAL_MS || '3600000', 10); // Default: every 1 hour (3600000ms)

/**
 * Executes a single complete crawler cycle across all configured sources.
 */
export async function runCrawlCycle(): Promise<void> {
  console.log('[INFO] [Crawler Worker] Running background historical knowledge crawl cycle across Slack, GitHub & Linear...');
  try {
    const slackRes = await crawlSlackHistory();
    const githubRes = await crawlGithubPostMortems();
    const linearRes = await crawlLinearIncidents();

    console.log('[INFO] [Crawler Worker] Background crawl cycle complete:', {
      slack: slackRes.status,
      github: githubRes.status,
      linear: linearRes.status,
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
