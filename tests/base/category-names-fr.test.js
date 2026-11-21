'use strict';
/** Optional French name of a category: saved on add, changed or cleared on update, kept when not given. */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll } = require('./helpers');
after(() => cleanupAll());

test('category French name: add, keep, change, clear', async () => {
  const s = await newStorage();
  try {
    const id = s.addCategory('رجال', 15, ' Hommes ');
    const get = () => s.getCategories(false).find(c => c.id === id);
    assert.equal(get().name_fr, 'Hommes');
    s.updateCategory(id, 'رجال', 20);            // no French name given: kept
    assert.equal(get().name_fr, 'Hommes');
    assert.equal(get().price, 20);
    s.updateCategory(id, 'رجال', 20, 'Adultes');
    assert.equal(get().name_fr, 'Adultes');
    s.updateCategory(id, 'رجال', 20, '');         // emptied: removed
    assert.equal(get().name_fr, null);
    const id2 = s.addCategory('نساء', 15);
    assert.equal(s.getCategories(false).find(c => c.id === id2).name_fr, null);
  } finally { cleanup(s); }
});
