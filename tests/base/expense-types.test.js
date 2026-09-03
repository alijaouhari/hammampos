'use strict';
// Regression tests for reusable/custom expense types (v2.8.14).
// Reuses the existing ExpenseTemplateManager (expense_templates table). Verifies:
// - default types seeded on a fresh DB
// - a newly created type persists and is retrievable (for the dropdown)
// - persistence across DB reopen AND across a second initialize() (the core fix:
//   createDefaultTemplates must NOT wipe existing types anymore)
// - deactivate hides from the active list but keeps the type and never touches
//   historical expense records
// - existing expense records and cash-in-hand math are unaffected
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll, StorageManager, ExpenseTemplateManager } = require('./helpers');

after(() => cleanupAll());

async function newStorageWithTemplates() {
  const s = await newStorage();
  const et = new ExpenseTemplateManager(s);
  et.initialize();
  return { s, et };
}

test('fresh DB seeds the 3 default expense types', async () => {
  const { s, et } = await newStorageWithTemplates();
  try {
    const types = et.getTemplates(false);
    assert.equal(types.length, 3);
    const names = types.map(t => t.name);
    assert.ok(names.includes('أجر الفرناتشي'));
  } finally { cleanup(s); }
});

test('a newly created expense type is persisted and retrievable (active list for dropdown)', async () => {
  const { s, et } = await newStorageWithTemplates();
  try {
    const id = et.addTemplate('صيانة', 'عام', null, null, null, '');
    assert.equal(typeof id, 'number');
    const active = et.getTemplates(true); // what the dropdown loads
    assert.ok(active.some(t => t.name === 'صيانة'), 'new type appears in active list');
    assert.equal(active.length, 4); // 3 defaults + 1 new
  } finally { cleanup(s); }
});

test('CORE FIX: owner-created type survives a second initialize() (no delete-all-reseed)', async () => {
  const { s, et } = await newStorageWithTemplates();
  try {
    et.addTemplate('نوع مخصص', 'عام', null, null, null, '');
    assert.equal(et.getTemplates(false).length, 4);
    // Re-run initialize() (simulates the app being reopened / re-init path).
    et.initialize();
    const after = et.getTemplates(false);
    assert.equal(after.length, 4, 'types not wiped by re-initialize');
    assert.ok(after.some(t => t.name === 'نوع مخصص'), 'owner type still present');
  } finally { cleanup(s); }
});

test('expense types persist across a full DB reopen + re-init', async () => {
  const { s, et } = await newStorageWithTemplates();
  const dbPath = s.dbPath;
  try {
    et.addTemplate('كهرباء إضافية', 'عام', null, null, null, '');
  } finally { cleanup(s); }

  const s2 = new StorageManager(dbPath);
  s2.dbPath = dbPath;
  await s2.initialize();
  const et2 = new ExpenseTemplateManager(s2);
  et2.initialize(); // must NOT wipe
  try {
    const types = et2.getTemplates(false);
    assert.ok(types.some(t => t.name === 'كهرباء إضافية'), 'custom type persisted across reopen');
    assert.equal(types.length, 4);
  } finally { cleanup(s2); }
});

test('deactivate hides a type from the active (dropdown) list but keeps it', async () => {
  const { s, et } = await newStorageWithTemplates();
  try {
    const id = et.addTemplate('نوع مؤقت', 'عام', null, null, null, '');
    et.toggleTemplate(id, false);
    assert.ok(!et.getTemplates(true).some(t => t.name === 'نوع مؤقت'), 'hidden from active list');
    assert.ok(et.getTemplates(false).some(t => t.name === 'نوع مؤقت'), 'still exists in full list');
    // reactivate
    et.toggleTemplate(id, true);
    assert.ok(et.getTemplates(true).some(t => t.name === 'نوع مؤقت'), 'reactivated');
  } finally { cleanup(s); }
});

test('deactivating a type does NOT alter historical expense records', async () => {
  const { s, et } = await newStorageWithTemplates();
  try {
    // Create an expense using a template, then deactivate that template.
    const id = et.addTemplate('إصلاح', 'عام', 100, null, null, '');
    const expId = et.createExpenseFromTemplate(id, 1, 100, '');
    const today = new Date().toISOString().split('T')[0];
    const before = s.getExpensesForDate(today);
    assert.equal(before.length, 1);
    const beforeDesc = before[0].description;

    et.toggleTemplate(id, false); // deactivate the type

    const afterList = s.getExpensesForDate(today);
    assert.equal(afterList.length, 1, 'expense record still present');
    assert.equal(afterList[0].description, beforeDesc, 'expense description unchanged');
  } finally { cleanup(s); }
});

test('cash-in-hand math is unaffected by expense-type management', async () => {
  const { s, et } = await newStorageWithTemplates();
  try {
    const c = s.addCategory('رجال', 100);
    s.createTicket(c);                 // +100
    et.addTemplate('نوع بلا أثر مالي', 'عام', null, null, null, ''); // creating a TYPE must not move money
    et.toggleTemplate(et.getTemplates(false)[0].id, false);          // toggling must not move money
    assert.equal(s.getCashInHand(), 100, 'managing types does not change cash-in-hand');
    // creating an actual expense from a fixed-amount template DOES reduce cash-in-hand
    const id = et.addTemplate('مصروف ثابت', 'عام', 30, null, null, '');
    et.createExpenseFromTemplate(id, 1, 30, '');
    assert.equal(s.getCashInHand(), 70); // 100 - 30
  } finally { cleanup(s); }
});
