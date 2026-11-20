-- HammamPOS cloud: close public access (final step of the lockdown).
-- Run ONLY after every hammam PC signs in with its own device login (app v2.8.31+)
-- and the dashboard works with the manager login. After this, the public (anon)
-- key alone cannot read or change anything.

drop policy if exists "Allow all on tickets"     on public.tickets;
drop policy if exists "Allow all on expenses"    on public.expenses;
drop policy if exists "Allow all on collections" on public.collections;
drop policy if exists "Allow all on locations"   on public.locations;

revoke all on public.tickets, public.expenses, public.collections, public.locations,
              public.devices, public.app_admins from anon;
