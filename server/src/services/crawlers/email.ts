import { logger } from '../../logger.js';
import dotenv from 'dotenv';
import { supabase } from '../../config/supabase.js';
import { processThreadTail } from '../../ingestion/documentPipeline.js';
import { linkSopClaimsBestEffort } from '../../knowledge/claimProvenance.js';
import { createVersion } from '../freshness.js';
import { generateEmbedding, recordEmbeddingFailure, EmbeddingError } from '../embeddings.js';
import { getIntegrationCredential, storeIntegrationCredential } from '../integrations/secrets.js';
import { ssrfSafeFetch } from '../security/ssrfGuard.js';

dotenv.config();

const GMAIL_TOKEN = process.env.GMAIL_API_TOKEN || process.env.MS_GRAPH_TOKEN || '';

export interface EmailCrawlResult {
  source: 'email';
  inbox: string;
  threads_crawled: number;
  sops_extracted: number;
  status: 'success' | 'skipped' | 'error';
}

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

async function markEmailThreadCrawled(emailId: string, inbox: string): Promise<void> {
  try {
    await supabase.from('crawled_sources').insert({
      source: 'email',
      external_id: emailId,
      target: inbox,
    });
  } catch (err) {
    logger.warn('[Email Crawler] Failed to record deduplication entry:', err);
  }
}

/**
 * Helper to refresh expired Gmail access tokens via Google OAuth API (Gap N)
 */
async function refreshGmailAccessToken(workspaceId: string, refreshToken: string): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    logger.info(`[Email Crawler] Refreshing expired Gmail OAuth access token for workspace ${workspaceId}...`);
    const res = await ssrfSafeFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      logger.warn('[Email Crawler] Token refresh failed:', await res.text());
      return null;
    }

    const data = await res.json();
    const newAccessToken = data.access_token;

    if (newAccessToken) {
      await storeIntegrationCredential({
        workspace_id: workspaceId,
        provider: 'gmail',
        external_org_id: workspaceId,
        access_token: newAccessToken,
        refresh_token: refreshToken,
      });
      logger.info(`[Email Crawler] Successfully refreshed and updated Gmail OAuth token for workspace ${workspaceId}`);
      return newAccessToken;
    }
  } catch (err) {
    logger.error('[Email Crawler] Exception during token refresh:', err);
  }

  return null;
}

/**
 * Crawls shared ops inbox threads via Gmail / MS Graph REST APIs per workspace with token refresh logic.
 */
export async function crawlEmailInbox(
  inbox: string = process.env.OPS_INBOX_EMAIL || 'ops-support@company.com',
  workspaceId: string = '00000000-0000-0000-0000-000000000000'
): Promise<EmailCrawlResult> {
  let effectiveToken = GMAIL_TOKEN;
  let storedRefreshToken: string | null = null;

  // Attempt to fetch per-workspace OAuth token from integration_credentials
  try {
    const cred = await getIntegrationCredential(workspaceId, 'gmail');
    if (cred?.access_token) {
      effectiveToken = cred.access_token;
      storedRefreshToken = cred.refresh_token;
    }
  } catch {
    // Non-fatal fallback to env var
  }

  if (!effectiveToken) {
    logger.info('[INFO] [Email Crawler] GMAIL_API_TOKEN / Gmail OAuth token not configured. Skipping active email inbox sweep.');
    return { source: 'email', inbox, threads_crawled: 0, sops_extracted: 0, status: 'skipped' };
  }

  logger.info(`[INFO] [Email Crawler] Sweeping shared inbox threads for: ${inbox} (Workspace: ${workspaceId})...`);

  let sopsExtracted = 0;
  let threadsCrawled = 0;

  try {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=label:ops-runbook+OR+subject:incident&maxResults=20`;
    let response = await ssrfSafeFetch(url, {
      headers: {
        'Authorization': `Bearer ${effectiveToken}`,
        'Accept': 'application/json',
      },
    });

    // Handle token expiration (HTTP 401) with automatic token refresh (Gap N)
    if (response.status === 401 && storedRefreshToken) {
      const refreshedToken = await refreshGmailAccessToken(workspaceId, storedRefreshToken);
      if (refreshedToken) {
        effectiveToken = refreshedToken;
        response = await ssrfSafeFetch(url, {
          headers: {
            'Authorization': `Bearer ${effectiveToken}`,
            'Accept': 'application/json',
          },
        });
      }
    }

    if (!response.ok) {
      logger.warn(`[WARN] [Email Crawler] API error (${response.status}): ${await response.text()}`);
      return { source: 'email', inbox, threads_crawled: 0, sops_extracted: 0, status: 'error' };
    }

    const data = (await response.json()) as any;
    const messages = data.messages || [];

    logger.info(`[INFO] [Email Crawler] Found ${messages.length} candidate email threads in inbox.`);

    for (const msgRef of messages) {
      const emailId = `email_${msgRef.id}`;

      if (await isEmailThreadCrawled(emailId)) {
        continue;
      }

      threadsCrawled++;

      let emailTranscript: Array<{ user: string; text: string }> = [];
      try {
        const msgRes = await ssrfSafeFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgRef.id}`, {
          headers: { 'Authorization': `Bearer ${effectiveToken}` },
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
        logger.warn(`[WARN] [Email Crawler] Failed to fetch details for email ${msgRef.id}:`, fetchErr);
        continue;
      }

      if (emailTranscript.length === 0) continue;

      // Phase 3 (B1b): shared thread tail — persists source document +
      // chunks + grounded claims, then extracts the SOP (ONE
      // provider-agnostic implementation, shared with durable webhooks).
      try {
        const { sourceDocument, extractedSOP } = await processThreadTail({
          workspaceId,
          source: 'email',
          externalId: emailId,
          title: `email:${msgRef.id}`,
          messages: emailTranscript,
          sourceTrust: 'crawled',
        });

        if (extractedSOP && extractedSOP.is_valid_sop && extractedSOP.confidence_score >= 0.4) {
          let sopEmbedding: number[] | null = null;
          try {
            sopEmbedding = await generateEmbedding(`${extractedSOP.title}: ${extractedSOP.trigger_condition}`);
          } catch (embErr) {
            await recordEmbeddingFailure({
              workspaceId,
              source: 'email',
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
            await createVersion(sopData.id, 'email_crawler', 'initial_extraction');
            if (sourceDocument) {
              await linkSopClaimsBestEffort({
                workspaceId,
                sopId: sopData.id,
                sourceDocumentId: sourceDocument.id,
              });
            }
            sopsExtracted++;
            logger.info(`[SUCCESS] [Email Crawler] Extracted SOP "${sopData.title}" from Email ${msgRef.id}`);
          }
        }
      } catch (extractErr) {
        if (extractErr instanceof EmbeddingError) throw extractErr;
        logger.warn(`[WARN] [Email Crawler] Extraction skipped for email ${msgRef.id}:`, (extractErr as Error).message);
      }

      await markEmailThreadCrawled(emailId, inbox);
    }

    return { source: 'email', inbox, threads_crawled: threadsCrawled, sops_extracted: sopsExtracted, status: 'success' };
  } catch (err) {
    logger.error('[ERROR] [Email Crawler] Error during crawl execution:', err);
    return { source: 'email', inbox, threads_crawled: threadsCrawled, sops_extracted: sopsExtracted, status: 'error' };
  }
}
