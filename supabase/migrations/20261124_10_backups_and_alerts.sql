-- 10: full database backups in the cloud, and the new alert types.
--
-- Backups: a private storage bucket "backups". Each PC writes only into its own
-- folder (<location id>/...); only the admin can read them. Nothing is public.
--
-- New PC events sent to the phone:
--   change  = a ticket / expense / collection / price was deleted or changed
--   count   = the seller counted the box (difference with what the app expects)
--   health  = a problem on the PC (cloud backup failing, disk almost full, printer)

insert into storage.buckets (id, name, public, file_size_limit)
values ('backups', 'backups', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists "device writes own backups" on storage.objects;
drop policy if exists "device updates own backups" on storage.objects;
drop policy if exists "device reads own backups" on storage.objects;
drop policy if exists "device deletes own backups" on storage.objects;
drop policy if exists "admin reads backups" on storage.objects;

create policy "device writes own backups" on storage.objects for insert to authenticated
  with check (bucket_id = 'backups' and (storage.foldername(name))[1] = public.device_location()::text);
create policy "device updates own backups" on storage.objects for update to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = public.device_location()::text)
  with check (bucket_id = 'backups' and (storage.foldername(name))[1] = public.device_location()::text);
create policy "device reads own backups" on storage.objects for select to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = public.device_location()::text);
create policy "device deletes own backups" on storage.objects for delete to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = public.device_location()::text);
create policy "admin reads backups" on storage.objects for select to authenticated
  using (bucket_id = 'backups' and public.is_admin());

-- Phones: new types on by default, and added to the phones already signed up.
alter table public.push_subscriptions
  alter column types set default array['expense','late_entry','refund','seller_collection','offline','change','count','health'];
update public.push_subscriptions
  set types = types || array(select t from unnest(array['change','count','health']) t where not t = any(types))
  where not (types @> array['change','count','health']);

create or replace function public.notifications_push() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if new.type in ('expense', 'late_entry', 'refund', 'seller_collection', 'change', 'count', 'health') then
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
