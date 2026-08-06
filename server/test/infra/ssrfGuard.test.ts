import { ssrfGuard } from '../security/ssrfGuard.js';

jest.mock('../security/ssrfGuard.js');

describe('Phase 0: SSRF Guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should reject requests with invalid User-Agent', async () => {
    const req = {
      headers: { 'user-agent': 'malicious-agent' },
      body: { url: 'https://internal.example.com' }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    ssrfGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid User-Agent for SSRF requests' });
    expect(next).not.toHaveBeenCalled();
  });

  test('should reject requests to non-allowlisted hosts', async () => {
    const req = {
      headers: { 'user-agent': 'company-brain' },
      body: { url: 'https://example.com' }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    ssrfGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Host not in allowed SSRF list' });
    expect(next).not.toHaveBeenCalled();
  });

  test('should reject IP address URLs', async () => {
    const req = {
      headers: { 'user-agent': 'company-brain' },
      body: { url: 'https://192.168.1.1:8080' }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    ssrfGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'SSRF: IP addresses in URLs are not allowed' });
    expect(next).not.toHaveBeenCalled();
  });

  test('should allow valid requests', async () => {
    const req = {
      headers: { 'user-agent': 'company-brain' },
      body: { url: 'https://example.com/api' }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    ssrfGuard(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});