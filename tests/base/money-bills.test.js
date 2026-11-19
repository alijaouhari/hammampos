'use strict';
/**
 * Money system — Task 3: unpaid bills and paying them.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT, ExpenseTemplateManager } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));

after(() => cleanupAll());

const NOW = '2026-11-15T10:00:00Z';
let serial = 1;
function sell(s, catId, price) {
  s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
            VALUES (?, 2026, ?, 'ر', ?, '2026-11-15', '10:30:00', '2026-11-15 10:30:00')`, [serial++, catId, price]);
}
async function setup(cash) {
  const s = await newStorage();
  const m = new MoneyService(s, { now: () => new Date(NOW) });
  m.switchOver();
  const c = s.addCategory('ر', 1);
  if (cash > 0) sell(s, c, cash);
  return { s, m, c };
}
const four = (b) => [b.cashInHand, b.owedToSuppliers, b.owedToManager, b.owedBySeller];

test('partial payments add up; status goes unpaid -> partial -> paid', async () => {
  const { s, m, c } = await setup(0);
  try {
    const r = m.recordExpense({ description: 'خشب', supplier: 'حسن', total: 500, fromDrawer: 0, restAs: 'unpaid' });
    assert.equal(m.getBill(r.expenseId).status, 'unpaid');
    sell(s, c, 300);
    let p = m.payBill(r.expenseId, 300, 'drawer');
    assert.equal(p.success, true, p.error);
    assert.equal(p.bill.status, 'partial');
    assert.equal(p.bill.paid, 300);
    assert.equal(p.bill.remaining, 200);
    assert.deepEqual(four(m.getBalances()), [0, 200, 0, 0]);
    // Mirror stays "unpaid" until fully settled.
    assert.equal(s.getExpense(r.mirrorExpenseId).paid, 0);

    sell(s, c, 200);
    p = m.payBill(r.expenseId, 200, 'drawer');
    assert.equal(p.bill.status, 'paid');
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 0]);
    assert.equal(s.getExpense(r.mirrorExpenseId).paid, 1);
    assert.equal(m.getBills({ openOnly: true }).length, 0);
  } finally { cleanup(s); }
});

test('cannot overpay a bill, nor pay more than the drawer holds', async () => {
  const { s, m } = await setup(1000);
  try {
    const r = m.recordExpense({ description: 'x', total: 500, fromDrawer: 0, restAs: 'unpaid' });
    assert.equal(m.payBill(r.expenseId, 500.01, 'drawer').success, false);
    assert.equal(m.payBill(r.expenseId, 0, 'drawer').success, false);
    assert.equal(m.payBill(r.expenseId, -5, 'drawer').success, false);
    assert.equal(m.payBill(r.expenseId, 10, 'pocket').success, false);
    assert.equal(m.payBill(99999, 10, 'drawer').success, false);
    // Drawer limit.
    const big = m.recordExpense({ description: 'y', total: 3000, fromDrawer: 0, restAs: 'unpaid' });
    assert.equal(m.payBill(big.expenseId, 1500, 'drawer').success, false);
    assert.deepEqual(four(m.getBalances()), [1000, 3500, 0, 0]);
    // Paid bill cannot be paid again.
    assert.equal(m.payBill(r.expenseId, 500, 'drawer').success, true);
    assert.equal(m.payBill(r.expenseId, 1, 'drawer').success, false);
  } finally { cleanup(s); }
});

test('manager pays from his pocket: owed to manager grows, drawer untouched, notified', async () => {
  const { s, m } = await setup(100);
  try {
    const r = m.recordExpense({ description: 'قطع غيار', total: 6000, fromDrawer: 100, restAs: 'unpaid' });
    const p = m.payBill(r.expenseId, 3000, 'manager');
    assert.equal(p.success, true, p.error);
    assert.equal(p.bill.status, 'partial');
    assert.equal(p.bill.paid_drawer, 100);
    assert.equal(p.bill.paid_manager, 3000);
    assert.deepEqual(four(m.getBalances()), [0, 2900, 3000, 0]);
    const n = m.getNotifications();
    assert.equal(n[0].type, 'paid_by_manager');
    assert.equal(n[0].payload.amount, 3000);
    // The manager can pay more than the drawer holds.
    assert.equal(m.payBill(r.expenseId, 2900, 'manager').success, true);
    assert.deepEqual(four(m.getBalances()), [0, 0, 5900, 0]);
  } finally { cleanup(s); }
});

test('the user example: 6,000 bill, 1,000 drawer + 3,000 manager, 2,000 still owed', async () => {
  const { s, m } = await setup(1000);
  try {
    const r = m.recordExpense({ description: 'إصلاح كبير', total: 6000, fromDrawer: 1000, restAs: 'unpaid' });
    m.payBill(r.expenseId, 3000, 'manager');
    const b = m.getBill(r.expenseId);
    assert.deepEqual([b.total, b.paid_drawer, b.paid_manager, b.remaining], [6000, 1000, 3000, 2000]);
    assert.deepEqual(four(m.getBalances()), [0, 2000, 3000, 0]);
  } finally { cleanup(s); }
});

test('paying a wood bill in full marks the wood purchase paid', async () => {
  const { s, m } = await setup(0);
  try {
    const w = new ExpenseTemplateManager(s); w.initialize();
    const seller = w.addWoodSeller('حسن', '', 'أوكاليبتوس', 2);
    const r = m.recordWoodPurchase(w, { sellerId: seller.id, woodType: 'أوكاليبتوس', pricingMethod: 'per_load',
      totalAmount: 500, deliveryDate: '2026-11-15', fromDrawer: 0, restAs: 'unpaid' });
    const bill = m.getBills().find(b => b.wood_purchase_id === r.woodId);
    assert.equal(bill.supplier, 'حسن');
    m.payBill(bill.id, 300, 'manager');
    assert.equal(s.db.exec('SELECT paid FROM wood_purchases WHERE id = ?', [r.woodId])[0].values[0][0], 0);
    m.payBill(bill.id, 200, 'manager');
    const row = s.db.exec('SELECT paid, paid_date FROM wood_purchases WHERE id = ?', [r.woodId])[0].values[0];
    assert.deepEqual(row, [1, '2026-11-15']);
  } finally { cleanup(s); }
});

test('open bills list only shows what is still owed, newest first', async () => {
  const { s, m } = await setup(1000);
  try {
    m.recordExpense({ description: 'a', total: 100, fromDrawer: 100, date: '2026-11-13' });               // paid
    m.recordExpense({ description: 'b', total: 300, fromDrawer: 0, restAs: 'unpaid', date: '2026-11-14' });
    m.recordExpense({ description: 'c', total: 200, fromDrawer: 50, restAs: 'unpaid', date: '2026-11-15' });
    const open = m.getBills({ openOnly: true });
    assert.deepEqual(open.map(b => [b.description, b.status, b.remaining]), [['c', 'partial', 150], ['b', 'unpaid', 300]]);
    assert.equal(m.getBills().length, 3);
  } finally { cleanup(s); }
});
