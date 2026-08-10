import { installHarness } from '../harness/index.js';
import crypto from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { supabase } from '../../src/config/supabase.js';
import { ingestWebhookEvent, processWebhookEventJob, recoverStaleWebhookEvents } from '../../src/ingestion/webhookPipeline.js';
import {
  deriveWebhookDedupeKey,
  extractWebhookEventTimestamp,
  persistRawSourceEvent,
  webhookExtractIdempotencyKey,
} from '../../src/services/ingestion/webhookService.js';
import { acquireIdempotency } from '../../src/services/idempotency.js';
import ingestionRouter from '../../src/routes/ingestion.js';
import webhooksRouter from '../../src/routes/webhooks.js';
import { webhookIngestionQueue } from '../../src/queue/ingestionQueue.js';

// The durable pipeline never awaits a transport failure (Redis down => event
// stays 'received' and a provider redelivery retries it). Under the harness,
// queue.add() can stall when a developer's docker Redis is reachable but the
// stub is installed afterwards — so the suite stubs the enqueue to resolve
// deterministically while still firing the real enqueue in the background.
// Every enqueue is also captured so tests can assert the canonical
// { eventId, workspaceId } job payload.
const realEnqueue = webhookIngestionQueue.add.bind(webhookIngestionQueue);
const enqueuedJobs: Array<{ name: string; data: any }> = [];
webhookIngestionQueue.add = async (name: string, data: any) => {
  enqueuedJobs.push({ name, data });
  realEnqueue(name, data).catch(() => {});
  return { id: `job_${Date.now()}` };
};

const DEV_WORKSPACE = '00000000-0000-0000-0000-000000000000';
const OTHER_WORKSPACE = '11111111-1111-1111-1111-111111111111';

export async function runWebhookDurabilityTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running Phase 2 Webhook Durability Pipeline Test');
  console.log('=================================================');

  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    checks.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
    if (ok) console.log(`✅ WEBHOOK DURABILITY: ${name}`);
    else console.error(`❌ WEBHOOK DURABILITY FAILED: ${name}`, detail ?? '');
  };

  // ─── Test 1: dedupe key determinism + sensitivity ──────────────
  try {
    const base = {
      workspaceId: DEV_WORKSPACE,
      provider: 'slack',
      externalId: 'C12345.678',
      eventTimestamp: '1700000000.000001',
      rawPayload: { event: { ts: '1700000000.000001' } },
    };
    const k1 = deriveWebhookDedupeKey(base);
    const k2 = deriveWebhookDedupeKey({ ...base });
    check('deriveWebhookDedupeKey is deterministic for identical deliveries', k1 === k2);

    const variants: Array<[string, Partial<typeof base>]> = [
      ['workspace', { workspaceId: OTHER_WORKSPACE }],
      ['provider', { provider: 'github' }],
      ['externalId', { externalId: 'C99999.000' }],
      ['eventTimestamp', { eventTimestamp: '1700000001.000001' }],
    ];
    const distinct = variants.filter(([, v]) => deriveWebhookDedupeKey({ ...base, ...v }) !== k1);
    check('dedupe key changes with workspace/provider/externalId/eventTimestamp', distinct.length === 4, distinct.map(([n]) => n));

    const noTs = deriveWebhookDedupeKey({ ...base, eventTimestamp: undefined });
    const noTsAgain = deriveWebhookDedupeKey({ ...base, eventTimestamp: undefined });
    const diffPayload = deriveWebhookDedupeKey({ ...base, eventTimestamp: undefined, rawPayload: { other: true } });
    check('dedupe key falls back to content hash when no event timestamp', noTs === noTsAgain && noTs !== diffPayload);
  } catch (err: any) {
    check('Test 1 (dedupe key)', false, err.message);
  }

  // ─── Test 2: provider event timestamp extraction ────────────────
  try {
    const slackTs = extractWebhookEventTimestamp('slack', { event: { ts: '1700000000.000001' }, event_time: 123 });
    check('slack timestamp prefers event.ts', slackTs === '1700000000.000001', slackTs);

    const githubTs = extractWebhookEventTimestamp('github', {
      comment: { created_at: '2024-01-01T00:00:00Z' },
      issue: { created_at: '2023-01-01T00:00:00Z' },
    });
    check('github timestamp prefers comment.created_at', githubTs === '2024-01-01T00:00:00Z', githubTs);

    const linearTs = extractWebhookEventTimestamp('linear', { data: { createdAt: '2024-02-02T00:00:00Z' } });
    check('linear timestamp reads data.createdAt', linearTs === '2024-02-02T00:00:00Z', linearTs);

    const none = extractWebhookEventTimestamp('zendesk', { foo: 'bar' });
    check('unknown/missing timestamps return undefined', none === undefined, none);
  } catch (err: any) {
    check('Test 2 (timestamp extraction)', false, err.message);
  }

  // ─── Test 3: raw event persistence + replay ─────────────────────
  try {
    const input = {
      workspaceId: DEV_WORKSPACE,
      provider: 'slack',
      source: 'slack',
      externalId: 'C11111.001',
      eventTimestamp: '1700000000.100001',
      rawPayload: { event: { type: 'message' } },
      normalizedPayload: { hello: 'world' },
      sourceTrust: 'crawled',
    };

    const first = await persistRawSourceEvent(input);
    check('persistRawSourceEvent returns fresh row with received status', !first.replayed && first.row.status === 'received' && !!first.row.id);
    check('persistRawSourceEvent stores raw + normalized payloads', first.row.raw_payload.event.type === 'message' && first.row.normalized_payload.hello === 'world');

    const replay = await persistRawSourceEvent(input);
    check('identical redelivery returns the SAME row (replayed)', replay.replayed && replay.row.id === first.row.id);

    const { data: rows } = await supabase.from('raw_source_events').select('*').eq('dedupe_key', first.row.dedupe_key);
    check('no second row is created for a replayed delivery', Array.isArray(rows) && rows.length === 1);

    const changed = await persistRawSourceEvent({ ...input, eventTimestamp: '1700000000.200001' });
    check('a different event timestamp yields a NEW event', !changed.replayed && changed.row.id !== first.row.id);
  } catch (err: any) {
    check('Test 3 (persistence)', false, err.message);
  }

  // ─── Test 4: pipeline accept semantics (202 + dedupe) ───────────
  try {
    const accept = {
      workspaceId: DEV_WORKSPACE,
      provider: 'github',
      source: 'github',
      externalId: 'GH-issue-42',
      eventTimestamp: '2024-03-03T00:00:00Z',
      rawPayload: { action: 'opened', issue: { number: 42 } },
      normalizedPayload: null,
      sourceTrust: 'crawled',
    };

    const fresh = await ingestWebhookEvent(accept);
    check('fresh delivery accepted with event_id (queued or received)', fresh.eventId.length > 0 && (fresh.status === 'queued' || fresh.status === 'received'), fresh);

    const dup = await ingestWebhookEvent(accept);
    const dupOk =
      dup.eventId === fresh.eventId &&
      dup.replayed === true &&
      // If the first delivery was already queued, this must be a clean
      // duplicate; if the first enqueue failed (status 'received'), the
      // redelivery either recovers the enqueue or stays 'received'.
      (fresh.status === 'queued' ? dup.status === 'duplicate' : dup.status === 'duplicate' || dup.status === 'queued' || dup.status === 'received');
    check('duplicate delivery returns same event_id + duplicate semantics', dupOk, { fresh, dup });

    const newEvent = await ingestWebhookEvent({ ...accept, eventTimestamp: '2024-03-03T00:00:01Z' });
    check('new event_ts accepted as a NEW event', newEvent.eventId !== fresh.eventId, newEvent);

    // Recovery semantics: an event whose first enqueue never landed (status
    // 'received') is re-enqueued by its next redelivery.
    const { error: resetErr } = await supabase.from('raw_source_events').update({ status: 'received' }).eq('id', fresh.eventId);
    if (resetErr) throw resetErr;
    const recovered = await ingestWebhookEvent(accept);
    check('redelivery recovers a never-enqueued event (re-enqueued)', recovered.eventId === fresh.eventId && recovered.replayed === true && recovered.status === 'queued', recovered);
  } catch (err: any) {
    check('Test 4 (pipeline accept)', false, err.message);
  }

  // ─── Test 5: consumer processing is exactly-once ────────────────
  try {
    const delivery = {
      workspaceId: DEV_WORKSPACE,
      provider: 'slack',
      source: 'slack',
      externalId: 'C22222.002',
      eventTimestamp: '2024-04-04T00:00:00.000Z',
      rawPayload: { event: { ts: '2024-04-04T00:00:00.000Z' } },
      normalizedPayload: {
        workspace_id: DEV_WORKSPACE,
        source: 'slack',
        external_thread_id: 'C22222.002',
        channel_or_project: 'ops',
        messages: [{ user: 'U1', text: 'We had a prod incident today', timestamp: '2024-04-04T00:00:00.000Z' }],
      },
      sourceTrust: 'crawled',
    };

    const accepted = await ingestWebhookEvent(delivery);
    check('delivery accepted before processing', accepted.eventId.length > 0);

    let processed;
    let processedError: string | null = null;
    try {
      processed = await processWebhookEventJob({ eventId: accepted.eventId, workspaceId: DEV_WORKSPACE });
    } catch (err: any) {
      processedError = err.message;
    }
    check(
      'consumer run either completes or fails loudly (both are terminal)',
      processedError !== null || processed === 'skipped' || ['sop_created', 'sop_linked', 'no_sop'].includes((processed as any)?.outcome),
      { processed, processedError },
    );

    const { data: eventAfter } = await supabase.from('raw_source_events').select('*').eq('id', accepted.eventId).maybeSingle();
    check('event row reaches a terminal status', eventAfter && ['completed', 'failed'].includes(eventAfter.status), eventAfter?.status);

    const { data: threads } = await supabase.from('raw_threads').select('*').eq('external_thread_id', 'C22222.002');
    check('exactly ONE raw thread exists after the full cycle', Array.isArray(threads) && threads.length === 1, threads?.length);

    const reProcessed = await processWebhookEventJob({ eventId: accepted.eventId, workspaceId: DEV_WORKSPACE });
    check('re-processing a terminal event is skipped', reProcessed === 'skipped', reProcessed);

    const reAccepted = await ingestWebhookEvent(delivery);
    check('redelivery after processing is a duplicate of the same event', reAccepted.eventId === accepted.eventId && reAccepted.status === 'duplicate', reAccepted);

    const { data: ledger } = await supabase.from('idempotency_keys').select('*');
    const webhookLedger = Array.isArray(ledger) ? ledger.filter((r: any) => r.operation === 'webhook_extract') : [];
    check('idempotency ledger recorded the extraction (terminal status)', webhookLedger.length >= 1 && webhookLedger.every((r: any) => r.status === 'completed' || r.status === 'failed'), webhookLedger.map((r: any) => r.status));
  } catch (err: any) {
    check('Test 5 (consumer exactly-once)', false, err.message);
  }

  // ─── Test 6: unknown event id ───────────────────────────────────
  try {
    const missing = await processWebhookEventJob({ eventId: '00000000-0000-0000-0000-000000000000', workspaceId: DEV_WORKSPACE });
    check('unknown event id returns not_found', missing === 'not_found', missing);
  } catch (err: any) {
    check('Test 6 (unknown event)', false, err.message);
  }

  // ─── Test 7: route-level 202 + status endpoint ──────────────────
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/ingestion', ingestionRouter);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    // The harness does not touch SLACK_SIGNING_SECRET, so a developer's
    // server/.env leaks it in. Sign requests when present (hermetic CI has no
    // .env and the middleware skips verification entirely in non-prod).
    const slackSecret = process.env.SLACK_SIGNING_SECRET;
    const signedHeaders = (rawBody: string): Record<string, string> => {
      if (!slackSecret) return { 'content-type': 'application/json' };
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = crypto
        .createHmac('sha256', slackSecret)
        .update(`v0:${ts}:${rawBody}`)
        .digest('hex');
      return {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': `v0=${sig}`,
      };
    };

    const slackBody = {
      team_id: 'T99999',
      workspace_id: DEV_WORKSPACE,
      external_thread_id: 'C33333.003',
      channel_or_project: 'ops',
      event: { ts: '2024-05-05T00:00:00.000Z' },
      messages: [{ user: 'U1', text: 'Deploy failed at 2am', ts: '2024-05-05T00:00:00.000Z' }],
    };
    const slackRaw = JSON.stringify(slackBody);

    const post = await fetch(`${base}/api/ingestion/webhook`, {
      method: 'POST',
      headers: signedHeaders(slackRaw),
      body: slackRaw,
    });
    const postBody: any = await post.json();
    check('POST /api/ingestion/webhook returns 202 with event_id', post.status === 202 && postBody.success === true && !!postBody.event_id, postBody);

    const dupPost = await fetch(`${base}/api/ingestion/webhook`, {
      method: 'POST',
      headers: signedHeaders(slackRaw),
      body: slackRaw,
    });
    const dupBody: any = await dupPost.json();
    const dupOk =
      dupBody.event_id === postBody.event_id &&
      (postBody.status === 'queued' ? dupBody.status === 'duplicate' : dupBody.status === 'duplicate' || dupBody.status === 'queued' || dupBody.status === 'received');
    check('duplicate POST returns duplicate semantics + same event_id', dupPost.status === 202 && dupOk, { postBody, dupBody });

    const statusRes = await fetch(`${base}/api/ingestion/events/${postBody.event_id}`, {
      headers: { authorization: 'Bearer mock-admin-token' },
    });
    const statusBody: any = await statusRes.json();
    check('GET /api/ingestion/events/:id returns ledger row', statusRes.status === 200 && statusBody.event_id === postBody.event_id && ['received', 'queued'].includes(statusBody.status), statusBody);

    const missingRes = await fetch(`${base}/api/ingestion/events/00000000-0000-0000-0000-000000000000`, {
      headers: { authorization: 'Bearer mock-admin-token' },
    });
    check('unknown event id returns 404', missingRes.status === 404, missingRes.status);

    const { error: crossInsertErr } = await supabase.from('raw_source_events').insert({
      id: '99999999-9999-9999-9999-999999999999',
      dedupe_key: 'cross-workspace-key',
      workspace_id: OTHER_WORKSPACE,
      provider: 'slack',
      source: 'slack',
      external_id: 'other-1',
      raw_payload: {},
      normalized_payload: {},
      source_trust: 'crawled',
      status: 'received',
    });
    if (crossInsertErr) throw crossInsertErr;
    const crossRes = await fetch(`${base}/api/ingestion/events/99999999-9999-9999-9999-999999999999`, { headers: { authorization: 'Bearer mock-admin-token' } });
    check('cross-workspace event id is not visible (404)', crossRes.status === 404, crossRes.status);

    const noTeamRaw = slackRaw.replace('"team_id":"T99999",', '');
    const noTeamRes = await fetch(`${base}/api/ingestion/webhook`, {
      method: 'POST',
      headers: signedHeaders(noTeamRaw),
      body: noTeamRaw,
    });
    check('slack webhook without team_id rejected by middleware (400)', noTeamRes.status === 400, noTeamRes.status);

    server.close();
  } catch (err: any) {
    check('Test 7 (routes)', false, err.message);
  }

  // ─── Test 8: stale event recovery ────────────────────────────────
  try {
    const staleAfterMs = 60_000;
    const cutoffOld = new Date(Date.now() - 10 * 60_000).toISOString();
    const nowIso = new Date().toISOString();

    // (b) fresh processing event is NOT recovered
    const freshId = crypto.randomUUID();
    await supabase.from('raw_source_events').insert({
      id: freshId,
      dedupe_key: 'recovery-fresh',
      workspace_id: DEV_WORKSPACE,
      provider: 'slack',
      source: 'slack',
      external_id: 'fresh-1',
      raw_payload: {},
      normalized_payload: {},
      source_trust: 'crawled',
      status: 'processing',
      created_at: nowIso,
    });
    const freshSweep = await recoverStaleWebhookEvents({ workspaceId: DEV_WORKSPACE, staleAfterMs });
    const { data: freshRow } = await supabase.from('raw_source_events').select('*').eq('id', freshId).maybeSingle();
    check('fresh processing event is NOT recovered', freshSweep.recovered === 0 && freshRow?.status === 'processing', { freshSweep, status: freshRow?.status });

    // (a) stale processing event is recovered: claimed -> queued + canonical enqueue
    const staleId = crypto.randomUUID();
    const staleThreadId = 'recovery-thread-1';
    await supabase.from('raw_source_events').insert({
      id: staleId,
      dedupe_key: 'recovery-stale',
      workspace_id: DEV_WORKSPACE,
      provider: 'slack',
      source: 'slack',
      external_id: staleThreadId,
      event_timestamp: '2024-06-06T00:00:00.000Z',
      raw_payload: { event: { ts: '2024-06-06T00:00:00.000Z' } },
      normalized_payload: {
        workspace_id: DEV_WORKSPACE,
        source: 'slack',
        external_thread_id: staleThreadId,
        channel_or_project: 'ops',
        messages: [{ user: 'U1', text: 'Recovered event content', timestamp: '2024-06-06T00:00:00.000Z' }],
      },
      source_trust: 'crawled',
      status: 'processing',
      created_at: cutoffOld,
    });
    const enqueuedBefore = enqueuedJobs.length;
    const staleSweep = await recoverStaleWebhookEvents({ workspaceId: DEV_WORKSPACE, staleAfterMs });
    const recoveredEnqueues = enqueuedJobs.slice(enqueuedBefore);
    const { data: staleRow } = await supabase.from('raw_source_events').select('*').eq('id', staleId).maybeSingle();
    check(
      'stale processing event is recovered (queued + canonical enqueue)',
      staleSweep.recovered === 1 &&
        staleRow?.status === 'queued' &&
        recoveredEnqueues.length === 1 &&
        recoveredEnqueues[0].name === 'webhook_event' &&
        recoveredEnqueues[0].data.eventId === staleId &&
        recoveredEnqueues[0].data.workspaceId === DEV_WORKSPACE,
      { staleSweep, status: staleRow?.status, recoveredEnqueues },
    );

    // (d) duplicate recovery attempts do not create duplicate processing
    const enqueuedBefore2 = enqueuedJobs.length;
    const dupSweep = await recoverStaleWebhookEvents({ workspaceId: DEV_WORKSPACE, staleAfterMs });
    const dupEnqueues = enqueuedJobs.slice(enqueuedBefore2);
    check('duplicate recovery attempt claims nothing and does not re-enqueue', dupSweep.recovered === 0 && dupEnqueues.length === 0, { dupSweep, dupEnqueues });

    // (c) recovered event is eventually processed to a terminal status
    // (the harness LLM output is invalid for SOP extraction, so the worker
    // may fail loudly — a terminal 'failed' outcome — exactly like Test 5)
    let reprocessed: any = null;
    let reprocessErr: string | null = null;
    try {
      reprocessed = await processWebhookEventJob({ eventId: staleId, workspaceId: DEV_WORKSPACE });
    } catch (err: any) {
      reprocessErr = err.message;
    }
    const { data: terminalRow } = await supabase.from('raw_source_events').select('*').eq('id', staleId).maybeSingle();
    check(
      'recovered event is eventually processed (terminal status)',
      (reprocessed === 'skipped' ||
        ['sop_created', 'sop_linked', 'no_sop'].includes((reprocessed as any)?.outcome) ||
        reprocessErr !== null) &&
        ['completed', 'failed'].includes(terminalRow?.status),
      { reprocessed, reprocessErr, status: terminalRow?.status },
    );

    // workspace-scope: a stale event in ANOTHER workspace is never touched
    const otherId = crypto.randomUUID();
    await supabase.from('raw_source_events').insert({
      id: otherId,
      dedupe_key: 'recovery-other-workspace',
      workspace_id: OTHER_WORKSPACE,
      provider: 'slack',
      source: 'slack',
      external_id: 'other-1',
      raw_payload: {},
      normalized_payload: {},
      source_trust: 'crawled',
      status: 'processing',
      created_at: cutoffOld,
    });
    const scopedSweep = await recoverStaleWebhookEvents({ workspaceId: DEV_WORKSPACE, staleAfterMs });
    const { data: otherRow } = await supabase.from('raw_source_events').select('*').eq('id', otherId).maybeSingle();
    check('recovery is workspace-scoped (other workspace untouched)', scopedSweep.recovered === 0 && otherRow?.status === 'processing', { scopedSweep, status: otherRow?.status });

    // liveness guard: a stale processing event whose ledger is pending+unexpired
    // (worker may still be alive) is NOT recovered
    const liveId = crypto.randomUUID();
    const liveThreadId = 'recovery-live-1';
    await supabase.from('raw_source_events').insert({
      id: liveId,
      dedupe_key: 'recovery-live',
      workspace_id: DEV_WORKSPACE,
      provider: 'slack',
      source: 'slack',
      external_id: liveThreadId,
      event_timestamp: '2024-07-07T00:00:00.000Z',
      raw_payload: { event: { ts: '2024-07-07T00:00:00.000Z' } },
      normalized_payload: { workspace_id: DEV_WORKSPACE, source: 'slack', external_thread_id: liveThreadId, channel_or_project: 'ops', messages: [] },
      source_trust: 'crawled',
      status: 'processing',
      created_at: cutoffOld,
    });
    const liveLedgerKey = webhookExtractIdempotencyKey({
      workspaceId: DEV_WORKSPACE,
      provider: 'slack',
      externalId: liveThreadId,
      eventTimestamp: '2024-07-07T00:00:00.000Z',
      rawPayload: { event: { ts: '2024-07-07T00:00:00.000Z' } },
    });
    const liveAcquire = await acquireIdempotency(DEV_WORKSPACE, liveLedgerKey, 'webhook_extract', { ttlMs: 5 * 60 * 1000 });
    check('liveness guard setup: ledger acquired as pending', liveAcquire.acquired === true);
    const liveSweep = await recoverStaleWebhookEvents({ workspaceId: DEV_WORKSPACE, staleAfterMs });
    const { data: liveRow } = await supabase.from('raw_source_events').select('*').eq('id', liveId).maybeSingle();
    check('processing event with live pending ledger is skipped, not recovered', liveSweep.skipped === 1 && liveSweep.recovered === 0 && liveRow?.status === 'processing', { liveSweep, status: liveRow?.status });
  } catch (err: any) {
    check('Test 8 (stale recovery)', false, err.message);
  }

  // ─── Test 9: legacy webhook route uses the canonical pipeline ────
  try {
    const legacyApp = express();
    legacyApp.use(
      express.json({
        verify: (req: any, _res: any, buf: Buffer) => {
          req.rawBody = buf.toString();
        },
      })
    );
    legacyApp.use('/api/v1/webhooks', webhooksRouter);
    const server = legacyApp.listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const slackSecret = process.env.SLACK_SIGNING_SECRET;
    const signedHeaders = (rawBody: string): Record<string, string> => {
      if (!slackSecret) return { 'content-type': 'application/json' };
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = crypto
        .createHmac('sha256', slackSecret)
        .update(`v0:${ts}:${rawBody}`)
        .digest('hex');
      return {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': `v0=${sig}`,
      };
    };

    // url_verification challenge is answered before any pipeline work
    const challengeBody = { type: 'url_verification', challenge: 'challenge-legacy-123' };
    const challengeRes = await fetch(`${base}/api/v1/webhooks/slack`, {
      method: 'POST',
      headers: signedHeaders(JSON.stringify(challengeBody)),
      body: JSON.stringify(challengeBody),
    });
    const challengeJson: any = await challengeRes.json();
    check('slack url_verification returns the challenge', challengeRes.status === 200 && challengeJson.challenge === 'challenge-legacy-123', challengeJson);

    // real Slack message event -> durable pipeline -> canonical enqueue
    const eventBody = {
      team_id: 'T-leggy',
      event: { type: 'message', channel: 'C-leggy', user: 'U-leggy', text: 'Legacy route event', ts: '1710000000.000001' },
    };
    const eventRaw = JSON.stringify(eventBody);
    const enqueuedBefore3 = enqueuedJobs.length;
    const legacyPost = await fetch(`${base}/api/v1/webhooks/slack`, {
      method: 'POST',
      headers: { ...signedHeaders(eventRaw), 'x-workspace-id': DEV_WORKSPACE },
      body: eventRaw,
    });
    const legacyJson: any = await legacyPost.json();
    const legacyEnqueues = enqueuedJobs.slice(enqueuedBefore3);
    const { data: legacyRow } = await supabase.from('raw_source_events').select('*').eq('id', legacyJson.event_id).maybeSingle();
    check(
      'legacy slack route persists + enqueues canonical { eventId, workspaceId }',
      legacyPost.status === 202 &&
        !!legacyJson.event_id &&
        legacyEnqueues.length === 1 &&
        legacyEnqueues[0].data.eventId === legacyJson.event_id &&
        legacyEnqueues[0].data.workspaceId === DEV_WORKSPACE &&
        legacyRow?.provider === 'slack' &&
        legacyRow?.external_id === 'slack:C-leggy:1710000000.000001',
      { status: legacyPost.status, legacyJson, legacyEnqueues, row: legacyRow?.external_id },
    );

    // non-message Slack events are acknowledged without ingesting
    const ignoredBody = { team_id: 'T-leggy', event: { type: 'member_joined_channel', channel: 'C-leggy', user: 'U-leggy' } };
    const ignoredRaw = JSON.stringify(ignoredBody);
    const enqueuedBefore4 = enqueuedJobs.length;
    const ignoredRes = await fetch(`${base}/api/v1/webhooks/slack`, {
      method: 'POST',
      headers: { ...signedHeaders(ignoredRaw), 'x-workspace-id': DEV_WORKSPACE },
      body: ignoredRaw,
    });
    const ignoredEnqueues = enqueuedJobs.slice(enqueuedBefore4);
    check('non-message slack event is acknowledged, not ingested', ignoredRes.status === 200 && ignoredEnqueues.length === 0, ignoredRes.status);

    const unsupportedRes = await fetch(`${base}/api/v1/webhooks/zoom`, { method: 'POST', body: '{}' });
    check('unsupported provider rejected (400)', unsupportedRes.status === 400, unsupportedRes.status);

    server.close();
  } catch (err: any) {
    check('Test 9 (legacy route)', false, err.message);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nWebhook durability suite: ${checks.length - failed.length} passed, ${failed.length} failed.`);
  return failed.length === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWebhookDurabilityTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
