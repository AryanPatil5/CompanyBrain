// Phase 3: document upload + status routes (ADR-T6, ADR-T15).
//
// POST /api/documents/upload — multipart upload (multer, memory storage):
//   MIME/size validated against the STORAGE_MAX_UPLOAD_MB gate, content hash
//   computed server-side, object stored content-addressed
//   (raw/{workspace_id}/{sha256}.{ext}), source_documents row persisted with
//   storage_uri + extraction_stage='queued', and a `parse_document` BullMQ
//   job enqueued (workspace-scoped, no zero-workspace fallback). Returns 202
//   with the document id — the worker owns all heavy work.
//
// GET /api/documents/:id/status — workspace-scoped status probe; unknown or
//   cross-workspace documents return 404 (no existence leak).

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { logger } from '../logger.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { getTenantClient } from '../middleware/tenantClient.js';
import { documentIngestionQueue } from '../queue/ingestionQueue.js';
import {
  getStorageProvider,
  hashBytes,
  objectKeyFor,
  readStorageConfig,
} from '../services/storage/storageProvider.js';

const router = Router();
router.use(authenticate);

const MAX_UPLOAD_MB = parseInt(process.env.STORAGE_MAX_UPLOAD_MB || '25', 10);

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'text/plain',
  'text/markdown',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      cb(new Error(`Unsupported file type: ${mime || 'unknown'}`));
      return;
    }
    cb(null, true);
  },
});

// ─── POST /api/documents/upload ───────────────────────────────

router.post('/upload', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;

    if (!req.file) {
      res.status(400).json({ error: 'Multipart field "file" is required.' });
      return;
    }

    // Storage availability is a hard dependency of the upload path: no
    // provider -> 503. Never silently fall back to any other persistence.
    const provider = getStorageProvider();
    if (!provider) {
      res.status(503).json({ error: 'Object storage is not configured; upload ingestion is unavailable.' });
      return;
    }

    const mime = (req.file.mimetype || '').toLowerCase();
    const contentHash = hashBytes(req.file.buffer);
    const objectKey = objectKeyFor(workspaceId, contentHash, mime);

    const stored = await provider.putObject(objectKey, req.file.buffer, { contentType: mime });
    const config = readStorageConfig();
    const scheme = config?.provider === 'memory' ? 'memory' : 's3';
    const storageUri = `${scheme}://${config?.bucket ?? 'company-brain'}/${objectKey}`;

    const client = getTenantClient(req);
    const { data: doc, error: docErr } = await client
      .from('source_documents')
      .insert({
        workspace_id: workspaceId,
        source: 'upload',
        external_id: contentHash,
        title: req.file.originalname || `upload-${contentHash.slice(0, 12)}`,
        storage_uri: storageUri,
        extraction_stage: 'queued',
        metadata: {
          content_type: mime,
          size_bytes: stored.size,
          original_filename: req.file.originalname || null,
        },
      })
      .select('id, extraction_stage')
      .single();

    if (docErr || !doc) {
      // Duplicate upload of the same content (unique violation on
      // workspace_id+source+external_id): the object is already stored and
      // the row already exists — recover by returning the EXISTING
      // document_id as 202 instead of an uncaught 500. The worker's
      // content-hash short-circuit skips fully-ingested rows; a failed row
      // gets (re)enqueued below, which is exactly the recovery path that
      // re-uploads enable.
      if (docErr?.code === '23505' || /duplicate key|already exists/i.test(docErr?.message ?? '')) {
        const { data: existing } = await client
          .from('source_documents')
          .select('id, extraction_stage')
          .eq('workspace_id', workspaceId)
          .eq('source', 'upload')
          .eq('external_id', contentHash)
          .maybeSingle();
        if (existing?.id) {
          await documentIngestionQueue.add('parse_document', {
            job_name: 'parse_document',
            document_id: existing.id,
            workspace_id: workspaceId,
            storage_key: objectKey,
            content_type: mime,
            content_hash: contentHash,
          });
          res.status(202).json({
            success: true,
            document_id: existing.id,
            storage_key: objectKey,
            status: existing.extraction_stage ?? 'queued',
            deduplicated: true,
          });
          return;
        }
      }
      // Object stored but row failed: log and surface — a retry re-PUTs the
      // same content-addressed key (idempotent) and re-inserts the row.
      throw new Error(`Failed to record uploaded document: ${docErr?.message ?? 'no row returned'}`);
    }

    await documentIngestionQueue.add('parse_document', {
      job_name: 'parse_document',
      document_id: doc.id,
      workspace_id: workspaceId,
      storage_key: objectKey,
      content_type: mime,
      content_hash: contentHash,
    });

    res.status(202).json({
      success: true,
      document_id: doc.id,
      storage_key: objectKey,
      status: doc.extraction_stage ?? 'queued',
    });
  } catch (err: any) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File exceeds the ${MAX_UPLOAD_MB}MB upload limit.` });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    if (err?.message?.includes('Unsupported file type')) {
      res.status(415).json({ error: err.message });
      return;
    }
    logger.error('[Documents Upload Error]:', err);
    res.status(500).json({ error: 'Failed to ingest uploaded document' });
  }
});

// ─── GET /api/documents/:id/status ────────────────────────────

router.get('/:id/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const client = getTenantClient(req);

    const { data, error } = await client
      .from('source_documents')
      .select('id, title, storage_uri, extraction_stage, created_at, metadata')
      .eq('id', req.params.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    if (!data) {
      // Unknown OR cross-workspace: identical 404 (no existence leak).
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    res.json({
      document_id: data.id,
      title: data.title,
      extraction_stage: data.extraction_stage,
      storage_uri: data.storage_uri,
      created_at: data.created_at,
      metadata: data.metadata ?? {},
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch document status' });
  }
});

// Multer errors and the fileFilter rejection are delivered via next(err), so
// they bypass the route handler's try/catch entirely. Without this
// middleware they would fall through to Express's default HTML error page.
// Map them to JSON with the documented status codes (415 unsupported type,
// 413 over the size gate, 400 other multipart problems).
router.use((err: any, _req: Request, res: Response, next: (e?: unknown) => void): void => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `File exceeds the ${MAX_UPLOAD_MB}MB upload limit.` });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  if (err?.message?.includes('Unsupported file type')) {
    res.status(415).json({ error: err.message });
    return;
  }
  next(err);
});

export default router;
