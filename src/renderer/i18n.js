/**
 * HammamPOS - Arabic / French switch for the screens.
 *
 * The screens are written in Arabic. In French, every Arabic text on the page
 * (text, placeholders, tooltips, button values) is replaced from the dictionary
 * window.HPOS_FR (i18n-fr.js): whole sentences first, then known pieces inside
 * longer texts (numbers and names stay as they are). New content is translated
 * as it appears. Switching back restores the original Arabic.
 *
 * Not translated: anything inside [data-no-i18n] (names typed by the owner,
 * like the hammam name and the categories), inputs' typed values, and printing.
 *
 * window.i18n = { setLang('ar'|'fr'), getLang(), t(text) }
 */
(function () {
  'use strict';
  var AR = /[\u0600-\u06FF]/;
  var dict = window.HPOS_FR || {};
  var norm = function (s) { return s.replace(/\s+/g, ' ').trim(); };
  var exact = Object.create(null);
  Object.keys(dict).forEach(function (k) { exact[norm(k)] = dict[k]; });
  // Pieces, longest first, matched only as whole words.
  var keys = Object.keys(exact).filter(function (k) { return k.length > 1; }).sort(function (a, b) { return b.length - a.length; });
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var pieceRe = keys.length ? new RegExp('(?<![\\u0600-\\u06FF])(' + keys.map(esc).join('|') + ')(?![\\u0600-\\u06FF])', 'g') : null;
  // Sentences with numbers in them.
  var PATTERNS = [
    [/^الخطوة (\d+) من (\d+)$/, 'Étape $1 sur $2'],
    [/^قبل (\d+) ث$/, 'il y a $1 s'],
    [/^قبل (\d+) د$/, 'il y a $1 min'],
    [/^قبل (\d+) س$/, 'il y a $1 h'],
    [/^قبل (\d+) يوم$/, 'il y a $1 j'],
    [/^([\d.,]+) د$/, '$1 min'],
    [/^([\d.,]+) ث$/, '$1 s']
  ];

  function translate(text) {
    if (!text || !AR.test(text)) return null;
    var lead = text.match(/^\s*/)[0], tail = text.match(/\s*$/)[0];
    var core = norm(text);
    if (exact[core] != null) return lead + exact[core] + tail;
    // "Text:" or "(Text)" around a known text
    var m = core.match(/^([\s:·—\-–,.()*•|]*)(.*?)([\s:·—\-–,.()*•|؟?]*)$/);
    if (m && m[2] && exact[m[2]] != null) return lead + m[1] + exact[m[2]] + m[3].replace('؟', ' ?') + tail;
    for (var i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i][0].test(core)) return lead + core.replace(PATTERNS[i][0], PATTERNS[i][1]) + tail;
    }
    if (!pieceRe) return null;
    var out = core.replace(pieceRe, function (p) { return exact[p]; }).replace(/؟/g, ' ?').replace(/،/g, ',');
    return out === core ? null : lead + out + tail;
  }

  var lang = 'ar';
  // Dates and times written with the Arabic locale follow the language.
  ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'].forEach(function (fn) {
    var orig = Date.prototype[fn];
    Date.prototype[fn] = function (loc, opts) {
      if (lang === 'fr' && (loc == null || /^ar/i.test(String(loc)))) loc = 'fr-FR';
      return orig.call(this, loc, opts);
    };
  });
  var ATTRS = ['placeholder', 'title', 'aria-label'];
  var origText = new WeakMap();   // text node -> Arabic
  var origAttr = new WeakMap();   // element -> { attr: Arabic }
  var applying = false;

  function skip(el) {
    return !el || (el.closest && el.closest('[data-no-i18n], script, style, textarea, [contenteditable="true"]'));
  }
  function doText(node) {
    if (skip(node.parentElement)) return;
    var cur = node.nodeValue;
    var saved = origText.get(node);
    if (lang === 'ar') { if (saved != null && saved.fr === cur) node.nodeValue = saved.ar; return; }
    if (saved && saved.fr === cur) return;          // already ours
    var fr = translate(cur);
    if (fr == null) return;
    origText.set(node, { ar: cur, fr: fr });
    node.nodeValue = fr;
  }
  function doAttrs(el) {
    if (skip(el)) return;
    var saved = origAttr.get(el) || {};
    var list = ATTRS.slice();
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit')) list.push('value');
    list.forEach(function (a) {
      var cur = el.getAttribute(a);
      if (cur == null) return;
      var s = saved[a];
      if (lang === 'ar') { if (s && s.fr === cur) el.setAttribute(a, s.ar); return; }
      if (s && s.fr === cur) return;
      var fr = translate(cur);
      if (fr == null) return;
      saved[a] = { ar: cur, fr: fr };
      el.setAttribute(a, fr);
    });
    origAttr.set(el, saved);
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) doAttrs(root);
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var n;
    while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }

  var observer = new MutationObserver(function (records) {
    if (lang === 'ar' || applying) return;
    applying = true;
    try {
      records.forEach(function (r) {
        if (r.type === 'characterData') doText(r.target);
        else if (r.type === 'attributes') doAttrs(r.target);
        else r.addedNodes.forEach(walk);
      });
    } finally { applying = false; }
  });

  function applyDir() {
    var html = document.documentElement;
    html.lang = lang;
    html.dir = lang === 'fr' ? 'ltr' : 'rtl';
    if (document.body) document.body.classList.toggle('lang-fr', lang === 'fr');
    if (document.title) {
      var t = lang === 'fr' ? translate(document.title) : (document.__arTitle || null);
      if (lang === 'fr' && t) { document.__arTitle = document.title; document.title = t; }
      else if (lang === 'ar' && t) document.title = t;
    }
  }
  function setLang(l) {
    l = l === 'fr' ? 'fr' : 'ar';
    if (l === lang && document.body && document.body.__i18nDone) return;
    lang = l;
    applying = true;
    try { walk(document.body || document.documentElement); } finally { applying = false; }
    applyDir();
    if (document.body) document.body.__i18nDone = true;
    observer.disconnect();
    if (lang === 'fr') observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(['value']) });
    try { document.dispatchEvent(new CustomEvent('hpos:lang', { detail: lang })); } catch (_) {}
  }

  ['confirm', 'alert', 'prompt'].forEach(function (fn) {
    var orig = window[fn];
    if (typeof orig !== 'function') return;
    window[fn] = function (msg) {
      var args = Array.prototype.slice.call(arguments);
      if (lang === 'fr' && typeof msg === 'string') { var t = translate(msg); if (t != null) args[0] = t; }
      return orig.apply(window, args);
    };
  });
  window.i18n = {
    setLang: setLang,
    getLang: function () { return lang; },
    t: function (s) { if (lang !== 'fr') return s; var r = translate(String(s)); return r == null ? s : r; }
  };
})();
