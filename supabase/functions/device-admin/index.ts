// HammamPOS cloud: device management (manager only).
//   POST { action: 'create', name }              -> new location + device login + connection code
//   POST { action: 'new_code', location_id }     -> new device login for a location (old logins revoked)
//   POST { action: 'delete', location_id }       -> removes the location, its data and its device logins
// The caller must be signed in as a manager (row in public.app_admins).
// Device logins are Supabase Auth users that only reach their own location (see RLS).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function randomSecret(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function connectionCode(url: string, anonKey: string, loc: { id: string; name: string }, email: string, password: string) {
  const payload = JSON.stringify({ u: url, k: anonKey, l: loc.id, n: loc.name, e: email, p: password });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(payload)));
  return 'HPOS2.' + b64;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') || '';

  // Who is calling? Must be a manager.
  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: isAdmin, error: adminErr } = await asCaller.rpc('is_admin');
  if (adminErr || isAdmin !== true) return json({ error: 'not allowed' }, 403);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: { action?: string; name?: string; location_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }

  async function newDeviceLogin(loc: { id: string; name: string }) {
    const email = `device-${crypto.randomUUID()}@devices.hammampos.app`;
    const password = randomSecret(32);
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      app_metadata: { role: 'device', location_id: loc.id },
      user_metadata: { location_name: loc.name }
    });
    if (error || !data.user) throw new Error(error?.message || 'could not create device login');
    const { error: e2 } = await admin.from('devices').insert({ user_id: data.user.id, location_id: loc.id, label: loc.name });
    if (e2) { await admin.auth.admin.deleteUser(data.user.id); throw new Error(e2.message); }
    return { code: connectionCode(url, anonKey, loc, email, password), deviceUserId: data.user.id };
  }

  async function revokeLogins(locationId: string, keepUserId?: string) {
    const { data } = await admin.from('devices').select('user_id').eq('location_id', locationId);
    for (const d of data || []) {
      if (d.user_id !== keepUserId) await admin.auth.admin.deleteUser(d.user_id); // cascades the devices row
    }
  }

  try {
    if (body.action === 'create') {
      const name = String(body.name || '').trim();
      if (!name) return json({ error: 'name required' }, 400);
      const { data: loc, error } = await admin.from('locations').insert({ name }).select('id,name').single();
      if (error) throw new Error(error.message);
      const r = await newDeviceLogin(loc);
      return json({ ok: true, location: loc, code: r.code });
    }
    if (body.action === 'new_code') {
      const { data: loc, error } = await admin.from('locations').select('id,name').eq('id', body.location_id).maybeSingle();
      if (error || !loc) return json({ error: 'location not found' }, 404);
      const r = await newDeviceLogin(loc);
      await revokeLogins(loc.id, r.deviceUserId);
      return json({ ok: true, location: loc, code: r.code });
    }
    if (body.action === 'delete') {
      const id = String(body.location_id || '');
      if (!id) return json({ error: 'location_id required' }, 400);
      await revokeLogins(id);
      for (const t of ['tickets', 'expenses', 'collections']) await admin.from(t).delete().eq('location_id', id);
      const { error } = await admin.from('locations').delete().eq('id', id);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
