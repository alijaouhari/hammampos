-- HammamPOS cloud: commands from the dashboard to a hammam PC (live connection, step 2).
--   The manager inserts a command; the PC of that location receives it over Realtime
--   (or finds it on its 15 s check), claims it once, runs it and writes the result.
--   A command older than 10 minutes (server clock) can no longer be claimed.

create table if not exists public.device_commands (
  id           bigint generated always as identity primary key,
  location_id  uuid not null references public.locations(id) on delete cascade,
  action       text not null,
  args         jsonb not null default '{}'::jsonb,
  status       text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'expired')),
  result       jsonb,
  requested_by uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index if not exists device_commands_loc_status_idx on public.device_commands(location_id, status, created_at desc);

alter table public.device_commands enable row level security;

drop policy if exists "admin manages commands" on public.device_commands;
create policy "admin manages commands" on public.device_commands for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "device reads own commands" on public.device_commands;
create policy "device reads own commands" on public.device_commands for select to authenticated
  using (location_id = public.device_location());
drop policy if exists "device updates own commands" on public.device_commands;
create policy "device updates own commands" on public.device_commands for update to authenticated
  using (location_id = public.device_location()) with check (location_id = public.device_location());

-- created_at always from the server; only these columns are the device's to change.
create or replace function public.device_commands_guard() returns trigger
  language plpgsql as
$$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.status := 'pending';
    new.started_at := null; new.finished_at := null; new.result := null;
  elsif not public.is_admin() then
    -- a device may only move status forward and write its result
    new.location_id := old.location_id; new.action := old.action; new.args := old.args;
    new.requested_by := old.requested_by; new.created_at := old.created_at;
    if new.status in ('done', 'failed') then new.finished_at := now(); end if;
  end if;
  return new;
end
$$;
drop trigger if exists device_commands_guard on public.device_commands;
create trigger device_commands_guard before insert or update on public.device_commands
  for each row execute function public.device_commands_guard();

-- Claim a command exactly once, and only if it is fresh (server clock).
create or replace function public.claim_device_command(cmd_id bigint) returns public.device_commands
  language plpgsql security invoker set search_path = public as
$$
declare r public.device_commands;
begin
  update public.device_commands
     set status = 'running', started_at = now()
   where id = cmd_id and status = 'pending' and created_at > now() - interval '10 minutes'
   returning * into r;
  if r.id is null then
    update public.device_commands set status = 'expired', finished_at = now()
     where id = cmd_id and status = 'pending' and created_at <= now() - interval '10 minutes';
  end if;
  return r;
end
$$;
revoke all on function public.claim_device_command(bigint) from public;
grant execute on function public.claim_device_command(bigint) to authenticated;

-- Live delivery.
do $$ begin
  alter publication supabase_realtime add table public.device_commands;
exception when duplicate_object then null; end $$;
