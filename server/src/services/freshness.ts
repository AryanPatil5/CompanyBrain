/**
 * Knowledge Freshness Service
 *
 * Handles SOP versioning, staleness detection, and conflict detection
 * to keep the Company Brain knowledge current and accurate.
 */

import { supabase } from '../config/supabase.js';

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

// ─── Conflict Detection ──────────────────────────────────────

interface ConflictResult {
  has_conflict: boolean;
  matching_sop_id: string | null;
  matching_sop_title: string | null;
  similarity_score: number;
  conflict_summary: string;
}

/**
 * Checks if a newly extracted SOP conflicts with or duplicates an existing one.
 * Uses LLM comparison to detect semantic similarity.
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
    // Fetch existing approved/draft SOPs in the same workspace
    const { data: existing, error } = await supabase
      .from('skills_sops')
      .select('id, title, trigger_condition, category')
      .or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
      .limit(20);

    if (error || !existing || existing.length === 0) {
      return noConflict;
    }

    // Build a concise list for LLM comparison
    const existingList = existing.map((s, i) =>
      `[${i}] Title: "${s.title}" | Trigger: "${s.trigger_condition || 'N/A'}"`
    ).join('\n');

    const prompt = `You are comparing SOPs. A new SOP was extracted:
Title: "${newTitle}"
Trigger: "${newTrigger}"

Existing SOPs in the system:
${existingList}

Does the new SOP describe the SAME procedure as any existing one? Respond with only this JSON:
{
  "has_conflict": boolean,
  "matching_index": number or null,
  "similarity_score": number between 0 and 1,
  "conflict_summary": "brief explanation"
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

    if (parsed.has_conflict && parsed.matching_index !== null && parsed.matching_index < existing.length) {
      const match = existing[parsed.matching_index];
      return {
        has_conflict: true,
        matching_sop_id: match.id,
        matching_sop_title: match.title,
        similarity_score: parsed.similarity_score || 0.8,
        conflict_summary: parsed.conflict_summary || 'Potential duplicate detected.',
      };
    }

    return {
      ...noConflict,
      similarity_score: parsed.similarity_score || 0,
      conflict_summary: parsed.conflict_summary || 'No conflicts found.',
    };
  } catch (err) {
    console.warn('[Freshness] Conflict detection error (non-fatal):', err);
    return noConflict;
  }
}
