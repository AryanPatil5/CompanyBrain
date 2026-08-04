import { GraphTriple } from './ontologyCompiler.js';
import { findSimilarEntities } from './vectorEntityResolver.js';

export const ENTERPRISE_ALIAS_DICTIONARY: Record<string, string> = {
  // Database aliases
  'pg': 'postgresql_db',
  'postgres': 'postgresql_db',
  'postgresql': 'postgresql_db',
  'postgresql primary': 'postgresql_db',
  'pg_primary': 'postgresql_db',
  'postgres_db': 'postgresql_db',
  'replica_db': 'postgresql_replica',

  // CI/CD & Cloud Infrastructure aliases
  'github_actions': 'gh_ci',
  'gh_actions': 'gh_ci',
  'github ci': 'gh_ci',
  'actions': 'gh_ci',
  'k8s': 'kubernetes',
  'kube': 'kubernetes',
  'k8s cluster': 'kubernetes',
  'aws_s3': 's3_storage',
  's3': 's3_storage',
  's3 bucket': 's3_storage',

  // Payment & External Integrations
  'stripe': 'stripe_api',
  'stripe_payments': 'stripe_api',
  'stripe gateway': 'stripe_api',
  'stripe_billing': 'stripe_api',

  // Messaging & Operations
  'slack': 'slack_workspace',
  'slack_channel': 'slack_workspace',
  'zendesk': 'zendesk_support',
  'linear': 'linear_tracker',
};

/**
 * Normalizes and maps raw entity names/synonyms to a canonical graph node identifier.
 */
export function canonicalizeEntity(rawName: string, _entityType?: string): string {
  if (!rawName) return 'unnamed_entity';

  // 1. Lowercase and normalize whitespace/special characters
  const normalized = rawName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/\s+/g, '_');

  // 2. Lookup in enterprise alias dictionary
  if (ENTERPRISE_ALIAS_DICTIONARY[normalized]) {
    return ENTERPRISE_ALIAS_DICTIONARY[normalized];
  }

  const rawClean = rawName.toLowerCase().trim().replace(/[^a-z0-9]/g, ' ');
  if (ENTERPRISE_ALIAS_DICTIONARY[rawClean]) {
    return ENTERPRISE_ALIAS_DICTIONARY[rawClean];
  }

  // 3. Fallback to snake_case slug
  return normalized || 'unnamed_entity';
}

/**
 * Vector-assisted entity resolution before node creation.
 */
export async function disambiguateEntityWithVector(
  rawName: string,
  entityType: string,
  workspaceId: string
): Promise<string> {
  const dictionaryMatch = canonicalizeEntity(rawName, entityType);
  if (dictionaryMatch && ENTERPRISE_ALIAS_DICTIONARY[dictionaryMatch]) {
    return dictionaryMatch;
  }

  try {
    const vectorMatch = await findSimilarEntities(rawName, entityType, workspaceId);
    if (vectorMatch.isDuplicate && vectorMatch.canonicalName) {
      return canonicalizeEntity(vectorMatch.canonicalName, entityType);
    }
  } catch (err) {
    console.warn('[EntityDisambiguator Warning] Vector resolution fallback:', err);
  }

  return dictionaryMatch;
}

/**
 * Disambiguates subject and object nodes within a GraphTriple, preserving raw strings in metadata.
 */
export function disambiguateTriple(triple: GraphTriple): GraphTriple {
  const canonicalSubject = canonicalizeEntity(triple.subject, triple.subjectType);
  const canonicalObject = canonicalizeEntity(triple.object, triple.objectType);

  return {
    ...triple,
    subject: canonicalSubject,
    object: canonicalObject,
    metadata: {
      ...(triple.metadata || {}),
      rawSubject: triple.subject,
      rawObject: triple.object,
      canonicalizedAt: new Date().toISOString(),
    },
  };
}
