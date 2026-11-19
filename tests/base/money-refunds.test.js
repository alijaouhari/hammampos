'use strict';
/**
 * Money system — Task 4: refunds (same day, within 2 hours).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));

after(() => cleanupAll());

// Local-time clock helpers: tests run in the machine's time zone, so build the
// "now" and the sale times from LOCAL wall-clock values and convert to UTC stamps.
const local = (y, mo, d, h, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const stamp = (date) => date.toISOString().replace('T', ' ').slice(0, 19);

async function setup(nowDate) {
  const s = await newStorage();
  let now = nowDate;
  const m = new MoneyService(s, { now: () => new Date(now) });
  m.switchOver.call(new MoneyService(s, { now: () => local(2026, 11, 15, 6) })); // switch-over at 06:00 local
  m.setRefundsEnabled(true);
  const c = s.addCategory('ر', 35);
  return { s, m, c, setNow: (d) => { now = d; } };
}
let serial = 1;
function sellAt(s, catId, price, when) {
  const st = stamp(when);
  s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
            VALUES (?, 2026, ?, 'ر', ?, ?, ?, ?)`, [serial++, catId, price, st.slice(0, 10), st.slice(11), st]);
  return s.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

test('refund within 2 hours: cash, income and zakat go down; ticket stays on record', async () => {
  const { s, m, c } = await setup(local(2026, 11, 15, 12, 0));
  try {
    const keep = sellAt(s, c, 35, local(2026, 11, 15, 11, 0));
    const t = sellAt(s, c, 35, local(2026, 11, 15, 11, 30));
    assert.equal(m.getBalances().cashInHand, 70);
    const r = m.refundTicket(t, 'انقطاع الماء الساخن');
    assert.equal(r.success, true, r.error);
    assert.equal(m.getBalances().cashInHand, 35);

    const row = s.db.exec('SELECT refunded_at, refund_reason FROM tickets WHERE id = ?', [t])[0].values[0];
    assert.ok(row[0]);
    assert.equal(row[1], 'انقطاع الماء الساخن');
    // Ticket is still listed for the day (on record), but income counts only the kept one.
    const date = stamp(local(2026, 11, 15, 11, 30)).slice(0, 10);
    assert.equal(s.getTicketsForDate(date).length, 2);
    const day = s.getDailySummariesWithDetails(100000).find(d => d.date === date);
    assert.equal(day.revenue, 35);
    assert.equal(day.total_tickets, 1);
    const z = s.getZakatDaysHistory().find(d => d.date === date);
    assert.equal(z.zakat, Math.round(35 * 0.025 * 100) / 100);

    const n = m.getNotifications();
    assert.equal(n[0].type, 'refund');
    assert.equal(n[0].payload.amount, 35);
    assert.equal(n[0].payload.reason, 'انقطاع الماء الساخن');
    assert.ok(keep);
  } finally { cleanup(s); }
});

test('2-hour boundary: exactly 2h is allowed, 2h + 1s is refused', async () => {
  const { s, m, c, setNow } = await setup(local(2026, 11, 15, 14, 0, 0));
  try {
    const t1 = sellAt(s, c, 35, local(2026, 11, 15, 12, 0, 0));
    assert.equal(m.refundTicket(t1, 'x').success, true);
    const t2 = sellAt(s, c, 35, local(2026, 11, 15, 12, 0, 0));
    setNow(local(2026, 11, 15, 14, 0, 1));
    const r = m.refundTicket(t2, 'x');
    assert.equal(r.success, false);
    assert.match(r.error, /ساعتين/);
  } finally { cleanup(s); }
});

test('same day only: a ticket from yesterday is refused even if under 2 hours', async () => {
  const { s, m, c } = await setup(local(2026, 11, 16, 0, 30));
  try {
    const t = sellAt(s, c, 35, local(2026, 11, 15, 23, 45)); // 45 minutes ago, but yesterday
    const r = m.refundTicket(t, 'x');
    assert.equal(r.success, false);
    assert.match(r.error, /يوم آخر/);
  } finally { cleanup(s); }
});

test('cannot refund twice; reason required; pre-switch-over tickets refused', async () => {
  const { s, m, c } = await setup(local(2026, 11, 15, 12, 0));
  try {
    const t = sellAt(s, c, 35, local(2026, 11, 15, 11, 0));
    assert.equal(m.refundTicket(t, '').success, false);
    assert.equal(m.refundTicket(t, 'x').success, true);
    const again = m.refundTicket(t, 'x');
    assert.equal(again.success, false);
    assert.match(again.error, /مسبقاً/);
    const before = sellAt(s, c, 35, local(2026, 11, 15, 5, 30)); // before the 06:00 switch-over
    assert.equal(m.refundTicket(before, 'x').success, false);
    assert.equal(m.refundTicket(99999, 'x').success, false);
  } finally { cleanup(s); }
});

test('manager undo restores cash, income and zakat', async () => {
  const { s, m, c } = await setup(local(2026, 11, 15, 12, 0));
  try {
    const t = sellAt(s, c, 35, local(2026, 11, 15, 11, 0));
    m.refundTicket(t, 'x');
    assert.equal(m.getBalances().cashInHand, 0);
    assert.equal(m.undoRefund(t).success, true);
    assert.equal(m.getBalances().cashInHand, 35);
    const date = stamp(local(2026, 11, 15, 11, 0)).slice(0, 10);
    assert.equal(s.getDailySummariesWithDetails(100000).find(d => d.date === date).revenue, 35);
    assert.equal(m.undoRefund(t).success, false); // not refunded any more
  } finally { cleanup(s); }
});

test('refund status for a date lists each ticket', async () => {
  const { s, m, c } = await setup(local(2026, 11, 15, 12, 0));
  try {
    const a = sellAt(s, c, 35, local(2026, 11, 15, 11, 0));
    const b = sellAt(s, c, 35, local(2026, 11, 15, 9, 0));  // 3h ago
    const d = sellAt(s, c, 35, local(2026, 11, 15, 11, 30));
    m.refundTicket(d, 'x');
    const date = stamp(local(2026, 11, 15, 11, 0)).slice(0, 10);
    const st = m.getRefundStatusForDate(date);
    assert.equal(st[a].refundable, true);
    assert.equal(st[b].refundable, false);
    assert.equal(st[d].refunded, true);
  } finally { cleanup(s); }
});

test("today's counters skip refunded tickets", async () => {
  const s = await newStorage();
  try {
    const m = new MoneyService(s, { now: () => new Date(Date.now()) });
    m.switchOver.call(new MoneyService(s, { now: () => new Date(Date.now() - 60000) }));
    m.setRefundsEnabled(true);
    const c = s.addCategory('ر', 35);
    const t1 = s.createTicket(c);
    s.createTicket(c);
    assert.equal(s.getTodayTickets().length, 2);
    assert.equal(m.refundTicket(t1.id, 'x').success, true);
    assert.equal(s.getTodayTickets().length, 1);
    assert.equal(s.getCategories(true).find(x => x.id === c).today_count, 1);
  } finally { cleanup(s); }
});
