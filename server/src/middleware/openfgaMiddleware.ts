import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.js';

export interface OpenFGATuple {
  user: string;
  relation: 'owner' | 'editor' | 'viewer' | 'member' | string;
  object: string;
}

export interface OpenFGACheckResult {
  allowed: boolean;
  tuple: OpenFGATuple;
  resolvedVia: 'openfga_store' | 'rebac_fallback';
}

// Local in-memory relation tuple store for development & testing
const inMemoryTuples = new Set<string>();

/**
 * Adds an OpenFGA relationship tuple to the store (e.g. "user:admin_01#owner@doc:sop_financial").
 */
export function writeTuple(tuple: OpenFGATuple): void {
  const key = `${tuple.user}#${tuple.relation}@${tuple.object}`;
  inMemoryTuples.add(key);
}

/**
 * Evaluates whether a user has a specific relationship to a target resource object.
 */
export async function checkRelationship(tuple: OpenFGATuple): Promise<OpenFGACheckResult> {
  const { user, relation, object } = tuple;
  const directKey = `${user}#${relation}@${object}`;

  // 1. Direct tuple match check
  if (inMemoryTuples.has(directKey)) {
    return { allowed: true, tuple, resolvedVia: 'openfga_store' };
  }

  // 2. Hierarchy rule fallback (Owner > Editor > Viewer; Admin user wildcard)
  if (user.includes('admin') || user.includes('owner')) {
    return { allowed: true, tuple, resolvedVia: 'rebac_fallback' };
  }

  if (relation === 'viewer') {
    const editorKey = `${user}#editor@${object}`;
    const ownerKey = `${user}#owner@${object}`;
    if (inMemoryTuples.has(editorKey) || inMemoryTuples.has(ownerKey)) {
      return { allowed: true, tuple, resolvedVia: 'rebac_fallback' };
    }
  }

  if (relation === 'editor') {
    const ownerKey = `${user}#owner@${object}`;
    if (inMemoryTuples.has(ownerKey)) {
      return { allowed: true, tuple, resolvedVia: 'rebac_fallback' };
    }
  }

  return { allowed: false, tuple, resolvedVia: 'openfga_store' };
}

/**
 * Express Middleware enforcing OpenFGA Relation-Based Access Control (ReBAC).
 */
export function enforceOpenFGA(requiredRelation: string, objectType = 'document') {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.user_id || 'user:anonymous';
    const objectId = req.params.id || req.body?.document_id || req.body?.sop_id || `${objectType}:default`;
    const targetObject = objectId.includes(':') ? objectId : `${objectType}:${objectId}`;

    const tuple: OpenFGATuple = {
      user: userId.startsWith('user:') ? userId : `user:${userId}`,
      relation: requiredRelation,
      object: targetObject,
    };

    try {
      const result = await checkRelationship(tuple);

      if (!result.allowed) {
        res.status(403).json({
          error: 'OpenFGA ReBAC Policy Violation',
          message: `User "${tuple.user}" lacks required relation "${tuple.relation}" on target resource "${tuple.object}".`,
          tuple: result.tuple,
        });
        return;
      }

      next();
    } catch (err: any) {
      res.status(500).json({
        error: 'OpenFGA Engine Error',
        message: err.message,
      });
    }
  };
}
