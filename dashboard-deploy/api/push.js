/**
 * Sends push notifications (called by the cloud database, see migration 09).
 * POST { event, subscriptions: [{ endpoint, p256dh, auth, lang, types }] }
 * Header x-push-secret must equal PUSH_SECRET.
 * Environment (Vercel): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY.
 */
'use strict';
const webpush = require('web-push');
const { buildMessage, settingOf } = require('./_message');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const secret = process.env.PUSH_SECRET;
  if (!secret || req.headers['x-push-secret'] !== secret) { res.status(401).end(); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  const event = body && body.event;
  const subs = (body && Array.isArray(body.subscriptions)) ? body.subscriptions : [];
  if (!event || !event.type) { res.status(400).json({ error: 'no event' }); return; }
  webpush.setVapidDetails('mailto:alijaouhari50@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  let sent = 0;
  const gone = [];
  await Promise.all(subs.map(async (s) => {
    const types = Array.isArray(s.types) ? s.types : null;
    if (event.type !== 'test' && types && !types.includes(settingOf(event.type))) return;
    const msg = buildMessage(event, s.lang);
    if (!msg) return;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(msg), { TTL: 6 * 3600, urgency: 'high' });
      sent++;
    } catch (error) {
      if (error && (error.statusCode === 404 || error.statusCode === 410)) gone.push(s.endpoint);
    }
  }));
  if (gone.length && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    try {
      await fetch(process.env.SUPABASE_URL + '/rest/v1/rpc/push_drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: process.env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_ANON_KEY },
        body: JSON.stringify({ p_secret: secret, p_endpoints: gone })
      });
    } catch (_) { /* tried; the phone will be dropped next time */ }
  }
  res.status(200).json({ sent, gone: gone.length });
};
