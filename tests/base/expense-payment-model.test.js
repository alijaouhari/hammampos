'use strict';
/**
 * Regression tests for the Expense Payment Model overhaul (v2.8.22 candidate).
 *
 * Separates: expense day (`date`) / paid state (`paid`) / paid day (`paid_date`) /
 * payment source (`payment_source` = 'cash' | 'out_of_pocket'). Business cash only
 * decreases for expenses that are paid AND paid from business cash — enforced
 * centrally in StorageManager.getCashInHand().
 *
 * Mirrors the wood-payment pattern (recordExpense ~ recordWoodPurchase,
 * payExpense ~ payWoodPurchase). Covers the 15 required scenarios from the task,
 * plus backward-compatibility with the legacy addExpense(description, amount) form.
 *
 * All state is exercised at the service level (StorageManager); the Teller/Manager
 * UI uses exactly this backend via api.storage.recordExpense / payExpense.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll, StorageManager } = require('./helpers');

after(() => cleanupAll());

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
const today = () => new Date().toISOString().split('T')[0];

// --- CASE A: known + paid immediately from business cash -----------------------
test('CASE A: expense known and paid now from business cash — cash drops once, paid day = today', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 1000);
    s.createTicket(c); // +1000
    const before = s.getCashInHand();
    const res = s.recordExpense({ description: 'صيانة', amount: 500, date: today(), paid: true, paymentSource: 'cash' });
    assert.equal(res.success, true);
    assert.equal(s.getCashInHand(), before - 500); // exactly once
    const ex = s.getExpense(res.id);
    assert.equal(Number(ex.paid), 1);
    assert.equal(ex.date, today());
    assert.equal(ex.paid_date, today());
    assert.equal(ex.payment_source, 'cash');
  } finally { cleanup(s); }
});

// --- CASE B: known but unpaid --------------------------------------------------
test('CASE B: expense known but unpaid — recorded, no paid day, no cash movement', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 2000);
    s.createTicket(c); // +2000
    const before = s.getCashInHand();
    const res = s.recordExpense({ description: 'سباك', amount: 1000, date: today(), paid: false });
    assert.equal(res.success, true);
    assert.equal(s.getCashInHand(), before); // unchanged
    const ex = s.getExpense(res.id);
    assert.equal(Number(ex.paid), 0);
    assert.equal(ex.paid_date, null);
  } finally { cleanup(s); }
});

// --- CASE C: pay later from business cash --------------------------------------
test('CASE C: unpaid then paid later from business cash — expense day preserved, cash drops once at payment', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 3000);
    s.createTicket(c); // +3000
    const expenseDay = daysAgo(13);
    const rec = s.recordExpense({ description: 'سباك', amount: 1000, date: expenseDay, paid: false });
    const afterRecord = s.getCashInHand();
    assert.equal(afterRecord, 3000); // still no deduction

    const payDay = daysAgo(0);
    const pay = s.payExpense(rec.id, { paidDate: payDay, paymentSource: 'cash' });
    assert.equal(pay.success, true);
    assert.equal(s.getCashInHand(), 3000 - 1000); // exactly once

    const ex = s.getExpense(rec.id);
    assert.equal(ex.date, expenseDay);       // expense day UNCHANGED
    assert.equal(ex.paid_date, payDay);      // paid day recorded
    assert.equal(Number(ex.paid), 1);
    assert.equal(ex.payment_source, 'cash');
  } finally { cleanup(s); }
});

// --- CASE D: pay later out of pocket -------------------------------------------
test('CASE D: unpaid then paid later out of pocket — business cash does NOT decrease', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 3000);
    s.createTicket(c); // +3000
    const expenseDay = daysAgo(13);
    const rec = s.recordExpense({ description: 'سباك', amount: 1000, date: expenseDay, paid: false });
    const payDay = daysAgo(0);
    const pay = s.payExpense(rec.id, { paidDate: payDay, paymentSource: 'out_of_pocket' });
    assert.equal(pay.success, true);
    assert.equal(s.getCashInHand(), 3000); // NOT reduced (paid from pocket)

    const ex = s.getExpense(rec.id);
    assert.equal(ex.date, expenseDay);
    assert.equal(ex.paid_date, payDay);
    assert.equal(Number(ex.paid), 1);
    assert.equal(ex.payment_source, 'out_of_pocket');
  } finally { cleanup(s); }
});

// --- CASE E: add historical expense after price becomes known ------------------
test('CASE E: historical expense entered later keeps the selected past expense day, unpaid, no cash change', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 5000);
    s.createTicket(c); // +5000
    const pastDay = daysAgo(4); // e.g. Sep 2 entered on Sep 6
    const res = s.recordExpense({ description: 'سباك', amount: 1000, date: pastDay, paid: false });
    assert.equal(res.success, true);
    const ex = s.getExpense(res.id);
    assert.equal(ex.date, pastDay);        // NOT overwritten with today
    assert.equal(ex.amount, 1000);
    assert.equal(Number(ex.paid), 0);
    assert.equal(s.getCashInHand(), 5000); // no deduction
    // The expense is attached to its historical day, retrievable by that date.
    const onDay = s.getExpensesForDate(pastDay);
    assert.equal(onDay.length, 1);
    assert.equal(onDay[0].id, res.id);
  } finally { cleanup(s); }
});

// --- Paid immediately out of pocket --------------------------------------------
test('paid immediately out of pocket at entry — no cash movement, source recorded', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 800);
    s.createTicket(c);
    const res = s.recordExpense({ description: 'أدوات', amount: 300, date: today(), paid: true, paymentSource: 'out_of_pocket' });
    assert.equal(res.success, true);
    assert.equal(s.getCashInHand(), 800); // unchanged
    const ex = s.getExpense(res.id);
    assert.equal(Number(ex.paid), 1);
    assert.equal(ex.payment_source, 'out_of_pocket');
    assert.equal(ex.paid_date, today());
  } finally { cleanup(s); }
});

// --- DOUBLE PAYMENT PROTECTION -------------------------------------------------
test('double-payment protection: an already-paid expense cannot be paid again', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 3000);
    s.createTicket(c);
    const rec = s.recordExpense({ description: 'سباك', amount: 1000, date: daysAgo(5), paid: false });
    const firstPayDay = daysAgo(1);
    assert.equal(s.payExpense(rec.id, { paidDate: firstPayDay, paymentSource: 'cash' }).success, true);
    const cashAfterFirst = s.getCashInHand();
    assert.equal(cashAfterFirst, 2000); // 3000 - 1000 once

    // Attempt a second payment (different source/date) — must fail safely.
    const second = s.payExpense(rec.id, { paidDate: daysAgo(0), paymentSource: 'out_of_pocket' });
    assert.equal(second.success, false);
    assert.ok(second.error);
    assert.equal(s.getCashInHand(), cashAfterFirst); // no extra deduction
    const ex = s.getExpense(rec.id);
    assert.equal(ex.paid_date, firstPayDay);      // original paid day preserved
    assert.equal(ex.payment_source, 'cash');       // original source preserved
  } finally { cleanup(s); }
});

// --- unpaid expense does not reduce cash even across many entries --------------
test('multiple unpaid expenses never reduce cash; paying one deducts only that one', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 5000);
    s.createTicket(c); // +5000
    const a = s.recordExpense({ description: 'أ', amount: 100, date: today(), paid: false });
    const b = s.recordExpense({ description: 'ب', amount: 200, date: today(), paid: false });
    s.recordExpense({ description: 'ج', amount: 300, date: today(), paid: false });
    assert.equal(s.getCashInHand(), 5000); // all unpaid

    s.payExpense(a.id, { paymentSource: 'cash' });      // -100
    assert.equal(s.getCashInHand(), 4900);
    s.payExpense(b.id, { paymentSource: 'out_of_pocket' }); // no cash change
    assert.equal(s.getCashInHand(), 4900);
  } finally { cleanup(s); }
});

// --- historical expenses remain intact across reopen ---------------------------
test('historical expenses (paid + unpaid) survive a full DB reopen with all fields intact', async () => {
  const s = await newStorage();
  const dbPath = s.dbPath;
  let paidId, unpaidId;
  const expenseDay = daysAgo(9);
  try {
    const c = s.addCategory('رجال', 4000);
    s.createTicket(c);
    paidId = s.recordExpense({ description: 'مدفوع', amount: 400, date: expenseDay, paid: true, paymentSource: 'cash' }).id;
    unpaidId = s.recordExpense({ description: 'غير مدفوع', amount: 600, date: expenseDay, paid: false }).id;
  } finally { cleanup(s); }

  const s2 = new StorageManager(dbPath);
  s2.dbPath = dbPath;
  await s2.initialize();
  try {
    const paid = s2.getExpense(paidId);
    const unpaid = s2.getExpense(unpaidId);
    assert.equal(paid.date, expenseDay);
    assert.equal(Number(paid.paid), 1);
    assert.equal(paid.payment_source, 'cash');
    assert.equal(unpaid.date, expenseDay);
    assert.equal(Number(unpaid.paid), 0);
    assert.equal(unpaid.paid_date, null);
    // getCashInHand after reopen still reflects only the paid-cash expense.
    assert.equal(s2.getCashInHand(), 4000 - 400);
  } finally { cleanup(s2); }
});

// --- BACKWARD COMPATIBILITY ----------------------------------------------------
test('legacy addExpense(description, amount) still creates a paid business-cash expense today', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 100);
    s.createTicket(c); // +100
    const id = s.addExpense('كهرباء', 40); // legacy 2-arg form
    assert.equal(typeof id, 'number');
    assert.equal(s.getCashInHand(), 60); // still deducts (paid cash)
    const ex = s.getExpense(id);
    assert.equal(Number(ex.paid), 1);
    assert.equal(ex.payment_source, 'cash');
    assert.equal(ex.date, today());
    assert.equal(ex.paid_date, today());
  } finally { cleanup(s); }
});

// --- validation ----------------------------------------------------------------
test('recordExpense rejects empty description and non-positive amount without writing', async () => {
  const s = await newStorage();
  try {
    assert.equal(s.recordExpense({ description: '   ', amount: 100 }).success, false);
    assert.equal(s.recordExpense({ description: 'x', amount: 0 }).success, false);
    assert.equal(s.recordExpense({ description: 'x', amount: -5 }).success, false);
    // nothing recorded
    assert.equal(s.getOutstandingExpenses().length, 0);
  } finally { cleanup(s); }
});

// --- getOutstandingExpenses reflects only unpaid -------------------------------
test('getOutstandingExpenses lists only unpaid expenses and drops them once paid', async () => {
  const s = await newStorage();
  try {
    const u = s.recordExpense({ description: 'آجل', amount: 100, date: today(), paid: false });
    s.recordExpense({ description: 'مدفوع', amount: 50, date: today(), paid: true, paymentSource: 'cash' });
    let out = s.getOutstandingExpenses();
    assert.equal(out.length, 1);
    assert.equal(out[0].id, u.id);
    s.payExpense(u.id, { paymentSource: 'cash' });
    out = s.getOutstandingExpenses();
    assert.equal(out.length, 0);
  } finally { cleanup(s); }
});

// --- paying a non-existent expense fails safely --------------------------------
test('payExpense on a missing id fails safely without affecting cash', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 100);
    s.createTicket(c);
    const res = s.payExpense(999999, { paymentSource: 'cash' });
    assert.equal(res.success, false);
    assert.equal(s.getCashInHand(), 100);
  } finally { cleanup(s); }
});
