export const ALLOWED_NODE_TYPES = new Set([
  'SOP',
  'Step',
  'Policy',
  'System',
  'Team',
  'Role',
  'Person',
  'Rule',
  'Entity',
]);

export const ALLOWED_EDGE_RELATIONSHIPS = new Set([
  'HAS_STEP',
  'REQUIRES_ROLE',
  'TARGETS_SYSTEM',
  'DEPENDS_ON',
  'SUPERSEDES',
  'GOVERNED_BY',
  'OWNS',
  'REQUIRES',
  'MODIFIES',
  'EXECUTES',
]);

export interface GraphTriple {
  subject: string;
  subjectType: string;
  predicate: string;
  object: string;
  objectType: string;
  metadata?: Record<string, any>;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates a GraphTriple against the formal Enterprise Knowledge Graph Ontology.
 */
export function validateTriple(triple: GraphTriple): ValidationResult {
  if (!triple.subject || !triple.object) {
    return { valid: false, reason: 'Subject and object identifiers cannot be empty.' };
  }

  if (!ALLOWED_NODE_TYPES.has(triple.subjectType)) {
    return {
      valid: false,
      reason: `Invalid subjectType "${triple.subjectType}". Must be one of: ${Array.from(ALLOWED_NODE_TYPES).join(', ')}`,
    };
  }

  if (!ALLOWED_NODE_TYPES.has(triple.objectType)) {
    return {
      valid: false,
      reason: `Invalid objectType "${triple.objectType}". Must be one of: ${Array.from(ALLOWED_NODE_TYPES).join(', ')}`,
    };
  }

  const normalizedPredicate = (triple.predicate || '').toUpperCase().trim();
  if (!ALLOWED_EDGE_RELATIONSHIPS.has(normalizedPredicate)) {
    return {
      valid: false,
      reason: `Invalid predicate relationship "${triple.predicate}". Must be one of: ${Array.from(ALLOWED_EDGE_RELATIONSHIPS).join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Compiles and filters a batch of raw triples into validated compliant triples and rejected policy logs.
 */
export function compileAndValidateTriples(triples: GraphTriple[]): {
  validTriples: GraphTriple[];
  rejectedTriples: Array<{ triple: GraphTriple; reason: string }>;
} {
  const validTriples: GraphTriple[] = [];
  const rejectedTriples: Array<{ triple: GraphTriple; reason: string }> = [];

  for (const triple of triples) {
    const res = validateTriple(triple);
    if (res.valid) {
      validTriples.push({
        ...triple,
        predicate: triple.predicate.toUpperCase().trim(),
      });
    } else {
      rejectedTriples.push({
        triple,
        reason: res.reason || 'Non-compliant triple',
      });
    }
  }

  return { validTriples, rejectedTriples };
}
