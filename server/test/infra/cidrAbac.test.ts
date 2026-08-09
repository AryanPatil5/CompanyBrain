import { installHarness } from '../harness/index.js';
import { isClientIpAllowed } from '../../src/middleware/abacMiddleware.js';

/**
 * Phase 0: CIDR ABAC matcher suite (IPv4/IPv6, fail-closed, substring-bypass regression).
 * Pure function tests — no infrastructure required.
 */
export async function runCidrAbacTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running CIDR ABAC Matcher Test Suite          ');
  console.log('=================================================');

  let passed = 0;
  let failed = 0;

  function check(name: string, actual: boolean, expected: boolean): void {
    if (actual === expected) {
      passed++;
      console.log(`✅ CIDR TEST PASSED: ${name}`);
    } else {
      failed++;
      console.error(`❌ CIDR TEST FAILED: ${name} — expected ${expected}, got ${actual}`);
    }
  }

  // 1. IPv4 allow
  check('IPv4 allow (192.168.1.100 in 192.168.1.0/24)', isClientIpAllowed('192.168.1.100', ['192.168.1.0/24']), true);

  // 2. IPv4 deny
  check('IPv4 deny (10.0.0.5 outside 192.168.1.0/24)', isClientIpAllowed('10.0.0.5', ['192.168.1.0/24']), false);

  // 3. IPv6 allow
  check('IPv6 allow (2001:db8::1 in 2001:db8::/32)', isClientIpAllowed('2001:db8::1', ['2001:db8::/32']), true);

  // 4. IPv6 deny
  check('IPv6 deny (2001:db9::1 outside 2001:db8::/32)', isClientIpAllowed('2001:db9::1', ['2001:db8::/32']), false);

  // 5. Malformed CIDR → fail closed
  check('Malformed CIDR (999.1.1.0/24) denies', isClientIpAllowed('192.168.1.100', ['999.1.1.0/24']), false);
  check('Malformed CIDR (10.0.0.0/33) denies', isClientIpAllowed('10.0.0.1', ['10.0.0.0/33']), false);
  check('Malformed CIDR (10.0.0.0/-1) denies', isClientIpAllowed('10.0.0.1', ['10.0.0.0/-1']), false);
  check('Malformed CIDR (abc/24) denies', isClientIpAllowed('192.168.1.100', ['abc/24']), false);
  check('Malformed CIDR (2001:db8::/129) denies', isClientIpAllowed('2001:db8::1', ['2001:db8::/129']), false);
  check('Malformed CIDR (empty string) denies', isClientIpAllowed('192.168.1.100', ['']), false);

  // 6. Malformed client IP → fail closed
  check('Malformed client IP (999.1.1.1) denied', isClientIpAllowed('999.1.1.1', ['192.168.1.0/24']), false);
  check('Malformed client IP (not-an-ip) denied', isClientIpAllowed('not-an-ip', ['*']), false);
  check('Malformed client IP (1.2.3) denied', isClientIpAllowed('1.2.3', ['0.0.0.0/0']), false);
  check('Malformed client IP (with port) denied', isClientIpAllowed('192.168.1.100:8080', ['192.168.1.0/24']), false);

  // 7. Boundary cases
  check('Boundary: network address in /24', isClientIpAllowed('192.168.1.0', ['192.168.1.0/24']), true);
  check('Boundary: broadcast address in /24', isClientIpAllowed('192.168.1.255', ['192.168.1.0/24']), true);
  check('Boundary: /0 allows all IPv4', isClientIpAllowed('8.8.8.8', ['0.0.0.0/0']), true);
  check('Boundary: /0 blocks IPv6 client', isClientIpAllowed('2001:db8::1', ['0.0.0.0/0']), false);
  check('Boundary: exact /32 host in range', isClientIpAllowed('10.0.0.5', ['10.0.0.5/32']), true);
  check('Boundary: /32 rejects neighbor', isClientIpAllowed('10.0.0.6', ['10.0.0.5/32']), false);
  check('Boundary: IPv6 /128 exact', isClientIpAllowed('fe80::1', ['fe80::1/128']), true);
  check('Boundary: IPv6 /0 allows all IPv6', isClientIpAllowed('2001:db8::1', ['::/0']), true);
  check('Boundary: bare IP range acts as exact host', isClientIpAllowed('10.0.0.5', ['10.0.0.5']), true);
  check('Boundary: bare IP range rejects neighbor', isClientIpAllowed('10.0.0.6', ['10.0.0.5']), false);
  check('Boundary: IPv4-mapped IPv6 client matches IPv4 range', isClientIpAllowed('::ffff:192.168.1.100', ['192.168.1.0/24']), true);
  check('Boundary: IPv4-mapped IPv6 client outside range', isClientIpAllowed('::ffff:10.0.0.5', ['192.168.1.0/24']), false);

  // 8. Substring-bypass regression (the old `clientIp.includes(range)` bug)
  check('Bypass: 1.192.168.1.5 must NOT match 192.168.1.0/24', isClientIpAllowed('1.192.168.1.5', ['192.168.1.0/24']), false);
  check('Bypass: 192.168.1.10.5 must NOT match 192.168.1.10/24', isClientIpAllowed('192.168.1.10.5', ['192.168.1.10/24']), false);
  check('Bypass: 111.222.1.1 must NOT match 222.1.1', isClientIpAllowed('111.222.1.1', ['222.1.1']), false);
  check('Bypass: 2001:db8::1.5 must NOT match 2001:db8::1', isClientIpAllowed('2001:db8::1.5', ['2001:db8::1']), false);

  // 9. Wildcard and multi-range
  check('Wildcard * allows all', isClientIpAllowed('10.1.2.3', ['*']), true);
  check('Wildcard * allows malformed IP', isClientIpAllowed('anything-here', ['*']), false);
  check('Multi-range: second range matches', isClientIpAllowed('172.16.0.5', ['10.0.0.0/8', '172.16.0.0/12']), true);
  check('Multi-range: no range matches', isClientIpAllowed('203.0.113.5', ['10.0.0.0/8', '172.16.0.0/12']), false);

  console.log(`\nCIDR ABAC matcher: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCidrAbacTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
