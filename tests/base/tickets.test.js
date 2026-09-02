'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll } = require('./helpers');

after(() => cleanupAll());

// Ticket serial behavior (from StorageManager.createTicket):
//   each category has its own serial_counter; createTicket sets newSerial = counter + 1,
//   stamps year, and stores serial_number on the ticket.

test('each category maintains its own serial counter', async () => {
  const s = await newStorage();
  try {
    const men = s.addCategory('رجال', 15);
    const women = s.addCategory('نساء', 15);

    const t1 = s.createTicket(men);   // men serial 1
    const t2 = s.createTicket(men);   // men serial 2
    const t3 = s.createTicket(women); // women serial 1

    assert.equal(t1.serial_number, 1);
    assert.equal(t2.serial_number, 2);
    assert.equal(t3.serial_number, 1); // women independent of men
    assert.equal(t1.year, new Date().getFullYear());
  } finally { cleanup(s); }
});

test('creating a ticket in one category does not increment another', async () => {
  const s = await newStorage();
  try {
    const men = s.addCategory('رجال', 15);
    const kids = s.addCategory('أولاد', 10);

    s.createTicket(men);
    s.createTicket(men);
    s.createTicket(men);         // men counter = 3
    const k1 = s.createTicket(kids); // kids counter = 1

    assert.equal(k1.serial_number, 1);

    const cats = s.getCategories(false);
    const menRow = cats.find(c => c.name === 'رجال');
    const kidsRow = cats.find(c => c.name === 'أولاد');
    assert.equal(menRow.serial_counter, 3);
    assert.equal(kidsRow.serial_counter, 1);
  } finally { cleanup(s); }
});

test('today ticket count reflects created tickets', async () => {
  const s = await newStorage();
  try {
    const men = s.addCategory('رجال', 15);
    s.createTicket(men);
    s.createTicket(men);
    assert.equal(s.getTodayTickets().length, 2);
  } finally { cleanup(s); }
});

test('clearAllData resets serial counters so next serial is 1 (observed behavior)', async () => {
  const s = await newStorage();
  try {
    const men = s.addCategory('رجال', 15);
    s.createTicket(men);
    s.createTicket(men); // counter = 2
    s.clearAllData();    // resets serial_counter to 0 and clears tickets

    const cats = s.getCategories(false);
    const menRow = cats.find(c => c.name === 'رجال');
    assert.equal(menRow.serial_counter, 0);

    const next = s.createTicket(men);
    assert.equal(next.serial_number, 1); // next serial after reset
  } finally { cleanup(s); }
});
