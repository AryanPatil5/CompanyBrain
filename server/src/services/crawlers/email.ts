import dotenv from 'dotenv';
import { supabase } from '../../config/supabase.js';
import { extractSOPFromThread } from '../extractor.js';
import { createVersion } from '../freshness.js';
import { generateEmbedding } from '../embeddings.js';

dotenv.config();

const GMAIL_TOKEN = process.env.GMAIL_API_TOKEN || process.env.MS_GRAPH_TOKEN || '';

export interface EmailCrawlResult {
  source: 'email';
  inbox: string;
  threads_crawled: number;
  sops_extracted: number;
  status: 'success' | 'skipped' | 'error';
}

/**
 * Checks if an email thread/message ID has already been processed in `crawled_sources`.
 */
async function isEmailThreadCrawled(emailId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('crawled_sources')
      .select('id')
      .eq('source', 'email')
      .eq('external_id', emailId)
      .single();
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Marks an email message ID as processed in `crawled_sources`.
 */
async function markEmailThreadCrawled(emailId: string, inbox: string): Promise<void> {
  try {
    await supabase.from('crawled_sources').insert({
      source: 'email',
      external_id: emailId,
      target: inbox,
    });
  } catch (err) {
    console.warn('[Email Crawler] Failed to record deduplication entry:', err);
  }
}

/**
 * Crawls shared ops inbox threads via Gmail / MS Graph REST APIs per workspace.
 */
export async function crawlEmailInbox(
  inbox: string = process.env.OPS_INBOX_EMAIL || 'ops-support@company.com',
  workspaceId: string = '00000000-0000-0000-0000-000000000000'
): Promise<EmailCrawlResult> {
  let effectiveToken = GMAIL_TOKEN;

  // Attempt to fetch per-workspace OAuth token from integration_credentials
  try {
    const { data: cred } = await supabase
      .from('integration_credentials')
      .select('access_token_encrypted, refresh_token_encrypted')
      .eq('workspace_id', workspaceId)
      .eq('provider', 'gmail')
      .eq('status', 'connected')
      .single();

    if (cred?.access_token_encrypted) {
      effectiveToken = cred.access_token_encrypted.replace(/^enc:/, '');
    }
  } catch {
    // Non-fatal fallback to env var
  }

  if (!effectiveToken) {
    console.log('[INFO] [Email Crawler] GMAIL_API_TOKEN / Gmail OAuth token not configured. Skipping active email inbox sweep.');
    return { source: 'email', inbox, threads_crawled: 0, sops_extracted: 0, status: 'skipped' };
  }

  console.log(`[INFO] [Email Crawler] Sweeping shared inbox threads for: ${inbox}...`);

  let sopsExtracted = 0;
  let threadsCrawled = 0;

  try {
    // Gmail API / MS Graph API message query stub
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=label:ops-runbook+OR+subject:incident&maxResults=20`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GMAIL_TOKEN}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`[WARN] [Email Crawler] API error (${response.status}): ${await response.text()}`);
      return { source: 'email', inbox, threads_crawled: 0, sops_extracted: 0, status: 'error' };
    }

    const data = (await response.json()) as any;
    const messages = data.messages || [];

    console.log(`[INFO] [Email Crawler] Found ${messages.length} candidate email threads in inbox.`);

    for (const msgRef of messages) {
      const emailId = `email_${msgRef.id}`;

      if (await isEmailThreadCrawled(emailId)) {
        continue;
      }

      threadsCrawled++;

      // Fetch full message details
      let emailTranscript: Array<{ user: string; text: string }> = [];
      try {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgRef.id}`, {
          headers: { 'Authorization': `Bearer ${GMAIL_TOKEN}` },
        });

        if (msgRes.ok) {
          const msgDetail = await msgRes.json();
          const snippet = msgDetail.snippet || '';
          const headers = msgDetail.payload?.headers || [];
          const subject = headers.find((h: any) => h.name === 'Subject')?.value || 'Ops Procedure';
          const sender = headers.find((h: any) => h.name === 'From')?.value || 'Ops Lead';

          emailTranscript = [
            { user: sender, text: `Subject: ${subject}\nBody: ${snippet}` }
          ];
        }
      } catch (fetchErr) {
        console.warn(`[WARN] [Email Crawler] Failed to fetch details for email ${msgRef.id}:`, fetchErr);
        continue;
      }

      if (emailTranscript.length === 0) continue;

      // Extract SOP via LLM
      try {
        const extractedSOP = await extractSOPFromThread(emailTranscript, workspaceId, 'email');

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
            await createVersion(sopData.id, 'email_crawler', 'initial_extraction');
            sopsExtracted++;
            console.log(`[SUCCESS] [Email Crawler] Extracted SOP "${sopData.title}" from Email ${msgRef.id}`);
          }
        }
      } catch (extractErr) {
        console.warn(`[WARN] [Email Crawler] Extraction skipped for email ${msgRef.id}:`, (extractErr as Error).message);
      }

      await markEmailThreadCrawled(emailId, inbox);
    }

    return { source: 'email', inbox, threads_crawled: threadsCrawled, sops_extracted: sopsExtracted, status: 'success' };
  } catch (err) {
    console.error('[ERROR] [Email Crawler] Error during crawl execution:', err);
    return { source: 'email', inbox, threads_crawled: threadsCrawled, sops_extracted: sopsExtracted, status: 'error' };
  }
}
