'use strict';
/**
 * Regression tests for the UNIFIED expense-entry merge (v2.8.23 candidate).
 *
 * The UI now has ONE expense-entry form: a single selector holds every saved
 * expense/template plus a "مصروف مخصص" option. Both a saved expense and a custom
 * expense are submitted through the SAME backend path:
 *     ExpenseTemplateManager.getTemplateAmountAndDescription()  (templates only, compute-only)
 *     -> StorageManager.recordExpense({ description, amount, date, paid, paymentSource, paidDate })
 * so expense day / paid / paid_date / payment_source behave identically regardless
 * of which kind was chosen.
 *
 * These tests exercise that shared backend contract (the renderer calls exactly
 * these methods). Mutual exclusivity of "saved expense" vs "custom description" is a
 * UI invariant (one <select> value at a time) and is reflected here by the fact that
 * each submission carries exactly ONE resolved description.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll, ExpenseTemplateManager } = require('./helpers');

after(() => cleanupAll());

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
const today = () => new Date().toISOString().split('T')[0];

async function setup() {
  const s = await newStorage();
  const et = new ExpenseTemplateManager(s);
  et.initialize();
  return { s, et };
}

// Simulates exactly what the unified renderer submitExpense does for a SAVED expense:
// resolve amount+description from the template, then recordExpense with payment fields.
function submitSavedExpense(s, et, templateId, { quantity = 1, customAmount = null, notes = '', date, paid, paymentSource }) {
  const resolved = et.getTemplateAmountAndDescription(templateId, quantity, customAmount, notes);
  assert.equal(resolved.success, true, resolved.error);
  return s.recordExpense({
    description: resolved.description,
    amount: resolved.amount,
    date,
    paid,
    paymentSource: paid ? paymentSource : 'cash',
    paidDate: paid ? today() : null
  });
}

test('resolveTemplate matches legacy createExpenseFromTemplate amount + description (fixed)', async () => {
  const { s, et } = await setup();
  try {
    const id = et.addTemplate('كهرباء', 'عام', 120, null, null, '');
    const resolved = et.getTemplateAmountAndDescription(id, 2, null, 'الطابق');
    // fixed_amount * qty
    assert.equal(resolved.success, true);
    assert.equal(resolved.amount, 240);
    assert.equal(resolved.pricingKind, 'fixed');
    assert.ok(resolved.description.startsWith('كهرباء'));
    // legacy path produces the same amount (creates a row)
    const before = s.getExpensesForDate(today()).length;
    et.createExpenseFromTemplate(id, 2, null, 'الطابق');
    const rows = s.getExpensesForDate(today());
    assert.equal(rows.length, before + 1);
    assert.equal(rows[rows.length - 1].amount, 240);
  } finally { cleanup(s); }
});

test('resolveTemplate handles per-unit and variable templates', async () => {
  const { s, et } = await setup();
  try {
    const perUnit = et.addTemplate('حطب', 'عام', null, 'وحدة', 3, '');
    const r1 = et.getTemplateAmountAndDescription(perUnit, 5, null, '');
    assert.equal(r1.amount, 15); // 3 * 5
    assert.equal(r1.pricingKind, 'per_unit');

    const variable = et.addTemplate('متغير', 'عام', null, null, null, '');
    const rNo = et.getTemplateAmountAndDescription(variable, 1, null, '');
    assert.equal(rNo.success, false); // needs an amount
    const rYes = et.getTemplateAmountAndDescription(variable, 1, 77, '');
    assert.equal(rYes.success, true);
    assert.equal(rYes.amount, 77);
  } finally { cleanup(s); }
});

test('SAVED expense paid from cash — cash drops once, paid via template description', async () => {
  const { s, et } = await setup();
  try {
    const c = s.addCategory('رجال', 1000);
    s.createTicket(c); // +1000
    const id = et.addTemplate('صيانة', 'عام', 200, null, null, '');
    const res = submitSavedExpense(s, et, id, { date: today(), paid: true, paymentSource: 'cash' });
    assert.equal(res.success, true);
    assert.equal(s.getCashInHand(), 800); // -200 once
    const ex = s.getExpense(res.id);
    assert.equal(Number(ex.paid), 1);
    assert.equal(ex.payment_source, 'cash');
    assert.ok(ex.description.startsWith('صيانة'));
  } finally { cleanup(s); }
});

test('SAVED expense unpaid — recorded, no cash movement', async () => {
  const { s, et } = await setup();
  try {
    const c = s.addCategory('رجال', 1000);
    s.createTicket(c);
    const id = et.addTemplate('أجر', 'عام', 300, null, null, '');
    const res = submitSavedExpense(s, et, id, { date: today(), paid: false });
    assert.equal(res.success, true);
    assert.equal(s.getCashInHand(), 1000); // unchanged
    const ex = s.getExpense(res.id);
    assert.equal(Number(ex.paid), 0);
    assert.equal(ex.paid_date, null);
  } finally { cleanup(s); }
});

test('SAVED expense backdated + unpaid, then paid later from cash — expense day preserved, cash once', async () => {
  const { s, et } = await setup();
  try {
    const c = s.addCategory('رجال', 3000);
    s.createTicket(c); // +3000
    const id = et.addTemplate('سباك', 'عام', 1000, null, null, '');
    const past = daysAgo(4);
    const res = submitSavedExpense(s, et, id, { date: past, paid: false });
    assert.equal(s.getCashInHand(), 3000); // no deduction yet
    assert.equal(s.getExpense(res.id).date, past);

    const payDay = today();
    const pay = s.payExpense(res.id, { paidDate: payDay, paymentSource: 'cash' });
    assert.equal(pay.success, true);
    assert.equal(s.getCashInHand(), 2000); // -1000 once
    const ex = s.getExpense(res.id);
    assert.equal(ex.date, past);       // expense day unchanged
    assert.equal(ex.paid_date, payDay);
    assert.equal(ex.payment_source, 'cash');
  } finally { cleanup(s); }
});

test('SAVED expense paid later out of pocket — business cash unchanged', async () => {
  const { s, et } = await setup();
  try {
    const c = s.addCategory('رجال', 3000);
    s.createTicket(c);
    const id = et.addTemplate('سباك', 'عام', 1000, null, null, '');
    const res = submitSavedExpense(s, et, id, { date: daysAgo(2), paid: false });
    const pay = s.payExpense(res.id, { paidDate: today(), paymentSource: 'out_of_pocket' });
    assert.equal(pay.success, true);
    assert.equal(s.getCashInHand(), 3000); // NOT reduced
    assert.equal(s.getExpense(res.id).payment_source, 'out_of_pocket');
  } finally { cleanup(s); }
});

test('CUSTOM expense through the same model behaves identically (paid cash)', async () => {
  const { s } = await setup();
  try {
    const c = s.addCategory('رجال', 500);
    s.createTicket(c); // +500
    // Custom path: description typed directly, recordExpense (no template).
    const res = s.recordExpense({ description: 'مصروف مخصص طارئ', amount: 150, date: today(), paid: true, paymentSource: 'cash' });
    assert.equal(res.success, true);
    assert.equal(s.getCashInHand(), 350); // -150
    const ex = s.getExpense(res.id);
    assert.equal(ex.description, 'مصروف مخصص طارئ');
    assert.equal(Number(ex.paid), 1);
  } finally { cleanup(s); }
});

test('a submission carries exactly one description source (saved OR custom, never both)', async () => {
  const { s, et } = await setup();
  try {
    const id = et.addTemplate('كراء', 'عام', 500, null, null, '');
    // Saved: description is the template's; there is no separate custom text involved.
    const saved = submitSavedExpense(s, et, id, { date: today(), paid: false });
    assert.ok(s.getExpense(saved.id).description.startsWith('كراء'));
    // Custom: description is exactly the typed text; no template id is used.
    const custom = s.recordExpense({ description: 'شيء مخصص', amount: 40, date: today(), paid: false });
    assert.equal(s.getExpense(custom.id).description, 'شيء مخصص');
  } finally { cleanup(s); }
});

test('existing saved-template behavior preserved: legacy createExpenseFromTemplate still deducts cash', async () => {
  const { s, et } = await setup();
  try {
    const c = s.addCategory('رجال', 100);
    s.createTicket(c); // +100
    const id = et.addTemplate('ثابت', 'عام', 30, null, null, '');
    et.createExpenseFromTemplate(id, 1, null, '');
    assert.equal(s.getCashInHand(), 70); // legacy path unchanged
  } finally { cleanup(s); }
});
