import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.js';

export interface ABACPolicy {
  action: string;
  resource: string;
  requiredRole?: 'admin' | 'manager' | 'member' | string;
  maxSensitivityLevel?: number; // 1 (Public) to 5 (Top Secret)
}

const ROLE_HIERARCHY: Record<string, number> = {
  admin: 100,
  manager: 50,
  member: 10,
  guest: 1,
};

/**
 * Attribute-Based Access Control (ABAC) Middleware
 * Evaluates user attributes, role hierarchy, workspace context, and resource sensitivity levels.
 */
export function enforceABAC(policy: ABACPolicy) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const user = req.user;

    // 1. Unauthenticated user check
    if (!user || !user.role) {
      res.status(401).json({
        error: 'Authentication Required',
        message: 'Valid user session or API key is required to perform this action.',
      });
      return;
    }

    const userRoleLevel = ROLE_HIERARCHY[user.role.toLowerCase()] || 0;

    // 2. Role Constraint Verification
    if (policy.requiredRole) {
      const requiredRoleLevel = ROLE_HIERARCHY[policy.requiredRole.toLowerCase()] || 0;
      if (userRoleLevel < requiredRoleLevel) {
        res.status(403).json({
          error: 'ABAC Policy Violation',
          policy: policy.action,
          message: `User role "${user.role}" does not satisfy required role "${policy.requiredRole}" for resource "${policy.resource}".`,
        });
        return;
      }
    }

    // 3. Sensitivity Level Constraint Verification (e.g. Sensitivity level 4-5 requires Manager/Admin)
    const resourceSensitivity = Number(req.headers['x-sensitivity-level'] || req.body?.sensitivity_level || 1);

    if (policy.maxSensitivityLevel && resourceSensitivity > policy.maxSensitivityLevel) {
      if (userRoleLevel < ROLE_HIERARCHY.manager) {
        res.status(403).json({
          error: 'ABAC Policy Violation',
          policy: policy.action,
          message: `Resource sensitivity level (${resourceSensitivity}) exceeds permitted policy threshold (${policy.maxSensitivityLevel}) for non-manager user.`,
        });
        return;
      }
    }

    next();
  };
}
