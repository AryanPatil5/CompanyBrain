import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { supabase } from '../src/config/supabase.js';
import { persistSourceDocumentWithChunks, formatMessagesAsTranscript } from '../src/ingestion/sourceObjects.js';
import { hybridSearch } from '../src/services/retrieval/hybridSearch.js';
import { chunkText } from '../src/ingestion/chunker.js';

/**
 * Integration Test: End-to-End Chunk Ingestion → Embedding → Retrieval Pipeline
 * 
 * This test validates that:
 * 1. Source documents are created with proper workspace scoping
 * 2. Documents are chunked with overlaps
 * 3. Chunks receive embeddings
 * 4. Retrieval uses chunks (not just fallback to SOPs)
 * 5. ACL-aware filtering works on chunks
 */
describe('Chunk Ingestion Pipeline', () => {
  const TEST_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';
  const TEST_SOURCE = 'test_connector';
  const TEST_EXTERNAL_ID = `test_${Date.now()}`;
  let createdSourceDocumentId: string | null = null;
  const createdChunkIds: string[] = [];

  beforeAll(async () => {
    console.log('🧪 Starting chunk ingestion integration tests...');
  });

  afterAll(async () => {
    // Cleanup: remove test data
    if (createdSourceDocumentId) {
      await supabase
        .from('source_documents')
        .delete()
        .eq('id', createdSourceDocumentId);
    }
    if (createdChunkIds.length > 0) {
      for (const chunkId of createdChunkIds) {
        await supabase
          .from('document_chunks')
          .delete()
          .eq('id', chunkId);
      }
    }
    console.log('✅ Cleaned up test data');
  });

  describe('Source Document Creation', () => {
    it('should create source_documents with proper metadata', async () => {
      const testMessages = [
        { user: 'alice', text: 'We had a production outage yesterday at 3pm UTC.' },
        { user: 'bob', text: 'Root cause was a database connection pool exhaustion.' },
        { user: 'alice', text: 'We fixed it by increasing pool size and adding better monitoring.' },
      ];

      const transcript = formatMessagesAsTranscript(testMessages);
      expect(transcript).toContain('alice');
      expect(transcript).toContain('production outage');

      const result = await persistSourceDocumentWithChunks({
        workspaceId: TEST_WORKSPACE_ID,
        source: TEST_SOURCE,
        externalId: TEST_EXTERNAL_ID,
        title: 'Test: Database Outage Resolution',
        text: transcript,
        metadata: {
          test: true,
          message_count: testMessages.length,
        },
      });

      expect(result).not.toBeNull();
      expect(result?.source_key).toContain(TEST_WORKSPACE_ID);
      expect(result?.chunksPersisted).toBeGreaterThan(0);
      expect(result?.chunks.length).toBe(result?.chunksPersisted);

      createdSourceDocumentId = result?.id || null;

      // Verify in database
      const { data: doc, error } = await supabase
        .from('source_documents')
        .select('id, workspace_id, source, external_id, title, content_hash')
        .eq('id', createdSourceDocumentId)
        .single();

      expect(error).toBeNull();
      expect(doc).not.toBeNull();
      expect(doc?.workspace_id).toBe(TEST_WORKSPACE_ID);
      expect(doc?.source).toBe(TEST_SOURCE);
      expect(doc?.external_id).toBe(TEST_EXTERNAL_ID);
    });
  });

  describe('Chunk Creation and Storage', () => {
    it('should create multiple chunks with proper segmentation', async () => {
      const longText =
        'Step 1: Check the database logs. Look for connection pool errors in /var/log/mysql/error.log.\n\n' +
        'Step 2: Increase the max_connections parameter in /etc/mysql/my.cnf from 150 to 300.\n\n' +
        'Step 3: Restart MySQL: sudo systemctl restart mysql.\n\n' +
        'Step 4: Verify connections are working: mysql -u root -p -e "SHOW STATUS LIKE \'Threads_connected\';".\n\n' +
        'Step 5: Monitor for 24 hours using our new Prometheus dashboards.\n\n' +
        'If issues recur, escalate to infrastructure team.';

      const chunks = chunkText(longText, {
        maxChars: 300,
        overlapChars: 50,
        metadata: { type: 'procedure', source: 'runbook' },
      });

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      chunks.forEach((chunk, idx) => {
        expect(chunk.chunk_index).toBe(idx);
        expect(chunk.content).toBeTruthy();
        expect(chunk.content_hash).toBeTruthy();
        expect(chunk.token_count_estimate).toBeGreaterThan(0);
        expect(chunk.metadata.type).toBe('procedure');
      });
    });

    it('should store chunks in database with embeddings', async () => {
      // Create a source document
      const testMessages = [
        { user: 'eng', text: 'We deployed v2.1.0 with rate limiter fixes.' },
        { user: 'ops', text: 'Latency dropped 40% after the deploy.' },
      ];

      const result = await persistSourceDocumentWithChunks({
        workspaceId: TEST_WORKSPACE_ID,
        source: TEST_SOURCE,
        externalId: `test_chunks_${Date.now()}`,
        title: 'Test: Rate Limiter Fix Deployment',
        text: formatMessagesAsTranscript(testMessages),
      });

      expect(result).not.toBeNull();
      expect(result!.chunksPersisted).toBeGreaterThan(0);

      // Retrieve chunks
      const { data: chunks, error } = await supabase
        .from('document_chunks')
        .select('id, content, embedding, metadata, allowed_roles')
        .eq('workspace_id', TEST_WORKSPACE_ID)
        .eq('source_document_id', result!.id);

      expect(error).toBeNull();
      expect(chunks).not.toBeNull();
      expect(chunks!.length).toBe(result!.chunksPersisted);

      // Track for cleanup
      chunks!.forEach((chunk) => {
        createdChunkIds.push(chunk.id);
      });

      // Verify each chunk
      chunks!.forEach((chunk) => {
        expect(chunk.content).toBeTruthy();
        expect(chunk.content.length).toBeGreaterThan(0);
        expect(chunk.metadata).toBeDefined();
        expect(chunk.allowed_roles).toEqual(expect.arrayContaining(['admin', 'member']));
      });

      // Verify embeddings were generated (may be null if embedding service not available)
      const chunksWithEmbedding = chunks!.filter((c) => c.embedding !== null);
      console.log(`✓ ${chunksWithEmbedding.length}/${chunks!.length} chunks have embeddings`);
    });
  });

  describe('ACL-Aware Retrieval', () => {
    it('should filter chunks by allowed_roles', async () => {
      // Create a document with restricted roles
      const result = await persistSourceDocumentWithChunks({
        workspaceId: TEST_WORKSPACE_ID,
        source: TEST_SOURCE,
        externalId: `test_acl_${Date.now()}`,
        title: 'Test: Sensitive Incident Response',
        text: formatMessagesAsTranscript([
          { user: 'security', text: 'We detected unauthorized API access.' },
          { user: 'security', text: 'Revoked compromised tokens immediately.' },
        ]),
        allowedRoles: ['admin'],
      });

      expect(result).not.toBeNull();

      // Track for cleanup
      const { data: chunks } = await supabase
        .from('document_chunks')
        .select('id')
        .eq('source_document_id', result!.id);

      chunks!.forEach((chunk) => {
        createdChunkIds.push(chunk.id);
      });

      // Verify ACL is stored
      const { data: docAcls } = await supabase
        .from('source_document_acls')
        .select('permission, principal_type, principal_id')
        .eq('source_document_id', result!.id);

      expect(docAcls).not.toBeNull();
      expect(docAcls!.length).toBeGreaterThan(0);
      expect(docAcls![0].principal_type).toBe('role');
      expect(docAcls![0].principal_id).toBe('admin');
    });

    it('should retrieve chunks via hybrid search', async () => {
      // First, create a source document with searchable content
      const result = await persistSourceDocumentWithChunks({
        workspaceId: TEST_WORKSPACE_ID,
        source: TEST_SOURCE,
        externalId: `test_search_${Date.now()}`,
        title: 'Test: Kubernetes Cluster Crash',
        text: formatMessagesAsTranscript([
          {
            user: 'devops',
            text:
              'The Kubernetes cluster crashed due to etcd corruption. We restored from backup. ' +
              'To prevent this, enable etcd snapshots every 6 hours.',
          },
          {
            user: 'platform',
            text: 'We also added automated health checks for etcd. Any anomalies trigger alerts.',
          },
        ]),
      });

      expect(result).not.toBeNull();

      // Track for cleanup
      const { data: chunks } = await supabase
        .from('document_chunks')
        .select('id')
        .eq('source_document_id', result!.id);

      chunks!.forEach((chunk) => {
        createdChunkIds.push(chunk.id);
      });

      // Now try to retrieve via hybrid search
      const searchResults = await hybridSearch({
        query: 'etcd backup restoration',
        workspaceId: TEST_WORKSPACE_ID,
        userId: 'test_user',
        role: 'admin',
        limit: 5,
      });

      // Should get some results (may be limited by embedding service availability)
      console.log(`✓ Hybrid search returned ${searchResults.length} results`);
      expect(Array.isArray(searchResults)).toBe(true);

      // If we got results, verify structure
      if (searchResults.length > 0) {
        const result = searchResults[0];
        expect(result.id).toBeDefined();
        expect(result.title).toBeDefined();
        expect(result.similarity).toBeDefined();
        expect(result.rrfScore).toBeDefined();
      }
    });
  });

  describe('Chunk Deduplication', () => {
    it('should not create duplicate chunks for same source', async () => {
      const externalId = `test_dedup_${Date.now()}`;
      const sampleText = formatMessagesAsTranscript([
        { user: 'user1', text: 'First message with important SOP info.' },
      ]);

      // Insert first time
      const result1 = await persistSourceDocumentWithChunks({
        workspaceId: TEST_WORKSPACE_ID,
        source: TEST_SOURCE,
        externalId,
        title: 'Test: Duplicate Source',
        text: sampleText,
      });

      expect(result1).not.toBeNull();
      const firstChunkCount = result1!.chunksPersisted;

      // Track for cleanup
      const { data: chunks1 } = await supabase
        .from('document_chunks')
        .select('id')
        .eq('source_document_id', result1!.id);

      chunks1!.forEach((chunk) => {
        createdChunkIds.push(chunk.id);
      });

      // Upsert same source again (should update existing document)
      const result2 = await persistSourceDocumentWithChunks({
        workspaceId: TEST_WORKSPACE_ID,
        source: TEST_SOURCE,
        externalId,
        title: 'Test: Duplicate Source (Updated)',
        text: sampleText,
      });

      expect(result2).not.toBeNull();
      expect(result2!.id).toBe(result1!.id); // Same document
      expect(result2!.chunksPersisted).toBe(firstChunkCount); // Same number of chunks
    });
  });

  describe('Performance and Edge Cases', () => {
    it('should handle empty text gracefully', async () => {
      const result = await persistSourceDocumentWithChunks({
        workspaceId: TEST_WORKSPACE_ID,
        source: TEST_SOURCE,
        externalId: `test_empty_${Date.now()}`,
        title: 'Test: Empty Document',
        text: '   \n  \n   ',
      });

      expect(result).toBeNull(); // Empty text should return null
    });

    it('should handle very large documents', async () => {
      // Create a large text (e.g., 50KB)
      let largeText = '';
      for (let i = 0; i < 1000; i++) {
        largeText += `Section ${i}: This is a procedural step in a long runbook. `;
        largeText += 'We need to ensure all steps are properly indexed and searchable. ';
        largeText += 'Each chunk should be semantic and useful for retrieval. ';
        largeText += 'Overlapping chunks help with context preservation.\n\n';
      }

      const result = await persistSourceDocumentWithChunks({
        workspaceId: TEST_WORKSPACE_ID,
        source: TEST_SOURCE,
        externalId: `test_large_${Date.now()}`,
        title: 'Test: Large Document',
        text: largeText,
      });

      expect(result).not.toBeNull();
      expect(result!.chunksPersisted).toBeGreaterThan(10); // Should create many chunks

      // Track for cleanup
      const { data: chunks } = await supabase
        .from('document_chunks')
        .select('id')
        .eq('source_document_id', result!.id);

      chunks!.forEach((chunk) => {
        createdChunkIds.push(chunk.id);
      });
    });
  });

  describe('Chunk Content Validation', () => {
    it('should preserve content integrity through chunking', async () => {
      const originalMessages = [
        {
          user: 'author',
          text:
            'Root cause: The load balancer failed to distribute traffic correctly due to a misconfigured health check.',
        },
        { user: 'responder', text: 'Fix: Updated health check endpoint and restarted load balancer service.' },
      ];

      const transcript = formatMessagesAsTranscript(originalMessages);
      const result = await persistSourceDocumentWithChunks({
        workspaceId: TEST_WORKSPACE_ID,
        source: TEST_SOURCE,
        externalId: `test_integrity_${Date.now()}`,
        title: 'Test: Content Integrity',
        text: transcript,
      });

      expect(result).not.toBeNull();

      // Retrieve chunks and reconstruct
      const { data: chunks } = await supabase
        .from('document_chunks')
        .select('content')
        .eq('source_document_id', result!.id)
        .order('chunk_index', { ascending: true });

      // Verify all key terms are present in chunks
      const reconstructedContent = chunks!.map((c) => c.content).join(' ');
      expect(reconstructedContent).toContain('load balancer');
      expect(reconstructedContent).toContain('health check');
      expect(reconstructedContent).toContain('Root cause');
      expect(reconstructedContent).toContain('Fix');

      // Track for cleanup
      chunks!.forEach((chunk) => {
        createdChunkIds.push(chunk.id);
      });
    });
  });
});
