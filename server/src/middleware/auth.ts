import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: {
    user_id: string;
    role: 'admin' | 'approver' | 'member';
    workspace_id: string;
  };
}

// 1. Hard-Fail on Missing JWT_SECRET at server startup in production
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error("FATAL: JWT_SECRET environment variable is missing in production mode.");
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

function verifyJWT(token: string, secret: string): any {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${headerB64}.${payloadB64}`);
  const calculatedSignature = hmac.digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  if (signatureB64 !== calculatedSignature) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64));
    
    // Check decoded expiration
    if (payload && typeof payload.exp === 'number') {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        return { error: 'expired' };
      }
    }
    
    return payload;
  } catch {
    return null;
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const isProdMode = process.env.NODE_ENV === 'production';
  const secretKey = process.env.JWT_SECRET;

  // Hard-Fail inside middleware if secret is missing in production
  if (isProdMode && !secretKey) {
    throw new Error("FATAL: JWT_SECRET environment variable is missing in production mode.");
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: missing authorization bearer token' });
  }

  const token = authHeader.substring(7);

  // 2. Gate/Remove Mock Token Backdoor: only allowed in development/non-production
  if (token === 'mock-admin-token' || token === 'mock-approver-token' || token === 'mock-member-token') {
    if (isProdMode) {
      return res.status(401).json({ error: 'Unauthorized: mock tokens are forbidden in production' });
    }
    
    if (token === 'mock-admin-token') {
      (req as AuthenticatedRequest).user = {
        user_id: 'mock-user-admin',
        role: 'admin',
        workspace_id: '00000000-0000-0000-0000-000000000000',
      };
    } else if (token === 'mock-approver-token') {
      (req as AuthenticatedRequest).user = {
        user_id: 'mock-user-approver',
        role: 'approver',
        workspace_id: '00000000-0000-0000-0000-000000000000',
      };
    } else if (token === 'mock-member-token') {
      (req as AuthenticatedRequest).user = {
        user_id: 'mock-user-member',
        role: 'member',
        workspace_id: '00000000-0000-0000-0000-000000000000',
      };
    }
    return next();
  }

  // 3. Decode standard JWT
  if (!secretKey) {
    return res.status(401).json({ error: 'Unauthorized: JWT_SECRET is not configured on the server.' });
  }

  const decoded = verifyJWT(token, secretKey);

  if (!decoded) {
    return res.status(401).json({ error: 'Unauthorized: invalid token signature' });
  }

  if (decoded.error === 'expired') {
    return res.status(401).json({ error: 'Unauthorized: token has expired' });
  }

  const role = decoded.role;
  if (role !== 'admin' && role !== 'approver' && role !== 'member') {
    return res.status(401).json({ error: 'Unauthorized: invalid user role claim' });
  }

  (req as AuthenticatedRequest).user = {
    user_id: decoded.user_id || decoded.sub || 'unknown',
    role: role,
    workspace_id: decoded.workspace_id || '00000000-0000-0000-0000-000000000000',
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
