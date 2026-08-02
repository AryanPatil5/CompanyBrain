import dotenv from 'dotenv';
import { supabase } from '../../config/supabase.js';
import { extractSOPFromThread } from '../extractor.js';
import { createVersion } from '../freshness.js';
import { generateEmbedding } from '../embeddings.js';

dotenv.config();

const ZENDESK_TOKEN = process.env.ZENDESK_API_TOKEN || process.env.ZENDESK_TOKEN || '';
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || 'company';
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL || 'support@company.com';

export interface ZendeskCrawlResult {
  source: 'zendesk';
  tickets_crawled: number;
  sops_extracted: number;
  status: 'success' | 'skipped' | 'error';
}

/**
 * Checks if a Zendesk ticket ID has already been processed in `crawled_sources`.
 */
async function isZendeskTicketCrawled(ticketId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('crawled_sources')
      .select('id')
      .eq('source', 'zendesk')
      .eq('external_id', ticketId)
      .single();
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Marks a Zendesk ticket ID as processed in `crawled_sources`.
 */
async function markZendeskTicketCrawled(ticketId: string): Promise<void> {
  try {
    await supabase.from('crawled_sources').insert({
      source: 'zendesk',
      external_id: ticketId,
      target: ZENDESK_SUBDOMAIN,
    });
  } catch (err) {
    console.warn('[Zendesk Crawler] Failed to record deduplication entry:', err);
  }
}

/**
 * Crawls solved Zendesk tickets and internal resolution notes via Zendesk Search API.
 */
export async function crawlZendeskTickets(
  workspaceId: string = '00000000-0000-0000-0000-000000000000'
): Promise<ZendeskCrawlResult> {
  if (!ZENDESK_TOKEN) {
    console.log('[INFO] [Zendesk Crawler] ZENDESK_API_TOKEN not configured. Skipping active Zendesk tickets sweep.');
    return { source: 'zendesk', tickets_crawled: 0, sops_extracted: 0, status: 'skipped' };
  }

  console.log(`[INFO] [Zendesk Crawler] Sweeping solved tickets via Zendesk Search API (${ZENDESK_SUBDOMAIN}.zendesk.com)...`);

  let sopsExtracted = 0;
  let ticketsCrawled = 0;

  try {
    const authHeader = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
    const searchUrl = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/search.json?query=type:ticket status:solved`;

    const response = await fetch(searchUrl, {
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`[WARN] [Zendesk Crawler] API error (${response.status}): ${await response.text()}`);
      return { source: 'zendesk', tickets_crawled: 0, sops_extracted: 0, status: 'error' };
    }

    const data = (await response.json()) as any;
    const tickets = data.results || [];

    console.log(`[INFO] [Zendesk Crawler] Found ${tickets.length} solved candidate tickets.`);

    for (const ticket of tickets) {
      const ticketId = `zendesk_${ticket.id}`;

      if (await isZendeskTicketCrawled(ticketId)) {
        continue;
      }

      ticketsCrawled++;

      // Fetch comments & internal notes
      let commentsText = '';
      try {
        const commentsRes = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket.id}/comments.json`, {
          headers: { 'Authorization': `Basic ${authHeader}` },
        });
        if (commentsRes.ok) {
          const cData = await commentsRes.json();
          const comments = cData.comments || [];
          commentsText = comments.map((c: any) => `[Comment by ${c.author_id}]: ${c.body}`).join('\n');
        }
      } catch (err) {
        console.warn(`[WARN] [Zendesk Crawler] Failed to fetch comments for ticket #${ticket.id}:`, err);
      }

      const ticketTranscript = [
        { user: 'support_agent', text: `Subject: ${ticket.subject}\nDescription: ${ticket.description || ''}` },
        ...(commentsText ? [{ user: 'ticket_notes', text: commentsText }] : []),
      ];

      try {
        const extractedSOP = await extractSOPFromThread(ticketTranscript, workspaceId, 'zendesk');

        if (extractedSOP && extractedSOP.is_valid_sop && extractedSOP.confidence_score >= 0.4) {
          const sopEmbedding = await generateEmbedding(`${extractedSOP.title}: ${extractedSOP.trigger_condition}`);

          const insertPayload: Record<string, any> = {
            workspace_id: workspaceId,
            title: extractedSOP.title,
            category: extractedSOP.category || 'Support',
            trigger_condition: extractedSOP.trigger_condition,
            preconditions: extractedSOP.preconditions,
            execution_steps: extractedSOP.execution_steps,
            risk_level: extractedSOP.risk_level || 'Medium',
            requires_human_gate: extractedSOP.requires_human_gate || false,
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
            await createVersion(sopData.id, 'zendesk_crawler', 'initial_extraction');
            sopsExtracted++;
            console.log(`[SUCCESS] [Zendesk Crawler] Extracted SOP "${sopData.title}" from Ticket #${ticket.id}`);
          }
        }
      } catch (extractErr) {
        console.warn(`[WARN] [Zendesk Crawler] Extraction skipped for ticket #${ticket.id}:`, (extractErr as Error).message);
      }

      await markZendeskTicketCrawled(ticketId);
    }

    return { source: 'zendesk', tickets_crawled: ticketsCrawled, sops_extracted: sopsExtracted, status: 'success' };
  } catch (err) {
    console.error('[ERROR] [Zendesk Crawler] Error during crawl execution:', err);
    return { source: 'zendesk', tickets_crawled: ticketsCrawled, sops_extracted: sopsExtracted, status: 'error' };
  }
}
