'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll } = require('./helpers');

after(() => cleanupAll());

// Cash-in-hand formula (from StorageManager.getCashInHand):
//   SUM(tickets.price) - SUM(expenses.amount) - SUM(collections.amount)
// Change float is deliberately EXCLUDED.

test('cash-in-hand is 0 on a fresh database', async () => {
  const s = await newStorage();
  try {
    assert.equal(s.getCashInHand(), 0);
    assert.equal(s.getLifetimeRevenue(), 0);
  } finally { cleanup(s); }
});

test('cash-in-hand = tickets - expenses - collections (15 + 20 - 30 = 5)', async () => {
  const s = await newStorage();
  try {
    const men = s.addCategory('رجال', 15);
    const women = s.addCategory('نساء', 20);
    s.createTicket(men);    // +15
    s.createTicket(women);  // +20
    s.addExpense('ماء وكهرباء', 30); // -30
    assert.equal(s.getCashInHand(), 5);
    assert.equal(s.getLifetimeRevenue(), 35);
  } finally { cleanup(s); }
});

test('collections reduce cash-in-hand', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 50);
    s.createTicket(c);      // +50
    s.collectMoney(20, 'تحصيل'); // -20
    assert.equal(s.getCashInHand(), 30);
  } finally { cleanup(s); }
});

test('change float does NOT affect cash-in-hand', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 15);
    s.createTicket(c);          // cash-in-hand +15
    const before = s.getCashInHand();
    assert.equal(before, 15);

    const add = s.addFloat(100, 'صرف');
    assert.equal(add.success, true);
    assert.equal(s.getFloatBalance(), 100);
    // cash-in-hand unchanged by float add
    assert.equal(s.getCashInHand(), 15);

    const take = s.takeFloat(30, 'استرجاع');
    assert.equal(take.success, true);
    assert.equal(s.getFloatBalance(), 70);
    // cash-in-hand still unchanged by float take
    assert.equal(s.getCashInHand(), 15);
  } finally { cleanup(s); }
});

test('change float rejects invalid and over-balance operations', async () => {
  const s = await newStorage();
  try {
    assert.equal(s.getFloatBalance(), 0);
    assert.equal(s.addFloat(0).success, false);       // zero rejected
    assert.equal(s.addFloat(-5).success, false);      // negative rejected
    assert.equal(s.takeFloat(10).success, false);     // take beyond balance rejected
    assert.equal(s.getFloatBalance(), 0);             // nothing written

    assert.equal(s.addFloat(50).success, true);
    assert.equal(s.takeFloat(60).success, false);     // over-balance rejected
    assert.equal(s.getFloatBalance(), 50);            // balance preserved

    const hist = s.getFloatHistory();
    // only the successful add(50) should be recorded
    assert.equal(hist.length, 1);
    assert.equal(hist[0].operation, 'add');
    assert.equal(hist[0].amount, 50);
    assert.equal(hist[0].balance_after, 50);
  } finally { cleanup(s); }
});
