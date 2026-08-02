import dotenv from 'dotenv';
import { supabase } from '../config/supabase.js';

dotenv.config();

/**
 * Background Crawler Worker Service (Skeleton Architecture)
 * 
 * Periodically polls historical team communications across Slack channels,
 * GitHub post-mortem issues/PRs, and Linear incident tickets to pull tacit knowledge
 * into raw_threads for automated SOP extraction.
 */

let crawlerTimer: NodeJS.Timeout | null = null;
const CRAWL_INTERVAL_MS = parseInt(process.env.CRAWL_INTERVAL_MS || '300000', 10); // Default: every 5 minutes

export interface CrawlResult {
  source: string;
  target: string;
  threads_ingested: number;
  status: 'stubbed' | 'success' | 'failed';
}

/**
 * Historical Slack Channel Poller Stub
 * 
 * TODO: Requires Slack App with Bot Token permissions:
 * - `channels:history` (read public channel message history)
 * - `groups:history` (read private channel message history)
 * - `users:read` (resolve user display names)
 */
export async function crawlSlackHistory(channelId: string = 'C0123456789'): Promise<CrawlResult> {
  console.log(`[Crawler Stub] Polling Slack history for channel: ${channelId}...`);

  // TODO: Replace stub with Slack Web API client:
  // const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  // const result = await slackClient.conversations.history({ channel: channelId, limit: 50 });
  // Store raw conversations into `raw_threads` table with source: 'slack'

  return {
    source: 'slack',
    target: channelId,
    threads_ingested: 0,
    status: 'stubbed',
  };
}

/**
 * GitHub Post-Mortem & Incident Issue Poller Stub
 * 
 * TODO: Requires GitHub OAuth / App installation with scopes:
 * - `repo` (Full control of private repositories to read post-mortem issues & incident PRs)
 * - `read:org` (Read organization team discussions)
 */
export async function crawlGithubPostMortems(repo: string = 'org/repo'): Promise<CrawlResult> {
  console.log(`[Crawler Stub] Polling GitHub post-mortem issues for repo: ${repo}...`);

  // TODO: Replace stub with Octokit REST API client:
  // const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  // const issues = await octokit.rest.issues.listForRepo({ owner, repo, labels: 'post-mortem,incident' });
  // Store raw issue threads into `raw_threads` table with source: 'github'

  return {
    source: 'github',
    target: repo,
    threads_ingested: 0,
    status: 'stubbed',
  };
}

/**
 * Linear Incident & Outage Ticket Poller Stub
 * 
 * TODO: Requires Linear API Key or OAuth 2.0 with scopes:
 * - `read` (Read access to Linear issues, projects, and comments)
 * - Filter issues by label: 'Outage', 'Incident', 'SOP-Candidate'
 */
export async function crawlLinearIncidents(): Promise<CrawlResult> {
  console.log('[Crawler Stub] Polling Linear incident tickets...');

  // TODO: Replace stub with Linear SDK client:
  // const linearClient = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
  // const issues = await linearClient.issues({ filter: { labels: { name: { in: ["Incident", "Outage"] } } } });
  // Store ticket conversations into `raw_threads` table with source: 'linear'

  return {
    source: 'linear',
    target: 'all_teams',
    threads_ingested: 0,
    status: 'stubbed',
  };
}

/**
 * Executes a single crawler cycle across all configured sources.
 */
export async function runCrawlCycle(): Promise<void> {
  console.log('[Crawler Worker] Running background crawl cycle for historical knowledge...');
  try {
    await crawlSlackHistory();
    await crawlGithubPostMortems();
    await crawlLinearIncidents();
    console.log('[Crawler Worker] Background crawl cycle complete (stubbed mode).');
  } catch (err) {
    console.error('[Crawler Worker Error] Failures during crawl cycle:', err);
  }
}

/**
 * Starts the periodic background crawler worker.
 */
export function startCrawlerWorker(): void {
  if (crawlerTimer) return;
  console.log(`[Crawler Service] Initializing active crawler worker (Interval: ${CRAWL_INTERVAL_MS}ms)...`);

  // Run initial crawl cycle asynchronously
  void runCrawlCycle();

  // Schedule recurring polling loop
  crawlerTimer = setInterval(() => {
    void runCrawlCycle();
  }, CRAWL_INTERVAL_MS);
}

/**
 * Stops the background crawler worker.
 */
export function stopCrawlerWorker(): void {
  if (crawlerTimer) {
    clearInterval(crawlerTimer);
    crawlerTimer = null;
    console.log('[Crawler Service] Background crawler worker stopped.');
  }
}
