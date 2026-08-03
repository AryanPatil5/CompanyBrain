-- ==========================================================
-- Company Brain: Document-Level Access Control (DLAC) Vector Search Function
-- Run this in Supabase SQL Editor
-- ==========================================================

-- 1. Create document_permissions mapping table for explicit per-document grants
create table if not exists public.document_permissions (
  id uuid primary key default gen_random_uuid(),
  sop_id uuid references public.skills_sops(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  min_role text check (min_role in ('admin', 'approver', 'member')),
  created_at timestamptz not null default now()
);

create index if not exists idx_doc_perm_sop on public.document_permissions(sop_id);
create index if not exists idx_doc_perm_user on public.document_permissions(user_id);

alter table public.document_permissions enable row level security;

create policy "Service role full access on document_permissions"
  on public.document_permissions for all using (true) with check (true);

-- 2. Define match_embeddings_dlac RPC function with fine-grained DLAC access filtering
create or replace function match_embeddings_dlac(
  query_embedding vector(1536),
  p_workspace_id text,
  p_user_id text,
  match_threshold float default 0.1,
  match_count int default 5
)
returns table (
  id uuid,
  title text,
  trigger_condition text,
  category text,
  risk_level text,
  requires_human_gate boolean,
  similarity float
)
language plpgsql
as $$
declare
  v_user_role text;
begin
  -- Lookup user role in workspace
  select role into v_user_role
  from public.user_workspace_roles
  where user_id::text = p_user_id and workspace_id = p_workspace_id;

  return query
  select
    s.id,
    s.title,
    s.trigger_condition,
    s.category,
    s.risk_level,
    s.requires_human_gate,
    (1 - (s.embedding <=> query_embedding))::float as similarity
  from public.skills_sops s
  where s.workspace_id = p_workspace_id
    and s.embedding is not null
    and (1 - (s.embedding <=> query_embedding)) > match_threshold
    and (
      -- Admins can view all documents in their workspace
      v_user_role = 'admin'
      -- Non-admins can view non-restricted documents (risk_level Low/Medium & requires_human_gate false)
      or (s.requires_human_gate = false and s.risk_level in ('Low', 'Medium'))
      -- Or documents explicitly granted in document_permissions table
      or exists (
        select 1 from public.document_permissions dp
        where dp.sop_id = s.id
          and (dp.user_id::text = p_user_id or dp.min_role = v_user_role)
      )
    )
  order by s.embedding <=> query_embedding
  limit match_count;
end;
$$;
