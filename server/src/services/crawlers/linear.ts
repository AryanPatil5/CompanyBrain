import dotenv from 'dotenv';
import { supabase } from '../../config/supabase.js';
import { extractSOPFromThread } from '../extractor.js';
import { createVersion } from '../freshness.js';
import { generateEmbedding } from '../embeddings.js';

dotenv.config();

const LINEAR_API_KEY = process.env.LINEAR_API_KEY || '';

export interface LinearCrawlResult {
  source: 'linear';
  issues_crawled: number;
  sops_extracted: number;
  status: 'success' | 'skipped' | 'error';
}

/**
 * Checks if a Linear issue ID has already been processed in `crawled_sources`.
 */
async function isLinearIssueCrawled(linearIssueId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('crawled_sources')
      .select('id')
      .eq('source', 'linear')
      .eq('external_id', linearIssueId)
      .single();
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Marks a Linear issue ID as processed in `crawled_sources`.
 */
async function markLinearIssueCrawled(linearIssueId: string, teamKey?: string): Promise<void> {
  try {
    await supabase.from('crawled_sources').insert({
      source: 'linear',
      external_id: linearIssueId,
      target: teamKey || 'all_teams',
    });
  } catch (err) {
    console.warn('[Linear Crawler] Failed to record deduplication entry:', err);
  }
}

/**
 * Crawls completed high-priority Linear tickets (P0/P1) for incident remediation SOPs.
 */
export async function crawlLinearIncidents(
  workspaceId: string = '00000000-0000-0000-0000-000000000000'
): Promise<LinearCrawlResult> {
  if (!LINEAR_API_KEY) {
    console.log('[INFO] [Linear Crawler] LINEAR_API_KEY not configured. Skipping active Linear incident sweep.');
    return { source: 'linear', issues_crawled: 0, sops_extracted: 0, status: 'skipped' };
  }

  console.log('[INFO] [Linear Crawler] Sweeping high-priority (P0/P1) incident tickets from Linear GraphQL API...');

  let sopsExtracted = 0;
  let issuesCrawled = 0;

  try {
    // Linear GraphQL Query to fetch completed issues with high priority (priority 1 = Urgent/P0, priority 2 = High/P1)
    const graphqlQuery = {
      query: `
        query {
          issues(
            filter: {
              state: { type: { eq: "completed" } }
              priority: { in: [1, 2] }
            }
            first: 30
          ) {
            nodes {
              id
              identifier
              title
              description
              priority
              team {
                name
                key
              }
              comments {
                nodes {
                  user {
                    name
                  }
                  body
                  createdAt
                }
              }
            }
          }
        }
      `,
    };

    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': LINEAR_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(graphqlQuery),
    });

    if (!response.ok) {
      console.warn(`[WARN] [Linear Crawler] GraphQL API error (${response.status}): ${await response.text()}`);
      return { source: 'linear', issues_crawled: 0, sops_extracted: 0, status: 'error' };
    }

    const result = await response.json();
    const issues = result?.data?.issues?.nodes || [];

    console.log(`[INFO] [Linear Crawler] Found ${issues.length} completed high-priority Linear tickets.`);

    for (const issue of issues) {
      const issueId = `linear_${issue.id || issue.identifier}`;

      // Deduplication check
      if (await isLinearIssueCrawled(issueId)) {
        continue;
      }

      issuesCrawled++;

      const commentNodes = issue.comments?.nodes || [];
      const commentsText = commentNodes
        .map((c: any) => `[${c.user?.name || 'team_member'}]: ${c.body}`)
        .join('\n');

      const ticketTranscript = [
        {
          user: issue.team?.name || 'Linear Ticket',
          text: `Ticket: ${issue.identifier} - ${issue.title}\nDescription: ${issue.description || ''}`,
        },
        ...(commentsText ? [{ user: 'triage_comments', text: commentsText }] : []),
      ];

      // Extract SOP via LLM
      try {
        const extractedSOP = await extractSOPFromThread(ticketTranscript, workspaceId, 'linear');

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
            await createVersion(sopData.id, 'linear_crawler', 'initial_extraction');
            sopsExtracted++;
            console.log(`[SUCCESS] [Linear Crawler] Extracted SOP "${sopData.title}" from Ticket ${issue.identifier}`);
          }
        }
      } catch (extractErr) {
        console.warn(`[WARN] [Linear Crawler] Extraction skipped for Linear ticket ${issue.identifier}:`, (extractErr as Error).message);
      }

      // Mark as processed in deduplication table
      await markLinearIssueCrawled(issueId, issue.team?.key);
    }

    return { source: 'linear', issues_crawled: issuesCrawled, sops_extracted: sopsExtracted, status: 'success' };
  } catch (err) {
    console.error('[ERROR] [Linear Crawler] Error during crawl execution:', err);
    return { source: 'linear', issues_crawled: issuesCrawled, sops_extracted: sopsExtracted, status: 'error' };
  }
}
