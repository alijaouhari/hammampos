'use strict';
/**
 * Remote commands (live connection, step 2): claim once, allow-list, results,
 * restart actions run only after the result is reported, polling safety net.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const RemoteCommands = require(path.resolve(__dirname, '..', '..', 'src', 'services', 'RemoteCommands'));

function fakeCloud() {
  const rows = [];
  let liveHandler = null;
  let nextId = 1;
  const sb = {
    rows,
    channel() {
      const ch = {
        on(_ev, _filter, cb) { liveHandler = cb; return ch; },
        subscribe(cb) { cb('SUBSCRIBED'); return ch; }
      };
      return ch;
    },
    removeChannel() { liveHandler = null; },
    async rpc(name, { cmd_id }) {
      const r = rows.find(x => x.id === cmd_id);
      if (!r || r.status !== 'pending') return { data: null, error: null };
      if (r.expired) { r.status = 'expired'; return { data: null, error: null }; }
      r.status = 'running';
      return { data: { ...r }, error: null };
    },
    from() {
      const q = { f: {}, op: 'select', vals: null };
      q.select = () => q;
      q.eq = (k, v) => { q.f[k] = v; return q; };
      q.order = () => q;
      q.limit = () => q;
      q.update = (v) => { q.op = 'update'; q.vals = v; return q; };
      q.then = (res) => {
        const match = rows.filter(r => Object.entries(q.f).every(([k, v]) => r[k] === v));
        if (q.op === 'update') { match.forEach(r => Object.assign(r, q.vals)); return Promise.resolve({ error: null }).then(res); }
        return Promise.resolve({ data: match.map(r => ({ ...r })), error: null }).then(res);
      };
      return q;
    }
  };
  const send = (action, extra = {}) => {
    const r = { id: nextId++, location_id: 'L1', action, args: {}, status: 'pending', ...extra };
    rows.push(r);
    return r;
  };
  return { cloud: { supabase: sb, locationId: 'L1' }, sb, send, live: () => liveHandler };
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('live delivery: a ping arrives over the channel and gets its answer', async () => {
  const f = fakeCloud();
  const rc = new RemoteCommands(f.cloud, { ping: () => ({ pong: 1 }) });
  await rc.start();
  assert.equal(rc.live, true);
  const cmd = f.send('ping');
  f.live()({ new: { ...cmd } });
  await tick();
  assert.equal(cmd.status, 'done');
  assert.deepEqual(cmd.result, { pong: 1 });
});

test('a command runs only once even if delivered twice (live + poll)', async () => {
  const f = fakeCloud();
  let runs = 0;
  const rc = new RemoteCommands(f.cloud, { sync_now: async () => { runs++; await tick(20); return { ok: true }; } });
  await rc.start();
  const cmd = f.send('sync_now');
  f.live()({ new: { ...cmd } });
  await rc.poll();
  await tick(40);
  assert.equal(runs, 1);
  assert.equal(cmd.status, 'done');
});

test('unknown or not-allowed actions are refused; handler errors are reported', async () => {
  const f = fakeCloud();
  const rc = new RemoteCommands(f.cloud, { ping: () => ({}), format_disk: () => 'never', diagnostics: () => { throw new Error('boom'); } });
  await rc.start();
  const bad = f.send('format_disk');
  const err = f.send('diagnostics');
  await rc.poll();
  await tick();
  assert.equal(bad.status, 'failed');
  assert.match(bad.result.error, /غير مسموح/);
  assert.equal(err.status, 'failed');
  assert.equal(err.result.error, 'boom');
});

test('expired commands are not run', async () => {
  const f = fakeCloud();
  let ran = false;
  const rc = new RemoteCommands(f.cloud, { restart_pc: () => { ran = true; return {}; } });
  await rc.start();
  const old = f.send('restart_pc', { expired: true });
  await rc.poll();
  await tick();
  assert.equal(ran, false);
  assert.equal(old.status, 'expired');
});

test('restart actions: the result is reported first, the restart happens after', async () => {
  const f = fakeCloud();
  const order = [];
  const rc = new RemoteCommands(f.cloud, {
    restart_app: () => ({ result: { restarting: true }, after: () => order.push('restarted') })
  }, { afterDelayMs: 30 });
  await rc.start();
  const cmd = f.send('restart_app');
  await rc.poll();
  order.push('status=' + cmd.status);
  assert.deepEqual(cmd.result, { restarting: true });
  await tick(60);
  assert.deepEqual(order, ['status=done', 'restarted']);
});

test('allowed action list is the fixed support list', () => {
  assert.deepEqual(RemoteCommands.ALLOWED_ACTIONS, ['ping', 'sync_now', 'diagnostics', 'restart_app', 'restart_pc', 'install_update', 'backup_now']);
});
