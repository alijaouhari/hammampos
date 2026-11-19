'use strict';
/**
 * Money system — fixes from the Task 3 review:
 *  1. unpaid bills from before the switch-over are carried over and payable
 *  2. daily report / end-of-day record use the new cash in hand
 *  3. "clear all data" also clears the new money records
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT, ExpenseTemplateManager } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));
const SchedulerService = require(path.join(PROJECT_ROOT, 'src', 'services', 'SchedulerService'));

after(() => cleanupAll());

const NOW = '2026-11-15T10:00:00Z';
const four = (b) => [b.cashInHand, b.owedToSuppliers, b.owedToManager, b.owedBySeller];
function sell(s, catId, price, stamp = '2026-11-15 10:30:00') {
  s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
            VALUES (?, 2026, ?, 'ر', ?, ?, ?, ?)`, [Math.floor(Math.random() * 99999), catId, price, stamp.slice(0, 10), stamp.slice(11), stamp]);
}

test('unpaid old wood (like morad 678 + 300) is carried over and can be paid', async () => {
  const s = await newStorage();
  try {
    const w = new ExpenseTemplateManager(s); w.initialize();
    const seller = w.addWoodSeller('morad', '', 'deche', 2);
    // Old system: unpaid wood creates NO expense row.
    const a = w.recordWoodPurchase({ sellerId: seller.id, woodType: 'deche', pricingMethod: 'per_load', totalAmount: 678, deliveryDate: '2026-09-04', paid: false });
    const b = w.recordWoodPurchase({ sellerId: seller.id, woodType: 'deche', pricingMethod: 'per_load', totalAmount: 300, deliveryDate: '2026-09-04', paid: false });
    w.recordWoodPurchase({ sellerId: seller.id, woodType: 'deche', pricingMethod: 'per_load', totalAmount: 500, deliveryDate: '2026-09-03', paid: true });
    const oldExpenseCount = s.db.exec('SELECT COUNT(*) FROM expenses')[0].values[0][0];

    const m = new MoneyService(s, { now: () => new Date(NOW) });
    const r = m.switchOver();
    assert.equal(r.carriedBills, 2);
    assert.equal(r.carriedAmount, 978);
    assert.deepEqual(four(m.getBalances()), [0, 978, 0, 0]);
    // No new rows in the old table: history before the switch-over is unchanged.
    assert.equal(s.db.exec('SELECT COUNT(*) FROM expenses')[0].values[0][0], oldExpenseCount);

    const open = m.getBills({ openOnly: true });
    assert.equal(open.length, 2);
    assert.ok(open.every(x => x.supplier === 'morad' && x.status === 'unpaid'));

    // Pay the 300 delivery: 100 from the drawer, 200 from the manager's pocket.
    const c = s.addCategory('ر', 1);
    sell(s, c, 100);
    const bill300 = open.find(x => x.wood_purchase_id === b.woodId);
    assert.equal(m.payBill(bill300.id, 100, 'drawer').success, true);
    assert.equal(m.payBill(bill300.id, 200, 'manager').success, true);
    assert.deepEqual(four(m.getBalances()), [0, 678, 200, 0]);
    const row = s.db.exec('SELECT paid FROM wood_purchases WHERE id = ?', [b.woodId])[0].values[0][0];
    assert.equal(row, 1);
    assert.equal(s.db.exec('SELECT paid FROM wood_purchases WHERE id = ?', [a.woodId])[0].values[0][0], 0);
  } finally { cleanup(s); }
});

test('unpaid old expense is carried over; paying it marks the old row paid', async () => {
  const s = await newStorage();
  try {
    const r0 = s.recordExpense({ description: 'parts', amount: 300, paid: false, date: '2026-11-10' });
    const m = new MoneyService(s, { now: () => new Date(NOW) });
    m.switchOver();
    const bill = m.getBills({ openOnly: true })[0];
    assert.equal(bill.mirror_expense_id, r0.id);
    assert.equal(bill.remaining, 300);
    m.payBill(bill.id, 300, 'manager');
    assert.equal(s.getExpense(r0.id).paid, 1);
    assert.deepEqual(four(m.getBalances()), [0, 0, 300, 0]);
  } finally { cleanup(s); }
});

test('old out-of-pocket expenses become owed to the manager (like the real 1,400)', async () => {
  const s = await newStorage();
  try {
    s.recordExpense({ description: 'فاتورة الماء والكهرباء', amount: 1200, paid: true, paymentSource: 'out_of_pocket', date: '2026-08-31' });
    s.recordExpense({ description: 'TDWIRA', amount: 100, paid: true, paymentSource: 'out_of_pocket', date: '2026-09-02' });
    s.recordExpense({ description: 'ROULOT', amount: 100, paid: true, paymentSource: 'out_of_pocket', date: '2026-09-02' });
    s.recordExpense({ description: 'cash one', amount: 80, paid: true, paymentSource: 'cash', date: '2026-09-02' });
    const m = new MoneyService(s, { now: () => new Date(NOW) });
    const r = m.switchOver();
    assert.equal(r.carriedOwedToManager, 1400);
    assert.deepEqual(four(m.getBalances()), [0, 0, 1400, 0]);
    // They are fully paid bills, so they never show as unpaid.
    assert.equal(m.getBills({ openOnly: true }).length, 0);
  } finally { cleanup(s); }
});

test('scheduler daily report uses the new cash in hand when provided', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    sell(s, c, 719, '2026-11-15 08:00:00');  // before switch-over (old cash)
    const m = new MoneyService(s, { now: () => new Date(NOW) });
    m.switchOver();
    sell(s, c, 50, '2026-11-15 10:30:00');
    const sch = new SchedulerService(s);
    sch.getCashInHand = () => m.getBalances().cashInHand;
    const report = await sch.generateDailyReport('2026-11-15', s.getTicketsForDate('2026-11-15'), s.getExpensesForDate('2026-11-15'));
    assert.equal(report.cashInHand, 50);
    assert.equal(s.getCashInHand(), 769); // old formula would have reported this
  } finally { cleanup(s); }
});

test('clear all data also clears the new money records', async () => {
  const s = await newStorage();
  try {
    const m = new MoneyService(s, { now: () => new Date(NOW) });
    m.switchOver();
    const c = s.addCategory('ر', 1);
    sell(s, c, 1000);
    m.recordExpense({ description: 'x', total: 1500, fromDrawer: 1000, restAs: 'manager' });
    assert.deepEqual(four(m.getBalances()), [0, 0, 500, 0]);
    s.clearAllData();
    m.clearMoneyData();
    assert.deepEqual(four(m.getBalances()), [0, 0, 0, 0]);
    assert.equal(m.getNotifications().length, 0);
    assert.equal(m.isSwitchedOver(), true);
  } finally { cleanup(s); }
});
