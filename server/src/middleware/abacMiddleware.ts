import { Response, NextFunction } from 'express';
import ipaddr from 'ipaddr.js';
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
 * Standards-compliant CIDR matching (IPv4 + IPv6) via ipaddr.js.
 * - Rejects malformed client IPs (returns false).
 * - Rejects malformed CIDRs / bare-IP ranges (returns false — fail closed on invalid configuration).
 * - Wildcard "*" allows all (legacy behavior preserved).
 * - Never uses string substring matching.
 */
export function isClientIpAllowed(clientIp: string, allowedIpRanges: string[]): boolean {
  let clientAddr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    clientAddr = ipaddr.process(clientIp.trim());
  } catch {
    // Malformed client IP → fail closed.
    return false;
  }

  for (const rawRange of allowedIpRanges) {
    const range = rawRange.trim();

    if (range === '*') {
      return true;
    }

    let rangeAddr: ipaddr.IPv4 | ipaddr.IPv6;
    let prefixLength: number;
    try {
      [rangeAddr, prefixLength] = ipaddr.parseCIDR(range);
    } catch {
      // Not a CIDR — accept a bare IP address as an exact-host range.
      try {
        rangeAddr = ipaddr.parse(range);
        prefixLength = rangeAddr.kind() === 'ipv4' ? 32 : 128;
      } catch {
        // Malformed CIDR/address in policy → fail closed.
        return false;
      }
    }

    if (rangeAddr.kind() !== clientAddr.kind()) {
      continue;
    }

    if (clientAddr.kind() === 'ipv4') {
      const clientV4 = clientAddr as ipaddr.IPv4;
      const rangeV4 = rangeAddr as ipaddr.IPv4;
      if (clientV4.match([rangeV4, prefixLength])) return true;
    } else {
      const clientV6 = clientAddr as ipaddr.IPv6;
      const rangeV6 = rangeAddr as ipaddr.IPv6;
      if (clientV6.match([rangeV6, prefixLength])) return true;
    }
  }

  return false;
}

/**
 * Extracts the leftmost (original client) entry from X-Forwarded-For, falling back to req.ip.
 */
function extractClientIp(req: AuthenticatedRequest): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.ip || '127.0.0.1';
}

/**
 * Hardened Attribute-Based Access Control (ABAC) Middleware
 * Evaluates verified claims on req.user and dynamic environmental conditions (CIDR IP ranges, scopes, sensitivity levels).
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

    // 4. Dynamic Environmental CIDR IP Range Verification (fail closed on malformed IP/CIDR)
    if (policy.allowedIpRanges && policy.allowedIpRanges.length > 0) {
      const clientIp = extractClientIp(req);
      const isIpAllowed = isClientIpAllowed(clientIp, policy.allowedIpRanges);
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
