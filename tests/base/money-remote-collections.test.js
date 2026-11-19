'use strict';
/**
 * Money system — Task 5: deposits / transfers recorded by the seller,
 * automatic repayment of what is owed to the manager.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));

after(() => cleanupAll());

const NOW = '2026-11-15T10:00:00Z';
const four = (b) => [b.cashInHand, b.owedToSuppliers, b.owedToManager, b.owedBySeller];
let serial = 1;
function sell(s, c, price) {
  s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
            VALUES (?, 2026, ?, 'ر', ?, '2026-11-15', '10:30:00', '2026-11-15 10:30:00')`, [serial++, c, price]);
}
async function setup(cash) {
  const s = await newStorage();
  const m = new MoneyService(s, { now: () => new Date(NOW) });
  m.switchOver();
  const c = s.addCategory('ر', 1);
  if (cash > 0) sell(s, c, cash);
  return { s, m, c };
}

test('seller bank deposit: drawer goes down at once, manager notified', async () => {
  const { s, m } = await setup(5000);
  try {
    const r = m.recordRemoteCollection({ type: 'bank', amount: 4000, reference: '123456' });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(four(m.getBalances()), [1000, 0, 0, 0]);
    assert.equal(r.collection.recorded_by, 'seller');
    assert.equal(r.collection.profit_part, 4000);
    const n = m.getNotifications()[0];
    assert.equal(n.type, 'seller_collection');
    assert.equal(n.payload.amount, 4000);
    assert.equal(n.payload.reference, '123456');
    // Mirrored into the old collections table (admin list / Excel / cloud).
    const old = s.getCollections().find(x => x.id === r.mirrorCollectionId);
    assert.equal(old.amount, 4000);
    assert.match(old.notes, /123456/);
  } finally { cleanup(s); }
});

test('amount cannot exceed the cash in hand; type and amount validated; on_behalf needs a name', async () => {
  const { s, m } = await setup(1000);
  try {
    assert.equal(m.recordRemoteCollection({ type: 'bank', amount: 1000.01 }).success, false);
    assert.equal(m.recordRemoteCollection({ type: 'bank', amount: 0 }).success, false);
    assert.equal(m.recordRemoteCollection({ type: 'cash', amount: 10 }).success, false);
    assert.equal(m.recordRemoteCollection({ type: 'on_behalf', amount: 100 }).success, false);
    assert.equal(m.recordRemoteCollection({ type: 'on_behalf', amount: 100, recipient: 'سي محمد' }).success, true);
    assert.equal(m.recordRemoteCollection({ type: 'transfer', amount: 900, reference: 'WU-77' }).success, true);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('automatic repayment: what is owed to the manager is repaid first, rest is profit', async () => {
  const { s, m, c } = await setup(1000);
  try {
    // Manager paid 3,000 from his pocket -> owed to manager 3,000.
    m.recordExpense({ description: 'إصلاح', total: 3000, fromDrawer: 0, restAs: 'manager' });
    assert.equal(m.getBalances().owedToManager, 3000);
    sell(s, c, 4000); // cash 5,000
    const r = m.recordRemoteCollection({ type: 'bank', amount: 5000 });
    assert.equal(r.collection.repayment_part, 3000);
    assert.equal(r.collection.profit_part, 2000);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('partial repayment when the collection is smaller than the debt', async () => {
  const { s, m } = await setup(1000);
  try {
    m.recordExpense({ description: 'إصلاح', total: 3000, fromDrawer: 0, restAs: 'manager' });
    const r = m.recordRemoteCollection({ type: 'transfer', amount: 1000 });
    assert.equal(r.collection.repayment_part, 1000);
    assert.equal(r.collection.profit_part, 0);
    assert.deepEqual(four(m.getBalances()), [0, 0, 2000, 0]);
  } finally { cleanup(s); }
});

test('manager cancels a deposit that never arrived: cash and debt come back', async () => {
  const { s, m } = await setup(1000);
  try {
    m.recordExpense({ description: 'إصلاح', total: 500, fromDrawer: 0, restAs: 'manager' });
    const r = m.recordRemoteCollection({ type: 'bank', amount: 800, reference: 'X1' });
    assert.deepEqual(four(m.getBalances()), [200, 0, 0, 0]);
    assert.equal(m.cancelCollection(r.collection.id, '').success, false); // reason required
    const cx = m.cancelCollection(r.collection.id, 'لم يصل المبلغ');
    assert.equal(cx.success, true, cx.error);
    assert.deepEqual(four(m.getBalances()), [1000, 0, 500, 0]);
    assert.equal(m.cancelCollection(r.collection.id, 'x').success, false); // already cancelled
    // Old-table mirror removed.
    assert.equal(s.getCollections().some(x => x.id === r.mirrorCollectionId), false);
  } finally { cleanup(s); }
});

test('deleting the mirror from the old collections list cancels the new record', async () => {
  const { s, m } = await setup(1000);
  try {
    const r = m.recordRemoteCollection({ type: 'bank', amount: 600 });
    s.deleteCollection(r.mirrorCollectionId);
    assert.equal(m.onMirrorCollectionDeleted(r.mirrorCollectionId), 1);
    assert.equal(m.getBalances().cashInHand, 1000);
    assert.ok(m.getCollection(r.collection.id).cancelled_at);
  } finally { cleanup(s); }
});

test('manager-recorded receipt: no notification', async () => {
  const { s, m } = await setup(1000);
  try {
    m.recordRemoteCollection({ type: 'bank', amount: 300, recordedBy: 'manager' });
    assert.equal(m.getNotifications().length, 0);
    assert.equal(m.getCollections({ remoteOnly: true })[0].recorded_by, 'manager');
  } finally { cleanup(s); }
});
