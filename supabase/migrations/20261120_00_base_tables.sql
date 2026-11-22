-- HammamPOS cloud: base tables (run this FIRST, before 20261120_01 ... 08).
-- A brand-new Supabase project has none of these tables; the later migrations only
-- add to them. Safe to re-run, and harmless on a project that already has them:
-- only "create if not exists" / "add column if not exists", no drops, no data changes.
--   * locations   : one row per hammam (PC). The PC writes its status here (heartbeat).
--   * tickets, expenses, collections : copies of the PC's data. The PC upserts them with
--       on conflict (location_id, local_id), so that pair must be unique.
-- Row level security is turned on here. The access policies come in 01.
-- (live, summary, summary_at on locations are added by 05 and 08.)
create table if not exists public.locations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz,
  ping_requested_at   timestamptz,
  ping_reply_at       timestamptz,
  app_version         text,
  queue_size          integer,
  last_sync_at        timestamptz,
  last_error          text,
  device_info         jsonb
);
-- Existing project: make sure every column is there.
alter table public.locations add column if not exists name text;
alter table public.locations add column if not exists created_at timestamptz not null default now();
alter table public.locations add column if not exists last_seen_at timestamptz;
alter table public.locations add column if not exists ping_requested_at timestamptz;
alter table public.locations add column if not exists ping_reply_at timestamptz;
alter table public.locations add column if not exists app_version text;
alter table public.locations add column if not exists queue_size integer;
alter table public.locations add column if not exists last_sync_at timestamptz;
alter table public.locations add column if not exists last_error text;
alter table public.locations add column if not exists device_info jsonb;
create table if not exists public.tickets (
  id            bigint generated always as identity primary key,
  location_id   uuid not null references public.locations(id) on delete cascade,
  local_id      integer not null,
  serial_number integer not null,
  year          integer not null,
  category_name text not null,
  price         numeric not null,
  date          text not null,
  time          text not null,
  created_at    timestamptz not null default now()
);
alter table public.tickets add column if not exists local_id integer;
alter table public.tickets add column if not exists serial_number integer;
alter table public.tickets add column if not exists year integer;
alter table public.tickets add column if not exists category_name text;
alter table public.tickets add column if not exists price numeric;
alter table public.tickets add column if not exists date text;
alter table public.tickets add column if not exists time text;
alter table public.tickets add column if not exists created_at timestamptz not null default now();
create table if not exists public.expenses (
  id          bigint generated always as identity primary key,
  location_id uuid not null references public.locations(id) on delete cascade,
  local_id    integer not null,
  description text not null,
  amount      numeric not null,
  date        text not null,
  time        text not null,
  created_at  timestamptz not null default now()
);
alter table public.expenses add column if not exists local_id integer;
alter table public.expenses add column if not exists description text;
alter table public.expenses add column if not exists amount numeric;
alter table public.expenses add column if not exists date text;
alter table public.expenses add column if not exists time text;
alter table public.expenses add column if not exists created_at timestamptz not null default now();
create table if not exists public.collections (
  id          bigint generated always as identity primary key,
  location_id uuid not null references public.locations(id) on delete cascade,
  local_id    integer not null,
  amount      numeric not null,
  notes       text,
  date        text not null,
  time        text not null,
  created_at  timestamptz not null default now()
);
alter table public.collections add column if not exists local_id integer;
alter table public.collections add column if not exists amount numeric;
alter table public.collections add column if not exists notes text;
alter table public.collections add column if not exists date text;
alter table public.collections add column if not exists time text;
alter table public.collections add column if not exists created_at timestamptz not null default now();
-- Upsert target (location_id, local_id) must be unique. Add it only if no unique
-- index on exactly these two columns exists yet (the old project may have one).
do $$
declare t text;
begin
  foreach t in array array['tickets', 'expenses', 'collections'] loop
    if not exists (
      select 1
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = t
         and i.indisunique and i.indpred is null and i.indexprs is null
         and i.indnatts = 2
         and (select array_agg(a.attname::text order by a.attname::text)
                from pg_attribute a
               where a.attrelid = c.oid and a.attnum = any (i.indkey::int2[])) = array['local_id', 'location_id']
    ) then
      execute format('alter table public.%I add constraint %I unique (location_id, local_id)', t, t || '_location_local_key');
    end if;
  end loop;
end $$;
create index if not exists tickets_location_date_idx on public.tickets(location_id, date);
create index if not exists expenses_location_date_idx on public.expenses(location_id, date);
create index if not exists collections_location_date_idx on public.collections(location_id, date);
alter table public.locations   enable row level security;
alter table public.tickets     enable row level security;
alter table public.expenses    enable row level security;
alter table public.collections enable row level security;
-- Live updates: the dashboard listens for changes on locations (device status).
-- (device_commands and notifications are added to the publication in 04 and 08.)
do $$ begin
  alter publication supabase_realtime add table public.locations;
exception when duplicate_object then null; end $$;
