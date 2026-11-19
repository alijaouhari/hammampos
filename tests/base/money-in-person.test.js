'use strict';
/**
 * Money system — Task 6: the manager's in-person collection.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));

after(() => cleanupAll());

const four = (b) => [b.cashInHand, b.owedToSuppliers, b.owedToManager, b.owedBySeller];
const stamp = (iso) => iso.replace('T', ' ').slice(0, 19);
let serial = 1;

// Controllable clock (UTC stamps are used throughout, so the tests are time-zone proof).
async function setup(startIso = '2026-11-15T06:00:00Z') {
  const s = await newStorage();
  let t = new Date(startIso);
  const m = new MoneyService(s, { now: () => new Date(t) });
  m.switchOver();
  const c = s.addCategory('ر', 1);
  return {
    s, m, c,
    at: (iso) => { t = new Date(iso); },
    sell(price, iso) {
      const st = stamp(iso);
      s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
                VALUES (?, 2026, ?, 'ر', ?, ?, ?, ?)`, [serial++, c, price, st.slice(0, 10), st.slice(11), st]);
      return s.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    }
  };
}

test('summary lines add up to the expected cash (sales, payments, deposits)', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(3000, '2026-11-15T08:00:00Z');
    sell(2500, '2026-11-15T09:00:00Z');
    at('2026-11-15T10:00:00Z');
    m.recordExpense({ description: 'مصباح', total: 300, fromDrawer: 300 });
    m.recordRemoteCollection({ type: 'bank', amount: 1200, reference: 'BK1' });
    const p = m.getPeriodSummary();
    assert.equal(p.sales.total, 5500);
    assert.equal(p.sales.count, 2);
    assert.equal(p.payments.total, 300);
    assert.equal(p.remote.total, 1200);
    assert.equal(p.refunds.total, 0);
    assert.equal(p.expected, 4000);
    assert.equal(p.other, 0);
    assert.equal(p.sales.total - p.refunds.total - p.payments.total - p.remote.total, p.expected);
    assert.equal(p.lastVisit, null);
    assert.equal(p.payments.items[0].description, 'مصباح');
    assert.equal(p.remote.items[0].reference, 'BK1');
  } finally { cleanup(s); }
});

test('exact count: drawer goes to 0, period closes, next period starts empty', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(5000, '2026-11-15T08:00:00Z');
    at('2026-11-15T14:00:00Z');
    const r = m.collectInPerson({ counted: 5000 });
    assert.equal(r.success, true, r.error);
    assert.equal(r.shortage, 0);
    assert.equal(r.surplus, 0);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 0]);
    assert.equal(r.collection.expected, 5000);
    assert.equal(r.collection.counted, 5000);
    const p = m.getPeriodSummary();
    assert.equal(p.sales.total, 0);
    assert.equal(p.expected, 0);
    assert.equal(p.lastVisit.id, r.collection.id);
    // Mirrored into the old collections log.
    assert.equal(s.getCollections().length, 1);
  } finally { cleanup(s); }
});

test('shortage: expected 5,000, counted 4,500 -> collect 4,500, owed by seller 500, drawer 0', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(5000, '2026-11-15T08:00:00Z');
    at('2026-11-15T14:00:00Z');
    const r = m.collectInPerson({ counted: 4500 });
    assert.equal(r.success, true, r.error);
    assert.equal(r.shortage, 500);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 500]);
    assert.equal(r.collection.amount, 4500);
    assert.equal(s.getCollections()[0].amount, 4500);
  } finally { cleanup(s); }
});

test('surplus: needs acknowledgement; then collected and marked unexplained; drawer 0', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(5000, '2026-11-15T08:00:00Z');
    at('2026-11-15T14:00:00Z');
    const first = m.collectInPerson({ counted: 5100 });
    assert.equal(first.success, false);
    assert.equal(first.needsSurplusConfirmation, true);
    assert.equal(first.surplus, 100);
    assert.deepEqual(four(m.getBalances()), [5000, 0, 0, 0]); // nothing was written

    const r = m.collectInPerson({ counted: 5100, surplusAcknowledged: true, note: 'لم أجد السبب' });
    assert.equal(r.success, true, r.error);
    assert.equal(r.surplus, 100);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 0]);
    const corr = s.db.exec("SELECT type, amount, collection_id FROM money_corrections")[0].values;
    assert.deepEqual(corr, [['unexplained_surplus', 100, r.collection.id]]);
  } finally { cleanup(s); }
});

test('the 14:00 example: morning money is collected, the afternoon starts a new period', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(1800, '2026-11-15T09:00:00Z');                 // morning
    at('2026-11-15T14:00:00Z');
    m.collectInPerson({ counted: 1800 });
    sell(1200, '2026-11-15T16:00:00Z');                 // afternoon
    at('2026-11-15T20:00:00Z');
    const p = m.getPeriodSummary();
    assert.equal(p.sales.total, 1200, 'only the afternoon is in the new period');
    assert.equal(p.expected, 1200);
    assert.equal(m.getBalances().cashInHand, 1200);
    // The daily report is NOT split: both parts are today's income.
    const day = s.getDailySummariesWithDetails(0, { start: '2026-11-15', end: '2026-11-15' })[0];
    assert.equal(day.revenue, 3000);
  } finally { cleanup(s); }
});

test('repayment first: owed to the manager is repaid, the rest is profit', async () => {
  const { s, m, sell, at } = await setup();
  try {
    m.recordExpense({ description: 'إصلاح', total: 3000, fromDrawer: 0, restAs: 'manager' });
    sell(5000, '2026-11-15T08:00:00Z');
    at('2026-11-15T14:00:00Z');
    const r = m.collectInPerson({ counted: 5000 });
    assert.equal(r.repayment, 3000);
    assert.equal(r.profit, 2000);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('forgotten receipt added by the manager lowers the expected cash before counting', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(5000, '2026-11-15T08:00:00Z');
    at('2026-11-15T14:00:00Z');
    assert.equal(m.getPeriodSummary().expected, 5000);
    m.recordRemoteCollection({ type: 'bank', amount: 4000, reference: 'FORGOT', recordedBy: 'manager' });
    assert.equal(m.getPeriodSummary().expected, 1000);
    const r = m.collectInPerson({ counted: 1000 });
    assert.equal(r.shortage, 0);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('invalid counts are refused; nothing is written', async () => {
  const { s, m, sell, at } = await setup();
  try {
    assert.equal(m.collectInPerson({ counted: 0 }).success, false);          // nothing to collect
    sell(500, '2026-11-15T08:00:00Z');
    at('2026-11-15T14:00:00Z');
    for (const bad of [-1, '', null, undefined, 'abc', NaN]) {
      assert.equal(m.collectInPerson({ counted: bad }).success, false, String(bad));
    }
    assert.equal(s.db.exec('SELECT COUNT(*) FROM money_collections')[0].values[0][0], 0);
    // Counting 0 with cash expected makes the whole amount a debt of the seller.
    const r = m.collectInPerson({ counted: 0 });
    assert.equal(r.success, true);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 500]);
  } finally { cleanup(s); }
});

test('cancelling an in-person visit restores cash and removes the shortage', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(5000, '2026-11-15T08:00:00Z');
    at('2026-11-15T14:00:00Z');
    const r = m.collectInPerson({ counted: 4500 });
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 500]);
    assert.equal(m.cancelCollection(r.collection.id, 'خطأ في العد').success, true);
    assert.deepEqual(four(m.getBalances()), [5000, 0, 0, 0]);
    assert.equal(m.getPeriodSummary().lastVisit, null, 'period is open again');
    assert.equal(s.getCollections().length, 0);
  } finally { cleanup(s); }
});

test('a ticket sold before the visit and refunded after it reduces the new period', async () => {
  const { s, m, sell, at } = await setup();
  try {
    const t = sell(35, '2026-11-15T13:30:00Z');
    at('2026-11-15T14:00:00Z');
    m.collectInPerson({ counted: 35 });
    sell(100, '2026-11-15T14:10:00Z');
    at('2026-11-15T14:30:00Z');
    m.setRefundsEnabled(true);
    assert.equal(m.refundTicket(t, 'x').success, true);
    const p = m.getPeriodSummary();
    assert.equal(p.sales.total, 100);
    assert.equal(p.refunds.total, 35);
    assert.equal(p.expected, 65);
    assert.equal(p.other, 0);
  } finally { cleanup(s); }
});

test('visits chain: a shortage is not counted again in the next period', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(5000, '2026-11-15T08:00:00Z');
    at('2026-11-15T14:00:00Z');
    m.collectInPerson({ counted: 4500 });                // shortage 500
    sell(2000, '2026-11-16T09:00:00Z');
    at('2026-11-16T12:00:00Z');
    const p = m.getPeriodSummary();
    assert.equal(p.expected, 2000);
    const r = m.collectInPerson({ counted: 2000 });
    assert.equal(r.shortage, 0);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 500]); // the old shortage is still owed by the seller
  } finally { cleanup(s); }
});
