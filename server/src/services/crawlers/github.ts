import { logger } from '../../logger.js';
import dotenv from 'dotenv';
import { supabase } from '../../config/supabase.js';
import { extractSOPFromThread } from '../extractor.js';
import { createVersion } from '../freshness.js';
import { generateEmbedding, recordEmbeddingFailure, EmbeddingError } from '../embeddings.js';
import { ssrfSafeFetch } from '../security/ssrfGuard.js';
import { handleRateLimitResponse } from '../../queue/rateLimiter.js';

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_ACCESS_TOKEN || process.env.GITHUB_TOKEN || '';

export interface GitHubIssueCrawlResult {
  source: 'github';
  repo: string;
  issues_crawled: number;
  sops_extracted: number;
  status: 'success' | 'skipped' | 'error';
}

async function isGitHubIssueCrawled(issueGlobalId: string, workspaceId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('crawled_sources')
      .select('id')
      .eq('source', 'github')
      .eq('external_id', issueGlobalId)
      .eq('workspace_id', workspaceId)
      .single();
    return !!data;
  } catch {
    return false;
  }
}

async function markGitHubIssueCrawledBatch(entries: Array<{ source: string; external_id: string; target: string; workspace_id: string }>): Promise<void> {
  if (entries.length === 0) return;
  try {
    await supabase.from('crawled_sources').insert(entries);
  } catch (err) {
    logger.warn('[GitHub Crawler] Failed batch deduplication insert:', err);
  }
}

/**
 * Async Generator streaming GitHub candidate issues in bounded memory batches.
 */
export async function* fetchGitHubIssuesStream(
  owner: string,
  repoName: string
): AsyncGenerator<any[], void, unknown> {
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues?state=closed&labels=incident,post-mortem,hotfix&per_page=30`;

  let attempt = 1;
  while (attempt <= 3) {
    try {
      const response = await ssrfSafeFetch(url, {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Company-Brain-Crawler',
        },
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        await handleRateLimitResponse(retryAfter, attempt);
        attempt++;
        continue;
      }

      if (!response.ok) {
        logger.warn(`[WARN] [GitHub Crawler] API error (${response.status}): ${await response.text()}`);
        return;
      }

      const issues = (await response.json()) as any[];
      if (Array.isArray(issues) && issues.length > 0) {
        yield issues;
      }
      return;
    } catch (err) {
      logger.warn('[GitHub Crawler] Network error during issue stream:', err);
      attempt++;
    }
  }
}

/**
 * Crawls closed GitHub issues and pull requests with post-mortem/incident labels using bounded streaming & 100-batch DB writes.
 */
export async function crawlGithubPostMortems(
  repo: string = process.env.GITHUB_REPO || 'owner/repo',
  workspaceId: string = '00000000-0000-0000-0000-000000000000'
): Promise<GitHubIssueCrawlResult> {
  if (!GITHUB_TOKEN) {
    logger.info('[INFO] [GitHub Crawler] GITHUB_ACCESS_TOKEN not configured. Skipping active GitHub sweep.');
    return { source: 'github', repo, issues_crawled: 0, sops_extracted: 0, status: 'skipped' };
  }

  logger.info(`[INFO] [GitHub Crawler] Sweeping post-mortems and incident issues for repo: ${repo}...`);

  let sopsExtracted = 0;
  let issuesCrawled = 0;

  try {
    const [owner, repoName] = repo.split('/');
    if (!owner || !repoName) {
      return { source: 'github', repo, issues_crawled: 0, sops_extracted: 0, status: 'error' };
    }

    const deduplicationBatch: Array<{ source: string; external_id: string; target: string; workspace_id: string }> = [];

    for await (const issueBatch of fetchGitHubIssuesStream(owner, repoName)) {
      for (const issue of issueBatch) {
        const issueId = `github_${repo}_${issue.number}`;

        if (await isGitHubIssueCrawled(issueId, workspaceId)) continue;
        issuesCrawled++;

        let commentsText = '';
        if (issue.comments > 0 && issue.comments_url) {
          try {
            const commentsRes = await ssrfSafeFetch(`${issue.comments_url}?per_page=10`, {
              headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Company-Brain-Crawler',
              },
            });

            if (commentsRes.status === 429) {
              await handleRateLimitResponse(commentsRes.headers.get('Retry-After'), 1);
            } else if (commentsRes.ok) {
              const comments = (await commentsRes.json()) as any[];
              commentsText = comments.map((c) => `[${c.user?.login || 'commenter'}]: ${c.body}`).join('\n');
            }
          } catch (err) {
            logger.warn(`[WARN] [GitHub Crawler] Comments fetch error for issue #${issue.number}:`, err);
          }
        }

        const issueTranscript = [
          { user: issue.user?.login || 'author', text: `Issue Title: ${issue.title}\nBody: ${issue.body || ''}` },
          ...(commentsText ? [{ user: 'system_comments', text: commentsText }] : []),
        ];

        try {
          const extractedSOP = await extractSOPFromThread(issueTranscript, workspaceId, 'github');
          if (extractedSOP && extractedSOP.is_valid_sop && extractedSOP.confidence_score >= 0.4) {
            let sopEmbedding: number[] | null = null;
            try {
              sopEmbedding = await generateEmbedding(`${extractedSOP.title}: ${extractedSOP.trigger_condition}`);
            } catch (embErr) {
              await recordEmbeddingFailure({
                workspaceId,
                source: 'github',
                rawContent: `${extractedSOP.title}: ${extractedSOP.trigger_condition}`,
                error: embErr,
              });
              throw embErr;
            }

            const insertPayload: Record<string, any> = {
              workspace_id: workspaceId,
              title: extractedSOP.title,
              category: extractedSOP.category,
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
              await createVersion(sopData.id, 'github_crawler', 'initial_extraction');
              sopsExtracted++;
            }
          }
        } catch (extractErr) {
          if (extractErr instanceof EmbeddingError) throw extractErr;
          logger.warn(`[WARN] [GitHub Crawler] Extraction skipped for issue #${issue.number}:`, (extractErr as Error).message);
        }

        deduplicationBatch.push({ source: 'github', external_id: issueId, target: repo, workspace_id: workspaceId });

        // Batch database writes in chunks of 100 records
        if (deduplicationBatch.length >= 100) {
          await markGitHubIssueCrawledBatch(deduplicationBatch);
          deduplicationBatch.length = 0;
        }
      }
    }

    if (deduplicationBatch.length > 0) {
      await markGitHubIssueCrawledBatch(deduplicationBatch);
    }

    return { source: 'github', repo, issues_crawled: issuesCrawled, sops_extracted: sopsExtracted, status: 'success' };
  } catch (err) {
    logger.error('[ERROR] [GitHub Crawler] Error during crawl execution:', err);
    return { source: 'github', repo, issues_crawled: issuesCrawled, sops_extracted: sopsExtracted, status: 'error' };
  }
}
