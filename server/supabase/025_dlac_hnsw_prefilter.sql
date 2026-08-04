-- ==========================================================
-- Company Brain: Document-Level Access Control (DLAC) HNSW Vector Prefilter
-- Run this in Supabase / PostgreSQL SQL Editor
-- ==========================================================

create or replace function public.dlac_hnsw_vector_search(
  query_embedding vector(1536),
  workspace_id_filter text,
  allowed_doc_ids text[] default null,
  match_threshold float default 0.3,
  match_count int default 10
)
returns table (
  id uuid,
  document_id text,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
security definer
as $$
begin
  return query
  select
    d.id,
    d.source_document_id as document_id,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.document_chunks d
  where d.workspace_id = workspace_id_filter
    and (1 - (d.embedding <=> query_embedding)) > match_threshold
    and (
      -- NULL means unrestricted admin/system access. An empty array means
      -- the caller has no explicit document grants and must not see chunks.
      allowed_doc_ids is null
      or d.source_document_id = any(allowed_doc_ids)
    )
  order by d.embedding <=> query_embedding
  limit match_count;
end;
$$;
