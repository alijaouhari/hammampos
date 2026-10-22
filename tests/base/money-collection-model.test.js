'use strict';
/**
 * Regression tests for the Money Collection / Zakat model overhaul.
 *
 * Covers every locked business rule (A–Q from the task spec):
 *   A. Normal multi-day accumulation.
 *   B. Today's partial amount is collectible.
 *   C. Owner can leave today's amount uncollected.
 *   D. Paid-later expense: recorded Day 1, paid Day 3 → cash impact Day 3.
 *   E. Out-of-pocket expense never reduces drawer cash.
 *   F. Unpaid expense never reduces drawer cash.
 *   G. Previous collection reduces physical drawer cash.
 *   H. Selecting available days never exceeds actual cash-in-hand.
 *   I. Collection history correctly identifies collected days.
 *   J. Partial collection / leaving a later day works.
 *   K. Zakat is 2.5%.
 *   L. Zakat is calculated from collected money, not gross sales.
 *   M. Uncollected money generates no Zakat.
 *   N. Zakat set-aside does not change Cash in Hand.
 *   O. Zakat set-aside does not change Money Collection.
 *   P. The two Zakat visibility settings are independent.
 *   Q. Repeat/partial collection of the same date (Option ii).
 *      getCashInHand stays correct throughout.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll } = require('./helpers');

after(() => cleanupAll());

function today() { return new Date().toISOString().split('T')[0]; }
function dateStr(n) {
  // n days from a fixed epoch to produce deterministic past dates
  const d = new Date('2026-09-01');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}
// Insert a ticket with an explicit date (bypassing createTicket which stamps today)
function insertTicket(s, catId, price, date) {
  s.db.run("INSERT INTO tickets (serial_number,year,category_id,category_name,price,date,time) VALUES (?,2026,?,'ر',?,?,'10:00:00')",
    [Math.floor(Math.random() * 99999), catId, price, date]);
}

// --- A. Normal multi-day accumulation ---
test('A: multi-day accumulation — available = sum of day cash-flows', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 100, dateStr(0));
    insertTicket(s, c, 200, dateStr(1));
    insertTicket(s, c, 300, dateStr(2));
    const days = s.getAvailableCollectionDays();
    const d0 = days.find(d => d.date === dateStr(0));
    const d1 = days.find(d => d.date === dateStr(1));
    const d2 = days.find(d => d.date === dateStr(2));
    assert.equal(d0.available, 100);
    assert.equal(d1.available, 200);
    assert.equal(d2.available, 300);
    // Total available = total cash-in-hand (no collections yet)
    assert.equal(s.getCashInHand(), 600);
    const totalAvail = days.filter(d => d.available > 0).reduce((s, d) => s + d.available, 0);
    assert.equal(totalAvail, 600);
  } finally { cleanup(s); }
});

// --- B. Today's partial amount is collectible ---
test('B: today is always included and collectible when it has revenue', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 400, today());
    const days = s.getAvailableCollectionDays();
    const todayRow = days.find(d => d.date === today());
    assert.ok(todayRow, 'today must appear');
    assert.equal(todayRow.available, 400);
    assert.equal(s.getCashInHand(), 400);
  } finally { cleanup(s); }
});

// --- C. Owner can leave today uncollected (only collect yesterday) ---
test('C: collecting yesterday leaves today uncollected and cash reduced by only yesterday', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 100, dateStr(0));
    insertTicket(s, c, 200, today());
    const cashBefore = s.getCashInHand(); // 300
    s.collectMoneyForDays(100, '', [dateStr(0)], { [dateStr(0)]: 100 });
    assert.equal(s.getCashInHand(), 200); // only 100 removed
    // today still appears as available
    const days = s.getAvailableCollectionDays();
    const todayRow = days.find(d => d.date === today());
    assert.ok(todayRow && todayRow.available === 200, 'today still 200 available');
    assert.equal(cashBefore, 300);
  } finally { cleanup(s); }
});

// --- D. Paid-later expense: expense Day 1, paid Day 3 → cash impact on Day 3 ---
test('D: paid-later expense — expense day unchanged, cash deducted at paid_date', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 500, dateStr(0)); // Day 0 revenue
    insertTicket(s, c, 500, dateStr(2)); // Day 2 revenue
    // Expense incurred Day 0 but paid (from cash) on Day 2
    const r = s.recordExpense({ description: 'x', amount: 100, date: dateStr(0), paid: false });
    s.payExpense(r.id, { paidDate: dateStr(2), paymentSource: 'cash' });
    const ex = s.getExpense(r.id);
    assert.equal(ex.date, dateStr(0),       'expense day preserved');
    assert.equal(ex.paid_date, dateStr(2),  'paid_date = payment day');
    assert.equal(s.getCashInHand(), 900);   // 1000 - 100

    const days = s.getAvailableCollectionDays();
    const d0 = days.find(d => d.date === dateStr(0));
    const d2 = days.find(d => d.date === dateStr(2));
    // Day 0: no cash-paid expense on paid_date=Day0; dayCashFlow(Day0) = 500
    assert.equal(d0.available, 500, 'Day 0 still 500 (expense paid on Day 2, not Day 0)');
    // Day 2: dayCashFlow = 500 - 100 = 400
    assert.equal(d2.available, 400, 'Day 2 reduced by 100 (paid_date=Day2)');
    // totalAvail == cash-in-hand
    const totalAvail = days.filter(d => d.available > 0).reduce((s, d) => s + d.available, 0);
    assert.equal(totalAvail, s.getCashInHand(), 'available total always = cash-in-hand');
  } finally { cleanup(s); }
});

// --- E. Out-of-pocket expense never reduces drawer cash ---
test('E: out-of-pocket expense does not reduce cash-in-hand or available amount', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 300, today());
    s.recordExpense({ description: 'x', amount: 100, date: today(), paid: true, paymentSource: 'out_of_pocket' });
    assert.equal(s.getCashInHand(), 300, 'pocket does not reduce cash');
    const days = s.getAvailableCollectionDays();
    const todayRow = days.find(d => d.date === today());
    // dayCashFlow uses paid_date and cash source only → 300, no deduction
    assert.equal(todayRow.available, 300, 'pocket does not reduce available');
    const totalAvail = days.filter(d => d.available > 0).reduce((s, d) => s + d.available, 0);
    assert.equal(totalAvail, s.getCashInHand());
  } finally { cleanup(s); }
});

// --- F. Unpaid expense never reduces drawer cash ---
test('F: unpaid expense does not reduce cash-in-hand or available amount', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 300, today());
    s.recordExpense({ description: 'x', amount: 100, date: today(), paid: false });
    assert.equal(s.getCashInHand(), 300);
    const days = s.getAvailableCollectionDays();
    const todayRow = days.find(d => d.date === today());
    assert.equal(todayRow.available, 300, 'unpaid does not reduce available');
    const totalAvail = days.filter(d => d.available > 0).reduce((s, d) => s + d.available, 0);
    assert.equal(totalAvail, s.getCashInHand());
  } finally { cleanup(s); }
});

// --- G. Previous collection reduces physical drawer cash ---
test('G: collecting reduces getCashInHand by the collected amount', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 1000, today());
    assert.equal(s.getCashInHand(), 1000);
    s.collectMoneyForDays(600, '', [today()], { [today()]: 600 });
    assert.equal(s.getCashInHand(), 400);
  } finally { cleanup(s); }
});

// --- H. Selected available days never exceed actual Cash in Hand ---
test('H: sum of all available days always equals getCashInHand (no prior collection)', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 100, dateStr(0));
    insertTicket(s, c, 200, dateStr(1));
    s.recordExpense({ description: 'x', amount: 50, date: dateStr(0), paid: true, paymentSource: 'cash', paidDate: dateStr(0) });
    s.recordExpense({ description: 'y', amount: 30, date: dateStr(1), paid: true, paymentSource: 'out_of_pocket', paidDate: dateStr(1) }); // pocket
    const days = s.getAvailableCollectionDays();
    const totalAvail = days.filter(d => d.available > 0).reduce((sum, d) => sum + d.available, 0);
    const cashInHand = s.getCashInHand();
    assert.equal(totalAvail, cashInHand, 'sum(available) === getCashInHand always');
  } finally { cleanup(s); }
});

// --- I. Collection history correctly identifies collected days ---
test('I: collection_days rows persist; getCollectedDays reflects them', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 300, dateStr(0));
    insertTicket(s, c, 300, dateStr(1));
    s.collectMoneyForDays(600, 'test', [dateStr(0), dateStr(1)],
      { [dateStr(0)]: 300, [dateStr(1)]: 300 });
    const cd = s.getCollectedDays();
    assert.ok(cd.includes(dateStr(0)));
    assert.ok(cd.includes(dateStr(1)));
    const colDays = s.getCollectionDaysWithAmounts(
      s.db.exec('SELECT id FROM collections')[0].values[0][0]);
    assert.equal(colDays.length, 2);
    assert.equal(colDays.find(d => d.date === dateStr(0)).amount, 300);
  } finally { cleanup(s); }
});

// --- J. Partial collection / leaving a later day ---
test('J: collect some days, leave others; left days remain available', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 100, dateStr(0));
    insertTicket(s, c, 200, dateStr(1));
    insertTicket(s, c, 300, dateStr(2));
    s.collectMoneyForDays(300, '', [dateStr(0), dateStr(1)],
      { [dateStr(0)]: 100, [dateStr(1)]: 200 });
    assert.equal(s.getCashInHand(), 300);
    const days = s.getAvailableCollectionDays();
    const d2 = days.find(d => d.date === dateStr(2));
    assert.equal(d2.available, 300);
    // dateStr(0) and dateStr(1) fully collected → 0 available
    const d0 = days.find(d => d.date === dateStr(0));
    const d1 = days.find(d => d.date === dateStr(1));
    assert.ok(!d0 || d0.available <= 0, 'Day 0 fully collected');
    assert.ok(!d1 || d1.available <= 0, 'Day 1 fully collected');
  } finally { cleanup(s); }
});

// --- K. Zakat is exactly 2.5% ---
test('K: Zakat = exactly 2.5% of collected day amount', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 800, dateStr(0));
    s.collectMoneyForDays(800, '', [dateStr(0)], { [dateStr(0)]: 800 });
    const hist = s.getZakatHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].amount, 800);
    assert.equal(hist[0].zakat, 20); // 800 * 0.025 = 20
  } finally { cleanup(s); }
});

// --- L. Zakat is from collected money, not gross sales ---
test('L: Zakat only on collected amounts; uncollected revenue generates zero Zakat records', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 1000, dateStr(0));
    insertTicket(s, c, 2000, dateStr(1));
    // Only collect Day 0
    s.collectMoneyForDays(1000, '', [dateStr(0)], { [dateStr(0)]: 1000 });
    const hist = s.getZakatHistory();
    assert.equal(hist.length, 1, 'only one day collected → one Zakat record');
    assert.equal(hist[0].amount, 1000);
    assert.equal(hist[0].zakat, 25); // 1000 * 0.025
    // Day 1 (uncollected) does not appear
    assert.ok(!hist.some(h => h.date === dateStr(1)));
  } finally { cleanup(s); }
});

// --- M. Uncollected money generates no Zakat ---
test('M: no collections → no Zakat history', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 500, today());
    const hist = s.getZakatHistory();
    assert.equal(hist.length, 0);
  } finally { cleanup(s); }
});

// --- N. Zakat set-aside does not change Cash in Hand ---
test('N: setZakatSetAside does not affect getCashInHand', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 400, dateStr(0));
    s.collectMoneyForDays(400, '', [dateStr(0)], { [dateStr(0)]: 400 });
    const cashBefore = s.getCashInHand();
    const hist = s.getZakatHistory();
    s.setZakatSetAside(hist[0].id, true);
    assert.equal(s.getCashInHand(), cashBefore, 'set-aside never changes cash');
  } finally { cleanup(s); }
});

// --- O. Zakat set-aside does not change collection records ---
test('O: setZakatSetAside does not alter collection or collection_days records', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 400, dateStr(0));
    s.collectMoneyForDays(400, '', [dateStr(0)], { [dateStr(0)]: 400 });
    const hist = s.getZakatHistory();
    const colBefore = s.db.exec('SELECT COUNT(*) FROM collections')[0].values[0][0];
    const cdBefore = s.db.exec('SELECT COUNT(*) FROM collection_days')[0].values[0][0];
    s.setZakatSetAside(hist[0].id, true);
    const colAfter = s.db.exec('SELECT COUNT(*) FROM collections')[0].values[0][0];
    const cdAfter = s.db.exec('SELECT COUNT(*) FROM collection_days')[0].values[0][0];
    assert.equal(colBefore, colAfter, 'collections unchanged');
    assert.equal(cdBefore, cdAfter,  'collection_days unchanged');
  } finally { cleanup(s); }
});

// --- P. The two Zakat visibility settings are independent ---
test('P: zakat_visible_sales_ledger and zakat_visible_admin_ledger are independent', async () => {
  const s = await newStorage();
  try {
    // Default: both off
    let vis = s.getZakatVisibility();
    assert.equal(vis.zakat_visible_sales_ledger, false);
    assert.equal(vis.zakat_visible_admin_ledger, false);
    // Turn on sales only
    s.setSetting('zakat_visible_sales_ledger', '1');
    vis = s.getZakatVisibility();
    assert.equal(vis.zakat_visible_sales_ledger, true,  'sales on');
    assert.equal(vis.zakat_visible_admin_ledger, false, 'admin still off');
    // Turn on admin only
    s.setSetting('zakat_visible_sales_ledger', '0');
    s.setSetting('zakat_visible_admin_ledger', '1');
    vis = s.getZakatVisibility();
    assert.equal(vis.zakat_visible_sales_ledger, false, 'sales off');
    assert.equal(vis.zakat_visible_admin_ledger, true,  'admin on');
  } finally { cleanup(s); }
});

// --- Q. Repeat/partial collection of the same date (Option ii) ---
test('Q: same date collectible multiple times as new cash accumulates', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 600, dateStr(0)); // initial revenue
    // First collection: take 600
    s.collectMoneyForDays(600, '', [dateStr(0)], { [dateStr(0)]: 600 });
    let days = s.getAvailableCollectionDays();
    let d0 = days.find(d => d.date === dateStr(0));
    // fully collected: available = 0 (not offered again yet)
    assert.ok(!d0 || d0.available === 0, 'Day 0 fully collected → 0 available');
    assert.equal(s.getCashInHand(), 0);

    // New revenue arrives on the same date
    insertTicket(s, c, 400, dateStr(0));
    days = s.getAvailableCollectionDays();
    d0 = days.find(d => d.date === dateStr(0));
    assert.ok(d0, 'Day 0 reappears with new revenue');
    assert.equal(d0.available, 400, 'available = new 400 after prior 600 collected');
    assert.equal(s.getCashInHand(), 400);

    // Second collection: take the new 400
    s.collectMoneyForDays(400, '', [dateStr(0)], { [dateStr(0)]: 400 });
    assert.equal(s.getCashInHand(), 0);
    days = s.getAvailableCollectionDays();
    d0 = days.find(d => d.date === dateStr(0));
    assert.ok(!d0 || d0.available === 0, 'Day 0 again fully collected');
    // collection_days should have 2 rows for dateStr(0)
    const cdRows = s.db.exec(
      `SELECT COUNT(*) FROM collection_days WHERE date='${dateStr(0)}'`)[0].values[0][0];
    assert.equal(cdRows, 2, 'two collection_days rows for same date');
    // total collected from that date = 600 + 400 = 1000
    const totalCollected = s.db.exec(
      `SELECT COALESCE(SUM(amount),0) FROM collection_days WHERE date='${dateStr(0)}'`)[0].values[0][0];
    assert.equal(totalCollected, 1000);
  } finally { cleanup(s); }
});

// --- Zakat history reflects per-day amounts from repeat collections ---
test('Zakat history shows correct per-day amounts across repeat collections', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 800, dateStr(0));
    s.collectMoneyForDays(800, '', [dateStr(0)], { [dateStr(0)]: 800 });
    insertTicket(s, c, 200, dateStr(0));
    s.collectMoneyForDays(200, '', [dateStr(0)], { [dateStr(0)]: 200 });
    const hist = s.getZakatHistory();
    assert.equal(hist.length, 2);
    const totalZakat = hist.reduce((sum, r) => sum + r.zakat, 0);
    // 800*0.025=20 + 200*0.025=5 = 25
    assert.equal(Math.round(totalZakat * 100) / 100, 25);
  } finally { cleanup(s); }
});

// --- getCashInHand unchanged (existing financial model integrity) ---
test('getCashInHand: revenue - paid-cash-expenses - collections (existing formula unchanged)', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 1);
    insertTicket(s, c, 1000, today());
    s.addExpense('x', 200); // legacy: paid cash today
    s.collectMoneyForDays(400, '', [today()], { [today()]: 400 });
    // 1000 - 200 - 400 = 400
    assert.equal(s.getCashInHand(), 400);
  } finally { cleanup(s); }
});
