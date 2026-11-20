-- Device status times come from the server clock, not the PC clock: a PC whose
-- clock is a few minutes off must not look "late" or fail the connection test.
create or replace function public.locations_server_times() returns trigger
  language plpgsql as
$$
begin
  if new.last_seen_at is distinct from old.last_seen_at then new.last_seen_at := now(); end if;
  if new.ping_reply_at is distinct from old.ping_reply_at then new.ping_reply_at := now(); end if;
  if new.ping_requested_at is distinct from old.ping_requested_at then new.ping_requested_at := now(); end if;
  return new;
end
$$;

drop trigger if exists locations_server_times on public.locations;
create trigger locations_server_times before update on public.locations
  for each row execute function public.locations_server_times();
