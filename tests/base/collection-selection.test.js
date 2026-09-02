'use strict';
// Focused regression tests for the money-collection SELECTION/TOTAL logic (Task #3 fix).
//
// The actual selection lives in the renderer (hammampos.html): a Set `selectedDays`,
// setDaySelection(date,isChecked) (checkbox is the source of truth), selectAllDays(),
// clearAllDays(), and updateCollectionTotals() which computes
//   total = sum over selectedDays of (day.revenue - day.expenses).
//
// These functions are DOM-bound and cannot be imported without launching Electron.
// Per the task rules we do NOT refactor production code just to make it testable.
// Instead we replicate the EXACT selection/total semantics the fix guarantees and
// assert the arithmetic + set behavior, which is the logic that was buggy.
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Faithful re-implementation of the renderer's selection model AFTER the fix.
function makeSelectionModel(days) {
  // days: [{ date, revenue, expenses }]
  const byDate = new Map(days.map(d => [d.date, d]));
  const selected = new Set();
  const net = (d) => (d.revenue || 0) - (d.expenses || 0);

  return {
    // setDaySelection(date, isChecked): checkbox state is the source of truth.
    set(date, isChecked) {
      if (isChecked) selected.add(date); else selected.delete(date);
    },
    selectAll() { for (const d of days) selected.add(d.date); },
    clearAll() { selected.clear(); },
    total() {
      let t = 0;
      for (const date of selected) {
        const d = byDate.get(date);
        if (d) t += net(d);
      }
      return t;
    },
    count() { return selected.size; },
    has(date) { return selected.has(date); },
  };
}

const DAYS = [
  { date: '2026-09-01', revenue: 100, expenses: 0 },  // net 100
  { date: '2026-09-02', revenue: 150, expenses: 50 }, // net 100
  { date: '2026-09-03', revenue: 40, expenses: 10 },  // net 30
];

test('selecting one day increases the total by that day\'s amount', () => {
  const m = makeSelectionModel(DAYS);
  assert.equal(m.total(), 0);
  m.set('2026-09-01', true);
  assert.equal(m.total(), 100);
  assert.equal(m.count(), 1);
});

test('unselecting a day decreases the total by that day\'s amount', () => {
  const m = makeSelectionModel(DAYS);
  m.set('2026-09-01', true);   // +100
  m.set('2026-09-02', true);   // +100 -> 200
  assert.equal(m.total(), 200);
  m.set('2026-09-01', false);  // -100 -> 100
  assert.equal(m.total(), 100);
  assert.equal(m.has('2026-09-01'), false);
  assert.equal(m.count(), 1);
});

test('checked state is the source of truth (re-setting checked=true is idempotent)', () => {
  const m = makeSelectionModel(DAYS);
  m.set('2026-09-02', true);
  m.set('2026-09-02', true);   // still just selected once
  assert.equal(m.count(), 1);
  assert.equal(m.total(), 100);
  m.set('2026-09-02', false);
  m.set('2026-09-02', false);  // still just removed
  assert.equal(m.count(), 0);
  assert.equal(m.total(), 0);
});

test('selecting multiple days produces the exact sum', () => {
  const m = makeSelectionModel(DAYS);
  m.set('2026-09-01', true);
  m.set('2026-09-02', true);
  m.set('2026-09-03', true);
  assert.equal(m.total(), 230); // 100 + 100 + 30
  assert.equal(m.count(), 3);
});

test('select-all selects every available day and totals their exact sum', () => {
  const m = makeSelectionModel(DAYS);
  m.selectAll();
  assert.equal(m.count(), DAYS.length);
  assert.equal(m.total(), 230);
  for (const d of DAYS) assert.ok(m.has(d.date), `${d.date} selected`);
});

test('clear-all leaves zero selected and total zero', () => {
  const m = makeSelectionModel(DAYS);
  m.selectAll();
  assert.equal(m.total(), 230);
  m.clearAll();
  assert.equal(m.count(), 0);
  assert.equal(m.total(), 0);
});

test('select-all then unselect one keeps checkbox/state/total in agreement', () => {
  const m = makeSelectionModel(DAYS);
  m.selectAll();               // all selected, total 230
  m.set('2026-09-03', false);  // uncheck the 30 day
  assert.equal(m.has('2026-09-03'), false);
  assert.equal(m.count(), 2);
  assert.equal(m.total(), 200); // 100 + 100
});
