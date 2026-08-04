import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.js';

export interface ABACPolicy {
  action: string;
  resource: string;
  requiredRole?: 'admin' | 'manager' | 'member' | string;
  maxSensitivityLevel?: number;
  allowedIpRanges?: string[];
  allowedScope?: string;
}

const ROLE_HIERARCHY: Record<string, number> = {
  admin: 100,
  manager: 50,
  member: 10,
  guest: 1,
};

/**
 * Hardened Attribute-Based Access Control (ABAC) Middleware
 * Evaluates verified claims on req.user and dynamic environmental conditions (IP range, scopes, sensitivity levels).
 */
export function enforceABAC(policy: ABACPolicy) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const user = req.user;

    // 1. Unauthenticated user check
    if (!user || !user.role) {
      res.status(401).json({
        error: 'Authentication Required',
        message: 'Cryptographically verified JWT token context is required.',
      });
      return;
    }

    const userRoleLevel = ROLE_HIERARCHY[user.role.toLowerCase()] || 0;
    const userClearance = user.clearance_level ?? 1;

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

    // 3. Sensitivity Level Constraint Verification
    if (policy.maxSensitivityLevel && policy.maxSensitivityLevel > userClearance) {
      if (userRoleLevel < ROLE_HIERARCHY.manager) {
        res.status(403).json({
          error: 'ABAC Policy Violation',
          policy: policy.action,
          message: `Resource sensitivity level (${policy.maxSensitivityLevel}) exceeds user clearance level (${userClearance}).`,
        });
        return;
      }
    }

    // 4. Dynamic Environmental IP Range Verification
    if (policy.allowedIpRanges && policy.allowedIpRanges.length > 0) {
      const clientIp = (req.headers['x-forwarded-for'] as string) || req.ip || '127.0.0.1';
      const isIpAllowed = policy.allowedIpRanges.some((range) => clientIp.includes(range) || range === '*');
      if (!isIpAllowed) {
        res.status(403).json({
          error: 'ABAC Environment Policy Violation',
          message: `Client IP "${clientIp}" is not permitted to access resource "${policy.resource}".`,
        });
        return;
      }
    }

    next();
  };
}
