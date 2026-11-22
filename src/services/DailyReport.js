/**
 * HammamPOS - DailyReport
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 *
 * Builds the data of the daily e-mail report. The numbers come from the same
 * sources as the dashboard (buildSummary in main-working.js): the tickets table,
 * MoneyService balances, open bills and pending late entries. Expenses come from
 * the money system (money_expenses) once it is switched on, otherwise from the
 * old expenses table. No sending and no network here.
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function getLanguage(storage) {
  return storage.getSetting('ui_language') === 'fr' ? 'fr' : 'ar';
}

/** French screens use hammam_name_fr when set; otherwise hammam_name. */
function getHammamName(storage, lang) {
  const ar = storage.getSetting('hammam_name') || '';
  const fr = storage.getSetting('hammam_name_fr') || '';
  return (lang === 'fr' ? (fr || ar) : ar) || 'HammamPOS';
}

/**
 * @param {object} storage StorageManager
 * @param {object|null} money MoneyService (null: old system only)
 * @param {string} date 'YYYY-MM-DD'
 * @param {string} [lang] 'ar' | 'fr' (default: the app's ui_language)
 */
function buildDailyReport(storage, money, date, lang) {
  lang = lang || getLanguage(storage);
  const rows = (sql, params = []) => {
    const r = storage.db.exec(sql, params);
    return r[0] ? r[0].values : [];
  };
  const one = (sql, params = []) => { const v = rows(sql, params)[0]; return v ? v[0] : null; };
  const fr = lang === 'fr';

  const nameFr = {};
  try { storage.getCategories(false).forEach(c => { if (c.name_fr) nameFr[c.name] = c.name_fr; }); } catch (_) {}
  const categoryName = (n) => (fr && nameFr[n]) || n;

  const hammamName = getHammamName(storage, lang);

  const b = money ? money.getBalances() : { switchedOver: false, cashInHand: storage.getCashInHand() };
  const switchedOver = !!b.switchedOver;

  // Sales: refunded tickets are not sales (same as the dashboard).
  const sales = round2(one('SELECT COALESCE(SUM(price),0) FROM tickets WHERE refunded_at IS NULL AND date = ?', [date]));
  const tickets = one('SELECT COUNT(*) FROM tickets WHERE refunded_at IS NULL AND date = ?', [date]) || 0;
  const refundCount = one('SELECT COUNT(*) FROM tickets WHERE refunded_at IS NOT NULL AND date = ?', [date]) || 0;
  const refundTotal = round2(one('SELECT COALESCE(SUM(price),0) FROM tickets WHERE refunded_at IS NOT NULL AND date = ?', [date]));
  const byCategory = rows(`SELECT category_name, COUNT(*), COALESCE(SUM(price),0) FROM tickets
      WHERE refunded_at IS NULL AND date = ? GROUP BY category_name ORDER BY category_name`, [date])
    .map(([name, count, revenue]) => ({ name: categoryName(name), count, revenue: round2(revenue) }));

  // Expenses of the day: money system when switched over (with what is still unpaid).
  let expenses;
  if (switchedOver) {
    const remainingById = {};
    money.getBills().filter(x => x.date === date).forEach(x => { remainingById[x.id] = x.remaining; });
    expenses = rows(`SELECT id, description, supplier, total FROM money_expenses WHERE date = ? ORDER BY id`, [date])
      .map(([id, description, supplier, total]) => ({
        description, supplier: supplier || '', amount: round2(total), unpaid: round2(remainingById[id] || 0)
      }));
  } else {
    expenses = rows('SELECT description, amount FROM expenses WHERE date = ? ORDER BY id', [date])
      .map(([description, amount]) => ({ description, supplier: '', amount: round2(amount), unpaid: 0 }));
  }
  const totalExpenses = round2(expenses.reduce((a, e) => a + e.amount, 0));

  const bills = switchedOver ? money.getBills({ openOnly: true }) : [];
  const late = switchedOver ? money.getLateEntries({ pendingOnly: true }) : [];
  let changeFloat = null;
  try { changeFloat = storage.getFloatBalance ? storage.getFloatBalance() : null; } catch (_) {}

  return {
    lang,
    date,
    hammamName,
    switchedOver,
    tickets,
    sales,
    expenses,
    totalExpenses,
    net: round2(sales - totalExpenses),
    refunds: { count: refundCount, total: refundTotal },
    byCategory,
    cashInHand: b.cashInHand || 0,
    owedToSuppliers: b.owedToSuppliers || 0,
    owedToManager: b.owedToManager || 0,
    owedBySeller: b.owedBySeller || 0,
    changeFloat,
    openBills: { count: bills.length, total: round2(bills.reduce((a, x) => a + (x.remaining || 0), 0)) },
    pendingLate: { count: late.length, total: round2(late.reduce((a, x) => a + (x.amount || 0), 0)) }
  };
}

module.exports = { buildDailyReport, getLanguage, getHammamName };
