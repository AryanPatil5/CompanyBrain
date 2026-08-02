-- ===================================================
-- Company Brain: Custom Access Token Auth Hook
-- Run this in Supabase SQL Editor
-- ===================================================

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  user_role text;
  user_workspace_id text;
begin
  select role, workspace_id
    into user_role, user_workspace_id
    from public.user_workspace_roles
    where user_id = (event->>'user_id')::uuid;

  claims := event->'claims';

  if user_role is not null then
    claims := jsonb_set(claims, '{role}', to_jsonb(user_role));
    claims := jsonb_set(claims, '{workspace_id}', to_jsonb(user_workspace_id));
  else
    -- No mapping found — do not silently default. Deny by omission: leave role/workspace_id
    -- unset so downstream authenticate middleware treats this as unauthorized.
    claims := jsonb_set(claims, '{role}', 'null'::jsonb);
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
