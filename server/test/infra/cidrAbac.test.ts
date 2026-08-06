import { ROLE_HIERARCHY, type ABACPolicy, enforceABAC } from '../middleware/abacMiddleware.js';

jest.mock('../middleware/abacMiddleware.js');

describe('Phase 0: CIDR ABAC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should allow admin role with CIDR', async () => {
    const policy: ABACPolicy = {
      action: 'read',
      resource: 'document',
      requiredRole: 'admin',
      allowedIpRanges: ['192.168.1.0/24']
    };

    const req = {
      user: { role: 'admin', clearance_level: 100 },
      headers: { 'x-forwarded-for': '192.168.1.100' }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    enforceABAC(policy)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should reject member role with CIDR', async () => {
    const policy: ABACPolicy = {
      action: 'read',
      resource: 'document',
      requiredRole: 'admin',
      allowedIpRanges: ['192.168.1.0/24']
    };

    const req = {
      user: { role: 'member', clearance_level: 10 },
      headers: { 'x-forwarded-for': '192.168.1.100' }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    enforceABAC(policy)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('should allow request with wildcard CIDR', async () => {
    const policy: ABACPolicy = {
      action: 'read',
      resource: 'document',
      allowedIpRanges: ['*']
    };

    const req = {
      user: { role: 'guest', clearance_level: 1 },
      headers: { 'x-forwarded-for': 'any.ip.address' }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    enforceABAC(policy)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});