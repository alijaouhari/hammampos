'use strict';
/**
 * Regression tests for the v2.8.20 bug-fix batch (root causes only):
 *  - Bug 4: getDailySummariesWithDetails must include data dated AFTER the machine
 *    clock's "today" (the window was capping at today and blanking the ledger).
 *  - Money collection: every uncollected day in the window must be represented,
 *    including zero-sales / holiday / repair days (previously silently filtered);
 *    collectible days (net > 0) drive the total; collected days leave availability.
 *  - Bug 5: the money numeric token places the minus sign on the LEFT (-50), and
 *    the labeled form reads "درهم <number>".
 *
 * The formatMoney/ltrNum helpers live in the renderer (hammampos.html) and cannot
 * be required headlessly, so the numeric-token behavior is verified against a
 * mirror of the exact helper logic (kept in sync).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll, StorageManager } = require('./helpers');

after(() => cleanupAll());

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// Insert a ticket directly with an explicit date, filling all NOT NULL columns the
// tickets table requires (category_name, price, date, time, serial_number, year...).
function seedTicket(s, categoryId, categoryName, price, date) {
  const d = new Date(date + 'T12:00:00');
  const cols = s.db.exec('PRAGMA table_info(tickets)')[0].values.map(r => r[1]);
  const row = {
    category_id: categoryId,
    category_name: categoryName,
    price: price,
    date: date,
    time: '10:00:00',
    serial_number: Math.floor(Math.random() * 1e9),
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    timestamp: date + ' 10:00:00'
  };
  const useCols = cols.filter(c => c !== 'id' && row[c] !== undefined);
  const placeholders = useCols.map(() => '?').join(', ');
  s.db.run(`INSERT INTO tickets (${useCols.join(', ')}) VALUES (${placeholders})`,
    useCols.map(c => row[c]));
  s.save();
}

// Bug 4: future-dated data must still appear in the summaries window.
test('bug4: sales dated after machine today still appear in the ledger window', async () => {
  const s = await newStorage();
  try {
    const cat = s.addCategory('رجال', 50);
    const future = daysFromNow(3); // 3 days after the machine clock
    seedTicket(s, cat, 'رجال', 50, future);

    const sums = s.getDailySummariesWithDetails(60);
    const dates = sums.map(x => x.date);
    assert.ok(dates.includes(future), 'future-dated day is present in the window');
    const futureRow = sums.find(x => x.date === future);
    assert.equal(futureRow.revenue, 50); // sales value preserved
  } finally { cleanup(s); }
});

// Bug 4: dates are chronological (newest first) and contiguous down to earliest data.
test('bug4: summary dates are chronological (descending) with no gaps to today', async () => {
  const s = await newStorage();
  try {
    const cat = s.addCategory('رجال', 50);
    s.createTicket(cat); // today
    const sums = s.getDailySummariesWithDetails(10);
    const dates = sums.map(x => x.date);
    // Descending order.
    const sorted = [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    assert.deepEqual(dates, sorted);
    // Contiguous (each day exactly one before the previous).
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1] + 'T12:00:00');
      const cur = new Date(dates[i] + 'T12:00:00');
      assert.equal((prev - cur) / 86400000, 1, 'no gap between consecutive days');
    }
  } finally { cleanup(s); }
});

// Money-collection coverage: zero-sales / holiday days must be represented in the
// window (renderer no longer filters them out). Mirror the NEW predicate here:
//   available (shown) = NOT already collected  (any net)
//   collectible       = net > 0
test('collection: zero-sales and holiday days are represented (not dropped)', async () => {
  const s = await newStorage();
  try {
    const cat = s.addCategory('رجال', 100);
    s.createTicket(cat); // today: revenue 100 (collectible)
    const today = new Date().toISOString().split('T')[0];
    // Seed a ticket several days in the PAST so the window spans multiple days,
    // guaranteeing zero-net days exist between the past day and today.
    seedTicket(s, cat, 'رجال', 100, daysFromNow(-5));

    const summaries = s.getDailySummariesWithDetails(30);
    const collected = new Set(s.getCollectedDays());
    // NEW availability: all uncollected days shown.
    const shown = summaries.filter(d => !collected.has(d.date)).map(d => d.date);
    // There is at least one zero-sales day in the window besides today.
    const zeroDays = summaries.filter(d => ((d.revenue || 0) - (d.expenses || 0)) === 0);
    assert.ok(zeroDays.length > 0, 'window contains zero-net days');
    assert.ok(zeroDays.every(z => shown.includes(z.date)), 'zero-net days are shown');
    assert.ok(shown.includes(today), 'collectible day shown too');
  } finally { cleanup(s); }
});

// Money-collection total == sum of selected collectible days; collected day leaves list.
test('collection: total equals sum of selected days and collected day is removed', async () => {
  const s = await newStorage();
  try {
    const cat = s.addCategory('رجال', 100);
    s.createTicket(cat);
    const today = new Date().toISOString().split('T')[0];

    // Collectible = net > 0.
    const collectible = (arr) => arr.filter(d => ((d.revenue || 0) - (d.expenses || 0)) > 0);
    let summaries = s.getDailySummariesWithDetails(30);
    let avail = collectible(summaries.filter(d => !new Set(s.getCollectedDays()).has(d.date)));
    assert.ok(avail.some(d => d.date === today));

    // The "displayed total" for selecting all collectible days equals the sum of
    // their nets.
    const total = avail.reduce((sum, d) => sum + ((d.revenue || 0) - (d.expenses || 0)), 0);
    assert.equal(total, 100);

    // Collect today; it must leave the available list.
    s.collectMoneyForDays(total, 'test', avail.map(d => d.date));
    summaries = s.getDailySummariesWithDetails(30);
    const collectedSet = new Set(s.getCollectedDays());
    const availAfter = collectible(summaries.filter(d => !collectedSet.has(d.date)));
    assert.ok(!availAfter.some(d => d.date === today), 'collected day removed from availability');
    assert.ok(collectedSet.has(today), 'collected day recorded');
  } finally { cleanup(s); }
});

// ── Bug 5: money numeric token (mirror of renderer helpers) ──────────────────
function moneyNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return (Math.round(num * 100) / 100).toString();
}
function formatMoneyText(n) { return `درهم ${moneyNumber(n)}`; }

test('bug5: money label is "درهم <number>" and negatives keep the minus on the left', () => {
  assert.equal(formatMoneyText(50), 'درهم 50');
  assert.equal(formatMoneyText(0), 'درهم 0');
  assert.equal(formatMoneyText(-50), 'درهم -50');
  assert.equal(formatMoneyText(-6517), 'درهم -6517');
  assert.equal(moneyNumber(-50).charAt(0), '-');   // sign on the left of digits
  assert.equal(moneyNumber(12.5), '12.5');          // decimals preserved
});
