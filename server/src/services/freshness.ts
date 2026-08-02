/**
 * Knowledge Freshness Service
 *
 * Handles SOP versioning, staleness detection, and pgvector semantic conflict detection
 * to keep the Company Brain knowledge current and accurate.
 */

import { supabase } from '../config/supabase.js';
import { generateEmbedding } from './embeddings.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ─── Versioning ──────────────────────────────────────────────

/**
 * Creates an immutable version snapshot before an SOP is modified.
 * Call this BEFORE applying any updates to the SOP.
 */
export async function createVersion(
  sopId: string,
  changedBy: string = 'system',
  changeReason: string = 'manual_edit'
): Promise<boolean> {
  try {
    // Fetch current SOP state
    const { data: current, error: fetchErr } = await supabase
      .from('skills_sops')
      .select('*')
      .eq('id', sopId)
      .single();

    if (fetchErr || !current) {
      console.error('[Freshness] Cannot version — SOP not found:', sopId);
      return false;
    }

    const nextVersion = (current.version || 1);

    // Insert version snapshot
    const { error: insertErr } = await supabase
      .from('sop_versions')
      .insert({
        sop_id: sopId,
        version_number: nextVersion,
        changed_by: changedBy,
        change_reason: changeReason,
        snapshot: {
          title: current.title,
          category: current.category,
          status: current.status,
          trigger_condition: current.trigger_condition,
          preconditions: current.preconditions,
          execution_steps: current.execution_steps,
          summary: current.summary,
        },
      });

    if (insertErr) {
      console.error('[Freshness] Failed to create version snapshot:', insertErr);
      return false;
    }

    // Increment version counter on the SOP
    await supabase
      .from('skills_sops')
      .update({ version: nextVersion + 1, updated_at: new Date().toISOString() })
      .eq('id', sopId);

    console.log(`[Freshness] Created version ${nextVersion} for SOP: ${sopId}`);
    return true;
  } catch (err) {
    console.error('[Freshness] Version creation error:', err);
    return false;
  }
}

// ─── Staleness Detection ─────────────────────────────────────

/**
 * Marks SOPs as stale if they haven't been confirmed within the threshold.
 * Returns the number of SOPs marked stale.
 */
export async function markStaleSOPs(thresholdDays: number = 30): Promise<number> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - thresholdDays);

    const { data, error } = await supabase
      .from('skills_sops')
      .update({ is_stale: true, updated_at: new Date().toISOString() })
      .eq('is_stale', false)
      .lt('last_confirmed_at', cutoff.toISOString())
      .select('id');

    if (error) {
      console.error('[Freshness] Staleness sweep error:', error);
      return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
      console.log(`[Freshness] Marked ${count} SOPs as stale (threshold: ${thresholdDays} days)`);
    }
    return count;
  } catch (err) {
    console.error('[Freshness] Staleness sweep exception:', err);
    return 0;
  }
}

/**
 * Confirms an SOP is still current — resets staleness.
 */
export async function confirmSOP(sopId: string): Promise<boolean> {
  const { error } = await supabase
    .from('skills_sops')
    .update({
      is_stale: false,
      last_confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', sopId);

  if (error) {
    console.error('[Freshness] Failed to confirm SOP:', error);
    return false;
  }

  console.log(`[Freshness] SOP confirmed as current: ${sopId}`);
  return true;
}

// ─── Vector-Based Conflict Detection ────────────────────────

interface ConflictResult {
  has_conflict: boolean;
  matching_sop_id: string | null;
  matching_sop_title: string | null;
  similarity_score: number;
  conflict_summary: string;
}

interface CandidateSOP {
  id: string;
  title: string;
  trigger_condition: string;
  category?: string;
  similarity?: number;
}

/**
 * Checks if a newly extracted SOP conflicts with or duplicates an existing one.
 * Uses pgvector semantic embeddings search (match_sops_by_embedding RPC) to retrieve
 * the top 5 candidates, then passes them to LLM for final verification.
 */
export async function detectConflict(
  newTitle: string,
  newTrigger: string,
  workspaceId: string
): Promise<ConflictResult> {
  const noConflict: ConflictResult = {
    has_conflict: false,
    matching_sop_id: null,
    matching_sop_title: null,
    similarity_score: 0,
    conflict_summary: 'No matching SOPs found.',
  };

  try {
    let candidateSOPs: CandidateSOP[] = [];

    // 1. Generate semantic embedding vector for incoming SOP title + trigger
    const queryText = `${newTitle}: ${newTrigger}`;
    const queryEmbedding = await generateEmbedding(queryText);

    if (queryEmbedding && queryEmbedding.length > 0) {
      // 2. Perform vector search query via Supabase match_sops_by_embedding RPC (top 5 max)
      const { data: rpcMatches, error: rpcErr } = await supabase.rpc('match_sops_by_embedding', {
        query_embedding: queryEmbedding,
        filter_workspace_id: workspaceId,
        match_threshold: 0.1,
        match_count: 5,
      });

      if (!rpcErr && rpcMatches && rpcMatches.length > 0) {
        candidateSOPs = rpcMatches;
        console.log(`[Freshness] Semantic vector search found ${candidateSOPs.length} candidate matches for "${newTitle}"`);
      }
    }

    // Fallback: If vector search returned no results or embedding API was unavailable,
    // fetch top 5 most recent SOPs in workspace as fallback candidates
    if (candidateSOPs.length === 0) {
      const { data: fallbackList, error: fallbackErr } = await supabase
        .from('skills_sops')
        .select('id, title, trigger_condition, category')
        .or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
        .order('created_at', { ascending: false })
        .limit(5);

      if (fallbackErr || !fallbackList || fallbackList.length === 0) {
        return noConflict;
      }
      candidateSOPs = fallbackList;
    }

    // Guarantee we only pass top 5 candidates max into LLM prompt
    const topCandidates = candidateSOPs.slice(0, 5);

    // Build a concise candidate list for LLM verification
    const candidatesText = topCandidates
      .map((s, i) => `[Candidate ${i}] ID: "${s.id}" | Title: "${s.title}" | Trigger: "${s.trigger_condition || 'N/A'}"`)
      .join('\n');

    const prompt = `You are an Enterprise Knowledge Engineer evaluating potential duplicate SOPs.

A new SOP was extracted:
Title: "${newTitle}"
Trigger: "${newTrigger}"

Candidate Existing SOPs (Top Vector Matches):
${candidatesText}

Does the new SOP describe the SAME operational procedure or override protocol as any candidate?
Respond ONLY with this raw JSON object:
{
  "has_conflict": boolean,
  "matching_index": number or null,
  "similarity_score": number between 0 and 1,
  "conflict_summary": "brief description of overlap or conflict"
}`;

    const response = await fetch(OPENROUTER_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5001',
        'X-Title': 'Company Brain',
      },
      body: JSON.stringify({
        model: 'inclusionai/ling-3.0-flash:free',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      console.warn('[Freshness] Conflict detection LLM call failed, skipping');
      return noConflict;
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content?.trim() || '';
    const cleanJson = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const parsed = JSON.parse(cleanJson);

    if (parsed.has_conflict && parsed.matching_index !== null && parsed.matching_index >= 0 && parsed.matching_index < topCandidates.length) {
      const match = topCandidates[parsed.matching_index];
      return {
        has_conflict: true,
        matching_sop_id: match.id,
        matching_sop_title: match.title,
        similarity_score: parsed.similarity_score || match.similarity || 0.8,
        conflict_summary: parsed.conflict_summary || 'Potential duplicate detected.',
      };
    }

    return {
      ...noConflict,
      similarity_score: parsed.similarity_score || 0,
      conflict_summary: parsed.conflict_summary || 'No conflicts found.',
    };
  } catch (err) {
    console.warn('[Freshness] Conflict detection exception (non-fatal):', err);
    return noConflict;
  }
}
