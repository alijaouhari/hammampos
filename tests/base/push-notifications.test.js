'use strict';
/** Push notifications: message texts/links, and the sender's checks (secret, choices, dead phones). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { PROJECT_ROOT } = require('./helpers');
const API = path.join(PROJECT_ROOT, 'dashboard-deploy', 'api');
const { buildMessage } = require(path.join(API, '_message'));

test('messages: Arabic and French, with the page to open', () => {
  const ev = { type: 'expense', location_id: 'L1', hammam: 'حمام الهدى', payload: { expenseId: 5, description: 'حطب', supplier: 'مراد', total: 1008, unpaid: 600 } };
  const ar = buildMessage(ev, 'ar');
  assert.equal(ar.title, 'حمام الهدى · مصروف جديد');
  assert.match(ar.body, /حطب: 1 008 DH/);
  assert.match(ar.body, /غير مدفوع 600 DH/);
  assert.equal(ar.url, '/?open=expenses&loc=L1');
  const fr = buildMessage(ev, 'fr');
  assert.equal(fr.title, 'حمام الهدى · Nouvelle dépense');
  assert.match(fr.body, /impayé 600 DH/);
  assert.match(buildMessage({ ...ev, payload: { ...ev.payload, unpaid: 1008 } }, 'ar').body, /غير مدفوع بالكامل/);
  assert.equal(buildMessage({ type: 'late_entry', location_id: 'L1', payload: { amount: 150, description: 'حطب' } }, 'ar').url, '/?open=late&loc=L1');
  assert.equal(buildMessage({ type: 'refund', payload: { amount: 15, category: 'رجال', serial: '41/2026' } }, 'ar').url, '/?open=sales');
  assert.match(buildMessage({ type: 'seller_collection', payload: { type: 'bank', amount: 2000, reference: 'R12' } }, 'fr').body, /réf\. R12/);
  assert.match(buildMessage({ type: 'offline', hammam: 'X', payload: { minutes: 12 } }, 'ar').body, /12 دقيقة/);
  assert.equal(buildMessage({ type: 'paid_by_manager', payload: {} }, 'ar'), null); // the manager knows: not sent
});

function loadSender(sendImpl) {
  const orig = Module._resolveFilename;
  const fake = path.join(API, '__fake_web_push.js');
  require.cache[fake] = { id: fake, filename: fake, loaded: true, exports: { setVapidDetails() {}, sendNotification: sendImpl } };
  Module._resolveFilename = function (req, ...rest) { return req === 'web-push' ? fake : orig.call(this, req, ...rest); };
  delete require.cache[require.resolve(path.join(API, 'push'))];
  try { return require(path.join(API, 'push')); } finally { Module._resolveFilename = orig; }
}
const call = (handler, { secret = 's3', body }) => new Promise((resolve) => {
  const res = { code: 200, out: null, status(c) { this.code = c; return this; }, json(o) { this.out = o; resolve(this); }, end() { resolve(this); } };
  handler({ method: 'POST', headers: { 'x-push-secret': secret }, body }, res);
});

test('sender: refuses a wrong secret, follows each phone\'s choices, reports dead phones', async () => {
  process.env.PUSH_SECRET = 's3';
  process.env.VAPID_PUBLIC_KEY = 'p'; process.env.VAPID_PRIVATE_KEY = 'k';
  delete process.env.SUPABASE_URL;
  const sent = [];
  const handler = loadSender(async (sub, payload) => {
    if (sub.endpoint === 'dead') { const e = new Error('gone'); e.statusCode = 410; throw e; }
    sent.push([sub.endpoint, JSON.parse(payload)]);
  });
  const bad = await call(handler, { secret: 'nope', body: {} });
  assert.equal(bad.code, 401);
  const subs = [
    { endpoint: 'a', p256dh: 'x', auth: 'y', lang: 'ar', types: ['expense', 'offline'] },
    { endpoint: 'b', p256dh: 'x', auth: 'y', lang: 'fr', types: ['refund'] },
    { endpoint: 'dead', p256dh: 'x', auth: 'y', lang: 'ar', types: ['expense'] }
  ];
  const r = await call(handler, { body: { event: { type: 'expense', payload: { total: 10, description: 'x' } }, subscriptions: subs } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.out, { sent: 1, gone: 1 });
  assert.equal(sent[0][0], 'a');
  sent.length = 0;
  await call(handler, { body: { event: { type: 'online', hammam: 'H', payload: {} }, subscriptions: subs } }); // follows "offline"
  assert.deepEqual(sent.map(x => x[0]), ['a']);
});
