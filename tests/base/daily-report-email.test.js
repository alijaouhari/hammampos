'use strict';
/**
 * Daily report + recovery code e-mails: numbers match the money system / dashboard,
 * Arabic and French versions, empty day. Nothing is sent: only data building and HTML rendering.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));
const EmailService = require(path.join(PROJECT_ROOT, 'src', 'services', 'EmailService'));
const SchedulerService = require(path.join(PROJECT_ROOT, 'src', 'services', 'SchedulerService'));
const { buildDailyReport } = require(path.join(PROJECT_ROOT, 'src', 'services', 'DailyReport'));

after(() => cleanupAll());

const stamp = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const L = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0);
const DAY = '2026-11-15';
let serial = 1;

async function setup() {
  const s = await newStorage();
  let t = L(2026, 11, 15, 6);
  const m = new MoneyService(s, { now: () => new Date(t) });
  m.switchOver();
  const c1 = s.addCategory('رجال', 35, 'Hommes');
  const c2 = s.addCategory('نساء', 30);
  const sell = (cid, name, price, when) => {
    const st = stamp(when);
    s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
              VALUES (?, 2026, ?, ?, ?, ?, ?, ?)`, [serial++, cid, name, price, st.slice(0, 10), st.slice(11), st]);
    return s.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  };
  return { s, m, c1, c2, sell, at: (d) => { t = d; } };
}

// The dashboard's figures (buildSummary in main-working.js), computed the same way.
function dashboard(s, m, date) {
  const one = (sql, p = []) => { const r = s.db.exec(sql, p); return r[0] ? r[0].values[0][0] : null; };
  const b = m.getBalances();
  return {
    tickets: one('SELECT COUNT(*) FROM tickets WHERE refunded_at IS NULL AND date = ?', [date]),
    sales: one('SELECT COALESCE(SUM(price),0) FROM tickets WHERE refunded_at IS NULL AND date = ?', [date]),
    refunds: one('SELECT COUNT(*) FROM tickets WHERE refunded_at IS NOT NULL AND date = ?', [date]),
    cashInHand: b.cashInHand, owedToSuppliers: b.owedToSuppliers, owedToManager: b.owedToManager, owedBySeller: b.owedBySeller,
    openBills: m.getBills({ openOnly: true }), late: m.getLateEntries({ pendingOnly: true })
  };
}

async function busyDay() {
  const x = await setup();
  const { s, m, c1, c2, sell, at } = x;
  m.setRefundsEnabled(true);
  sell(c1, 'رجال', 35, L(2026, 11, 15, 8));
  sell(c1, 'رجال', 35, L(2026, 11, 15, 9));
  sell(c2, 'نساء', 30, L(2026, 11, 15, 10));
  const r = sell(c2, 'نساء', 30, L(2026, 11, 15, 11));
  at(L(2026, 11, 15, 11, 30));
  assert.equal(m.refundTicket(r, 'water').success, true);
  assert.equal(m.recordExpense({ description: 'Bois <b>', total: 20, fromDrawer: 20, date: DAY }).success, true);
  assert.equal(m.recordExpense({ description: 'خشب', supplier: 'morad', total: 40, fromDrawer: 10, restAs: 'manager', date: DAY }).success, true);
  assert.equal(m.recordExpense({ description: 'Savon', total: 15, fromDrawer: 0, restAs: 'unpaid', date: DAY }).success, true);
  s.setSetting('hammam_name', 'حمام السلام');
  return x;
}

test('report numbers equal the dashboard / MoneyService values (new-system expenses, unpaid parts, refunds)', async () => {
  const { s, m } = await busyDay();
  try {
    const d = dashboard(s, m, DAY);
    const r = buildDailyReport(s, m, DAY, 'ar');
    assert.equal(r.tickets, d.tickets);
    assert.equal(r.tickets, 3);
    assert.equal(r.sales, d.sales);
    assert.equal(r.sales, 100);
    assert.equal(r.refunds.count, d.refunds);
    assert.equal(r.refunds.total, 30);
    assert.equal(r.cashInHand, d.cashInHand);
    assert.equal(r.owedToSuppliers, d.owedToSuppliers);
    assert.equal(r.owedToManager, d.owedToManager);
    assert.equal(r.owedBySeller, d.owedBySeller);
    assert.equal(r.openBills.count, d.openBills.length);
    assert.equal(r.openBills.total, d.openBills.reduce((a, x) => a + x.remaining, 0));
    assert.equal(r.pendingLate.count, d.late.length);
    // Expenses come from the money system, including the unpaid part.
    assert.equal(r.expenses.length, 3);
    assert.equal(r.totalExpenses, 75);
    assert.equal(r.net, 25);
    assert.equal(r.totalExpenses, m.getDaySummary(DAY).cost);
    assert.deepEqual(r.expenses.map(e => e.unpaid), [0, 0, 15]);
    assert.equal(r.owedToSuppliers, 15);
    assert.equal(r.owedToManager, 30);
    assert.deepEqual(r.byCategory.map(c => [c.name, c.count, c.revenue]).sort(), [['رجال', 2, 70], ['نساء', 1, 30]].sort());
  } finally { cleanup(s); }
});

test('expenses are taken from the money system, not only the old expenses table', async () => {
  const { s, m } = await busyDay();
  try {
    // An expense that exists only in the money system (its mirror in the old table is gone).
    s.db.run('DELETE FROM expenses');
    const r = buildDailyReport(s, m, DAY, 'ar');
    assert.equal(r.expenses.length, 3);
    assert.equal(r.totalExpenses, 75);
  } finally { cleanup(s); }
});

test('French report: French names, left-to-right, e-mail-safe layout', async () => {
  const { s, m } = await busyDay();
  try {
    s.setSetting('hammam_name_fr', 'Hammam Salam');
    const r = buildDailyReport(s, m, DAY, 'fr');
    assert.equal(r.hammamName, 'Hammam Salam');
    assert.deepEqual(r.byCategory.map(c => c.name).sort(), ['Hommes', 'نساء']);
    const { subject, html } = new EmailService(s).renderDailyReport(r);
    assert.match(subject, /^Rapport journalier - Hammam Salam - 15\/11\/2026$/);
    assert.match(html, /<html lang="fr" dir="ltr">/);
    assert.match(html, /charset="UTF-8"/);
    assert.match(html, /Ventes par catégorie/);
    assert.match(html, /Dépenses du jour/);
    assert.match(html, /Dû aux fournisseurs/);
    assert.match(html, /Impayé/);
    assert.match(html, /Hommes/);
    assert.match(html, /Bois &lt;b&gt;/); // text from the database is escaped
    assert.doesNotMatch(html, /<style|display:\s*grid/i);
  } finally { cleanup(s); }
});

test('French falls back to the Arabic hammam name when no French name is set', async () => {
  const { s, m } = await busyDay();
  try {
    assert.equal(buildDailyReport(s, m, DAY, 'fr').hammamName, 'حمام السلام');
  } finally { cleanup(s); }
});

test('Arabic report: right-to-left, Arabic names and wording', async () => {
  const { s, m } = await busyDay();
  try {
    s.setSetting('hammam_name_fr', 'Hammam Salam');
    const r = buildDailyReport(s, m, DAY, 'ar');
    assert.equal(r.hammamName, 'حمام السلام');
    assert.deepEqual(r.byCategory.map(c => c.name).sort(), ['رجال', 'نساء'].sort());
    const { subject, html } = new EmailService(s).renderDailyReport(r);
    assert.match(subject, /^التقرير اليومي - حمام السلام - 15\/11\/2026$/);
    assert.match(html, /<html lang="ar" dir="rtl">/);
    assert.match(html, /المبيعات حسب الفئة/);
    assert.match(html, /مستحق للموردين/);
    assert.doesNotMatch(html, /<style|display:\s*grid/i);
  } finally { cleanup(s); }
});

test('the language follows the ui_language setting (default Arabic)', async () => {
  const { s, m } = await busyDay();
  try {
    const sch = new SchedulerService(s);
    sch.money = m;
    assert.equal(sch.generateDailyReport(DAY).lang, 'ar');
    s.setSetting('ui_language', 'fr');
    assert.equal(sch.generateDailyReport(DAY).lang, 'fr');
    s.setSetting('ui_language', 'xx');
    assert.equal(sch.generateDailyReport(DAY).lang, 'ar');
  } finally { cleanup(s); }
});

test('empty day: clear messages in both languages, zero totals', async () => {
  const { s, m } = await setup();
  try {
    const r = buildDailyReport(s, m, '2026-11-14', 'fr');
    assert.equal(r.tickets, 0);
    assert.equal(r.sales, 0);
    assert.equal(r.totalExpenses, 0);
    assert.equal(r.expenses.length, 0);
    const email = new EmailService(s);
    const fr = email.renderDailyReport(r).html;
    assert.match(fr, /Aucun ticket vendu ce jour/);
    assert.match(fr, /Aucune dépense ce jour/);
    const ar = email.renderDailyReport(buildDailyReport(s, m, '2026-11-14', 'ar')).html;
    assert.match(ar, /لا توجد تذاكر مباعة في هذا اليوم/);
    assert.match(ar, /لا توجد مصروفات في هذا اليوم/);
  } finally { cleanup(s); }
});

test('before the new money system is switched on, expenses come from the old table', async () => {
  const s = await newStorage();
  try {
    const m = new MoneyService(s);
    s.addExpense('Old expense', 50, { date: DAY });
    const r = buildDailyReport(s, m, DAY, 'ar');
    assert.equal(r.switchedOver, false);
    assert.equal(r.totalExpenses, 50);
    assert.equal(r.expenses.length, 1);
    assert.equal(r.cashInHand, s.getCashInHand());
    const html = new EmailService(s).renderDailyReport(r).html;
    assert.doesNotMatch(html, /مستحق للموردين/);
  } finally { cleanup(s); }
});

test('recovery code e-mail: header, never-share line, code, both languages', async () => {
  const s = await newStorage();
  try {
    const email = new EmailService(s);
    const ar = email.renderRecoveryCode({ lang: 'ar', code: '123456', hammamName: 'حمام السلام' });
    assert.match(ar.subject, /^رمز استرجاع كلمة مرور الإدارة - حمام السلام$/);
    assert.match(ar.html, /<html lang="ar" dir="rtl">/);
    assert.match(ar.html, /لا تشارك هذا الرمز مع أي شخص أبداً/);
    assert.match(ar.html, />123456</);
    assert.match(ar.html, /حمام السلام/);
    const fr = email.renderRecoveryCode({ lang: 'fr', code: '654321', hammamName: 'Hammam <Salam>' });
    assert.match(fr.html, /<html lang="fr" dir="ltr">/);
    assert.match(fr.html, /Ne communiquez jamais ce code à personne/);
    assert.match(fr.html, /Hammam &lt;Salam&gt;/);
    assert.match(fr.html, /charset="UTF-8"/);
    assert.match(fr.html, />654321</);
  } finally { cleanup(s); }
});
