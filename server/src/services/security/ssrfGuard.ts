import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * SSRF Guard (Phase 0 Task 7)
 * Rejects outbound requests to private/loopback/link-local/reserved networks,
 * cloud metadata endpoints, and non-HTTP(S) schemes. Resolves DNS before
 * connecting and validates every resolved address to prevent DNS rebinding.
 * Redirects are followed manually and every hop re-validated.
 */

export class SsrfGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfGuardError';
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// IPv4 ranges that must never be contacted (RFC 1918, loopback, link-local,
// CGNAT, "this" network, benchmarking, multicast, reserved — plus the
// 169.254.0.0/16 block that covers cloud metadata endpoints like 169.254.169.254).
const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// IPv6 ranges: unspecified, loopback (::1), ULA (fc00::/7), link-local (fe80::/10),
// multicast (ff00::/8), and documentation (2001:db8::/32).
const BLOCKED_V6_RANGES: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

/**
 * Returns true when the IP belongs to a blocked (private/loopback/link-local/
 * reserved/metadata) network. Unparseable input fails closed (returns true).
 * IPv4-mapped IPv6 addresses are normalized to IPv4 before checking.
 */
export function isPrivateOrBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip.trim());
  } catch {
    return true;
  }

  if (addr.kind() === 'ipv4') {
    const v4 = addr as ipaddr.IPv4;
    return BLOCKED_V4_RANGES.some(([range, prefix]) => v4.match([ipaddr.parse(range) as ipaddr.IPv4, prefix]));
  }

  const v6 = addr as ipaddr.IPv6;
  return BLOCKED_V6_RANGES.some(([range, prefix]) => v6.match([ipaddr.parse(range) as ipaddr.IPv6, prefix]));
}

/**
 * Syntactic validation of an outbound URL: parses it, requires an http(s)
 * scheme, rejects embedded credentials and empty hosts. Does not touch DNS.
 */
export function validateOutboundUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfGuardError(`Invalid URL: "${rawUrl}"`);
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new SsrfGuardError(`Unsupported scheme "${url.protocol}" — only http:// and https:// are allowed`);
  }

  if (url.username || url.password) {
    throw new SsrfGuardError('URLs with embedded credentials are not allowed');
  }

  if (!url.hostname) {
    throw new SsrfGuardError(`URL has no hostname: "${rawUrl}"`);
  }

  return url;
}

/**
 * Resolves the hostname and rejects the target if ANY resolved address is
 * private/blocked (prevents DNS rebinding). Literal IPs skip DNS.
 */
export async function resolveAndValidateHost(url: URL): Promise<void> {
  // URL.hostname brackets IPv6 literals ("[::1]"); strip them so literal
  // IP detection works and IPv6 targets skip DNS entirely.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new SsrfGuardError(`Host "${hostname}" resolves to loopback and is not allowed`);
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isPrivateOrBlockedIp(hostname)) {
      throw new SsrfGuardError(`Target IP "${hostname}" is in a blocked network range`);
    }
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfGuardError(`DNS resolution failed for host "${hostname}"`);
  }

  if (!addresses || addresses.length === 0) {
    throw new SsrfGuardError(`DNS resolution returned no addresses for host "${hostname}"`);
  }

  for (const entry of addresses) {
    if (isPrivateOrBlockedIp(entry.address)) {
      throw new SsrfGuardError(
        `Host "${hostname}" resolved to blocked address "${entry.address}" (DNS rebinding attempt or private network target)`
      );
    }
  }
}

/**
 * Full target validation: syntax + scheme + resolved-IP check.
 */
export async function validateOutboundTarget(rawUrl: string): Promise<URL> {
  const url = validateOutboundUrl(rawUrl);
  await resolveAndValidateHost(url);
  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function shouldSwitchToGet(status: number, method: string): boolean {
  if (status === 303) return true;
  if (status === 301 || status === 302) return method === 'POST';
  return false;
}

/**
 * Validates a redirect location relative to the current URL. Throws when the
 * redirect target itself is unsafe.
 */
export async function validateRedirectTarget(location: string, baseUrl: URL): Promise<URL> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(location, baseUrl);
  } catch {
    throw new SsrfGuardError(`Invalid redirect location "${location}"`);
  }
  await validateOutboundTarget(targetUrl.toString());
  return targetUrl;
}

/**
 * SSRF-guarded fetch. Validates the initial target, disables automatic redirect
 * following, and manually follows redirects — re-validating (including DNS and
 * private-range checks) every hop. The caller's signal (abort/timeout) is honored.
 */
export async function ssrfSafeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: { maxRedirects?: number } = {}
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;

  let url = await validateOutboundTarget(rawUrl);
  let method = (init.method || 'GET').toUpperCase();
  let redirectCount = 0;

  for (;;) {
    const res = await fetch(url, {
      ...init,
      method,
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(res.status)) {
      return res;
    }

    const location = res.headers.get('location');
    if (!location) {
      return res;
    }

    if (redirectCount >= maxRedirects) {
      throw new SsrfGuardError(`Too many redirects (max ${maxRedirects})`);
    }
    redirectCount++;

    // Every redirect hop is re-validated (scheme, DNS, private ranges) — this
    // is where a malicious server would otherwise bounce us to 169.254.169.254.
    url = await validateRedirectTarget(location, url);

    if (shouldSwitchToGet(res.status, method)) {
      method = 'GET';
      init = { ...init, method: 'GET', body: undefined };
    }
  }
}
