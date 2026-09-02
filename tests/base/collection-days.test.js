'use strict';
// Regression coverage for money-collection day tracking (Task #3 authorized work).
// Verifies collection_days persistence, exclusion of collected days from availability,
// per-collection day retention, atomicity, and persistence across DB reopen.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, StorageManager } = require('./helpers');

after(() => cleanupAll());

// Mirror of the renderer's availability predicate (loadUncollectedDays):
//   available = netAmount > 0 AND not already collected
function availableDays(storage) {
  const summaries = storage.getDailySummariesWithDetails(60);
  const collected = new Set(storage.getCollectedDays());
  return summaries
    .filter(d => ((d.revenue || 0) - (d.expenses || 0)) > 0 && !collected.has(d.date))
    .map(d => d.date);
}

test('1: fresh database has no collected days', async () => {
  const s = await newStorage();
  try {
    assert.deepEqual(s.getCollectedDays(), []);
  } finally { cleanup(s); }
});

test('2-4: collect a day -> collection exists, day recorded, day no longer available', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 100);
    s.createTicket(c); // today has revenue 100
    const today = new Date().toISOString().split('T')[0];

    assert.ok(availableDays(s).includes(today), 'today available before collection');

    const res = s.collectMoneyForDays(100, 'test', [today]);
    assert.equal(typeof res.id, 'number');
    assert.deepEqual(res.days, [today]);

    // collection exists
    assert.equal(s.getCollections().length, 1);
    // day recorded against that collection
    assert.deepEqual(s.getCollectionDays(res.id), [today]);
    // day no longer available
    assert.ok(!availableDays(s).includes(today), 'today excluded after collection');
    // cash-in-hand reduced by the collected amount (100 revenue - 100 collection = 0)
    assert.equal(s.getCashInHand(), 0);
  } finally { cleanup(s); }
});

// Helper: a 'YYYY-MM-DD' date N days before today (kept within the summary window
// used by getDailySummariesWithDetails, which spans earliest-data..today capped by limit).
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
// Seed a ticket on a specific date via direct SQL (createTicket is today-only).
function seedTicket(s, catId, name, price, date) {
  s.db.run('INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time) VALUES (?,?,?,?,?,?,?)',
    [1, Number(date.slice(0, 4)), catId, name, price, date, '10:00:00']);
  s.save();
}

test('8-10: collect multiple days in one collection -> all recorded and all excluded', async () => {
  const s = await newStorage();
  try {
    const cat = s.addCategory('رجال', 50);
    const d1 = daysAgo(1), d2 = daysAgo(2), d3 = daysAgo(3);
    for (const d of [d1, d2, d3]) seedTicket(s, cat, 'رجال', 50, d);

    const avail = availableDays(s);
    assert.ok(avail.includes(d1) && avail.includes(d2) && avail.includes(d3), 'three days available');

    const res = s.collectMoneyForDays(100, 'multi', [d1, d2]); // collect only d1,d2
    assert.deepEqual(res.days.sort(), [d1, d2].sort());
    assert.deepEqual(s.getCollectionDays(res.id).sort(), [d1, d2].sort());

    const after = availableDays(s);
    assert.ok(!after.includes(d1) && !after.includes(d2), 'collected days excluded');
    assert.ok(after.includes(d3), 'uncollected day still available');
  } finally { cleanup(s); }
});

test('5-7: separate collections each retain only their own days', async () => {
  const s = await newStorage();
  try {
    const cat = s.addCategory('رجال', 40);
    const dA = daysAgo(4), dB = daysAgo(5);
    for (const d of [dA, dB]) seedTicket(s, cat, 'رجال', 40, d);

    const rA = s.collectMoneyForDays(40, 'A', [dA]);
    const rB = s.collectMoneyForDays(40, 'B', [dB]);

    assert.deepEqual(s.getCollectionDays(rA.id), [dA]);
    assert.deepEqual(s.getCollectionDays(rB.id), [dB]);

    const avail = availableDays(s);
    assert.ok(!avail.includes(dA) && !avail.includes(dB), 'both collected days excluded');
  } finally { cleanup(s); }
});

test('11: re-collecting an already-collected day keeps it excluded (no re-availability)', async () => {
  const s = await newStorage();
  try {
    const cat = s.addCategory('رجال', 30);
    const d = daysAgo(6);
    seedTicket(s, cat, 'رجال', 30, d);

    s.collectMoneyForDays(30, 'first', [d]);
    assert.ok(!availableDays(s).includes(d), 'day excluded after first collection');
    // Even if another collection references the same day, it stays excluded (never re-available).
    s.collectMoneyForDays(0.01, 'dup', [d]);
    assert.ok(!availableDays(s).includes(d), 'day still excluded');
  } finally { cleanup(s); }
});

test('12: collection-day associations persist across DB reopen', async () => {
  const s = await newStorage();
  const dbPath = s.dbPath;
  let collectionId;
  try {
    const cat = s.addCategory('رجال', 25);
    const d = daysAgo(7);
    seedTicket(s, cat, 'رجال', 25, d);
    const res = s.collectMoneyForDays(25, 'persist', [d]);
    collectionId = res.id;
  } finally { cleanup(s); }

  const persistedDay = daysAgo(7);
  const s2 = new StorageManager(dbPath);
  s2.dbPath = dbPath;
  await s2.initialize();
  try {
    assert.deepEqual(s2.getCollectionDays(collectionId), [persistedDay]);
    assert.ok(s2.getCollectedDays().includes(persistedDay), 'collected day persisted');
  } finally { cleanup(s2); }
});

test('13: cash-in-hand still = tickets - expenses - collections after day-tracked collection', async () => {
  const s = await newStorage();
  try {
    const cat = s.addCategory('رجال', 100);
    s.createTicket(cat);          // +100
    s.addExpense('ماء', 20);      // -20
    const today = new Date().toISOString().split('T')[0];
    s.collectMoneyForDays(30, 'partial', [today]); // -30
    assert.equal(s.getCashInHand(), 50); // 100 - 20 - 30
  } finally { cleanup(s); }
});

test('deleteCollection frees its days again', async () => {
  const s = await newStorage();
  try {
    const cat = s.addCategory('رجال', 60);
    const d = daysAgo(8);
    seedTicket(s, cat, 'رجال', 60, d);
    const res = s.collectMoneyForDays(60, 'x', [d]);
    assert.ok(!availableDays(s).includes(d));
    s.deleteCollection(res.id);
    assert.ok(availableDays(s).includes(d), 'day available again after collection deleted');
    assert.deepEqual(s.getCollectionDays(res.id), []);
  } finally { cleanup(s); }
});
