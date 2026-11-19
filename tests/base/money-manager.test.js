'use strict';
/**
 * Money system: refund on/off switch + manager edit / delete / history (Task 8).
 * Rule under test: after ANY edit or delete, balances equal what the records say.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));
after(() => cleanupAll());
const four = (b) => [b.cashInHand, b.owedToSuppliers, b.owedToManager, b.owedBySeller];
const stamp = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const L = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0);
let serial = 1;
async function setup() {
  const s = await newStorage();
  let t = L(2026, 11, 15, 6);
  const m = new MoneyService(s, { now: () => new Date(t) });
  m.switchOver();
  const c = s.addCategory('x', 1);
  return {
    s, m, c,
    at: (d) => { t = d; },
    sell(price, when) {
      const st = stamp(when);
      s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
                VALUES (?, 2026, ?, 'x', ?, ?, ?, ?)`, [serial++, c, price, st.slice(0, 10), st.slice(11), st]);
      return s.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    }
  };
}

test('refunds are OFF by default; the manager turns them on and off', async () => {
  const { s, m, sell, at } = await setup();
  try {
    const t = sell(35, L(2026, 11, 15, 12));
    at(L(2026, 11, 15, 12, 30));
    assert.equal(m.getRefundsEnabled(), false);
    assert.equal(m.getRefundEligibility(m._getTicket(t)).refundable, false);
    assert.equal(m.refundTicket(t, 'x').success, false);
    assert.equal(m.setRefundsEnabled(true).enabled, true);
    assert.equal(m.getRefundsEnabled(), true);
    assert.equal(m.getRefundEligibility(m._getTicket(t)).refundable, true);
    assert.equal(m.refundTicket(t, 'x').success, true);
    // turning it off again does not touch refunds already made, and the manager can still undo
    m.setRefundsEnabled(false);
    assert.equal(m.getBalances().cashInHand, 0);
    assert.equal(m.undoRefund(t).success, true);
    assert.equal(m.getBalances().cashInHand, 35);
    // the setting survives a restart
    assert.equal(new MoneyService(s).getRefundsEnabled(), false);
  } finally { cleanup(s); }
});

test('edit expense: fields change, balances follow, before/after is logged', async () => {
  const { s, m, sell } = await setup();
  try {
    sell(1000, L(2026, 11, 15, 8));
    const r = m.recordExpense({ description: 'soap', total: 300, fromDrawer: 100, restAs: 'unpaid', date: '2026-11-15' });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(four(m.getBalances()), [900, 200, 0, 0]);
    // raise the total: more is owed to the supplier, cash unchanged
    let e = m.editExpense(r.expenseId, { total: 450, description: 'soap bulk', date: '2026-11-14' });
    assert.equal(e.success, true, e.error);
    assert.deepEqual(four(m.getBalances()), [900, 350, 0, 0]);
    assert.equal(m.getExpenseByMirror(r.mirrorExpenseId).description, 'soap bulk');
    const old = s.db.exec('SELECT description, amount, date FROM expenses WHERE id = ' + r.mirrorExpenseId)[0].values[0];
    assert.deepEqual(old, ['soap bulk', 450, '2026-11-14']);
    // cannot go below what is already paid, or into the future, or empty
    assert.equal(m.editExpense(r.expenseId, { total: 50 }).success, false);
    assert.equal(m.editExpense(r.expenseId, { date: '2099-01-01' }).success, false);
    assert.equal(m.editExpense(r.expenseId, { description: '  ' }).success, false);
    assert.equal(m.editExpense(999, { total: 5 }).success, false);
    assert.deepEqual(four(m.getBalances()), [900, 350, 0, 0]);
    const h = m.getHistory().find(x => x.action === 'EDIT' && x.entity === 'money_expenses');
    assert.equal(h.parsed.before.total, 300);
    assert.equal(h.parsed.after.total, 450);
  } finally { cleanup(s); }
});

test('delete expense: preview matches the result; money returns to the drawer', async () => {
  const { s, m, sell } = await setup();
  try {
    sell(1000, L(2026, 11, 15, 8));
    const a = m.recordExpense({ description: 'a', total: 300, fromDrawer: 300, date: '2026-11-15' });
    const b = m.recordExpense({ description: 'b', total: 200, fromDrawer: 50, restAs: 'manager', date: '2026-11-15' });
    const c = m.recordExpense({ description: 'c', total: 120, fromDrawer: 0, restAs: 'unpaid', date: '2026-11-15' });
    assert.deepEqual(four(m.getBalances()), [650, 120, 150, 0]);
    for (const [id, mirror] of [[a.expenseId, a.mirrorExpenseId], [b.expenseId, b.mirrorExpenseId], [c.expenseId, c.mirrorExpenseId]]) {
      const p = m.previewDeleteExpense(id);
      assert.equal(p.success, true);
      const r = m.deleteExpense(id);
      assert.equal(r.success, true);
      const after = m.getBalances();
      assert.equal(after.cashInHand, p.cashAfter);
      assert.equal(after.owedToSuppliers, p.owedToSuppliersAfter);
      assert.equal(after.owedToManager, p.owedToManagerAfter);
      assert.equal(s.db.exec('SELECT COUNT(*) FROM expenses WHERE id = ' + mirror)[0].values[0][0], 0);
    }
    assert.deepEqual(four(m.getBalances()), [1000, 0, 0, 0]);
    const del = m.getHistory().filter(x => x.action === 'DELETE' && x.entity === 'money_expenses');
    assert.equal(del.length, 3);
    assert.equal(del[0].parsed.before.description, 'c');
  } finally { cleanup(s); }
});

test('delete an expense paid by the manager after he was repaid: no negative owed-to-manager', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(1000, L(2026, 11, 15, 8));
    const e = m.recordExpense({ description: 'p', total: 400, fromDrawer: 0, restAs: 'manager', date: '2026-11-15' });
    at(L(2026, 11, 15, 14));
    assert.equal(m.recordRemoteCollection({ type: 'bank', amount: 600, reference: 'r' }).success, true);
    assert.deepEqual(four(m.getBalances()), [400, 0, 0, 0]);
    const p = m.previewDeleteExpense(e.expenseId);
    assert.equal(p.owedToManagerAfter, 0);
    m.deleteExpense(e.expenseId);
    assert.deepEqual(four(m.getBalances()), [400, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('closed-period warning appears for records older than the last in-person visit', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(1000, L(2026, 11, 15, 8));
    const e = m.recordExpense({ description: 'old', total: 100, fromDrawer: 100, date: '2026-11-15' });
    assert.equal(m.previewDeleteExpense(e.expenseId).closedPeriod, false);
    at(L(2026, 11, 15, 14));
    m.collectInPerson({ counted: 900 });
    assert.equal(m.previewDeleteExpense(e.expenseId).closedPeriod, true);
    at(L(2026, 11, 15, 15));
    const e2 = m.recordExpense({ description: 'new', total: 10, fromDrawer: 0, restAs: 'unpaid', date: '2026-11-15' });
    assert.equal(m.previewDeleteExpense(e2.expenseId).closedPeriod, false);
  } finally { cleanup(s); }
});

test('deleting an expense whose late entry was accepted gives the seller his debt back', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(5000, L(2026, 11, 15, 8));
    at(L(2026, 11, 15, 14));
    m.collectInPerson({ counted: 4500 }); // shortage 500
    at(L(2026, 11, 16, 9));
    const e = m.recordExpense({ description: 'late', total: 200, fromDrawer: 200, date: '2026-11-14' });
    assert.equal(e.late, true);
    const pay = m.getLateEntries({ pendingOnly: true })[0];
    assert.equal(m.acceptLateEntry(pay.id).success, true);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 300]);
    const p = m.previewDeleteExpense(e.expenseId);
    assert.equal(p.owedBySellerAfter, 500);
    m.deleteExpense(e.expenseId);
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 500]);
  } finally { cleanup(s); }
});

test('collection preview matches cancelling; edit changes info only, never the amount', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(1000, L(2026, 11, 15, 8));
    m.recordExpense({ description: 'm', total: 300, fromDrawer: 0, restAs: 'manager', date: '2026-11-15' });
    at(L(2026, 11, 15, 10));
    const r = m.recordRemoteCollection({ type: 'on_behalf', amount: 500, recipient: 'Ali' });
    assert.deepEqual(four(m.getBalances()), [500, 0, 0, 0]);
    const ed = m.editCollection(r.collection.id, { recipient: 'Omar', note: 'fixed' });
    assert.equal(ed.success, true);
    assert.equal(ed.collection.amount, 500);
    assert.equal(ed.collection.recipient, 'Omar');
    assert.equal(m.editCollection(r.collection.id, { recipient: '' }).success, false); // on_behalf needs a name
    const h = m.getHistory().find(x => x.action === 'EDIT' && x.entity === 'money_collections');
    assert.equal(h.parsed.before.recipient, 'Ali');
    assert.equal(h.parsed.after.recipient, 'Omar');
    const p = m.previewCancelCollection(r.collection.id);
    assert.equal(p.cashAfter, 1000);
    assert.equal(p.owedToManagerAfter, 300);
    m.cancelCollection(r.collection.id, 'test');
    assert.deepEqual(four(m.getBalances()), [1000, 0, 300, 0]);
  } finally { cleanup(s); }
});

test('in-person preview: cash after cancelling includes the shortage that disappears', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(5000, L(2026, 11, 15, 8));
    at(L(2026, 11, 15, 14));
    const v = m.collectInPerson({ counted: 4500 });
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 500]);
    const p = m.previewCancelCollection(v.collection.id);
    assert.equal(p.cashAfter, 5000);
    assert.equal(p.owedBySellerAfter, 0);
    assert.equal(p.closedPeriod, false);
    m.cancelCollection(v.collection.id, 'wrong');
    assert.deepEqual(four(m.getBalances()), [5000, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('old-table delete hook removes the linked money expense with an audit copy', async () => {
  const { s, m, sell } = await setup();
  try {
    sell(500, L(2026, 11, 15, 8));
    const e = m.recordExpense({ description: 'hook', total: 100, fromDrawer: 100, date: '2026-11-15' });
    s.deleteExpense(e.mirrorExpenseId); // what the day-details delete does first
    assert.equal(m.onMirrorExpenseDeleted(e.mirrorExpenseId), 1);
    assert.deepEqual(four(m.getBalances()), [500, 0, 0, 0]);
    assert.equal(m.getHistory().filter(x => x.action === 'DELETE' && x.entity === 'money_expenses').length, 1);
  } finally { cleanup(s); }
});
