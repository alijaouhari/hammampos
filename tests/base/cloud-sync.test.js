'use strict';
/**
 * Cloud sync: queue (upsert + delete), reconcile, heartbeat/ping, connection code,
 * and the data wipe (including proof that it reached the file).
 * Uses an in-memory fake of the Supabase client; nothing touches the real cloud.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const CloudSync = require(path.join(PROJECT_ROOT, 'src', 'services', 'CloudSync'));
after(() => cleanupAll());

function fakeSupabase() {
  const db = { tickets: [], expenses: [], collections: [], locations: [{ id: 'L1', name: 'x', ping_requested_at: null, ping_reply_at: null }] };
  const state = { failing: false };
  class Q {
    constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.single = null; this.wantRows = false; }
    select() { this.wantRows = true; return this; }
    eq(k, v) { this.f.push(r => r[k] === v); return this; }
    in(k, a) { this.f.push(r => a.includes(r[k])); return this; }
    order() { return this; }
    limit() { return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    upsert(rows) { this.op = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    insert(row) { this.op = 'insert'; this.payload = [row]; return this; }
    update(v) { this.op = 'update'; this.payload = v; return this; }
    delete() { this.op = 'delete'; return this; }
    maybeSingle() { this.single = 'maybe'; return this; }
    then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
    run() {
      if (state.failing) return { data: null, error: { message: 'fetch failed' } };
      const rows = db[this.t];
      const match = (r) => this.f.every(fn => fn(r));
      if (this.op === 'upsert') {
        for (const p of this.payload) {
          const i = rows.findIndex(r => r.location_id === p.location_id && r.local_id === p.local_id);
          if (i >= 0) rows[i] = { ...rows[i], ...p }; else rows.push({ ...p });
        }
        return { data: null, error: null };
      }
      if (this.op === 'insert') {
        const r = { id: 'NEW' + rows.length, ...this.payload[0] }; rows.push(r);
        return { data: r, error: null };
      }
      if (this.op === 'update') {
        rows.filter(match).forEach(r => Object.assign(r, this.payload));
        return { data: null, error: null };
      }
      if (this.op === 'delete') {
        const gone = rows.filter(match);
        db[this.t] = rows.filter(r => !match(r));
        return { data: gone, error: null };
      }
      let out = rows.filter(match);
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.single) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }
  }
  const auth = {
    good: { email: 'dev@x', password: 'pw' }, signIns: 0,
    async signInWithPassword({ email, password }) {
      auth.signIns++;
      if (state.failing) return { error: { message: 'fetch failed' } };
      if (email === auth.good.email && password === auth.good.password) return { data: { session: {} }, error: null };
      return { data: null, error: { message: 'Invalid login credentials' } };
    }
  };
  return { db, state, auth, from: (t) => new Q(t) };
}

async function setup() {
  const s = await newStorage();
  const fake = fakeSupabase();
  let rows = { tickets: [], expenses: [], collections: [] };
  let version = '9.9.9';
  const cs = new CloudSync(s, { appVersion: version, getLocalRows: () => rows, getDeviceInfo: () => ({ ok: 1 }) });
  cs.supabase = fake;
  cs.enabled = true;
  cs.locationId = 'L1';
  cs.online = true;
  cs._ensureQueueTable();
  return { s, fake, cs, setRows: (r) => { rows = r; } };
}
const T = (id, price = 35, extra = {}) => ({ id, serial_number: id, year: 2026, category_name: 'x', price, date: '2026-11-15', time: '10:00:00', ...extra });

test('ticket sync upserts; a refunded ticket is removed from the cloud', async () => {
  const { s, fake, cs } = await setup();
  try {
    await cs.syncTicket(T(1));
    await cs.syncTicket(T(2));
    assert.equal(fake.db.tickets.length, 2);
    await cs.syncTicket(T(1, 35, { refunded_at: '2026-11-15 11:00:00' }));
    assert.deepEqual(fake.db.tickets.map(t => t.local_id), [2]);
    await cs.syncTicket(T(1)); // refund undone
    assert.equal(fake.db.tickets.length, 2);
  } finally { cleanup(s); }
});

test('offline: changes and deletes are queued, then sent in order when back online', async () => {
  const { s, fake, cs } = await setup();
  try {
    await cs.syncTicket(T(1));
    fake.state.failing = true;
    await cs.syncTicket(T(2));
    await cs.deleteTicket(1);
    assert.equal(cs.queueSize(), 2);
    assert.equal(fake.db.tickets.length, 1); // nothing reached the cloud while offline
    assert.match(cs.getStatus().lastError, /الوصول|الإنترنت/);
    await cs.processQueue();               // still offline
    assert.equal(cs.queueSize(), 2);
    fake.state.failing = false;
    await cs.processQueue();
    assert.equal(cs.queueSize(), 0);
    assert.deepEqual(fake.db.tickets.map(t => t.local_id), [2]);
  } finally { cleanup(s); }
});

test('a later change replaces an older queued one for the same row', async () => {
  const { s, fake, cs } = await setup();
  try {
    fake.state.failing = true;
    await cs.syncTicket(T(5, 35));
    await cs.deleteTicket(5);
    assert.equal(cs.queueSize(), 1);
    fake.state.failing = false;
    await cs.processQueue();
    assert.equal(fake.db.tickets.length, 0);
  } finally { cleanup(s); }
});

test('reconcile: sends missing/changed rows and removes rows that no longer exist locally', async () => {
  const { s, fake, cs, setRows } = await setup();
  try {
    // cloud has: ticket 1 (old price), ticket 9 (deleted locally), collection 7 (cancelled locally)
    fake.db.tickets.push({ location_id: 'L1', local_id: 1, price: 20, date: '2026-11-15', time: '10:00:00', category_name: 'x', serial_number: 1, year: 2026 });
    fake.db.tickets.push({ location_id: 'L1', local_id: 9, price: 35, date: '2026-11-15', time: '10:00:00', category_name: 'x', serial_number: 9, year: 2026 });
    fake.db.tickets.push({ location_id: 'OTHER', local_id: 50, price: 35 });  // another device: never touched
    fake.db.collections.push({ location_id: 'L1', local_id: 7, amount: 20, date: '2026-11-15', time: '10:00:00', notes: null });
    setRows({
      tickets: [T(1, 35), T(2, 50)],
      expenses: [{ id: 3, description: 'soap', amount: 100, date: '2026-11-15', time: '09:00:00' }],
      collections: []
    });
    const r = await cs.reconcile();
    assert.equal(r.ok, true, r.error);
    const mine = fake.db.tickets.filter(t => t.location_id === 'L1').map(t => [t.local_id, Number(t.price)]).sort();
    assert.deepEqual(mine, [[1, 35], [2, 50]]);
    assert.equal(fake.db.tickets.filter(t => t.location_id === 'OTHER').length, 1);
    assert.equal(fake.db.collections.length, 0);
    assert.equal(fake.db.expenses.length, 1);
    assert.deepEqual(r.tables.tickets, { local: 2, cloud: 2, sent: 2, removed: 1 });
    // second run: nothing to do
    const r2 = await cs.reconcile();
    assert.deepEqual(r2.tables.tickets, { local: 2, cloud: 2, sent: 0, removed: 0 });
  } finally { cleanup(s); }
});

test('reconcile offline reports the error and changes nothing', async () => {
  const { s, fake, cs, setRows } = await setup();
  try {
    setRows({ tickets: [T(1)], expenses: [], collections: [] });
    fake.state.failing = true;
    const r = await cs.reconcile();
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(cs.reconciling, false);
  } finally { cleanup(s); }
});

test('heartbeat records version and answers a dashboard ping', async () => {
  const { s, fake, cs } = await setup();
  try {
    await cs.heartbeat();
    const loc = fake.db.locations[0];
    assert.equal(loc.app_version, '9.9.9');
    assert.ok(loc.last_seen_at);
    assert.equal(loc.ping_reply_at, null);           // nobody asked yet
    loc.ping_requested_at = new Date().toISOString();
    await cs.heartbeat();
    assert.ok(loc.ping_reply_at && loc.ping_reply_at >= loc.ping_requested_at);
  } finally { cleanup(s); }
});

test('connection code round trip and bad codes', () => {
  const code = CloudSync.encodeConnection({ url: 'https://a.supabase.co', key: 'KEY', locationId: 'abc', name: 'حمام' });
  assert.ok(code.startsWith('HPOS1.'));
  assert.deepEqual(CloudSync.decodeConnection(' ' + code + ' '), { url: 'https://a.supabase.co', key: 'KEY', locationId: 'abc', name: 'حمام', deviceEmail: null, devicePassword: null });
  assert.throws(() => CloudSync.decodeConnection('hello'));
  assert.throws(() => CloudSync.decodeConnection('HPOS1.@@@'));
  assert.throws(() => CloudSync.decodeConnection('HPOS1.' + Buffer.from('{}').toString('base64')));
});

test('testConnection reports clear problems without a network', async () => {
  let r = await CloudSync.testConnection('', '');
  assert.equal(r.ok, false);
  r = await CloudSync.testConnection('http://insecure', 'k');
  assert.equal(r.ok, false);
  assert.match(r.steps[0].detail, /https/);
  r = await CloudSync.testConnection('https://does-not-exist-hammampos.invalid', 'k');
  assert.equal(r.ok, false);
  assert.match(r.steps[0].detail, /الخادم|الإنترنت/);
});

test('wipe: every transaction table is empty in the FILE, queue and day statuses included', async () => {
  const { s, cs } = await setup();
  try {
    const c = s.addCategory('x', 35);
    s.createTicket(c);
    s.addExpense('soap', 10);
    s.collectMoney(5, 'n');
    s.db.run("INSERT INTO day_status (date, status) VALUES ('2026-11-01', 'holiday')");
    cs.queueItem('tickets', 1, {}, 'upsert');
    assert.equal(s.verifyWipe().clean, false);
    s.clearAllData();
    const v = s.verifyWipe();
    assert.equal(v.persisted, true);
    assert.deepEqual(v.leftovers, {}, JSON.stringify(v.leftovers));
    assert.equal(v.clean, true);
  } finally { cleanup(s); }
});

test('wipeCloud deletes only this location and clears the queue', async () => {
  const { s, fake, cs } = await setup();
  try {
    await cs.syncTicket(T(1));
    fake.db.tickets.push({ location_id: 'OTHER', local_id: 1, price: 1 });
    cs.queueItem('tickets', 8, {}, 'upsert');
    const r = await cs.wipeCloud();
    assert.equal(r.ok, true);
    assert.deepEqual(fake.db.tickets.map(t => t.location_id), ['OTHER']);
    assert.equal(cs.queueSize(), 0);
  } finally { cleanup(s); }
});

// ── Device logins (v2.8.31) ─────────────────────────────────────────────
test('HPOS2 connection code carries the device login', () => {
  const payload = { u: 'https://a.supabase.co', k: 'KEY', l: 'L9', n: 'حمام', e: 'device-1@devices.hammampos.app', p: 'secret' };
  const code = 'HPOS2.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const c = CloudSync.decodeConnection(code);
  assert.deepEqual(c, { url: payload.u, key: 'KEY', locationId: 'L9', name: 'حمام', deviceEmail: payload.e, devicePassword: 'secret' });
  const missing = 'HPOS2.' + Buffer.from(JSON.stringify({ u: 'x', k: 'y', l: 'z' })).toString('base64');
  assert.throws(() => CloudSync.decodeConnection(missing));
  // old codes still decode, without a login
  const old = CloudSync.decodeConnection(CloudSync.encodeConnection({ url: 'u', key: 'k', locationId: 'l', name: 'n' }));
  assert.equal(old.deviceEmail, null);
});

test('device mode: signs in first, never registers a location, re-signs in after an auth error', async () => {
  const { s, fake, cs } = await setup();
  try {
    s.setSetting('device_email', 'dev@x');
    s.setSetting('device_password', 'pw');
    s.setSetting('location_id', 'L1');
    cs.locationId = null;
    assert.equal(cs.isDeviceMode(), true);
    await cs._signInIfDevice();
    assert.equal(fake.auth.signIns, 1);
    await cs.ensureLocation();
    assert.equal(cs.locationId, 'L1');
    // a location that no longer exists is NOT re-created by the device
    s.setSetting('location_id', 'GONE');
    await assert.rejects(() => cs.ensureLocation(), /لم يعد مسجلاً/);
    assert.equal(fake.db.locations.length, 1);
    // auth-type error -> a fresh sign-in on the next tick
    s.setSetting('location_id', 'L1');
    cs._noteError({ message: 'JWT expired' });
    assert.equal(cs._needsSignIn, true);
    await cs._tick();
    assert.equal(fake.auth.signIns, 2);
    assert.equal(cs._needsSignIn, false);
    assert.equal(cs.online, true);
    assert.equal(cs.getStatus().mode, 'device');
  } finally { cleanup(s); }
});

test('device mode: a wrong login is reported plainly and nothing is written', async () => {
  const { s, fake, cs } = await setup();
  try {
    s.setSetting('device_email', 'dev@x');
    s.setSetting('device_password', 'WRONG');
    await assert.rejects(() => cs._signInIfDevice(), (e) => /Invalid login/.test(e.message));
    assert.match(CloudSync.describeError({ message: 'Invalid login credentials' }), /رمز ربط جديد/);
    assert.match(CloudSync.describeError({ message: 'new row violates row-level security policy' }), /صلاحية/);
    assert.equal(fake.db.locations.length, 1);
  } finally { cleanup(s); }
});

test('an old error is cleared once the link works again and nothing is waiting', async () => {
  const { s, fake, cs } = await setup();
  try {
    fake.state.failing = true;
    await cs.syncTicket(T(1));
    assert.ok(cs.getStatus().lastError, 'error while offline');
    await cs.heartbeat();                      // still offline
    assert.ok(cs.getStatus().lastError);
    fake.state.failing = false;
    await cs.processQueue();                   // queued ticket sent
    await cs.heartbeat();
    assert.equal(cs.getStatus().lastError, null);
    assert.equal(fake.db.locations[0].last_error, null, 'dashboard no longer shows it');
    // while something is still waiting, the error stays
    fake.state.failing = true;
    await cs.syncTicket(T(2));
    fake.state.failing = false;
    cs.online = true;
    cs._clearErrorIfIdle();
    assert.ok(cs.getStatus().lastError, 'kept: one item still waiting');
  } finally { cleanup(s); }
});

test('notifications: pending ones are sent once and marked delivered; the summary rides on the heartbeat', async () => {
  const { s, fake, cs } = await setup();
  try {
    fake.db.notifications = [];
    s.setSetting('device_email', 'dev@x'); s.setSetting('device_password', 'pw');
    let pending = [{ id: 1, type: 'refund', payload: { amount: 15 }, created_at: '2026-11-20 10:00:00' }, { id: 2, type: 'late_entry', payload: {}, created_at: '2026-11-20 10:05:00' }];
    const delivered = [];
    cs.options.notifications = { pending: () => pending, delivered: (ids) => { delivered.push(...ids); pending = pending.filter(p => !ids.includes(p.id)); } };
    cs.options.getSummary = () => ({ v: 1, cashInHand: 120, today: { tickets: 3 } });
    assert.equal(await cs.pushNotifications(), 2);
    assert.deepEqual(delivered, [1, 2]);
    assert.deepEqual(fake.db.notifications.map(n => [n.local_id, n.type, n.location_id]), [[1, 'refund', 'L1'], [2, 'late_entry', 'L1']]);
    assert.equal(await cs.pushNotifications(), 0);
    // offline: nothing is marked delivered
    pending = [{ id: 3, type: 'refund', payload: {}, created_at: null }];
    fake.state.failing = true;
    assert.equal(await cs.pushNotifications(), 0);
    assert.equal(pending.length, 1);
    fake.state.failing = false;
    await cs.heartbeat();
    assert.deepEqual(fake.db.locations[0].summary, { v: 1, cashInHand: 120, today: { tickets: 3 } });
    assert.equal(pending.length, 0, 'heartbeat delivered the waiting notification');
  } finally { cleanup(s); }
});
