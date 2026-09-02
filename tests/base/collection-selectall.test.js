'use strict';
// Regression test for the "تحديد الكل" (select-all) bug in the money-collection modal.
//
// Real root cause (v2.8.11): selectAllDays()/setDaySelection() used a DOCUMENT-WIDE
// querySelector('[data-date=...]'). The daily-ledger tables ALSO render rows with
// data-date, and they appear earlier in the DOM, so the global query matched a table
// <tr> (no checkbox) instead of the modal's .day-item, leaving the checkboxes unchecked.
// Fix: scope the lookup to the '#uncollected-days-container'.
//
// The production functions are DOM-bound (hammampos.html) and cannot be imported without
// launching Electron. Per the task we do NOT refactor them just to test. Instead we build
// a minimal fake DOM that reproduces the exact collision, run faithful re-implementations
// of the BUGGY (document-wide) and FIXED (container-scoped) lookups, and assert that only
// the fixed, scoped version checks the modal checkboxes.
const { test } = require('node:test');
const assert = require('node:assert/strict');

// --- Minimal fake DOM ---------------------------------------------------
class FakeEl {
  constructor(tag, attrs = {}) {
    this.tag = tag;
    this.attrs = attrs;            // e.g. { 'data-date': '2026-09-01' }
    this.children = [];
    this.classes = new Set();
    this.checked = false;          // for checkbox inputs
    this.type = attrs.type || null;
  }
  append(child) { this.children.push(child); return child; }
  _descendants() {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  _matches(sel) {
    if (sel === 'input[type="checkbox"]') return this.tag === 'input' && this.type === 'checkbox';
    const m = sel.match(/^\[data-date="(.+)"\]$/);
    if (m) return this.attrs['data-date'] === m[1];
    if (sel === '.day-item') return this.classes.has('day-item');
    return false;
  }
  querySelector(sel) { return this._descendants().find(e => e._matches(sel)) || null; }
  querySelectorAll(sel) { return this._descendants().filter(e => e._matches(sel)); }
}

// Build a document where the ADMIN LEDGER rows (with data-date, no checkbox) come
// BEFORE the collection modal's .day-item rows (with checkboxes) — the real ordering.
function buildDoc(dates) {
  const doc = new FakeEl('document');
  const ledger = doc.append(new FakeEl('tbody', {}));       // daily-ledger table body
  for (const d of dates) ledger.append(new FakeEl('tr', { 'data-date': d })); // NO checkbox

  const container = doc.append(new FakeEl('div', {}));       // #uncollected-days-container
  container._isContainer = true;
  for (const d of dates) {
    const item = new FakeEl('div', { 'data-date': d });
    item.classes.add('day-item');
    const cb = new FakeEl('input', { type: 'checkbox' });
    item.append(cb);
    container.append(item);
  }
  return { doc, container };
}

const DATES = ['2026-09-01', '2026-09-02', '2026-09-03'];

test('BUGGY (document-wide) select-all fails to check modal checkboxes', () => {
  const { doc, container } = buildDoc(DATES);
  const selected = new Set();
  // Reproduce the old buggy selectAllDays: doc.querySelector('[data-date]')
  for (const d of DATES) {
    selected.add(d);
    const el = doc.querySelector(`[data-date="${d}"]`); // matches ledger <tr> first
    const cb = el && el.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = true; // never happens -> ledger row has no checkbox
  }
  const modalChecked = container.querySelectorAll('input[type="checkbox"]').filter(c => c.checked).length;
  assert.equal(selected.size, 3, 'selectedDays populated (why total looked right)');
  assert.equal(modalChecked, 0, 'BUG: no modal checkbox got checked');
});

test('FIXED (container-scoped) select-all checks every modal checkbox', () => {
  const { container } = buildDoc(DATES);
  const selected = new Set();
  // Reproduce the fixed selectAllDays: container.querySelector('[data-date]')
  for (const d of DATES) {
    selected.add(d);
    const el = container.querySelector(`[data-date="${d}"]`); // matches .day-item
    const cb = el && el.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = true;
  }
  const checkboxes = container.querySelectorAll('input[type="checkbox"]');
  assert.equal(selected.size, 3, 'all dates selected');
  assert.equal(checkboxes.filter(c => c.checked).length, 3, 'all modal checkboxes checked');
});

test('FIXED select-all is idempotent', () => {
  const { container } = buildDoc(DATES);
  const selected = new Set();
  const runSelectAll = () => {
    for (const d of DATES) {
      selected.add(d);
      const el = container.querySelector(`[data-date="${d}"]`);
      const cb = el && el.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = true;
    }
  };
  runSelectAll();
  runSelectAll(); // repeat
  assert.equal(selected.size, 3);
  assert.equal(container.querySelectorAll('input[type="checkbox"]').filter(c => c.checked).length, 3);
});

test('FIXED clear-all then select-all works', () => {
  const { container } = buildDoc(DATES);
  const selected = new Set(DATES);
  // clear
  selected.clear();
  container.querySelectorAll('.day-item').forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  });
  assert.equal(selected.size, 0);
  assert.equal(container.querySelectorAll('input[type="checkbox"]').filter(c => c.checked).length, 0);
  // select all
  for (const d of DATES) {
    selected.add(d);
    const el = container.querySelector(`[data-date="${d}"]`);
    const cb = el && el.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = true;
  }
  assert.equal(selected.size, 3);
  assert.equal(container.querySelectorAll('input[type="checkbox"]').filter(c => c.checked).length, 3);
});

test('total equals exact sum of all selected days after select-all', () => {
  const days = [
    { date: '2026-09-01', revenue: 100, expenses: 0 },
    { date: '2026-09-02', revenue: 150, expenses: 50 },
    { date: '2026-09-03', revenue: 40, expenses: 10 },
  ];
  const selected = new Set(days.map(d => d.date)); // after select-all
  let total = 0;
  for (const date of selected) {
    const d = days.find(x => x.date === date);
    if (d) total += (d.revenue || 0) - (d.expenses || 0);
  }
  assert.equal(total, 230); // 100 + 100 + 30
});
