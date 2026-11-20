-- HammamPOS cloud: access roles (step 1 of the lockdown).
--   * app_admins : the manager account(s) of this installation (dashboard users).
--   * devices    : one Supabase Auth user per hammam PC, bound to one location.
-- Policies give the manager full access and each device access to its own
-- location only. The old "Allow all" policies are removed in a later migration
-- (20261120_02_close_public_access.sql), after every device uses its own login.

create table if not exists public.app_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.devices (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  label       text,
  created_at  timestamptz not null default now()
);
create index if not exists devices_location_idx on public.devices(location_id);

alter table public.app_admins enable row level security;
alter table public.devices    enable row level security;

-- Helpers (security definer so policies can read app_admins/devices without recursion).
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.app_admins where user_id = auth.uid()) $$;

create or replace function public.device_location() returns uuid
  language sql stable security definer set search_path = public as
$$ select location_id from public.devices where user_id = auth.uid() limit 1 $$;

revoke all on function public.is_admin() from public;
revoke all on function public.device_location() from public;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.device_location() to authenticated;

-- app_admins / devices: readable by the manager; a device sees its own row.
drop policy if exists "admin reads admins" on public.app_admins;
create policy "admin reads admins" on public.app_admins for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "admin manages devices" on public.devices;
create policy "admin manages devices" on public.devices for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "device reads itself" on public.devices;
create policy "device reads itself" on public.devices for select to authenticated
  using (user_id = auth.uid());

-- locations: manager everything; a device reads and updates (heartbeat) its own row.
drop policy if exists "admin manages locations" on public.locations;
create policy "admin manages locations" on public.locations for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "device reads own location" on public.locations;
create policy "device reads own location" on public.locations for select to authenticated
  using (id = public.device_location());
drop policy if exists "device updates own location" on public.locations;
create policy "device updates own location" on public.locations for update to authenticated
  using (id = public.device_location()) with check (id = public.device_location());

-- data tables: manager everything; a device only rows of its own location.
do $$
declare t text;
begin
  foreach t in array array['tickets', 'expenses', 'collections'] loop
    execute format('drop policy if exists "admin manages %1$s" on public.%1$I', t);
    execute format('create policy "admin manages %1$s" on public.%1$I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('drop policy if exists "device manages own %1$s" on public.%1$I', t);
    execute format('create policy "device manages own %1$s" on public.%1$I for all to authenticated using (location_id = public.device_location()) with check (location_id = public.device_location())', t);
  end loop;
end $$;

-- The installation's manager (first user). For a new customer install, run:
--   insert into public.app_admins (user_id) select id from auth.users where email = '<manager email>';
