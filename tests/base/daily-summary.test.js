'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll } = require('./helpers');

after(() => cleanupAll());

// getDailySummariesWithDetails returns, per calendar day (newest first):
//   { date, <categoryName>: count, ..., total_tickets, revenue, expenses, day_status }
// Dynamic category columns are built from ACTIVE categories. P1-1 hardened the
// apostrophe-in-category-name path (identifier safely quoted, CASE value bound).

test('daily summary: per-category counts, totals, and apostrophe category name', async () => {
  const s = await newStorage();
  try {
    const men = s.addCategory('رجال', 15);
    const obrien = s.addCategory("O'Brien", 20); // quote-containing name (P1-1 regression)
    s.addCategory('نساء', 10);                    // zero-ticket category

    s.createTicket(men);     // رجال: 1  (+15)
    s.createTicket(men);     // رجال: 2  (+15)
    s.createTicket(obrien);  // O'Brien: 1 (+20)
    s.addExpense('صابون', 5); // expenses: 5

    const today = new Date().toISOString().split('T')[0];
    const rows = s.getDailySummariesWithDetails(30);
    const row = rows.find(r => r.date === today);
    assert.ok(row, 'today row present');

    assert.equal(row['رجال'], 2);
    assert.equal(row["O'Brien"], 1); // identifier safely quoted, no SQL breakage
    assert.equal(row['نساء'], 0);    // zero-ticket category counts as 0
    assert.equal(row.total_tickets, 3);
    assert.equal(row.revenue, 50);   // 15 + 15 + 20
    assert.equal(row.expenses, 5);
    assert.equal(row.day_status, 'working'); // default day status
  } finally { cleanup(s); }
});

test('daily summary row shape has expected keys', async () => {
  const s = await newStorage();
  try {
    s.addCategory('رجال', 15);
    const today = new Date().toISOString().split('T')[0];
    const rows = s.getDailySummariesWithDetails(5);
    const row = rows.find(r => r.date === today) || rows[0];
    for (const key of ['date', 'total_tickets', 'revenue', 'expenses', 'day_status']) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, key), `row has ${key}`);
    }
  } finally { cleanup(s); }
});

test('date filtering: getTicketsForDate / getExpensesForDate isolate by date', async () => {
  const s = await newStorage();
  try {
    const men = s.addCategory('رجال', 15);
    s.createTicket(men);
    s.addExpense('ماء', 7);

    const today = new Date().toISOString().split('T')[0];
    const other = '2000-01-01';

    assert.equal(s.getTicketsForDate(today).length, 1);
    assert.equal(s.getTicketsForDate(other).length, 0);
    assert.equal(s.getExpensesForDate(today).length, 1);
    assert.equal(s.getExpensesForDate(other).length, 0);
  } finally { cleanup(s); }
});

test('day status can be set and is reflected in the summary', async () => {
  const s = await newStorage();
  try {
    s.addCategory('رجال', 15);
    const today = new Date().toISOString().split('T')[0];
    s.setDayStatus(today, 'holiday');
    assert.equal(s.getDayStatus(today), 'holiday');
    const row = s.getDailySummariesWithDetails(5).find(r => r.date === today);
    assert.equal(row.day_status, 'holiday');
  } finally { cleanup(s); }
});
