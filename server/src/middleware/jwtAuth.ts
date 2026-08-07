import { logger } from '../logger.js';
import { Response, NextFunction } from 'express';
import * as jose from 'jose';
import { AuthenticatedRequest } from './auth.js';

export interface VerifiedUserPayload {
  user_id: string;
  workspace_id: string;
  role: 'admin' | 'manager' | 'member' | 'approver' | string;
  roles: string[];
  clearance_level: number;
}

const DEV_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'dev_secret_key_company_brain_32_bytes_long_min!'
);

let jwksRemote: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
if (process.env.JWKS_URI) {
  try {
    jwksRemote = jose.createRemoteJWKSet(new URL(process.env.JWKS_URI), {
      cacheMaxAge: 3600000, // 1 hour in-memory cache TTL
    });
  } catch (err) {
    logger.warn('[JWKS Warning] Failed to initialize remote JWK set:', err);
  }
}

/**
 * Generates a signed HS256 JWT token for testing and local authentication.
 */
export async function generateTestToken(
  payload: Partial<VerifiedUserPayload>,
  secret = DEV_SECRET,
  expiresIn = '1h'
): Promise<string> {
  const token = await new jose.SignJWT({
    user_id: payload.user_id || 'user_test_01',
    workspace_id: payload.workspace_id || '00000000-0000-0000-0000-000000000000',
    role: payload.role || 'member',
    roles: payload.roles || [payload.role || 'member'],
    clearance_level: payload.clearance_level ?? 1,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setIssuer('company-brain-auth')
    .setAudience('company-brain-api')
    .sign(secret);

  return token;
}

/**
 * Cryptographically Verifies Authorization Bearer JWT Tokens via JWKS / HMAC secret.
 * Blocks unverified, expired, or alg: "none" tokens.
 */
export function jwtAuth() {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: '401 Unauthorized',
        message: 'Missing or malformed Authorization header. Expected Bearer JWT token.',
      });
      return;
    }

    const token = authHeader.substring(7).trim();

    // Edge Case: Reject alg: "none" attacks
    try {
      const header = jose.decodeProtectedHeader(token);
      if (!header.alg || header.alg.toLowerCase() === 'none') {
        res.status(401).json({
          error: '401 Unauthorized',
          message: 'Insecure JWT algorithm "none" is strictly forbidden.',
        });
        return;
      }
    } catch {
      res.status(401).json({
        error: '401 Unauthorized',
        message: 'Invalid JWT structure.',
      });
      return;
    }

    try {
      let payload: jose.JWTPayload;

      if (jwksRemote) {
        const verifyResult = await jose.jwtVerify(token, jwksRemote, {
          issuer: process.env.JWT_ISSUER || 'company-brain-auth',
          audience: process.env.JWT_AUDIENCE || 'company-brain-api',
        });
        payload = verifyResult.payload;
      } else {
        // Local / Test HMAC Verification
        const verifyResult = await jose.jwtVerify(token, DEV_SECRET);
        payload = verifyResult.payload;
      }

      const verifiedUser: VerifiedUserPayload = {
        user_id: String(payload.user_id || payload.sub || 'unknown_user'),
        workspace_id: String(payload.workspace_id || '00000000-0000-0000-0000-000000000000'),
        role: String(payload.role || 'member'),
        roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [String(payload.role || 'member')],
        clearance_level: Number(payload.clearance_level ?? 1),
      };

      req.user = {
        user_id: verifiedUser.user_id,
        role: (verifiedUser.role as any) || 'member',
        workspace_id: verifiedUser.workspace_id,
        clearance_level: verifiedUser.clearance_level,
      } as any;

      next();
    } catch (err: any) {
      if (err.code === 'ERR_JWT_EXPIRED') {
        res.status(401).json({
          error: '401 Unauthorized',
          message: 'JWT token has expired.',
        });
        return;
      }

      res.status(401).json({
        error: '401 Unauthorized',
        message: `Cryptographic JWT verification failed: ${err.message}`,
      });
    }
  };
}
