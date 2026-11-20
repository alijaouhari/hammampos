-- HammamPOS cloud: remote admin panel (step 3a).
--  * remote_sessions: created by the manager (dashboard); the hammam PC accepts admin
--    requests only for a session row of ITS location that is open, not expired (server
--    clock) and unlocked with that hammam's admin password (checked on the PC).
--  * Transport: private Realtime broadcast topic 'admin-rpc:<location_id>'. Only the
--    manager and that location's device may read or send on it.

create table if not exists public.remote_sessions (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 minutes',
  password_ok boolean not null default false,
  ended_at    timestamptz
);
create index if not exists remote_sessions_loc_idx on public.remote_sessions(location_id, created_at desc);
alter table public.remote_sessions enable row level security;

drop policy if exists "admin manages remote sessions" on public.remote_sessions;
create policy "admin manages remote sessions" on public.remote_sessions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "device reads own remote sessions" on public.remote_sessions;
create policy "device reads own remote sessions" on public.remote_sessions for select to authenticated
  using (location_id = public.device_location());
drop policy if exists "device updates own remote sessions" on public.remote_sessions;
create policy "device updates own remote sessions" on public.remote_sessions for update to authenticated
  using (location_id = public.device_location()) with check (location_id = public.device_location());

-- Server-side checks (the PC clock is not trusted).
create or replace function public.remote_session_valid(sid uuid) returns boolean
  language sql stable security invoker set search_path = public as
$$ select exists (select 1 from public.remote_sessions
                   where id = sid and ended_at is null and expires_at > now()) $$;

create or replace function public.remote_session_touch(sid uuid) returns boolean
  language plpgsql security invoker set search_path = public as
$$
begin
  update public.remote_sessions set expires_at = now() + interval '30 minutes'
   where id = sid and ended_at is null and expires_at > now() and password_ok;
  return found;
end
$$;
revoke all on function public.remote_session_valid(uuid) from public, anon;
revoke all on function public.remote_session_touch(uuid) from public, anon;
grant execute on function public.remote_session_valid(uuid) to authenticated;
grant execute on function public.remote_session_touch(uuid) to authenticated;

-- Private broadcast topics.
drop policy if exists "hammampos rpc: admin receives" on realtime.messages;
create policy "hammampos rpc: admin receives" on realtime.messages for select to authenticated
  using (realtime.topic() like 'admin-rpc:%' and public.is_admin());
drop policy if exists "hammampos rpc: admin sends" on realtime.messages;
create policy "hammampos rpc: admin sends" on realtime.messages for insert to authenticated
  with check (realtime.topic() like 'admin-rpc:%' and public.is_admin());
drop policy if exists "hammampos rpc: device receives" on realtime.messages;
create policy "hammampos rpc: device receives" on realtime.messages for select to authenticated
  using (realtime.topic() = 'admin-rpc:' || public.device_location()::text);
drop policy if exists "hammampos rpc: device sends" on realtime.messages;
create policy "hammampos rpc: device sends" on realtime.messages for insert to authenticated
  with check (realtime.topic() = 'admin-rpc:' || public.device_location()::text);
