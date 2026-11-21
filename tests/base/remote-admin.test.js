'use strict';
/**
 * Remote admin panel (step 3a): session + admin password, allow-list, protected
 * settings, password lock-out, large answers split in parts.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const RemoteAdmin = require(path.resolve(__dirname, '..', '..', 'src', 'services', 'RemoteAdmin'));

const SID = '11111111-2222-4333-8444-555555555555';
function setup({ validSessions = [SID], password = '1234' } = {}) {
  const sent = [];
  const calls = [];
  const sessionRows = {};
  const sb = {
    async rpc(name, { sid }) {
      if (name === 'remote_session_valid') return { data: validSessions.includes(sid), error: null };
      return { data: true, error: null };
    },
    from() {
      const q = { vals: null };
      q.update = (v) => { q.vals = v; return q; };
      q.eq = (_k, v) => { sessionRows[v] = { ...(sessionRows[v] || {}), ...q.vals }; return Promise.resolve({ error: null }); };
      return q;
    }
  };
  const ra = new RemoteAdmin({ supabase: sb, locationId: 'L1', storage: { getSetting: () => 'حمام' } }, {
    invoke: async (channel, args) => { calls.push([channel, args]); return channel === 'settings:getAll' ? { hammam_name: 'x', admin_password: 'hash', device_password: 'p', cloud_key: 'k' } : { channel, args }; },
    verifyPassword: (pw) => pw === password
  });
  ra.channel = { send: async (m) => { sent.push(m.payload); } };
  const ask = async (channel, args = [], session = SID) => {
    const id = 'r' + Math.random();
    await ra.onRequest({ id, session, channel, args });
    return sent.filter(p => p.id === id);
  };
  return { ra, ask, calls, sessionRows, sent };
}

test('nothing runs before the session is unlocked with the admin password', async () => {
  const { ask, calls } = setup();
  const [r] = await ask('money:getBalances');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'session');
  assert.equal(calls.length, 0);
});

test('wrong password refused; right password opens; then admin actions run', async () => {
  const { ask, calls, sessionRows } = setup();
  let [r] = await ask('remote:open', ['0000']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'password');
  [r] = await ask('remote:open', ['1234']);
  assert.equal(r.ok, true);
  assert.equal(sessionRows[SID].password_ok, true);
  [r] = await ask('money:getBalances');
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['money:getBalances', []]);
});

test('a session the server does not know (or expired) cannot be opened', async () => {
  const { ask } = setup({ validSessions: [] });
  const [r] = await ask('remote:open', ['1234']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'session');
});

test('local-only actions are refused remotely', async () => {
  const { ask, calls } = setup();
  await ask('remote:open', ['1234']);
  for (const ch of ['storage:clearAllData', 'storage:generateTestData', 'storage:createTicket', 'money:refundTicket',
                    'cloud:applyConnectionCode', 'cloud:reconnect', 'printer:testPrint', 'update:apply', 'settings:setSetting',
                    'recovery:resetWithKey', 'license:activate', 'setup:complete', 'nonsense']) {
    const [r] = await ask(ch);
    assert.equal(r.ok, false, ch);
    assert.equal(r.error, 'denied', ch);
  }
  assert.equal(calls.length, 0);
  assert.equal(RemoteAdmin.isAllowed('money:payBill'), true);
  assert.equal(RemoteAdmin.isAllowed('storage:deleteExpense'), true);
  assert.equal(RemoteAdmin.isAllowed('wood:recordPurchase'), true);
});

test('settings that could cut the PC off the cloud are removed; secrets are hidden in answers', async () => {
  const { ask, calls } = setup();
  await ask('remote:open', ['1234']);
  await ask('settings:updateSettings', [{ hammam_name: 'جديد', cloud_url: 'https://evil', device_password: 'x', location_id: 'y', admin_password: 'z', printer_name: 'P', remote_notice: '0', sound_alerts: '0' }]);
  assert.deepEqual(calls[0][1][0], { hammam_name: 'جديد', printer_name: 'P', sound_alerts: '0' }); // the remote notice can only be turned off on the PC
  const [r] = await ask('settings:getAll');
  assert.equal(r.result.hammam_name, 'x');
  assert.equal(r.result.admin_password, '••••••');
  assert.equal(r.result.device_password, '••••••');
  assert.equal(r.result.cloud_key, '••••••');
});

test('5 wrong passwords lock remote opening for 10 minutes', async () => {
  const { ask } = setup();
  for (let i = 0; i < 5; i++) await ask('remote:open', ['bad']);
  const [r] = await ask('remote:open', ['1234']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'locked');
});

test('large answers are split in parts that join back', async () => {
  const { ra, ask } = setup();
  ra.hooks.invoke = async () => ({ big: 'x'.repeat(RemoteAdmin.MAX_PART * 2 + 10) });
  await ask('remote:open', ['1234']);
  const parts = await ask('storage:getTickets');
  assert.equal(parts.length, 3);
  const joined = JSON.parse(parts.sort((a, b) => a.part - b.part).map(p => p.chunk).join(''));
  assert.equal(joined.ok, true);
  assert.equal(joined.result.big.length, RemoteAdmin.MAX_PART * 2 + 10);
});

test('closing ends the session on the server and locally', async () => {
  const { ra, ask, sessionRows } = setup();
  await ask('remote:open', ['1234']);
  assert.equal(ra.activeSessions(), 1);
  await ask('remote:close');
  assert.equal(ra.activeSessions(), 0);
  assert.ok(sessionRows[SID].ended_at);
  const [r] = await ask('money:getBalances');
  assert.equal(r.error, 'session');
});
