'use strict';
/**
 * Regression tests for the on-screen keyboard (v2.8.17).
 *
 * The renderer wiring in hammampos.html is a thin DOM adapter over the pure
 * logic in src/services/OnScreenKeyboard.js. These tests exercise that pure
 * logic (layouts + applyKey) and a small DOM-less simulation of routing key
 * presses to the "currently focused" input, covering behaviors A–I. Behavior
 * J (existing tests still pass) is satisfied by running the full suite.
 */
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const OSK = require(path.resolve(__dirname, '..', '..', 'src', 'services', 'OnScreenKeyboard'));

// A. Open/close is a UI state toggle; the switchable pieces here are the layout
//    modes the panel can render. Confirm both modes exist and are the two we ship.
test('keyboard exposes exactly the Arabic and QWERTY layouts', () => {
  assert.deepEqual(OSK.layoutModes(), ['ar', 'qwerty']);
  assert.ok(OSK.getLayout('ar').length > 0);
  assert.ok(OSK.getLayout('qwerty').length > 0);
  assert.throws(() => OSK.getLayout('bogus'));
});

// B. Arabic layout contains expected Arabic characters.
test('Arabic layout contains Arabic letters', () => {
  const flat = OSK.getLayout('ar').flat();
  assert.ok(flat.includes('ض'));
  assert.ok(flat.includes('ا'));
  assert.ok(flat.includes('م'));
  // Should not contain latin letters.
  assert.ok(!flat.includes('q'));
});

// C. QWERTY layout contains expected English characters.
test('QWERTY layout contains English letters', () => {
  const flat = OSK.getLayout('qwerty').flat();
  assert.ok(flat.includes('q'));
  assert.ok(flat.includes('a'));
  assert.ok(flat.includes('m'));
  assert.ok(!flat.includes('ض'));
});

// D. Layout switching cycles between the two modes.
test('layout switching toggles between ar and qwerty', () => {
  assert.equal(OSK.nextLayout('ar'), 'qwerty');
  assert.equal(OSK.nextLayout('qwerty'), 'ar');
});

// getLayout returns a defensive copy (mutating it must not corrupt the source).
test('getLayout returns a copy that cannot corrupt the source', () => {
  const a = OSK.getLayout('qwerty');
  a[0][0] = 'ZZZ';
  const b = OSK.getLayout('qwerty');
  assert.notEqual(b[0][0], 'ZZZ');
});

// E. Character insertion at the caret, and replacing a selection.
test('applyKey inserts a character at the caret', () => {
  const r = OSK.applyKey({ value: 'ab', selStart: 1, selEnd: 1 }, 'X');
  assert.equal(r.value, 'aXb');
  assert.equal(r.selStart, 2);
  assert.equal(r.selEnd, 2);
});

test('applyKey inserts an Arabic character correctly', () => {
  const r = OSK.applyKey({ value: '', selStart: 0, selEnd: 0 }, 'ش');
  assert.equal(r.value, 'ش');
  assert.equal(r.selStart, 1);
});

test('applyKey replaces the current selection with the typed character', () => {
  const r = OSK.applyKey({ value: 'abcd', selStart: 1, selEnd: 3 }, 'X');
  assert.equal(r.value, 'aXd');
  assert.equal(r.selStart, 2);
});

// F. Backspace deletes one char before the caret, or the selection.
test('applyKey Backspace deletes the char before the caret', () => {
  const r = OSK.applyKey({ value: 'abc', selStart: 2, selEnd: 2 }, 'Backspace');
  assert.equal(r.value, 'ac');
  assert.equal(r.selStart, 1);
});

test('applyKey Backspace deletes the selection when one exists', () => {
  const r = OSK.applyKey({ value: 'abcd', selStart: 1, selEnd: 3 }, 'Backspace');
  assert.equal(r.value, 'ad');
  assert.equal(r.selStart, 1);
});

test('applyKey Backspace at start is a no-op', () => {
  const r = OSK.applyKey({ value: 'abc', selStart: 0, selEnd: 0 }, 'Backspace');
  assert.equal(r.value, 'abc');
  assert.equal(r.selStart, 0);
});

// G. Space inserts a space.
test('applyKey Space inserts a space at the caret', () => {
  const r = OSK.applyKey({ value: 'ab', selStart: 2, selEnd: 2 }, 'Space');
  assert.equal(r.value, 'ab ');
  assert.equal(r.selStart, 3);
});

// H. Enter: newline for multiline, submit signal for single-line.
test('applyKey Enter inserts a newline in multiline fields', () => {
  const r = OSK.applyKey({ value: 'ab', selStart: 2, selEnd: 2 }, 'Enter', { multiline: true });
  assert.equal(r.value, 'ab\n');
  assert.equal(r.selStart, 3);
  assert.ok(!r.submit);
});

test('applyKey Enter on a single-line field signals submit and inserts no char', () => {
  const r = OSK.applyKey({ value: 'ab', selStart: 2, selEnd: 2 }, 'Enter');
  assert.equal(r.value, 'ab');
  assert.equal(r.submit, true);
});

// Out-of-range / missing selection is tolerated (renderer uses this for number
// inputs which do not expose a selection).
test('applyKey tolerates missing selection by appending at the end', () => {
  const r = OSK.applyKey({ value: 'abc' }, 'Z');
  assert.equal(r.value, 'abcZ');
  assert.equal(r.selStart, 4);
});

// I. Switching focus between inputs routes keys to the newly focused input.
//    Simulate the renderer's routing: a tiny model where key presses are applied
//    to whichever "input" object is currently focused.
test('focus switch routes subsequent keys to the newly focused input', () => {
  const inputA = { value: '', selStart: 0, selEnd: 0 };
  const inputB = { value: '', selStart: 0, selEnd: 0 };
  let focused = inputA;

  const press = (key, opts) => {
    const next = OSK.applyKey(focused, key, opts);
    focused.value = next.value;
    focused.selStart = next.selStart;
    focused.selEnd = next.selEnd;
  };

  // Type into A.
  press('h'); press('i');
  assert.equal(inputA.value, 'hi');
  assert.equal(inputB.value, '');

  // Switch focus to B, type there.
  focused = inputB;
  press('ش'); press('س');
  assert.equal(inputB.value, 'شس');
  assert.equal(inputA.value, 'hi'); // A untouched after focus change
});
