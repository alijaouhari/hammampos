-- Device management without a service key: SECURITY DEFINER functions that only a
-- manager (app_admins) can use. They create / revoke the Supabase Auth login of a
-- hammam PC directly in the auth schema. The dashboard builds the connection code
-- (HPOS2) from the returned login plus its own project URL and public key.

create extension if not exists pgcrypto with schema extensions;

create or replace function public._new_device_login(loc_id uuid, loc_name text)
  returns table (email text, password text)
  language plpgsql security definer set search_path = public, extensions, auth as
$$
declare
  uid uuid := gen_random_uuid();
  em  text := 'device-' || gen_random_uuid()::text || '@devices.hammampos.app';
  pw  text := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
          crypt(pw, gen_salt('bf')), now(),
          jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', 'device', 'location_id', loc_id),
          jsonb_build_object('location_name', loc_name), now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text,
          jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());
  insert into public.devices (user_id, location_id, label) values (uid, loc_id, loc_name);
  return query select em, pw;
end
$$;
revoke all on function public._new_device_login(uuid, text) from public, anon, authenticated;

-- New hammam + its device login.
create or replace function public.admin_create_device(device_name text)
  returns json language plpgsql security definer set search_path = public, extensions, auth as
$$
declare loc public.locations; l record;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(trim(device_name), '') = '' then raise exception 'name required'; end if;
  insert into public.locations (name) values (trim(device_name)) returning * into loc;
  select * into l from public._new_device_login(loc.id, loc.name);
  return json_build_object('ok', true, 'location', json_build_object('id', loc.id, 'name', loc.name), 'email', l.email, 'password', l.password);
end
$$;

-- New login for an existing hammam; every older login of it stops working.
create or replace function public.admin_new_device_code(loc_id uuid)
  returns json language plpgsql security definer set search_path = public, extensions, auth as
$$
declare loc public.locations; l record; keep uuid;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into loc from public.locations where id = loc_id;
  if loc.id is null then raise exception 'location not found'; end if;
  select * into l from public._new_device_login(loc.id, loc.name);
  select u.id into keep from auth.users u where u.email = l.email;
  delete from auth.users where id in (select user_id from public.devices where location_id = loc.id and user_id <> keep);
  return json_build_object('ok', true, 'location', json_build_object('id', loc.id, 'name', loc.name), 'email', l.email, 'password', l.password);
end
$$;

-- Remove a hammam, its cloud data and its logins.
create or replace function public.admin_delete_device(loc_id uuid)
  returns json language plpgsql security definer set search_path = public, extensions, auth as
$$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from auth.users where id in (select user_id from public.devices where location_id = loc_id);
  delete from public.tickets where location_id = loc_id;
  delete from public.expenses where location_id = loc_id;
  delete from public.collections where location_id = loc_id;
  delete from public.locations where id = loc_id;
  return json_build_object('ok', true);
end
$$;

revoke all on function public.admin_create_device(text) from public, anon;
revoke all on function public.admin_new_device_code(uuid) from public, anon;
revoke all on function public.admin_delete_device(uuid) from public, anon;
grant execute on function public.admin_create_device(text) to authenticated;
grant execute on function public.admin_new_device_code(uuid) to authenticated;
grant execute on function public.admin_delete_device(uuid) to authenticated;
