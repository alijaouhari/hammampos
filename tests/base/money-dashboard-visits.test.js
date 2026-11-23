'use strict';
/** Dashboard: "since my last visit" period and the visits table, sent with the summary. */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));
after(() => cleanupAll());
const stamp = (iso) => iso.replace('T', ' ').slice(0, 19);
let serial = 1;
async function setup(startIso = '2026-11-15T06:00:00Z') {
  const s = await newStorage();
  let t = new Date(startIso);
  const m = new MoneyService(s, { now: () => new Date(t) });
  m.switchOver();
  const c = s.addCategory('ر', 1);
  return {
    s, m,
    at: (iso) => { t = new Date(iso); },
    sell(price, iso) {
      const st = stamp(iso);
      s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
                VALUES (?, 2026, ?, 'ر', ?, ?, ?, ?)`, [serial++, c, price, st.slice(0, 10), st.slice(11), st]);
    }
  };
}

test('no visit yet: period starts at the switch-over, no visits', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(100, '2026-11-15T07:00:00Z');
    at('2026-11-15T08:00:00Z');
    m.recordExpense({ description: 'x', total: 30, fromDrawer: 30 });
    const v = m.getDashboardVisits();
    assert.equal(v.visits.length, 0);
    assert.equal(v.period.visit, false);
    assert.equal(v.period.start, '2026-11-15 06:00:00');
    assert.deepEqual([v.period.n, v.period.s, v.period.e, v.period.en, v.period.p, v.period.cash], [1, 100, 30, 1, 30, 70]);
    assert.deepEqual([v.period.ed, v.period.em], [30, 0]);
  } finally { cleanup(s); }
});

test('two visits: each row covers its own period, the current period starts after the last one', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(1000, '2026-11-15T07:00:00Z');
    at('2026-11-15T08:00:00Z'); m.recordExpense({ description: 'a', total: 200, fromDrawer: 200 });
    at('2026-11-15T09:00:00Z'); m.collectInPerson({ counted: 800 });
    sell(500, '2026-11-16T07:00:00Z');
    sell(300, '2026-11-16T08:00:00Z');
    at('2026-11-16T09:00:00Z'); m.recordExpense({ description: 'b', total: 50, fromDrawer: 50 });
    at('2026-11-16T10:00:00Z'); m.collectInPerson({ counted: 750 });
    sell(40, '2026-11-17T07:00:00Z');
    at('2026-11-17T07:30:00Z'); assert.equal(m.recordExpense({ description: 'c', supplier: 'v', total: 90, restAs: 'unpaid' }).success, true); // unpaid
    const v = m.getDashboardVisits();
    assert.equal(v.visits.length, 2);
    const [last, first] = v.visits;
    assert.equal(last.at, '2026-11-16 10:00:00');
    assert.deepEqual([last.n, last.s, last.p, last.x, last.c], [2, 800, 50, 750, 750]);
    assert.equal(first.at, '2026-11-15 09:00:00');
    assert.deepEqual([first.n, first.s, first.p, first.x, first.c], [1, 1000, 200, 800, 800]);
    assert.equal(v.period.visit, true);
    assert.equal(v.period.start, '2026-11-16 10:00:00');
    assert.deepEqual([v.period.n, v.period.s, v.period.e, v.period.en, v.period.p, v.period.cash], [1, 40, 90, 1, 0, 40]);
    assert.deepEqual([v.period.ed, v.period.em], [0, 0]); // all 90 unpaid
    at('2026-11-17T07:40:00Z');
    assert.equal(m.recordExpense({ description: 'd', total: 500, fromDrawer: 30, restAs: 'manager' }).success, true);
    const w = m.getDashboardVisits().period;
    assert.deepEqual([w.e, w.ed, w.em], [590, 30, 470]);
  } finally { cleanup(s); }
});

test('a cancelled visit is not listed and does not start a period', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(100, '2026-11-15T07:00:00Z');
    at('2026-11-15T09:00:00Z');
    const r = m.collectInPerson({ counted: 100 });
    const id = r.id || (r.collection && r.collection.id) || s.db.exec('SELECT MAX(id) FROM money_collections')[0].values[0][0];
    m.cancelCollection(id, 'خطأ');
    const v = m.getDashboardVisits();
    assert.equal(v.visits.length, 0);
    assert.equal(v.period.visit, false);
    assert.equal(v.period.s, 100);
  } finally { cleanup(s); }
});

test('before the money system is switched on: nothing is sent', async () => {
  const s = await newStorage();
  try { assert.equal(new MoneyService(s).getDashboardVisits(), null); } finally { cleanup(s); }
});
