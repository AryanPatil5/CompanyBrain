import dotenv from 'dotenv';
import { supabase } from '../../config/supabase.js';
import { extractSOPFromThread } from '../extractor.js';
import { createVersion } from '../freshness.js';
import { generateEmbedding } from '../embeddings.js';

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_ACCESS_TOKEN || process.env.GITHUB_TOKEN || '';

export interface GitHubIssueCrawlResult {
  source: 'github';
  repo: string;
  issues_crawled: number;
  sops_extracted: number;
  status: 'success' | 'skipped' | 'error';
}

/**
 * Checks if a GitHub issue/PR ID has already been processed in `crawled_sources`.
 */
async function isGitHubIssueCrawled(issueGlobalId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('crawled_sources')
      .select('id')
      .eq('source', 'github')
      .eq('external_id', issueGlobalId)
      .single();
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Marks a GitHub issue ID as processed in `crawled_sources`.
 */
async function markGitHubIssueCrawled(issueGlobalId: string, repo: string): Promise<void> {
  try {
    await supabase.from('crawled_sources').insert({
      source: 'github',
      external_id: issueGlobalId,
      target: repo,
    });
  } catch (err) {
    console.warn('[GitHub Crawler] Failed to record deduplication entry:', err);
  }
}

/**
 * Crawls closed GitHub issues and pull requests with post-mortem/incident labels.
 */
export async function crawlGithubPostMortems(
  repo: string = process.env.GITHUB_REPO || 'owner/repo',
  workspaceId: string = '00000000-0000-0000-0000-000000000000'
): Promise<GitHubIssueCrawlResult> {
  if (!GITHUB_TOKEN) {
    console.log('[INFO] [GitHub Crawler] GITHUB_ACCESS_TOKEN not configured. Skipping active GitHub sweep.');
    return { source: 'github', repo, issues_crawled: 0, sops_extracted: 0, status: 'skipped' };
  }

  console.log(`[INFO] [GitHub Crawler] Sweeping post-mortems and incident issues for repo: ${repo}...`);

  let sopsExtracted = 0;
  let issuesCrawled = 0;

  try {
    const [owner, repoName] = repo.split('/');
    if (!owner || !repoName) {
      console.warn(`[WARN] [GitHub Crawler] Invalid repo format: "${repo}". Expected "owner/repo".`);
      return { source: 'github', repo, issues_crawled: 0, sops_extracted: 0, status: 'error' };
    }

    // Query closed issues with incident / post-mortem / hotfix labels via GitHub REST API
    const url = `https://api.github.com/repos/${owner}/${repoName}/issues?state=closed&labels=incident,post-mortem,hotfix&per_page=30`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Company-Brain-Crawler',
      },
    });

    if (!response.ok) {
      console.warn(`[WARN] [GitHub Crawler] API error (${response.status}): ${await response.text()}`);
      return { source: 'github', repo, issues_crawled: 0, sops_extracted: 0, status: 'error' };
    }

    const issues = (await response.json()) as any[];
    console.log(`[INFO] [GitHub Crawler] Found ${issues.length} candidate issues/PRs in ${repo}.`);

    for (const issue of issues) {
      const issueId = `github_${repo}_${issue.number}`;

      // Deduplication check
      if (await isGitHubIssueCrawled(issueId)) {
        continue;
      }

      issuesCrawled++;

      // Fetch comments for full resolution context
      let commentsText = '';
      if (issue.comments > 0 && issue.comments_url) {
        try {
          const commentsRes = await fetch(`${issue.comments_url}?per_page=10`, {
            headers: {
              'Authorization': `Bearer ${GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'Company-Brain-Crawler',
            },
          });
          if (commentsRes.ok) {
            const comments = (await commentsRes.json()) as any[];
            commentsText = comments.map((c) => `[${c.user?.login || 'commenter'}]: ${c.body}`).join('\n');
          }
        } catch (err) {
          console.warn(`[WARN] [GitHub Crawler] Failed to fetch comments for issue #${issue.number}:`, err);
        }
      }

      const issueTranscript = [
        { user: issue.user?.login || 'author', text: `Issue Title: ${issue.title}\nBody: ${issue.body || ''}` },
        ...(commentsText ? [{ user: 'system_comments', text: commentsText }] : []),
      ];

      // Extract SOP via LLM
      try {
        const extractedSOP = await extractSOPFromThread(issueTranscript, workspaceId, 'github');

        if (extractedSOP && extractedSOP.is_valid_sop && extractedSOP.confidence_score >= 0.4) {
          const sopEmbedding = await generateEmbedding(`${extractedSOP.title}: ${extractedSOP.trigger_condition}`);

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
            console.log(`[SUCCESS] [GitHub Crawler] Extracted SOP "${sopData.title}" from Issue #${issue.number}`);
          }
        }
      } catch (extractErr) {
        console.warn(`[WARN] [GitHub Crawler] Extraction skipped for issue #${issue.number}:`, (extractErr as Error).message);
      }

      // Mark as processed in deduplication table
      await markGitHubIssueCrawled(issueId, repo);
    }

    return { source: 'github', repo, issues_crawled: issuesCrawled, sops_extracted: sopsExtracted, status: 'success' };
  } catch (err) {
    console.error('[ERROR] [GitHub Crawler] Error during crawl execution:', err);
    return { source: 'github', repo, issues_crawled: issuesCrawled, sops_extracted: sopsExtracted, status: 'error' };
  }
}
