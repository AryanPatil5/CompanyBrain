import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.js';
import { openfgaClientManager, type OpenFGATuple } from '../services/security/openfgaClient.js';

export { openfgaClientManager };
export type { OpenFGATuple };

/**
 * Express Middleware enforcing OpenFGA Relationship-Based Access Control (ReBAC).
 * Evaluates authorization tuples against OpenFGA PDP client with 60s TTL caching.
 * Fails closed with 500 if authorization engine drops or fails.
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
      const result = await openfgaClientManager.checkTuple(tuple);

      if (!result.allowed) {
        res.status(403).json({
          error: 'OpenFGA ReBAC Policy Violation',
          message: `User "${tuple.user}" lacks required relation "${tuple.relation}" on target resource "${tuple.object}".`,
          tuple,
        });
        return;
      }

      next();
    } catch (err: any) {
      // Fail closed: 500 Authorization Engine Unavailable
      res.status(500).json({
        error: '500 Authorization Engine Unavailable',
        message: err.message || 'Authorization PDP service is unreachable. Failing closed.',
      });
    }
  };
}
