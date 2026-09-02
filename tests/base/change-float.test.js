'use strict';
// Dedicated regression coverage for Item #2 — Change Money / Teller Float.
// The feature already exists in StorageManager (addFloat/takeFloat/getFloatBalance/
// getFloatHistory + change_float table). These tests lock in the required behavior
// A–J from the task and confirm financial separation (G–I) and persistence (J).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, StorageManager } = require('./helpers');

after(() => cleanupAll());

test('A: fresh change-float balance = 0', async () => {
  const s = await newStorage();
  try {
    assert.equal(s.getFloatBalance(), 0);
    assert.deepEqual(s.getFloatHistory(), []);
  } finally { cleanup(s); }
});

test('B–D: ADD 1000 -> 1000, ADD 500 -> 1500, TAKE 500 -> 1000', async () => {
  const s = await newStorage();
  try {
    assert.equal(s.addFloat(1000).balance, 1000);
    assert.equal(s.getFloatBalance(), 1000);
    assert.equal(s.addFloat(500).balance, 1500);
    assert.equal(s.getFloatBalance(), 1500);
    assert.equal(s.takeFloat(500).balance, 1000);
    assert.equal(s.getFloatBalance(), 1000);
  } finally { cleanup(s); }
});

test('E: operation history contains all three ops in correct order with correct amounts/types', async () => {
  const s = await newStorage();
  try {
    s.addFloat(1000);
    s.addFloat(500);
    s.takeFloat(500);
    const hist = s.getFloatHistory(); // newest first (ORDER BY timestamp DESC, id DESC)
    assert.equal(hist.length, 3);
    // newest -> oldest
    assert.equal(hist[0].operation, 'take');
    assert.equal(hist[0].amount, 500);
    assert.equal(hist[0].balance_after, 1000);
    assert.equal(hist[1].operation, 'add');
    assert.equal(hist[1].amount, 500);
    assert.equal(hist[1].balance_after, 1500);
    assert.equal(hist[2].operation, 'add');
    assert.equal(hist[2].amount, 1000);
    assert.equal(hist[2].balance_after, 1000);
  } finally { cleanup(s); }
});

test('F: TAKE greater than balance is rejected and does not modify balance or add a transaction', async () => {
  const s = await newStorage();
  try {
    s.addFloat(1000);
    const res = s.takeFloat(1500);
    assert.equal(res.success, false);
    assert.ok(res.error && res.error.length > 0);
    assert.equal(s.getFloatBalance(), 1000);        // unchanged
    assert.equal(s.getFloatHistory().length, 1);    // only the add recorded
  } finally { cleanup(s); }
});

test('G: change-float operations do not alter ticket revenue', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 15);
    s.createTicket(c);
    const revBefore = s.getLifetimeRevenue();
    s.addFloat(1000);
    s.takeFloat(200);
    assert.equal(s.getLifetimeRevenue(), revBefore); // revenue unchanged
  } finally { cleanup(s); }
});

test('H: change-float operations do not create expenses', async () => {
  const s = await newStorage();
  try {
    const today = new Date().toISOString().split('T')[0];
    s.addFloat(1000);
    s.takeFloat(200);
    assert.equal(s.getExpenses(today).length, 0);
    assert.equal(s.getExpensesForDate(today).length, 0);
  } finally { cleanup(s); }
});

test('I: change-float operations do not alter collections', async () => {
  const s = await newStorage();
  try {
    const today = new Date().toISOString().split('T')[0];
    s.addFloat(1000);
    s.takeFloat(200);
    assert.equal(s.getCollections(today).length, 0);
  } finally { cleanup(s); }
});

test('J: change-float balance and history survive database reload', async () => {
  const s = await newStorage();
  const dbPath = s.dbPath;
  try {
    s.addFloat(1000);
    s.addFloat(500);
    s.takeFloat(500); // balance 1000
    assert.equal(s.getFloatBalance(), 1000);
  } finally { cleanup(s); }

  // Reopen the SAME db file (simulates application restart).
  const s2 = new StorageManager(dbPath);
  s2.dbPath = dbPath;
  await s2.initialize();
  try {
    assert.equal(s2.getFloatBalance(), 1000);        // persisted
    assert.equal(s2.getFloatHistory().length, 3);    // history persisted
  } finally { cleanup(s2); }
});
