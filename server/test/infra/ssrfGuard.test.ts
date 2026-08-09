import { installHarness } from '../harness/index.js';
import {
  validateOutboundUrl,
  validateOutboundTarget,
  validateRedirectTarget,
  isPrivateOrBlockedIp,
  ssrfSafeFetch,
} from '../../src/services/security/ssrfGuard.js';
import { lookup } from 'node:dns/promises';

/**
 * Phase 0: SSRF Guard test suite.
 * Scheme rejection, private/loopback/link-local/metadata ranges (IPv4 + IPv6),
 * DNS resolution + rebinding prevention, redirect-hop validation, and
 * integration with http_adapters and the OpenAPI auto-discoverer.
 */
export async function runSsrfGuardTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running SSRF Guard Test Suite                 ');
  console.log('=================================================');

  let passed = 0;
  let failed = 0;

  function check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
      passed++;
      console.log(`✅ SSRF TEST PASSED: ${name}`);
    } else {
      failed++;
      console.error(`❌ SSRF TEST FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  function expectReject(name: string, fn: () => Promise<unknown> | unknown): void {
    try {
      const result = fn();
      Promise.resolve(result).then(
        () => check(name, false, 'expected rejection, call succeeded'),
        () => check(name, true)
      );
    } catch {
      check(name, true);
    }
  }

  function expectAllow(name: string, fn: () => Promise<unknown> | unknown): void {
    try {
      const result = fn();
      Promise.resolve(result).then(
        () => check(name, true),
        (err) => check(name, false, `unexpected rejection: ${(err as Error).message}`)
      );
    } catch (err) {
      check(name, false, `unexpected rejection: ${(err as Error).message}`);
    }
  }

  // ─── 1. Scheme rejection ───
  for (const scheme of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'unix:///var/run/docker.sock', 'data:text/plain,hi', 'javascript:alert(1)', 'ws://example.com/', 'mailto:a@b.c', 'foo://example.com/']) {
    expectReject(`Scheme rejected: ${scheme.split(':')[0]}://`, () => validateOutboundUrl(scheme));
  }
  expectAllow('http:// allowed', () => validateOutboundUrl('http://example.com/'));
  expectAllow('https:// allowed', () => validateOutboundUrl('https://example.com/'));

  // ─── 2. URL syntax rejections ───
  expectReject('Malformed URL rejected', () => validateOutboundUrl('not a url'));
  expectReject('Embedded credentials rejected', () => validateOutboundUrl('https://user:pass@example.com/'));
  expectReject('Non-resolving parsed host rejected at DNS stage', () => validateOutboundTarget('https:///path'));

  // ─── 3. Private/blocked IPv4 ranges (literal IPs, no DNS) ───
  const blockedV4 = [
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254',
    '127.0.0.1', '127.255.255.254', '169.254.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255',
    '224.0.0.1', '240.0.0.1', '255.255.255.255',
  ];
  for (const ip of blockedV4) {
    expectReject(`Blocked IPv4: ${ip}`, () => validateOutboundTarget(`http://${ip}/`));
  }

  // ─── 4. Private/blocked IPv6 ranges ───
  const blockedV6 = [
    '::1', '::', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.1.1', '::ffff:169.254.169.254',
  ];
  for (const ip of blockedV6) {
    expectReject(`Blocked IPv6: ${ip}`, () => validateOutboundTarget(`http://[${ip}]/`));
  }

  // ─── 5. Public IPs allowed ───
  const publicIps = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '172.15.255.255', '172.32.0.1', '11.0.0.1', '192.167.255.255', '192.169.0.1', '169.255.0.1', '2001:4860:4860::8888'];
  for (const ip of publicIps) {
    const literal = ip.includes(':') ? `[${ip}]` : ip;
    expectAllow(`Public IP allowed: ${ip}`, () => validateOutboundTarget(`http://${literal}/`));
  }

  // ─── 6. Fail-closed on unparseable IP ───
  check('Unparseable IP fails closed', isPrivateOrBlockedIp('garbage-ip') === true);

  // ─── 7. Hostname handling (DNS) ───
  expectReject('localhost rejected before DNS', () => validateOutboundTarget('http://localhost:11434/'));
  expectReject('sub.localhost rejected', () => validateOutboundTarget('http://ollama.localhost/'));
  expectReject('Non-resolving host rejected (fail closed)', () => validateOutboundTarget('http://does-not-exist.invalid/'));
  // The example.com assertion requires real DNS resolution (public hostname ->
  // resolved public IPs validated). Skip it, instead of failing, when no
  // resolver is reachable (hermetic/CI environments with no network).
  let dnsAvailable = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DNS probe timed out')), 2000);
      lookup('example.com')
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err);
        });
    });
    dnsAvailable = true;
  } catch {
    dnsAvailable = false;
  }
  if (dnsAvailable) {
    expectAllow('Public hostname allowed (resolved IPs validated)', () => validateOutboundTarget('https://example.com/'));
  } else {
    console.log('⏭️  SSRF TEST SKIPPED: Public hostname DNS assertion skipped (no resolver reachable).');
  }

  // ─── 8. Redirect target validation ───
  const base = new URL('https://example.com/start');
  expectReject('Redirect to loopback rejected', () => validateRedirectTarget('http://127.0.0.1:8080/', base));
  expectReject('Redirect to metadata IP rejected', () => validateRedirectTarget('http://169.254.169.254/latest/meta-data/', base));
  expectReject('Redirect to file:// rejected', () => validateRedirectTarget('file:///etc/passwd', base));
  expectReject('Redirect to private hostname rejected', () => validateRedirectTarget('http://10.0.0.5/health', base));
  expectAllow('Redirect to public target allowed', () => validateRedirectTarget('https://1.1.1.1/', base));
  expectReject('Relative redirect through private base rejected', () => validateRedirectTarget('/admin', new URL('http://192.168.1.5/')));

  // ─── 9. ssrfSafeFetch rejects before connecting (hermetic) ───
  expectReject('ssrfSafeFetch blocks private target before connect', () => ssrfSafeFetch('http://127.0.0.1:1/'));
  expectReject('ssrfSafeFetch blocks metadata target before connect', () => ssrfSafeFetch('http://169.254.169.254/latest/meta-data/'));
  expectReject('ssrfSafeFetch blocks non-http scheme', () => ssrfSafeFetch('file:///etc/passwd'));

  // ─── 10. Redirect loop: every hop validated (stubbed fetch) ───
  const originalFetch = globalThis.fetch;
  try {
    const stubFetch = ((input: any) =>
      Promise.resolve(
        new Response(null, {
          status: String(input) === 'https://1.1.1.1/start' ? 302 : 200,
          headers: String(input) === 'https://1.1.1.1/start'
            ? { location: 'http://169.254.169.254/latest/meta-data/' }
            : {},
        })
      )) as unknown as typeof fetch;
    globalThis.fetch = stubFetch;

    expectReject('Redirect to metadata endpoint rejected mid-loop', () => ssrfSafeFetch('https://1.1.1.1/start'));

    const safeStub = ((input: any) =>
      Promise.resolve(
        new Response(null, {
          status: String(input) === 'https://1.1.1.1/start' ? 302 : 200,
          headers: String(input) === 'https://1.1.1.1/start' ? { location: 'https://1.1.1.1/done' } : {},
        })
      )) as unknown as typeof fetch;
    globalThis.fetch = safeStub;

    let hops = 0;
    const originalFetch2 = globalThis.fetch;
    const countingStub = ((_input: any) => {
      hops++;
      return Promise.resolve(
        new Response(null, {
          status: hops === 1 ? 302 : 200,
          headers: hops === 1 ? { location: 'https://1.1.1.1/done' } : {},
        })
      );
    }) as unknown as typeof fetch;
    globalThis.fetch = countingStub;

    try {
      const res = await ssrfSafeFetch('https://1.1.1.1/start');
      check('Redirect to public target followed', res.status === 200 && hops === 2);
    } catch (err) {
      check('Redirect to public target followed', false, (err as Error).message);
    } finally {
      globalThis.fetch = originalFetch2;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ─── 11. Integration: http_adapters rejects SSRF target ───
  try {
    const { dispatchStepExecution } = await import('../../src/services/integrations/http_adapters.js');
    const prevToken = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_ssrf_fake';
    try {
      const result = await dispatchStepExecution(
        'stripe',
        { base_url: 'http://169.254.169.254' },
        { action: 'refund' },
        'vault:stripe_secret_key'
      );
      check('http_adapters: metadata base_url rejected with 403', result.success === false && result.status_code === 403 && (result.error || '').includes('SSRF'));
    } finally {
      if (prevToken === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prevToken;
    }
  } catch (err) {
    check('http_adapters: metadata base_url rejected with 403', false, (err as Error).message);
  }

  // ─── 12. Integration: OpenAPI auto-discoverer rejects SSRF spec URL ───
  try {
    const { discoverAndSynthesizeToolsFromSpec } = await import('../../src/services/skills/openApiAutoDiscoverer.js');
    const result = await discoverAndSynthesizeToolsFromSpec('http://127.0.0.1/spec.json');
    check(
      'OpenAPI discoverer: private spec URL fails closed',
      result.status === 'error' && (result.error || '').includes('blocked')
    );
  } catch (err) {
    check('OpenAPI discoverer: private spec URL fails closed', false, (err as Error).message);
  }

  console.log(`\nSSRF guard: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSsrfGuardTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
