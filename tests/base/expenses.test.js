'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll, ExpenseTemplateManager } = require('./helpers');

after(() => cleanupAll());

test('creating an expense stores it and reduces cash-in-hand', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 100);
    s.createTicket(c); // +100
    const id = s.addExpense('كهرباء', 40);
    assert.equal(typeof id, 'number');
    assert.equal(s.getCashInHand(), 60);
    const today = new Date().toISOString().split('T')[0];
    const list = s.getExpensesForDate(today);
    assert.equal(list.length, 1);
    assert.equal(list[0].amount, 40);
    assert.equal(list[0].description, 'كهرباء');
  } finally { cleanup(s); }
});

test('expense templates: default templates created and createExpenseFromTemplate works', async () => {
  const s = await newStorage();
  try {
    const et = new ExpenseTemplateManager(s);
    et.initialize();
    const templates = et.getTemplates(false);
    assert.equal(templates.length, 3); // createDefaultTemplates seeds exactly 3

    const before = s.getCashInHand();
    const exId = et.createExpenseFromTemplate(templates[0].id, 1, 25, 'ملاحظة');
    assert.equal(typeof exId, 'number');
    // template expense flows through storage.addExpense -> affects cash-in-hand
    assert.equal(s.getCashInHand(), before - 25);
  } finally { cleanup(s); }
});

test('wood purchase creates a linked expense and affects cash-in-hand', async () => {
  const s = await newStorage();
  try {
    const et = new ExpenseTemplateManager(s);
    et.initialize();
    // net = gross - empty = 1000 - 200 = 800 kg; total = 800 * 2 = 1600
    const before = s.getCashInHand();
    const result = et.addWoodPurchase('المورد', 1000, 200, 2, '2026-06-20', 'حمولة');
    assert.equal(result.netWeight, 800);
    assert.equal(result.totalAmount, 1600);
    assert.equal(typeof result.expenseId, 'number');
    // the created expense reduces cash-in-hand by the total amount
    assert.equal(s.getCashInHand(), before - 1600);

    const purchases = et.getWoodPurchases(10);
    assert.equal(purchases.length, 1);
    assert.equal(purchases[0].net_wood_weight, 800);
    assert.equal(purchases[0].total_amount, 1600);
  } finally { cleanup(s); }
});

test('deleting an expense restores cash-in-hand', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 50);
    s.createTicket(c); // +50
    const id = s.addExpense('اختبار', 20); // -20 -> 30
    assert.equal(s.getCashInHand(), 30);
    s.deleteExpense(id);
    assert.equal(s.getCashInHand(), 50);
  } finally { cleanup(s); }
});
