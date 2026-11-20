/*
 * HammamPOS remote admin panel — browser adapter.
 * The page is the app's own screen (src/renderer/hammampos.html). This file replaces
 * the desktop link (Electron ipcRenderer) by the secure live channel to the hammam PC:
 * every api.* call becomes a request on the private topic 'admin-rpc:<location>' inside
 * a manager session that the PC unlocked with its admin password.
 * Must load BEFORE the app script (it defines require()).
 */
(function () {
  'use strict';
  var CONFIG = window.HPOS_CONFIG;
  var LOC = new URLSearchParams(location.search).get('loc') || '';
  var sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
  var channel = null, sessionId = null, hammamName = '';
  var waiters = new Map(), parts = new Map();
  var readyResolve; var ready = new Promise(function (r) { readyResolve = r; });

  function onRes(msg) {
    var p = msg && msg.payload; if (!p || !p.id) return;
    if (p.parts) {
      var arr = parts.get(p.id) || []; arr[p.part] = p.chunk; parts.set(p.id, arr);
      if (arr.filter(function (x) { return x != null; }).length !== p.parts) return;
      parts.delete(p.id); p = Object.assign({ id: p.id }, JSON.parse(arr.join('')));
    }
    var w = waiters.get(p.id); if (w) { waiters.delete(p.id); w(p); }
  }

  function joinChannel() {
    return new Promise(function (resolve, reject) {
      if (channel) { try { sb.removeChannel(channel); } catch (_) {} }
      channel = sb.channel('admin-rpc:' + LOC, { config: { private: true, broadcast: { self: false } } });
      channel.on('broadcast', { event: 'res' }, onRes);
      var done = false;
      channel.subscribe(function (s) {
        if (done) return;
        if (s === 'SUBSCRIBED') { done = true; resolve(); }
        else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { done = true; reject(new Error('تعذّر فتح القناة الآمنة (' + s + ')')); }
      });
    });
  }

  function raw(ch, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      waiters.set(id, resolve);
      channel.send({ type: 'broadcast', event: 'req', payload: { id: id, session: sessionId, channel: ch, args: args || [] } });
      setTimeout(function () {
        if (waiters.has(id)) { waiters.delete(id); reject(new Error('لا رد من الجهاز: تحقق أنه يعمل ومتصل')); }
      }, timeoutMs || 30000);
    });
  }

  var ipcRenderer = {
    invoke: function (ch) {
      var args = Array.prototype.slice.call(arguments, 1);
      return ready.then(function () {
        var slow = /rebuild|fullSync|testConnection|getDailySummaries/.test(ch);
        return raw(ch, args, slow ? 120000 : 30000);
      }).then(function (r) {
        if (!r.ok) {
          if (r.error === 'session') showOverlay('انتهت الجلسة. أدخل كلمة مرور الإدارة من جديد.');
          throw new Error(r.message || r.error);
        }
        return r.result;
      });
    },
    on: function () {}, once: function () {}, send: function () {}, removeListener: function () {}, removeAllListeners: function () {}
  };

  window.require = function (m) {
    if (m === 'electron') return { ipcRenderer: ipcRenderer };
    if (m === 'path') return { join: function () { return Array.prototype.slice.call(arguments).join('/'); } };
    if (String(m).indexOf('OnScreenKeyboard') >= 0) return window.__OSK_MODULE;
    throw new Error('غير متاح عن بعد: ' + m);
  };
  window.__dirname = '.';

  // ── Password screen + session banner ──────────────────────────────────
  var css = document.createElement('style');
  css.textContent =
    'body.remote-mode .header-actions, body.remote-mode #loading, body.remote-mode .osk-icon,' +
    'body.remote-mode [data-tab="security"], body.remote-mode [data-tab="cloud"], body.remote-mode [data-tab="updates"],' +
    'body.remote-mode #admin-clear-all-data, body.remote-mode #test-printer-settings,' +
    'body.remote-mode #categories-section, body.remote-mode #daily-summary-section, body.remote-mode #teller-wood-section { display: none !important; }' +
    '#hpos-remote-bar{position:sticky;top:0;z-index:30000;background:#4c1d95;color:#fff;display:flex;gap:1rem;align-items:center;justify-content:space-between;padding:0.5rem 1rem;font-family:inherit;direction:rtl}' +
    '#hpos-remote-bar button{background:#fff;color:#4c1d95;border:none;border-radius:6px;padding:0.35rem 0.8rem;font-weight:700;cursor:pointer}' +
    '#hpos-overlay{position:fixed;inset:0;z-index:40000;background:rgba(15,23,42,0.92);display:flex;align-items:center;justify-content:center;direction:rtl;font-family:Tahoma,Arial,sans-serif}' +
    '#hpos-overlay .box{background:#fff;border-radius:14px;padding:1.6rem;width:min(92vw,380px);text-align:center}' +
    '#hpos-overlay input{width:100%;padding:0.7rem;font-size:1.1rem;border:2px solid #cbd5e1;border-radius:8px;margin:0.8rem 0;box-sizing:border-box;text-align:center}' +
    '#hpos-overlay button{width:100%;padding:0.7rem;font-size:1rem;border:none;border-radius:8px;background:#4c1d95;color:#fff;font-weight:700;cursor:pointer}' +
    '#hpos-overlay .err{color:#b91c1c;min-height:1.3em;margin-top:0.6rem}#hpos-overlay a{display:block;margin-top:0.8rem;color:#475569}';
  document.head.appendChild(css);

  var overlay;
  function showOverlay(message) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'hpos-overlay';
      overlay.innerHTML = '<div class="box"><h2 style="margin:0 0 0.3rem">🖥 لوحة الإدارة عن بعد</h2>' +
        '<div id="hpos-ov-name" style="color:#4c1d95;font-weight:700"></div>' +
        '<div style="color:#64748b;font-size:0.9rem;margin-top:0.4rem">أدخل كلمة مرور الإدارة الخاصة بهذا الحمام</div>' +
        '<form id="hpos-ov-form"><input type="password" id="hpos-ov-pw" autocomplete="current-password" placeholder="كلمة مرور الإدارة" required>' +
        '<button type="submit" id="hpos-ov-btn">دخول</button></form><div class="err" id="hpos-ov-err"></div>' +
        '<a href="index.html">← العودة إلى لوحة المراقبة</a></div>';
      document.body.appendChild(overlay);
      document.getElementById('hpos-ov-form').onsubmit = function (e) { e.preventDefault(); unlock(); };
    }
    document.getElementById('hpos-ov-name').textContent = hammamName;
    document.getElementById('hpos-ov-err').textContent = message || '';
    overlay.style.display = 'flex';
    setTimeout(function () { var i = document.getElementById('hpos-ov-pw'); if (i) i.focus(); }, 50);
  }

  async function newSession() {
    var r = await sb.from('remote_sessions').insert({ location_id: LOC }).select('id').single();
    if (r.error) throw new Error(r.error.message);
    sessionId = r.data.id;
  }

  var unlocked = false;
  async function unlock() {
    var btn = document.getElementById('hpos-ov-btn'), err = document.getElementById('hpos-ov-err');
    var pw = document.getElementById('hpos-ov-pw').value;
    btn.disabled = true; err.textContent = 'جاري الاتصال بالجهاز...';
    try {
      if (!channel) await joinChannel();
      if (!sessionId || unlocked) { await newSession(); }
      var r = await raw('remote:open', [pw], 15000);
      if (!r.ok) { err.textContent = r.message || 'تعذّر الدخول'; if (r.error === 'session') sessionId = null; return; }
      unlocked = true;
      document.getElementById('hpos-ov-pw').value = '';
      overlay.style.display = 'none';
      startPanel();
      readyResolve();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  var panelStarted = false;
  function startPanel() {
    document.body.classList.add('remote-mode');
    if (!document.getElementById('hpos-remote-bar')) {
      var bar = document.createElement('div');
      bar.id = 'hpos-remote-bar';
      bar.innerHTML = '<span>🖥 جلسة إدارة عن بعد — <b id="hpos-bar-name"></b></span><button type="button" id="hpos-end">إنهاء الجلسة</button>';
      document.body.insertBefore(bar, document.body.firstChild);
      document.getElementById('hpos-end').onclick = endSession;
    }
    document.getElementById('hpos-bar-name').textContent = hammamName;
    if (panelStarted) return;
    panelStarted = true;
    // The app starts its normal screen on DOMContentLoaded; once it is up, open the admin panel.
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      // (the app keeps its api object private; its global functions show it has loaded)
      if (typeof window.showAdminDashboard === 'function' && document.readyState !== 'loading' && document.getElementById('admin-dashboard')) {
        clearInterval(t);
        window.closeAdminDashboard = endSession; // "back to selling" ends the remote session
        var back = document.getElementById('close-admin'); if (back) back.textContent = 'إنهاء الجلسة';
        window.showAdminDashboard();
      } else if (tries > 100) { clearInterval(t); }
    }, 150);
  }

  async function endSession() {
    try { if (channel && sessionId) await raw('remote:close', [], 5000); } catch (_) {}
    location.href = 'index.html';
  }

  window.addEventListener('beforeunload', function () {
    try { if (channel && sessionId) channel.send({ type: 'broadcast', event: 'req', payload: { id: 'bye', session: sessionId, channel: 'remote:close', args: [] } }); } catch (_) {}
  });

  // ── Start: must be logged in as the manager ───────────────────────────
  document.addEventListener('DOMContentLoaded', async function () {
    var s = await sb.auth.getSession();
    if (!s.data || !s.data.session) { location.href = 'index.html'; return; }
    if (sb.realtime && sb.realtime.setAuth) sb.realtime.setAuth(s.data.session.access_token);
    try {
      var loc = await sb.from('locations').select('name').eq('id', LOC).maybeSingle();
      hammamName = (loc.data && loc.data.name) || '';
      document.title = '🖥 ' + hammamName + ' — HammamPOS';
    } catch (_) {}
    showOverlay('');
  });
})();
