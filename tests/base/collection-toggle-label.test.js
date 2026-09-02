'use strict';
// Regression tests for the single select-all/clear TOGGLE label logic (Change 1).
// The renderer computes the button label from whether ALL currently available days
// are selected:  label = areAllDaysSelected() ? 'إلغاء التحديد' : 'تحديد الكل'.
// The DOM wiring lives in hammampos.html and cannot be imported without Electron, so
// (per task rules — no unnecessary refactor) we replicate the exact pure logic and
// assert the label transitions and the toggle action for all selection states.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const LABEL_ALL = 'تحديد الكل';
const LABEL_CLEAR = 'إلغاء التحديد';

function makeToggleModel(days) {
  const selected = new Set();
  const areAllSelected = () => days.length > 0 && days.every(d => selected.has(d.date));
  return {
    setDay(date, isChecked) { if (isChecked) selected.add(date); else selected.delete(date); },
    selectAll() { for (const d of days) selected.add(d.date); },
    clearAll() { selected.clear(); },
    // Mirrors toggleSelectAllDays(): all selected -> clear, else -> select all.
    toggle() { if (areAllSelected()) this.clearAll(); else this.selectAll(); },
    label() { return areAllSelected() ? LABEL_CLEAR : LABEL_ALL; },
    count() { return selected.size; },
    allSelected() { return areAllSelected(); },
  };
}

const DAYS = [
  { date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-03' },
];

test('empty selection shows "تحديد الكل"', () => {
  const m = makeToggleModel(DAYS);
  assert.equal(m.label(), LABEL_ALL);
});

test('partial selection still shows "تحديد الكل"', () => {
  const m = makeToggleModel(DAYS);
  m.setDay('2026-09-01', true);
  assert.equal(m.allSelected(), false);
  assert.equal(m.label(), LABEL_ALL);
});

test('all selected shows "إلغاء التحديد"', () => {
  const m = makeToggleModel(DAYS);
  m.selectAll();
  assert.equal(m.allSelected(), true);
  assert.equal(m.label(), LABEL_CLEAR);
});

test('toggle from empty selects all and flips label to clear', () => {
  const m = makeToggleModel(DAYS);
  assert.equal(m.label(), LABEL_ALL);
  m.toggle();
  assert.equal(m.count(), 3);
  assert.equal(m.label(), LABEL_CLEAR);
});

test('toggle when all selected clears and flips label back', () => {
  const m = makeToggleModel(DAYS);
  m.selectAll();
  assert.equal(m.label(), LABEL_CLEAR);
  m.toggle();
  assert.equal(m.count(), 0);
  assert.equal(m.label(), LABEL_ALL);
});

test('manual uncheck of one day after select-all flips label back to "تحديد الكل"', () => {
  const m = makeToggleModel(DAYS);
  m.selectAll();
  assert.equal(m.label(), LABEL_CLEAR);
  m.setDay('2026-09-02', false); // manual uncheck
  assert.equal(m.allSelected(), false);
  assert.equal(m.label(), LABEL_ALL);
});

test('manually checking the last remaining day flips label to "إلغاء التحديد"', () => {
  const m = makeToggleModel(DAYS);
  m.setDay('2026-09-01', true);
  m.setDay('2026-09-02', true);
  assert.equal(m.label(), LABEL_ALL); // not all yet
  m.setDay('2026-09-03', true);       // now all selected
  assert.equal(m.label(), LABEL_CLEAR);
});

test('no available days -> label stays "تحديد الكل" (areAllSelected false when empty list)', () => {
  const m = makeToggleModel([]);
  assert.equal(m.allSelected(), false);
  assert.equal(m.label(), LABEL_ALL);
});
