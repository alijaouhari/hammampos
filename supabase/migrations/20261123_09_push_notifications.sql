-- HammamPOS cloud: push notifications to the manager's phones (dashboard PWA).
--
-- How it works:
--   1. The dashboard saves each phone's push address in push_subscriptions (manager only).
--   2. When a PC's event arrives in public.notifications (expense, late entry, refund,
--      seller deposit), a trigger posts it, with the phones' addresses, to the dashboard
--      site's /api/push function, which sends the notifications.
--   3. Every minute, push_check_offline() sends "PC offline" (no signal for 10 minutes)
--      and "back online", once per episode.
-- The URL and the shared secret live in push_config (one row, set separately, never in
-- this file). Nobody can read push_config through the API.
-- Safe to run again.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid default auth.uid(),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  lang       text not null default 'ar',
  types      text[] not null default array['expense','late_entry','refund','seller_collection','offline'],
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "admin manages push subscriptions" on public.push_subscriptions;
create policy "admin manages push subscriptions" on public.push_subscriptions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create table if not exists public.push_config (
  id     int primary key default 1 check (id = 1),
  url    text not null,
  secret text not null
);
alter table public.push_config enable row level security;   -- no policies: API access closed
revoke all on public.push_config from anon, authenticated;

alter table public.locations add column if not exists offline_notified_at timestamptz;

-- Post one event to the sender with every saved phone.
create or replace function public._push_send(event jsonb) returns void
  language plpgsql security definer set search_path = public as
$$
declare
  c record;
  subs jsonb;
begin
  select url, secret into c from public.push_config where id = 1;
  if not found then return; end if;
  select coalesce(jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth,
                                               'lang', lang, 'types', to_jsonb(types))), '[]'::jsonb)
    into subs from public.push_subscriptions;
  if subs = '[]'::jsonb then return; end if;
  perform net.http_post(
    url := c.url,
    body := jsonb_build_object('event', event, 'subscriptions', subs),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', c.secret),
    timeout_milliseconds := 10000
  );
end
$$;
revoke all on function public._push_send(jsonb) from public, anon, authenticated;

-- PC events → push (expenses the manager paid himself are not sent: he knows).
create or replace function public.notifications_push() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if new.type in ('expense', 'late_entry', 'refund', 'seller_collection') then
    perform public._push_send(jsonb_build_object(
      'type', new.type,
      'location_id', new.location_id,
      'hammam', (select name from public.locations where id = new.location_id),
      'payload', new.payload,
      'at', coalesce(new.created_at, now())
    ));
  end if;
  return null;
exception when others then
  return null;   -- a sending problem must never block the PC's sync
end
$$;
drop trigger if exists notifications_push on public.notifications;
create trigger notifications_push after insert on public.notifications
  for each row execute function public.notifications_push();

-- PC offline / back online, once per episode.
create or replace function public.push_check_offline() returns void
  language plpgsql security definer set search_path = public as
$$
declare
  l record;
begin
  for l in select id, name, last_seen_at, offline_notified_at from public.locations where last_seen_at is not null loop
    if l.last_seen_at < now() - interval '10 minutes' and l.offline_notified_at is null then
      update public.locations set offline_notified_at = now() where id = l.id;
      perform public._push_send(jsonb_build_object('type', 'offline', 'location_id', l.id, 'hammam', l.name,
        'payload', jsonb_build_object('minutes', floor(extract(epoch from now() - l.last_seen_at) / 60)), 'at', now()));
    elsif l.last_seen_at >= now() - interval '2 minutes' and l.offline_notified_at is not null then
      update public.locations set offline_notified_at = null where id = l.id;
      perform public._push_send(jsonb_build_object('type', 'online', 'location_id', l.id, 'hammam', l.name,
        'payload', '{}'::jsonb, 'at', now()));
    end if;
  end loop;
end
$$;
revoke all on function public.push_check_offline() from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('hammampos-push-offline') where exists (select 1 from cron.job where jobname = 'hammampos-push-offline');
  perform cron.schedule('hammampos-push-offline', '* * * * *', 'select public.push_check_offline()');
end $$;

-- The sender removes phones that no longer exist (it only knows the shared secret).
create or replace function public.push_drop(p_secret text, p_endpoints text[]) returns int
  language plpgsql security definer set search_path = public as
$$
declare n int;
begin
  if p_secret is null or p_secret <> (select secret from public.push_config where id = 1) then return 0; end if;
  delete from public.push_subscriptions where endpoint = any(p_endpoints);
  get diagnostics n = row_count;
  return n;
end
$$;
grant execute on function public.push_drop(text, text[]) to anon, authenticated;

-- "Send a test" button on the dashboard (manager only).
create or replace function public.push_test() returns void
  language plpgsql security definer set search_path = public as
$$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  perform public._push_send(jsonb_build_object('type', 'test', 'hammam', 'HammamPOS', 'payload', '{}'::jsonb, 'at', now()));
end
$$;
grant execute on function public.push_test() to authenticated;
