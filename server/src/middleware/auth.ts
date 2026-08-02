import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    user_id: string;
    role: 'admin' | 'approver' | 'member';
    workspace_id: string;
  };
}

/**
 * Lightweight Base64URL JWT payload parser.
 * Used exclusively to extract custom claims (role, workspace_id) AFTER
 * cryptographic verification has already succeeded via supabase.auth.getUser().
 */
function decodeJwtPayload(token: string): any {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const isProdMode = process.env.NODE_ENV === 'production';
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: missing authorization bearer token' });
  }

  const token = authHeader.substring(7);

  // Mock tokens: dev/test only, forbidden in production mode
  if (token === 'mock-admin-token' || token === 'mock-approver-token' || token === 'mock-member-token') {
    if (isProdMode) {
      return res.status(401).json({ error: 'Unauthorized: mock tokens are forbidden in production' });
    }

    const roleMap: Record<string, 'admin' | 'approver' | 'member'> = {
      'mock-admin-token': 'admin',
      'mock-approver-token': 'approver',
      'mock-member-token': 'member',
    };

    const role = roleMap[token];
    (req as AuthenticatedRequest).user = {
      user_id: `mock-user-${role}`,
      role,
      workspace_id: '00000000-0000-0000-0000-000000000000',
    };
    return next();
  }

  // Real path: ask Supabase Auth to validate session token (handles key rotation natively)
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Unauthorized: invalid or expired session token' });
  }

  // Extract custom claims (role, workspace_id) injected by the Custom Access Token Hook
  const payload = decodeJwtPayload(token);
  const role = payload?.role;
  const workspaceId = payload?.workspace_id;

  if (role !== 'admin' && role !== 'approver' && role !== 'member') {
    return res.status(401).json({ error: 'Unauthorized: user has no assigned role/workspace' });
  }

  (req as AuthenticatedRequest).user = {
    user_id: data.user.id,
    role,
    workspace_id: workspaceId || '00000000-0000-0000-0000-000000000000',
  };

  return next();
}

export function requireRole(allowedRoles: Array<'admin' | 'approver' | 'member'>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: user context missing' });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ error: `Forbidden: role '${user.role}' is not authorized to perform this action` });
    }

    return next();
  };
}
