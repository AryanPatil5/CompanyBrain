// Phase 3: canonical entity resolution + graph projection (ADR-T15).
//
// The canonical `entities` / `entity_aliases` / `entity_relationships` tables
// are the source of truth. Entity ids are deterministic canonical slugs
// (alias dictionary + snake_case normalization, same rule as
// graph/entityDisambiguator.canonicalizeEntity) so reprocessing a document
// converges on the SAME canonical row instead of duplicating nodes.
//
// Graph projection: for relationship types that exist in the legacy
// graph_edges enum (migration 022: 10 values), the resolver dual-writes the
// exact same node/edge shapes addEntityNode/createRelationship produce.
//
// Projection ids are workspace-namespaced (`${workspace_id}:${canonical_slug}`)
// because graph_nodes.id is the global PK (migration 022) — a bare canonical
// slug would let two workspaces silently clobber each other's projected row
// (cross-tenant data collision). Every graph consumer treats node ids as
// opaque strings scoped by (workspace_id, id) filters, and graph_edges'
// source_id/target_id FKs stay internally consistent because both endpoints
// are namespaced together. The canonical `entities` tables remain the scoped
// source of truth. Relationship types outside the enum are stored canonically
// but NEVER projected. Projection failures are logged and never fail the job
// (canonical writes are the durable record); canonical write failures THROW
// so the pipeline records and retries them.

import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase.js';
import { logger } from '../logger.js';
import { canonicalizeEntity } from '../services/graph/entityDisambiguator.js';
import { addEntityNode, createRelationship, GraphNode } from '../services/graph/graphService.js';

export interface EntityMention {
  name: string;
  type: string;
}

export interface RelationshipMention {
  source: string;
  target: string;
  relationship_type: string;
}

export interface ResolveEntitiesInput {
  workspaceId: string;
  sourceDocumentId: string;
  entities: EntityMention[];
  relationships: RelationshipMention[];
  client?: SupabaseClient;
}

export interface ResolutionSummary {
  entitiesResolved: number;
  aliasesWritten: number;
  relationshipsResolved: number;
  projectedEdges: number;
  projectionSkipped: number;
  skipped: number;
}

/** Legacy graph_edges edge_type enum (migration 022) — the ONLY projectable set. */
const PROJECTABLE_EDGE_TYPES = new Set([
  'OWNS',
  'REQUIRES',
  'MODIFIES',
  'DEPENDS_ON',
  'EXECUTES',
  'HAS_STEP',
  'REQUIRES_ROLE',
  'TARGETS_SYSTEM',
  'SUPERSEDES',
  'GOVERNED_BY',
]);

const GRAPH_LABELS: Record<string, GraphNode['label']> = {
  Person: 'Person',
  System: 'System',
  SOP: 'SOP',
  Rule: 'Rule',
  Step: 'Step',
  Policy: 'Policy',
  Team: 'Team',
  Role: 'Role',
};

const labelFor = (entityType: string): GraphNode['label'] => GRAPH_LABELS[entityType] ?? 'Entity';

/** Deterministic entity id for a mention ('' means the mention is unnameable). */
function canonicalIdFor(name: string, type?: string): string {
  const canonical = canonicalizeEntity(name, type);
  return canonical === 'unnamed_entity' ? '' : canonical;
}

/**
 * Workspace-scoped projection node id. graph_nodes.id is a GLOBAL primary key,
 * so the bare canonical slug must never be used as a node id — two workspaces
 * resolving the same entity would clobber the shared row. Namespacing the id
 * keeps the upsert key collision-free across workspaces without any schema
 * change (all consumers filter by workspace_id and treat id as opaque).
 */
function projectedIdFor(workspaceId: string, canonicalSlug: string): string {
  return `${workspaceId}:${canonicalSlug}`;
}

async function upsertCanonicalEntity(
  client: SupabaseClient,
  input: ResolveEntitiesInput,
  mention: EntityMention,
  entityId: string,
  now: string
): Promise<void> {
  // Merge semantics: GREATEST(confidence) where confidence is DERIVED from
  // sighting volume (Phase 3 N5) — min(0.7 + 0.05*(times_seen-1), 0.95) —
  // plus last_seen_at/times_seen bumps.
  const { data: existing } = await client
    .from('entities')
    .select('confidence, first_seen_at, times_seen')
    .eq('workspace_id', input.workspaceId)
    .eq('entity_id', entityId)
    .maybeSingle();

  const previousConfidence = existing && typeof existing.confidence === 'number' ? existing.confidence : 0;
  const timesSeen = existing && typeof existing.times_seen === 'number' ? existing.times_seen : 1;
  const derivedConfidence = Math.min(0.7 + 0.05 * Math.max(timesSeen - 1, 0), 0.95);

  const { error } = await client.from('entities').upsert(
    {
      workspace_id: input.workspaceId,
      entity_id: entityId,
      canonical_name: mention.name,
      entity_type: mention.type,
      confidence: Math.max(previousConfidence, derivedConfidence),
      times_seen: timesSeen + 1,
      source_document_id: input.sourceDocumentId,
      first_seen_at: existing?.first_seen_at ?? now,
      last_seen_at: now,
    },
    { onConflict: 'workspace_id, entity_id' }
  );

  if (error) {
    throw new Error(`Failed to persist canonical entity ${entityId}: ${error.message}`);
  }

  // Alias row for the raw mention: (workspace_id, entity_id, alias) PK makes
  // repeated mentions of the same raw name converge on one row.
  const { error: aliasErr } = await client.from('entity_aliases').upsert(
    {
      workspace_id: input.workspaceId,
      entity_id: entityId,
      alias: mention.name,
    },
    { onConflict: 'workspace_id, entity_id, alias' }
  );

  if (aliasErr) {
    throw new Error(`Failed to persist entity alias for ${entityId}: ${aliasErr.message}`);
  }
}

/**
 * Resolves every extracted entity/relationship mention into the canonical
 * corpus tables, then projects enum-compatible relationships into the legacy
 * graph tables. Idempotent: canonical ids are deterministic slugs and every
 * write targets a unique key.
 */
export async function resolveEntitiesForDocument(input: ResolveEntitiesInput): Promise<ResolutionSummary> {
  const client = input.client || supabase;
  const summary: ResolutionSummary = {
    entitiesResolved: 0,
    aliasesWritten: 0,
    relationshipsResolved: 0,
    projectedEdges: 0,
    projectionSkipped: 0,
    skipped: 0,
  };
  const now = new Date().toISOString();
  const typeById = new Map<string, string>();

  // ── Canonical entities ─────────────────────────────────────────────────────
  for (const mention of input.entities) {
    const entityId = canonicalIdFor(mention.name, mention.type);
    if (!entityId) {
      summary.skipped += 1;
      logger.warn('[EntityResolver] Skipping unnameable entity mention', { workspaceId: input.workspaceId, name: mention.name });
      continue;
    }
    await upsertCanonicalEntity(client, input, mention, entityId, now);
    typeById.set(entityId, mention.type);
    summary.entitiesResolved += 1;
    summary.aliasesWritten += 1;
  }

  // ── Canonical relationships + graph projection ─────────────────────────────
  for (const rel of input.relationships) {
    const source = canonicalIdFor(rel.source);
    const target = canonicalIdFor(rel.target);
    const relationshipType = String(rel.relationship_type || '').toUpperCase();

    if (!source || !target || source === target || !relationshipType) {
      summary.skipped += 1;
      continue;
    }

    // Confidence derived from sighting volume (Phase 3 N5), same formula as
    // entities: min(0.7 + 0.05*(times_seen-1), 0.95), GREATEST-merged.
    const { data: existingRel } = await client
      .from('entity_relationships')
      .select('confidence, times_seen')
      .eq('workspace_id', input.workspaceId)
      .eq('source_entity_id', source)
      .eq('target_entity_id', target)
      .eq('relationship_type', relationshipType)
      .maybeSingle();
    const previousRelConfidence = existingRel && typeof existingRel.confidence === 'number' ? existingRel.confidence : 0;
    const relTimesSeen = existingRel && typeof existingRel.times_seen === 'number' ? existingRel.times_seen : 1;
    const derivedRelConfidence = Math.min(0.7 + 0.05 * Math.max(relTimesSeen - 1, 0), 0.95);

    const { error: relErr } = await client.from('entity_relationships').upsert(
      {
        workspace_id: input.workspaceId,
        source_entity_id: source,
        target_entity_id: target,
        relationship_type: relationshipType,
        confidence: Math.max(previousRelConfidence, derivedRelConfidence),
        times_seen: relTimesSeen + 1,
        source_document_id: input.sourceDocumentId,
        properties: { raw_source: rel.source, raw_target: rel.target },
      },
      { onConflict: 'workspace_id, source_entity_id, target_entity_id, relationship_type' }
    );

    if (relErr) {
      throw new Error(`Failed to persist entity relationship ${source}->${target}: ${relErr.message}`);
    }
    summary.relationshipsResolved += 1;

    // Projection: same write shape as addEntityNode/createRelationship, node id
    // = workspace-namespaced canonical slug (global PK isolation, see
    // projectedIdFor). Failures are logged, never fatal.
    if (!PROJECTABLE_EDGE_TYPES.has(relationshipType)) {
      summary.projectionSkipped += 1;
      continue;
    }

    const sourceProjectedId = projectedIdFor(input.workspaceId, source);
    const targetProjectedId = projectedIdFor(input.workspaceId, target);

    try {
      await addEntityNode(labelFor(typeById.get(source) ?? 'Entity'), {
        id: sourceProjectedId,
        name: rel.source,
        workspace_id: input.workspaceId,
        allowed_roles: ['admin', 'member'],
        source_document_id: input.sourceDocumentId,
      });
      await addEntityNode(labelFor(typeById.get(target) ?? 'Entity'), {
        id: targetProjectedId,
        name: rel.target,
        workspace_id: input.workspaceId,
        allowed_roles: ['admin', 'member'],
        source_document_id: input.sourceDocumentId,
      });
      await createRelationship(sourceProjectedId, targetProjectedId, relationshipType as never, {
        workspace_id: input.workspaceId,
        source_document_id: input.sourceDocumentId,
        valid_from: now,
      });
      summary.projectedEdges += 1;
    } catch (projErr) {
      logger.warn('[EntityResolver] Graph projection failed (canonical record kept):', projErr);
    }

    // Mark projection success on the canonical row (best-effort; a failure
    // here is not a pipeline failure — the next reprocessing retries it).
    await client
      .from('entity_relationships')
      .update({ projected_at: now })
      .eq('workspace_id', input.workspaceId)
      .eq('source_entity_id', source)
      .eq('target_entity_id', target)
      .eq('relationship_type', relationshipType)
      .then(({ error }) => {
        if (error) logger.warn('[EntityResolver] Failed to mark projected_at:', error);
      });
  }

  return summary;
}
