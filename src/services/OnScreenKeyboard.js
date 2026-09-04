'use strict';
/**
 * HammamPOS - OnScreenKeyboard (pure logic)
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 *
 * Pure, DOM-free keyboard logic so the behavior can be unit-tested headlessly.
 * The renderer (hammampos.html) requires this module to build the visual keys
 * and to transform the focused input's value/caret when a key is pressed.
 *
 * No external dependencies.
 */

// ── Layouts ──────────────────────────────────────────────────────────────
// Each layout is an array of rows; each row is an array of character keys.
// Special/control keys (Backspace, Space, Enter, layout switch) are rendered
// separately by the UI and handled by applyKey() below.

const QWERTY_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm']
];

// Standard Arabic (AZERTY-position-independent) letters, digits row on top.
const ARABIC_ROWS = [
  ['١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩', '٠'],
  ['ض', 'ص', 'ث', 'ق', 'ف', 'غ', 'ع', 'ه', 'خ', 'ح', 'ج'],
  ['ش', 'س', 'ي', 'ب', 'ل', 'ا', 'ت', 'ن', 'م', 'ك'],
  ['ظ', 'ط', 'ذ', 'د', 'ز', 'ر', 'و', 'ة', 'ى', 'ء']
];

const LAYOUTS = {
  qwerty: QWERTY_ROWS,
  ar: ARABIC_ROWS
};

/**
 * Return the row/key structure for a layout mode.
 * @param {'ar'|'qwerty'} mode
 * @returns {string[][]} rows of character keys
 */
function getLayout(mode) {
  const rows = LAYOUTS[mode];
  if (!rows) throw new Error('Unknown keyboard layout: ' + mode);
  // Return a defensive copy so callers cannot mutate the source arrays.
  return rows.map(row => row.slice());
}

/** List of supported layout modes, in switch order. */
function layoutModes() {
  return ['ar', 'qwerty'];
}

/** Toggle to the next layout mode (wraps around). */
function nextLayout(mode) {
  const modes = layoutModes();
  const idx = modes.indexOf(mode);
  return modes[(idx + 1 + modes.length) % modes.length];
}

// ── Key application ────────────────────────────────────────────────────────

function clampSelection(state) {
  const value = typeof state.value === 'string' ? state.value : '';
  let start = Number.isInteger(state.selStart) ? state.selStart : value.length;
  let end = Number.isInteger(state.selEnd) ? state.selEnd : start;
  start = Math.max(0, Math.min(start, value.length));
  end = Math.max(0, Math.min(end, value.length));
  if (start > end) { const t = start; start = end; end = t; }
  return { value, start, end };
}

/**
 * Apply a key press to an input state, purely.
 *
 * @param {{value:string, selStart:number, selEnd:number}} state
 * @param {string} key - a character, or one of the control keys:
 *        'Backspace', 'Space', 'Enter'
 * @param {{multiline?:boolean}} [opts] - multiline=true treats Enter as newline
 * @returns {{value:string, selStart:number, selEnd:number, submit?:boolean}}
 *          New state. `submit:true` is returned for Enter on a single-line
 *          field so the UI can trigger the field's default action.
 */
function applyKey(state, key, opts = {}) {
  const { value, start, end } = clampSelection(state || {});
  const before = value.slice(0, start);
  const after = value.slice(end);

  // Insert a literal string, replacing any current selection.
  const insert = (str) => ({
    value: before + str + after,
    selStart: start + str.length,
    selEnd: start + str.length
  });

  if (key === 'Backspace') {
    if (start !== end) {
      // Delete the selection.
      return { value: before + after, selStart: start, selEnd: start };
    }
    if (start === 0) {
      return { value, selStart: 0, selEnd: 0 }; // nothing to delete
    }
    // Delete one character before the caret.
    const newBefore = before.slice(0, -1);
    return { value: newBefore + after, selStart: start - 1, selEnd: start - 1 };
  }

  if (key === 'Space') {
    return insert(' ');
  }

  if (key === 'Enter') {
    if (opts.multiline) {
      return insert('\n');
    }
    // Single-line: no character inserted; signal the UI to submit/act.
    const res = insert('');
    res.submit = true;
    return res;
  }

  // Any other key is treated as a literal character (single char or grapheme).
  return insert(String(key));
}

module.exports = {
  getLayout,
  layoutModes,
  nextLayout,
  applyKey,
  QWERTY_ROWS,
  ARABIC_ROWS
};
