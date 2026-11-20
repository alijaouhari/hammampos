-- HammamPOS cloud: last-known summary per hammam + notifications feed (step 4).

-- Summary the PC sends with its heartbeat (four numbers, today, last days/months, alerts).
alter table public.locations add column if not exists summary jsonb;
alter table public.locations add column if not exists summary_at timestamptz;

create or replace function public.locations_server_times() returns trigger
  language plpgsql as
$$
begin
  if new.last_seen_at is distinct from old.last_seen_at then new.last_seen_at := now(); end if;
  if new.ping_reply_at is distinct from old.ping_reply_at then new.ping_reply_at := now(); end if;
  if new.ping_requested_at is distinct from old.ping_requested_at then new.ping_requested_at := now(); end if;
  if new.summary is distinct from old.summary then new.summary_at := now(); end if;
  return new;
end
$$;

-- Notifications created on a PC (refund, seller deposit, late entry, paid by manager).
create table if not exists public.notifications (
  id          bigint generated always as identity primary key,
  location_id uuid not null references public.locations(id) on delete cascade,
  local_id    integer not null,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz,
  received_at timestamptz not null default now(),
  read_at     timestamptz,
  unique (location_id, local_id)
);
create index if not exists notifications_received_idx on public.notifications(received_at desc);
alter table public.notifications enable row level security;

drop policy if exists "admin manages notifications" on public.notifications;
create policy "admin manages notifications" on public.notifications for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "device writes own notifications" on public.notifications;
create policy "device writes own notifications" on public.notifications for insert to authenticated
  with check (location_id = public.device_location());
drop policy if exists "device reads own notifications" on public.notifications;
create policy "device reads own notifications" on public.notifications for select to authenticated
  using (location_id = public.device_location());
drop policy if exists "device updates own notifications" on public.notifications;
create policy "device updates own notifications" on public.notifications for update to authenticated
  using (location_id = public.device_location()) with check (location_id = public.device_location());

-- received_at always from the server; a device cannot mark notifications as read.
create or replace function public.notifications_guard() returns trigger
  language plpgsql as
$$
begin
  if tg_op = 'INSERT' then new.received_at := now(); new.read_at := null;
  elsif not public.is_admin() then new.read_at := old.read_at; new.received_at := old.received_at;
  end if;
  return new;
end
$$;
drop trigger if exists notifications_guard on public.notifications;
create trigger notifications_guard before insert or update on public.notifications
  for each row execute function public.notifications_guard();

do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null; end $$;
