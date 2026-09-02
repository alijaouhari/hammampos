'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll } = require('./helpers');

after(() => cleanupAll());

test('collections are stored, retrievable, and reduce cash-in-hand', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 100);
    s.createTicket(c); // +100
    const id = s.collectMoney(40, 'إيداع');
    assert.equal(typeof id, 'number');
    assert.equal(s.getCashInHand(), 60);

    const today = new Date().toISOString().split('T')[0];
    const list = s.getCollections(today);
    assert.equal(list.length, 1);
    assert.equal(list[0].amount, 40);
    assert.equal(list[0].notes, 'إيداع');
  } finally { cleanup(s); }
});

test('deleting a collection restores cash-in-hand', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('رجال', 100);
    s.createTicket(c);            // +100
    const id = s.collectMoney(40); // -40 -> 60
    assert.equal(s.getCashInHand(), 60);
    s.deleteCollection(id);
    assert.equal(s.getCashInHand(), 100);
  } finally { cleanup(s); }
});

// Settings: relevant to base logic because the first-run/setup decision and
// admin gate depend on hammam_name and admin_password. P1-1 parameterized these.
test('settings round-trip, including quote-containing values (P1-1 regression)', async () => {
  const s = await newStorage();
  try {
    assert.equal(s.getSetting('hammam_name'), 'حمام'); // fresh default
    s.setSetting('hammam_name', 'حمام النور');
    assert.equal(s.getSetting('hammam_name'), 'حمام النور');

    const tricky = "O'Brien's ' ; DROP TABLE settings;--";
    s.setSetting('note', tricky);
    assert.equal(s.getSetting('note'), tricky); // stored verbatim, no injection
    // settings table must still exist / be usable
    assert.equal(typeof s.getSetting('admin_password'), 'string');
  } finally { cleanup(s); }
});

test('admin password: default verifies, and bcrypt after change', async () => {
  const s = await newStorage();
  try {
    // fresh default is plaintext '1234' (legacy path); verify + upgrade
    assert.equal(s.verifyAdminPassword('1234'), true);
    // change to a chosen password -> stored as bcrypt
    s.changeAdminPassword('ownerChoice');
    const stored = s.getSetting('admin_password');
    assert.ok(stored.startsWith('$2'), 'admin_password is bcrypt-hashed');
    assert.equal(s.verifyAdminPassword('ownerChoice'), true);
    assert.equal(s.verifyAdminPassword('1234'), false);
  } finally { cleanup(s); }
});
