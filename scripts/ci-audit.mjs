#!/usr/bin/env node
// CI dependency gate. Runs `npm audit --json` for one package directory and
// fails only when the scan reports HIGH/CRITICAL advisories that are NOT on
// the documented allowlist below. Moderate advisories are reported but never
// block. Exit codes: 0 = gate passes, 1 = blocking vulnerabilities found.
//
// Usage: node scripts/ci-audit.mjs <server|client>
//
// Allowlist rationale (each entry is a deliberate, documented risk decision):
// - @opentelemetry/* (1120253, 1124011, 1120252): the only fix is a BREAKING
//   major bump of the pre-1.0 OTel stack (e.g. sdk-node 0.218 -> 0.221). The
//   telemetry export surface is opt-in (OTEL_ENABLED=true, off by default) and
//   the affected paths are the Prometheus exporter and Jaeger header parser.
//   Revisit when the telemetry stack goes 1.x or when the exporters change.
// - xlsx (1108110, 1108111): the `xlsx` npm dist-tag is stale; SheetJS has
//   shipped fixes upstream (cdn.sheetjs.com) but never republished to npm, so
//   no fix is installable. Tracked as a standing exception; revisit on the
//   next xlsx release.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ALLOWLIST = new Map([
  ['@opentelemetry/exporter-prometheus', [1120253]],
  ['@opentelemetry/propagator-jaeger', [1124011]],
  ['@opentelemetry/sdk-node', [1120252]],
  ['@opentelemetry/sdk-trace-node', []],
  ['xlsx', [1108110, 1108111]],
]);

const pkgDir = process.argv[2];
if (!pkgDir || !existsSync(join(pkgDir, 'package-lock.json'))) {
  console.error(`usage: node scripts/ci-audit.mjs <server|client> (needs ${pkgDir}/package-lock.json)`);
  process.exit(2);
}

let auditJson;
try {
  auditJson = execFileSync('npm', ['audit', '--json', '--prefix', pkgDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  // npm audit exits 1 when ANY vulnerability is found (even allowlisted ones);
  // the JSON report is still written to stdout and is the input we parse.
  auditJson = err.stdout ?? '';
  if (!auditJson) {
    console.error('npm audit failed without output — registry unreachable?');
    process.exit(2);
  }
}

let report;
try {
  report = JSON.parse(auditJson);
} catch {
  console.error('npm audit returned invalid JSON — registry unreachable?');
  console.error(auditJson.slice(0, 2000));
  process.exit(2);
}

const blocked = [];
const warned = [];
let moderate = 0;

for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  const severity = vuln.severity ?? 'unknown';
  if (severity !== 'high' && severity !== 'critical') {
    if (severity === 'moderate') moderate++;
    continue;
  }
  const sources = (vuln.via ?? [])
    .filter((v) => typeof v === 'object')
    .map((v) => v.source);
  const allowed = ALLOWLIST.get(name);
  const covered = allowed !== undefined && sources.every((s) => allowed.includes(s));
  const entry = `${name} (${vuln.range ?? '?'}) — ${sources.map((s) => `GHSA-${s}`).join(', ') || 'via parent'}`;
  if (covered) warned.push(entry);
  else blocked.push(entry);
}

if (warned.length) {
  console.log(`[ci-audit] ${pkgDir}: ${warned.length} known/allowlisted high-severity finding(s) (accepted risk):`);
  for (const w of warned) console.log(`  [ALLOWED] ${w}`);
}
if (moderate > 0) {
  console.log(`[ci-audit] ${pkgDir}: ${moderate} moderate finding(s) — reported, not blocking.`);
}
if (blocked.length) {
  console.error(`[ci-audit] ${pkgDir}: ${blocked.length} BLOCKING high/critical finding(s):`);
  for (const b of blocked) console.error(`  [BLOCKED] ${b}`);
  console.error('[ci-audit] Fix or update the allowlist in scripts/ci-audit.mjs (with justification).');
  process.exit(1);
}

console.log(`[ci-audit] ${pkgDir}: gate PASS (${moderate} moderate, ${warned.length} allowlisted).`);
process.exit(0);
