/**
 * HammamPOS - Main Process
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * Unauthorized copying or distribution is strictly prohibited.
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
// Keep a reference to every IPC handler so the remote admin panel (dashboard) can call
// the same handlers the local screen uses (see RemoteAdmin: allow-list + admin password).
const ipcHandlers = new Map();
{
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => { ipcHandlers.set(channel, fn); return originalHandle(channel, fn); };
}
const path = require('path');
const fs = require('fs');
const StorageManager = require('../services/StorageManager');
const BackupManager = require('../services/BackupManager');
const ExcelManager = require('../services/ExcelManager');
const PrintManager = require('../services/PrintManager');
const SchedulerService = require('../services/SchedulerService');
const EmailService = require('../services/EmailService');
const ExpenseTemplateManager = require('../services/ExpenseTemplateManager');
const CloudSync = require('../services/CloudSync');
// Last errors, shown in the diagnostics and sent to the dashboard with the heartbeat.
const recentErrors = [];
{
  const origError = console.error.bind(console);
  console.error = (...args) => {
    try {
      recentErrors.push(new Date().toISOString() + ' ' + args.map(a => (a && a.message) || String(a)).join(' ').slice(0, 300));
      if (recentErrors.length > 30) recentErrors.shift();
    } catch (_) {}
    origError(...args);
  };
}
const UpdateManager = require('../services/UpdateManager');
const MoneyService = require('../services/MoneyService');

// Keep a global reference of the window object
let mainWindow;
let money;
let setupWindow;
let storage;
let backupManager;
let excelManager;
let printer;
let scheduler;
let emailService;
let expenseTemplates;
let cloudSync;
let updateManager;

function createSetupWindow() {
  // Create the setup wizard window
  setupWindow = new BrowserWindow({
    width: 800,
    height: 700,
    show: true,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  // Load the setup wizard HTML
  const setupPath = path.join(__dirname, '../renderer/setup-wizard.html');
  console.log('Loading Setup Wizard from:', setupPath);
  setupWindow.loadFile(setupPath);

  // Open DevTools in development mode
  if (process.argv.includes('--dev')) {
    setupWindow.webContents.openDevTools();
  }

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

function createWindow() {
  // Create the browser window with security disabled (working setup)
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    autoHideMenuBar: true, // Hide the menu bar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  // Window title always shows the app version. The page's own <title> would
  // otherwise overwrite it on load, so intercept title changes and insert the
  // version after the "HammamPOS" prefix (same version source as UpdateManager).
  const appVersion = require('../../package.json').version;
  const withVersion = (pageTitle) => {
    const title = pageTitle || 'HammamPOS';
    return /^HammamPOS/.test(title)
      ? title.replace(/^HammamPOS/, `HammamPOS v${appVersion}`)
      : `HammamPOS v${appVersion} - ${title}`;
  };
  mainWindow.setTitle(withVersion(''));
  mainWindow.on('page-title-updated', (event, pageTitle) => {
    event.preventDefault();
    mainWindow.setTitle(withVersion(pageTitle));
  });

  // Load the main HammamPOS HTML
  const htmlPath = path.join(__dirname, '../renderer/hammampos.html');
  console.log('Loading HammamPOS from:', htmlPath);
  mainWindow.loadFile(htmlPath);

  // Open DevTools in development mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Debug events
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('HammamPOS page loaded');
    // Readability: the app pins the whole renderer to device-scale-factor=1
    // (required for 1:1 thermal-printer bitmaps). On high-DPI Windows displays
    // that makes the entire UI render at 100% and appear small. Compensate by
    // zooming the MAIN window only. This does NOT affect thermal printing, which
    // renders in its own separate hidden BrowserWindow (see PrintManager).
    try {
      mainWindow.webContents.setZoomFactor(1.25);
    } catch (_) {}
    // Signal successful startup for the updater handshake
    if (updateManager) {
      updateManager.signalStartupSuccess();
    }
  });

  mainWindow.webContents.on('dom-ready', () => {
    console.log('HammamPOS DOM ready');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Enable keyboard shortcuts (Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A)
const menuTemplate = [
  { label: 'Edit', submenu: [
    { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
    { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
  ]}
];
Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

// Force DPI scale factor to 1 so thermal printer bitmaps are always 1:1 pixel ratio
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// Only ONE copy of the app may run. Two copies each keep their own copy of the
// database in memory and the last one to save erases what the other recorded.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow || BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// Initialize backend services
app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  console.log('HammamPOS Main Process Started');

  // Desktop shortcut shows the version ("HammamPOS v2.8.27"). Installed app only;
  // never in development (npm start runs electron.exe, not HammamPOS.exe).
  if (app.isPackaged && process.platform === 'win32') {
    setTimeout(() => {
      try {
        const { shell } = require('electron');
        const { syncDesktopShortcutName } = require('./desktopShortcut');
        syncDesktopShortcutName({
          shell,
          desktopDirs: [app.getPath('desktop'), path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop')],
          exePath: process.execPath,
          version: require('../../package.json').version,
          log: (m) => console.log('🖥️ ' + m)
        });
      } catch (error) {
        console.warn('Desktop shortcut sync skipped:', error.message);
      }
    }, 5000);
  }
  
  try {
    await initializeApplication();
    
  } catch (error) {
    console.error('Failed to initialize:', error);
  }
});

async function initializeApplication() {
  try {
    // Initialize database
    storage = new StorageManager();
    await storage.initialize();
    console.log('✅ Database loaded');

    // Money system (tables are created on load; balances computed from records)
    money = new MoneyService(storage);
    storage.save();
    console.log('✅ Money service ready' + (money.isSwitchedOver() ? '' : ' (not switched over yet)'));
    
    // Initialize Expense Templates
    try {
      expenseTemplates = new ExpenseTemplateManager(storage);
      expenseTemplates.initialize();
      console.log('✅ Expense templates loaded');
    } catch (error) {
      console.error('❌ Expense templates initialization failed:', error);
      expenseTemplates = null;
    }
    
    // Check if this is first run (no hammam name set)
    const hammamName = storage.getSetting('hammam_name');
    if (!hammamName || hammamName === 'حمام') {
      console.log('First run detected - showing setup wizard');
      createSetupWindow();
      // Stop here. setup:finished will call initializeServices() → createWindow()
      return;
    }
    
    // Normal startup — initialize everything and show main window
    await initializeServices();
    createWindow();
    
  } catch (error) {
    console.error('Failed to initialize backend:', error);
    createWindow(); // Still create window even if backend fails
  }
}

/**
 * Initialize all backend services (backup, excel, printer, scheduler, email, plugins, cloud sync).
 * Called after DB + settings are ready — either on normal startup or after setup wizard finishes.
 */
async function initializeServices() {
  // Initialize Backup Manager
  try {
    backupManager = new BackupManager();
    console.log('✅ Backup Manager initialized');
  } catch (error) {
    console.error('❌ Backup Manager initialization failed:', error);
    backupManager = null;
  }
  
  // Initialize Excel Manager
  try {
    excelManager = new ExcelManager();
    await excelManager.initialize(storage, money, { dbPath: storage.dbPath });
    console.log('✅ Excel Manager initialized');
  } catch (error) {
    console.error('❌ Excel Manager initialization failed:', error);
    excelManager = null;
  }
  
  // Initialize Printer
  const savedPrinterName = storage.getSetting('printer_name');
  printer = new PrintManager();
  printer._getSavedPrinter = () => storage.getSetting('printer_name') || null;
  try {
    await printer.initialize(savedPrinterName || null);
    console.log('✅ Printer ready');
  } catch (error) {
    console.warn('⚠️ Printer not initialized:', error.message);
  }
  
  // Initialize Scheduler
  scheduler = new SchedulerService(storage);
    // Reports and the end-of-day record use the same cash in hand as the screens.
    scheduler.getCashInHand = () => (money ? money.getBalances().cashInHand : storage.getCashInHand());
  try {
    scheduler.initialize();
    console.log('✅ Scheduler ready');
  } catch (error) {
    console.warn('⚠️ Scheduler not initialized:', error.message);
  }
  
  // Initialize Email Service
  emailService = new EmailService(storage);
  try {
    const emailResult = await emailService.initialize();
    if (emailResult.success) {
      console.log('✅ Email service ready');
      scheduler.email = emailService;
    } else {
      console.log('📧 Email service not configured or disabled');
    }
  } catch (error) {
    console.warn('⚠️ Email service not initialized:', error.message);
  }
  
  // Initialize Cloud Sync (optional — only if configured)
  cloudSync = newCloudSync();
  try {
    await cloudSync.initialize();
  } catch (error) {
    console.warn('☁️ Cloud sync not available:', error.message);
    cloudSync = null;
  }
  
  // Initialize Update Manager and check for updates (non-blocking)
  updateManager = new UpdateManager();
  updateManager.checkForUpdate().then(update => {
    if (update) {
      console.log(`🔄 Update available: v${update.version}`);
    }
  }).catch(() => {});
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handlers for database operations
console.log('Setting up IPC handlers...');

// Storage operations
ipcMain.handle('storage:getCategories', () => {
  return storage.getCategories();
});

ipcMain.handle('storage:createTicket', async (event, categoryId) => {
  const ticket = storage.createTicket(categoryId);
  console.log('🎫 Ticket created, adding to backups and Excel:', ticket);
  
  // Add to backup files
  if (backupManager) {
    try {
      await backupManager.addTicket(ticket);
      console.log('✅ Ticket added to backups successfully');
    } catch (error) {
      console.error('❌ Failed to add ticket to backups:', error);
    }
  } else {
    console.warn('⚠️ Backup Manager not initialized, skipping backup write for ticket');
  }
  
  // Add to Excel
  if (excelManager) {
    try {
      await excelManager.addTicket(ticket);
      console.log('✅ Ticket added to Excel successfully');
    } catch (error) {
      console.error('❌ Failed to add ticket to Excel:', error);
    }
  } else {
    console.warn('⚠️ Excel Manager not initialized, skipping Excel write for ticket');
  }
  
  // Sync to cloud (non-blocking)
  if (cloudSync) cloudSync.syncTicket(ticket).catch(() => {});
  
  return ticket;
});

// ── Cloud sync helpers ─────────────────────────────────────────────────
function cloudLocalRows() {
  return {
    tickets: storage.getTickets('2000-01-01', '2099-12-31').filter(t => !t.refunded_at),
    expenses: storage.getExpenses('2000-01-01', '2099-12-31'),
    collections: storage.getCollections('2000-01-01', '2099-12-31')
  };
}

let historyCache = null;
function historyDiagnostics() {
  if (historyCache && Date.now() - historyCache.at < 3600000) return historyCache.data;
  let data = null;
  try {
    data = storage.getHistoryDiagnostics(75);
    data.backupCsv = backupManager && backupManager.getTicketCsvCoverage ? backupManager.getTicketCsvCoverage(data.since) : null;
    data.backupDir = backupManager ? backupManager.backupDir : null;
    data.safetyCopies = storage.listSafetyCopies();
  } catch (error) {
    data = { error: error.message };
  }
  historyCache = { at: Date.now(), data };
  return data;
}

function deviceInfo() {
  let dbSize = null;
  try { dbSize = require('fs').statSync(storage.dbPath).size; } catch (_) {}
  return {
    version: app.getVersion(),
    platform: process.platform,
    dbPath: storage.dbPath,
    dbSize,
    counts: storage.getTableCounts(),
    switchedOver: money ? money.isSwitchedOver() : null,
    refundsEnabled: money ? money.getRefundsEnabled() : null,
    recentErrors: recentErrors.slice(-10),
    lastDbConflict: storage.lastConflict || null,
    history: historyDiagnostics(),
    uptimeMin: Math.round(process.uptime() / 60)
  };
}

// Support actions the manager can run from the dashboard (see RemoteCommands.ALLOWED_ACTIONS).
const remoteCommandHandlers = {
  ping: () => ({ version: app.getVersion(), time: new Date().toISOString(), uptimeMin: Math.round(process.uptime() / 60) }),
  sync_now: async () => {
    if (!cloudSync) throw new Error('السحابة غير مفعلة');
    const r = await cloudSync.reconcile();
    if (!r.ok) throw new Error(r.error || 'فشلت المزامنة');
    return r.tables;
  },
  diagnostics: () => {
    historyCache = null; // fresh numbers
    return { ...deviceInfo(), cloud: cloudSync ? cloudSync.getStatus() : null };
  },
  restart_app: () => ({
    result: { restarting: true },
    after: () => { app.relaunch(); app.exit(0); }
  }),
  restart_pc: () => ({
    result: { restartingInSeconds: 30 },
    after: () => {
      require('child_process').exec('shutdown /r /t 30 /c "HammamPOS: إعادة تشغيل الجهاز بطلب من المدير"', { windowsHide: true });
    }
  }),
  install_update: async () => {
    if (!updateManager) throw new Error('مدير التحديث غير جاهز');
    const u = await updateManager.checkForUpdate();
    if (!u) return { upToDate: true, version: app.getVersion() };
    await updateManager.downloadUpdate();
    return {
      result: { installing: u.version, from: app.getVersion() },
      after: () => { updateManager.applyAndRestart(); setTimeout(() => app.quit(), 1000); }
    };
  }
};

// ── Last-known summary for the dashboard (sent with the heartbeat, cached 60 s) ──
let summaryCache = null;
function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function buildSummary() {
  if (summaryCache && Date.now() - summaryCache.at < 60000) return summaryCache.data;
  const rows = (sql, params = []) => {
    const r = storage.db.exec(sql, params);
    return r[0] ? r[0].values : [];
  };
  const one = (sql, params = []) => { const v = rows(sql, params)[0]; return v ? v[0] : null; };
  let data;
  try {
    const today = localDay(0);
    const since = localDay(-34);
    const monthStart = localDay(-370).slice(0, 7);
    const b = money ? money.getBalances() : { cashInHand: storage.getCashInHand() };
    const salesDay = Object.fromEntries(rows("SELECT date, COUNT(*), COALESCE(SUM(price),0) FROM tickets WHERE refunded_at IS NULL AND date >= ? GROUP BY date", [since]).map(([d, n, s]) => [d, [n, s]]));
    const expDay = Object.fromEntries(rows('SELECT date, COALESCE(SUM(amount),0) FROM expenses WHERE date >= ? GROUP BY date', [since]));
    const days = [];
    for (let i = 34; i >= 0; i--) {
      const d = localDay(-i);
      days.push([d, (salesDay[d] || [0, 0])[0], Math.round(((salesDay[d] || [0, 0])[1]) * 100) / 100, Math.round((expDay[d] || 0) * 100) / 100]);
    }
    const mSales = Object.fromEntries(rows("SELECT substr(date,1,7), COUNT(*), COALESCE(SUM(price),0) FROM tickets WHERE refunded_at IS NULL AND substr(date,1,7) >= ? GROUP BY 1", [monthStart]).map(([m, n, s]) => [m, [n, s]]));
    const mExp = Object.fromEntries(rows('SELECT substr(date,1,7), COALESCE(SUM(amount),0) FROM expenses WHERE substr(date,1,7) >= ? GROUP BY 1', [monthStart]));
    const months = Array.from(new Set([...Object.keys(mSales), ...Object.keys(mExp)])).sort().slice(-12)
      .map(m => [m, (mSales[m] || [0, 0])[0], Math.round(((mSales[m] || [0, 0])[1]) * 100) / 100, Math.round((mExp[m] || 0) * 100) / 100]);
    const t = salesDay[today] || [0, 0];
    const bills = money && b.switchedOver ? money.getBills({ openOnly: true }) : [];
    const late = money && b.switchedOver ? money.getLateEntries({ pendingOnly: true }) : [];
    const cats = rows("SELECT category_name, COUNT(*), COALESCE(SUM(price),0) FROM tickets WHERE refunded_at IS NULL AND date = ? GROUP BY category_name", [today]);
    data = {
      v: 1,
      hammam: storage.getSetting('hammam_name') || null,
      day: today,
      switchedOver: !!b.switchedOver,
      cashInHand: b.cashInHand || 0,
      owedToSuppliers: b.owedToSuppliers || 0,
      owedToManager: b.owedToManager || 0,
      owedBySeller: b.owedBySeller || 0,
      changeFloat: (() => { try { return storage.getFloatBalance ? storage.getFloatBalance() : null; } catch (_) { return null; } })(),
      today: {
        tickets: t[0], sales: Math.round(t[1] * 100) / 100,
        expenses: Math.round((expDay[today] || 0) * 100) / 100,
        refunds: one("SELECT COUNT(*) FROM tickets WHERE refunded_at IS NOT NULL AND date = ?", [today]) || 0,
        byCategory: cats.map(([c, n, s]) => [c, n, Math.round(s * 100) / 100])
      },
      lastTicketAt: one("SELECT date || ' ' || time FROM tickets ORDER BY id DESC LIMIT 1"),
      openBills: { count: bills.length, total: Math.round(bills.reduce((a, x) => a + (x.remaining || 0), 0) * 100) / 100 },
      pendingLate: { count: late.length, total: Math.round(late.reduce((a, x) => a + (x.amount || 0), 0) * 100) / 100 },
      refundsEnabled: money ? money.getRefundsEnabled() : false,
      days, months
    };
  } catch (error) {
    data = { v: 1, error: error.message };
  }
  summaryCache = { at: Date.now(), data };
  return data;
}

// Notifications stored by the money system, delivered to the dashboard by the heartbeat.
const notificationHooks = {
  pending: () => {
    const r = storage.db.exec("SELECT id, type, payload, created_at FROM notifications WHERE delivery_status = 'pending' ORDER BY id LIMIT 50");
    return r[0] ? r[0].values.map(([id, type, payload, created_at]) => ({ id, type, payload: (() => { try { return JSON.parse(payload || '{}'); } catch (_) { return {}; } })(), created_at })) : [];
  },
  delivered: (ids) => {
    if (!ids.length) return;
    storage.db.run(`UPDATE notifications SET delivery_status = 'delivered', delivered_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [new Date().toISOString().replace('T', ' ').slice(0, 19), ...ids]);
    storage.save();
  }
};

// The manager's remote admin panel: same handlers as the local screen.
const remoteAdminHooks = {
  invoke: async (channel, args) => {
    const fn = ipcHandlers.get(channel);
    if (!fn) throw new Error('إجراء غير معروف: ' + channel);
    return fn({ remote: true }, ...args);
  },
  verifyPassword: (password) => storage.verifyAdminPassword(password),
  onSessionsChanged: (count) => {
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-admin:sessions', count); } catch (_) {}
  }
};

function newCloudSync() {
  return new CloudSync(storage, {
    appVersion: app.getVersion(), getDeviceInfo: deviceInfo, getLocalRows: cloudLocalRows,
    commandHandlers: remoteCommandHandlers, remoteAdmin: remoteAdminHooks,
    getSummary: buildSummary, notifications: notificationHooks
  });
}

// Called after anything that deletes / edits / refunds / cancels: the cloud copy is compared soon.
function cloudChanged() {
  if (cloudSync) cloudSync.scheduleReconcile();
}

ipcMain.handle('cloud:getStatus', () => (cloudSync ? cloudSync.getStatus() : { enabled: false }));
ipcMain.handle('cloud:testConnection', async (event, url, key) => {
  const locationId = storage.getSetting('location_id') || null;
  const sameProject = !url || url === storage.getSetting('cloud_url');
  const device = sameProject && storage.getSetting('device_email')
    ? { email: storage.getSetting('device_email'), password: storage.getSetting('device_password') }
    : null;
  return CloudSync.testConnection(url || storage.getSetting('cloud_url'), key || storage.getSetting('cloud_key'), sameProject ? locationId : null, device);
});
ipcMain.handle('cloud:reconnect', async () => {
  if (cloudSync) { try { await cloudSync.stop(); } catch (_) {} }
  cloudSync = newCloudSync();
  const res = await cloudSync.initialize();
  return { ...res, status: cloudSync.getStatus() };
});
ipcMain.handle('cloud:fullSync', async () => {
  if (!cloudSync || !cloudSync.enabled) return { ok: false, error: 'السحابة غير مفعلة' };
  return cloudSync.reconcile();
});
ipcMain.handle('cloud:applyConnectionCode', async (event, code) => {
  let c;
  try { c = CloudSync.decodeConnection(code); } catch (e) { return { ok: false, error: e.message }; }
  // HPOS2 codes carry this PC's own login; an old HPOS1 code clears it (shared key).
  const st = await applyConnectionCodeValue(code);
  return { ok: st.enabled === true && st.online === true, name: c.name, status: st, error: st.online ? null : st.lastError };
});
ipcMain.handle('diagnostics:get', () => ({ ...deviceInfo(), cloud: cloudSync ? cloudSync.getStatus() : null, appData: process.env.APPDATA || null }));

// Remote linking: support can drop a connection code in the data folder as
// connection-code.txt (over SSH); the running app applies it within 30 s and deletes it.
function saveConnectionSettings(c) {
  storage.setSetting('cloud_url', c.url);
  storage.setSetting('cloud_key', c.key);
  if (c.locationId) storage.setSetting('location_id', c.locationId);
  if (c.name) storage.setSetting('location_name', c.name);
  storage.setSetting('device_email', c.deviceEmail || '');
  storage.setSetting('device_password', c.devicePassword || '');
}
async function applyConnectionCodeValue(code) {
  saveConnectionSettings(CloudSync.decodeConnection(code));
  if (cloudSync) { try { await cloudSync.stop(); } catch (_) {} }
  cloudSync = newCloudSync();
  await cloudSync.initialize();
  return cloudSync.getStatus();
}
let codeFileBusy = false;
setInterval(async () => {
  if (codeFileBusy || !storage) return;
  const file = path.join(path.dirname(storage.dbPath), 'connection-code.txt');
  if (!fs.existsSync(file)) return;
  codeFileBusy = true;
  try {
    const code = fs.readFileSync(file, 'utf8').trim();
    fs.unlinkSync(file);
    const st = await applyConnectionCodeValue(code);
    storage.logAudit('CLOUD_LINK', 'settings', null, `connection code applied from file (mode ${st.mode}, online ${st.online})`);
    storage.save();
    console.log('☁️ Connection code applied from file:', st.mode, st.online ? 'online' : st.lastError);
  } catch (error) {
    console.error('Connection code file rejected:', error.message);
  } finally {
    codeFileBusy = false;
  }
}, 30000).unref();

ipcMain.handle('storage:getTodayTickets', () => {
  return storage.getTodayTickets();
});

ipcMain.handle('storage:addExpense', async (event, description, amount) => {
  const id = storage.addExpense(description, amount);
  const expense = { id, description, amount, date: new Date().toISOString().split('T')[0], time: new Date().toTimeString().split(' ')[0] };
  
  console.log('💸 Expense created, adding to backups and Excel:', expense);
  
  // Add to backup files
  if (backupManager) {
    try {
      await backupManager.addExpense(expense);
      console.log('✅ Expense added to backups successfully');
    } catch (error) {
      console.error('❌ Failed to add expense to backups:', error);
    }
  } else {
    console.warn('⚠️ Backup Manager not initialized, skipping backup write for expense');
  }
  
  // Add to Excel
  if (excelManager) {
    try {
      await excelManager.addExpense(expense);
      console.log('✅ Expense added to Excel successfully');
    } catch (error) {
      console.error('❌ Failed to add expense to Excel:', error);
    }
  } else {
    console.warn('⚠️ Excel Manager not initialized, skipping Excel write for expense');
  }
  
  // Sync to cloud (non-blocking)
  if (cloudSync) cloudSync.syncExpense(expense).catch(() => {});
  
  return id;
});

// Full-featured expense entry: separates expense day / paid state / payment source.
// opts = { description, amount, date, paid, paymentSource, paidDate }
ipcMain.handle('storage:recordExpense', async (event, opts) => {
  const res = storage.recordExpense(opts || {});
  if (!res.success) return res;

  const ex = storage.getExpense(res.id) || {};
  const expense = {
    id: res.id,
    description: ex.description,
    amount: ex.amount,
    date: ex.date,
    time: ex.time,
    paid: ex.paid,
    paid_date: ex.paid_date,
    payment_source: ex.payment_source
  };

  // Mirror the created expense to backups/Excel/cloud in the BACKGROUND so it never
  // blocks the save confirmation (same durability copy path as storage:addExpense).
  if (backupManager) { backupManager.addExpense(expense).catch(err => console.error('backup addExpense failed:', err)); }
  if (excelManager) { excelManager.addExpense(expense).catch(err => console.error('excel addExpense failed:', err)); }
  if (cloudSync) cloudSync.syncExpense(expense).catch(() => {});

  return res;
});

// Pay a previously-unpaid expense exactly once. opts = { paidDate, paymentSource }.
ipcMain.handle('storage:payExpense', (event, expenseId, opts) => {
  if (money && money.isSwitchedOver()) {
    return { success: false, error: 'دفع الفواتير غير المدفوعة متوفر في الخطوة التالية من نظام المال الجديد' };
  }
  return storage.payExpense(expenseId, opts || {});
});

ipcMain.handle('storage:getExpense', (event, id) => {
  return storage.getExpense(id);
});

ipcMain.handle('storage:getOutstandingExpenses', () => {
  return storage.getOutstandingExpenses();
});

ipcMain.handle('storage:getCashInHand', () => {
  return storage.getCashInHand();
});

// ── Money system ──────────────────────────────────────────────────────────
ipcMain.handle('money:getBalances', () => {
  if (!money) throw new Error('Money service not ready');
  return money.getBalances();
});

// Admin only (the renderer calls it from the password-protected admin panel).
ipcMain.handle('money:switchOver', () => {
  return money.switchOver();
});

ipcMain.handle('money:getNotifications', (event, limit) => {
  return money.getNotifications(limit || 100);
});

// Copy the old-table mirror of a new expense to backups/Excel/cloud (background,
// same fields as before so the current dashboard keeps working).
function mirrorNewExpense(mirrorExpenseId) {
  const ex = mirrorExpenseId ? storage.getExpense(mirrorExpenseId) : null;
  if (!ex) return;
  const expense = {
    id: ex.id, description: ex.description, amount: ex.amount, date: ex.date, time: ex.time,
    paid: ex.paid, paid_date: ex.paid_date, payment_source: ex.payment_source
  };
  if (backupManager) backupManager.addExpense(expense).catch(err => console.error('backup addExpense failed:', err));
  if (excelManager) excelManager.addExpense(expense).catch(err => console.error('excel addExpense failed:', err));
  if (cloudSync) cloudSync.syncExpense(expense).catch(() => {});
}

// Copy the old-table mirror of a new collection to backups/Excel/cloud (background).
function mirrorNewCollection(mirrorCollectionId) {
  const row = mirrorCollectionId ? storage.getCollections().find(c => c.id === mirrorCollectionId) : null;
  if (!row) return;
  const collection = { id: row.id, amount: row.amount, notes: row.notes, date: row.date, time: row.time, timestamp: row.timestamp };
  if (backupManager) backupManager.addCollection(collection).catch(err => console.error('backup addCollection failed:', err));
  if (excelManager) excelManager.addCollection(collection).catch(err => console.error('excel addCollection failed:', err));
  if (cloudSync) cloudSync.syncCollection(collection).catch(() => {});
}

// Seller debts (shortages) and late entries — manager decisions.
ipcMain.handle('money:getSellerDebts', () => money.getSellerDebts());
ipcMain.handle('money:markSellerRepayment', (event, amount, note) => money.markSellerRepayment(amount, note));
ipcMain.handle('money:getLateEntries', (event, opts) => money.getLateEntries(opts || {}));
ipcMain.handle('money:acceptLateEntry', (event, paymentId) => money.acceptLateEntry(paymentId));
ipcMain.handle('money:rejectLateEntry', (event, paymentId) => money.rejectLateEntry(paymentId));

// The manager's visit: period summary, then count + collect.
ipcMain.handle('money:getPeriodSummary', () => {
  return money.getPeriodSummary();
});
ipcMain.handle('money:collectInPerson', (event, opts) => {
  const res = money.collectInPerson(opts || {});
  if (res.success && res.collection) mirrorNewCollection(res.collection.mirror_collection_id);
  return res;
});

// Deposits / transfers / paid on the manager's behalf. byManager=true from admin.
ipcMain.handle('money:recordRemoteCollection', (event, opts, byManager) => {
  const res = money.recordRemoteCollection({ ...(opts || {}), recordedBy: byManager ? 'manager' : 'seller' });
  if (res.success) mirrorNewCollection(res.mirrorCollectionId);
  return res;
});
ipcMain.handle('money:getCollections', (event, opts) => {
  return money.getCollections(opts || {});
});
ipcMain.handle('money:cancelCollection', (event, id, reason) => {
  const res = money.cancelCollection(id, reason);
  cloudChanged();
  return res;
});

// Refunds: seller refunds (same day, ≤ 2 hours); manager can undo.
ipcMain.handle('money:refundTicket', (event, ticketId, reason) => {
  const res = money.refundTicket(ticketId, reason);
  cloudChanged();
  return res;
});
ipcMain.handle('money:undoRefund', (event, ticketId) => {
  const res = money.undoRefund(ticketId);
  cloudChanged();
  return res;
});
// Refund on/off switch (manager)
ipcMain.handle('money:getRefundsEnabled', () => money.getRefundsEnabled());
ipcMain.handle('money:setRefundsEnabled', (event, on) => money.setRefundsEnabled(!!on));
// Manager edit / delete / history
ipcMain.handle('money:getExpenseByMirror', (event, oldId) => money.getExpenseByMirror(oldId));
ipcMain.handle('money:previewDeleteExpense', (event, oldId) => {
  const e = money.getExpenseByMirror(oldId);
  return e ? money.previewDeleteExpense(e.id) : { success: false, error: 'not-linked' };
});
ipcMain.handle('money:editExpense', (event, oldId, fields) => {
  const e = money.getExpenseByMirror(oldId);
  const res = e ? money.editExpense(e.id, fields) : { success: false, error: 'هذا المصروف قديم ولا يمكن تعديله هنا' };
  cloudChanged();
  return res;
});
ipcMain.handle('money:previewDeleteCollection', (event, oldId) => {
  const c = money.getCollectionByMirror(oldId);
  return c ? money.previewCancelCollection(c.id) : { success: false, error: 'not-linked' };
});
ipcMain.handle('money:editCollection', (event, id, fields) => { const res = money.editCollection(id, fields); cloudChanged(); return res; });
ipcMain.handle('money:getHistory', (event, opts) => money.getHistory(opts || {}));
ipcMain.handle('money:getDaySummary', (event, date) => money.getDaySummary(date));
ipcMain.handle('money:getRefundStatusForDate', (event, date) => {
  return money.getRefundStatusForDate(date);
});

ipcMain.handle('money:getBills', (event, opts) => {
  return money.getBills(opts || {});
});

// source 'drawer' (seller or manager) | 'manager' (admin panel only: paid from pocket)
ipcMain.handle('money:payBill', (event, expenseId, amount, source, byManager) => {
  return money.payBill(expenseId, amount, source, { createdBy: byManager ? 'manager' : 'seller' });
});

// opts = { date, description, supplier, total, fromDrawer, restAs: 'unpaid'|'manager' }
ipcMain.handle('money:recordExpense', (event, opts) => {
  const res = money.recordExpense(opts || {});
  if (res.success) mirrorNewExpense(res.mirrorExpenseId);
  return res;
});

ipcMain.handle('storage:getLifetimeRevenue', () => {
  return storage.getLifetimeRevenue();
});

ipcMain.handle('storage:getDailySummariesWithDetails', (event, limit, range) => {
  return storage.getDailySummariesWithDetails(limit, range || null);
});

ipcMain.handle('storage:getLedgerDateBounds', () => {
  return storage.getLedgerDateBounds();
});

ipcMain.handle('storage:getTicketsForDate', (event, date) => {
  return storage.getTicketsForDate(date);
});

ipcMain.handle('storage:getTickets', (event, startDate, endDate) => {
  return storage.getTickets(startDate, endDate);
});

// Excel Manager status and operations
ipcMain.handle('excel:getStatus', async () => {
  if (!excelManager) {
    return { 
      error: 'Excel Manager not initialized',
      initialized: false
    };
  }
  
  try {
    const status = excelManager.getStatus();
    status.initialized = true;
    return status;
  } catch (error) {
    return {
      error: error.message,
      initialized: false
    };
  }
});

// Open the Excel copy (rebuilt first if it's missing or a change is waiting).
ipcMain.handle('excel:open', async () => {
  if (!excelManager || !storage) return { error: 'ملف Excel غير متاح' };
  try {
    const st = excelManager.getStatus();
    if (!st.exists || st.pending) await excelManager.rebuildFromDatabase(storage, money);
  } catch (error) {
    if (!excelManager.getStatus().exists) return { error: error.message };
  }
  const { shell } = require('electron');
  const err = await shell.openPath(excelManager.excelPath);
  return err ? { error: 'لا يوجد برنامج لفتح ملفات Excel على هذا الجهاز (' + err + ')' } : { success: true };
});
ipcMain.handle('excel:showInFolder', async () => {
  if (!excelManager) return { error: 'ملف Excel غير متاح' };
  const { shell } = require('electron');
  if (fs.existsSync(excelManager.excelPath)) shell.showItemInFolder(excelManager.excelPath);
  else { const e = await shell.openPath(path.dirname(excelManager.excelPath)); if (e) return { error: e }; }
  return { success: true };
});
// Rebuild Excel from database
ipcMain.handle('excel:rebuild', async () => {
  if (!excelManager || !storage) {
    return { error: 'Excel Manager or storage not initialized' };
  }
  return await excelManager.rebuildFromDatabase(storage, money);
});

// Backup Manager status and operations
ipcMain.handle('backup:getStatus', async () => {
  if (!backupManager) {
    return { 
      error: 'Backup Manager not initialized',
      initialized: false
    };
  }
  
  try {
    const status = await backupManager.getBackupStatus();
    status.initialized = true;
    return status;
  } catch (error) {
    return {
      error: error.message,
      initialized: false
    };
  }
});

// Rebuild backups from database
ipcMain.handle('backup:rebuild', async () => {
  if (!backupManager || !storage) {
    return { error: 'Backup Manager or storage not initialized' };
  }
  return await backupManager.rebuildFromDatabase(storage, money);
});

// Clear all backups
ipcMain.handle('backup:clearAll', async () => {
  if (!backupManager) {
    return { error: 'Backup Manager not initialized' };
  }
  return await backupManager.clearAllBackups();
});

ipcMain.handle('storage:getExpensesForDate', (event, date) => {
  return storage.getExpensesForDate(date);
});

ipcMain.handle('storage:getExpenses', (event, startDate, endDate) => {
  return storage.getExpenses(startDate, endDate);
});

ipcMain.handle('storage:collectMoney', async (event, amount, notes) => {
  const id = storage.collectMoney(amount, notes);
  const collection = { id, amount, notes, date: new Date().toISOString().split('T')[0], time: new Date().toTimeString().split(' ')[0] };
  
  // Add to backup files
  if (backupManager) {
    try {
      await backupManager.addCollection(collection);
      console.log('✅ Collection added to backups successfully');
    } catch (error) {
      console.error('❌ Failed to add collection to backups:', error);
    }
  }
  
  // Add to Excel
  if (excelManager) {
    try {
      await excelManager.addCollection(collection);
      console.log('✅ Collection added to Excel successfully');
    } catch (error) {
      console.error('❌ Failed to add collection to Excel:', error);
    }
  }
  
  // Sync to cloud (non-blocking)
  if (cloudSync) cloudSync.syncCollection(collection).catch(() => {});
  
  return id;
});

// Collect money for a specific set of days (persists day associations atomically)
ipcMain.handle('storage:collectMoneyForDays', async (event, amount, notes, days, dayAmounts) => {
  const result = storage.collectMoneyForDays(amount, notes, days, dayAmounts || {});
  const collection = { id: result.id, amount: result.amount, notes: result.notes, date: result.date, time: result.time };

  // Add to backup files (mirror pattern, best-effort — must not fail the DB write)
  if (backupManager) {
    try {
      await backupManager.addCollection(collection);
      console.log('✅ Collection added to backups successfully');
    } catch (error) {
      console.error('❌ Failed to add collection to backups:', error);
    }
  }

  // Add to Excel (best-effort)
  if (excelManager) {
    try {
      await excelManager.addCollection(collection);
      console.log('✅ Collection added to Excel successfully');
    } catch (error) {
      console.error('❌ Failed to add collection to Excel:', error);
    }
  }

  // Sync to cloud (non-blocking)
  if (cloudSync) cloudSync.syncCollection(collection).catch(() => {});

  return result;
});

ipcMain.handle('storage:getCollections', (event, startDate, endDate) => {
  return storage.getCollections(startDate, endDate);
});

ipcMain.handle('storage:getCollectedDays', () => {
  return storage.getCollectedDays();
});

ipcMain.handle('storage:getCollectionDays', (event, collectionId) => {
  return storage.getCollectionDays(collectionId);
});
ipcMain.handle('storage:getCollectionDaysWithAmounts', (event, collectionId) => {
  return storage.getCollectionDaysWithAmounts(collectionId);
});

// New collection/cash-flow model
ipcMain.handle('storage:getAvailableCollectionDays', (event, limit) => {
  return storage.getAvailableCollectionDays(limit || 60);
});

// Zakat tracking (informational only — zero financial effect)
ipcMain.handle('storage:getZakatVisibility', () => {
  return storage.getZakatVisibility();
});

// Day-based Zakat (2.5% of each day's income)
ipcMain.handle('storage:setZakatDay', (event, date, setAside) => {
  return storage.setZakatDay(date, setAside);
});
ipcMain.handle('storage:getZakatSetAsideDates', () => {
  return storage.getZakatSetAsideDates();
});
ipcMain.handle('storage:getZakatDaysHistory', () => {
  return storage.getZakatDaysHistory();
});

// Day status operations
ipcMain.handle('dayStatus:set', (event, date, status) => {
  return storage.setDayStatus(date, status);
});

ipcMain.handle('dayStatus:get', (event, date) => {
  return storage.getDayStatus(date);
});

// Teller change float operations (kept separate from sales/expenses/collections)
ipcMain.handle('float:add', async (event, amount, note) => {
  const result = storage.addFloat(amount, note);
  if (!result.success) return result;

  const operation = {
    id: result.id,
    operation: 'add',
    amount: result.amount,
    balance_after: result.balance,
    note: result.note,
    date: result.date,
    time: result.time
  };

  if (backupManager) {
    try {
      await backupManager.addFloatOperation(operation);
      console.log('✅ Float operation added to backups successfully');
    } catch (error) {
      console.error('❌ Failed to add float operation to backups:', error);
    }
  }

  if (excelManager) {
    try {
      await excelManager.addFloatOperation(operation);
      console.log('✅ Float operation added to Excel successfully');
    } catch (error) {
      console.error('❌ Failed to add float operation to Excel:', error);
    }
  }

  return result;
});

ipcMain.handle('float:take', async (event, amount, note) => {
  const result = storage.takeFloat(amount, note);
  if (!result.success) return result;

  const operation = {
    id: result.id,
    operation: 'take',
    amount: result.amount,
    balance_after: result.balance,
    note: result.note,
    date: result.date,
    time: result.time
  };

  if (backupManager) {
    try {
      await backupManager.addFloatOperation(operation);
      console.log('✅ Float operation added to backups successfully');
    } catch (error) {
      console.error('❌ Failed to add float operation to backups:', error);
    }
  }

  if (excelManager) {
    try {
      await excelManager.addFloatOperation(operation);
      console.log('✅ Float operation added to Excel successfully');
    } catch (error) {
      console.error('❌ Failed to add float operation to Excel:', error);
    }
  }

  return result;
});

ipcMain.handle('float:getBalance', (event) => {
  return storage.getFloatBalance();
});

ipcMain.handle('float:getHistory', (event) => {
  return storage.getFloatHistory();
});

// Printer operations
ipcMain.handle('printer:printTicket', async (event, ticket, hammamData) => {
  return await printer.printTicket(ticket, hammamData);
});

ipcMain.handle('printer:printTest', async () => {
  return await printer.printTest();
});

// Settings operations
ipcMain.handle('settings:verifyAdminPassword', (event, password) => {
  return storage.verifyAdminPassword(password);
});

ipcMain.handle('settings:getAll', () => {
  const all = storage.getAllSettings();
  // The device login stays in the main process; the screen only needs to know it exists.
  if (all.device_password) all.device_password = '••••••';
  return all;
});

ipcMain.handle('settings:updateSettings', (event, settings) => {
  return storage.updateSettings(settings);
});

ipcMain.handle('settings:setSetting', (event, key, value) => {
  if (key === 'admin_password_change') {
    storage.changeAdminPassword(value);
  } else {
    storage.setSetting(key, value);
  }
  return true;
});

// Category management operations
ipcMain.handle('storage:addCategory', async (event, name, price) => {
  const id = storage.addCategory(name, price);
  return id;
});

ipcMain.handle('storage:updateCategory', async (event, id, name, price) => {
  const result = storage.updateCategory(id, name, price);
  return result;
});

ipcMain.handle('storage:toggleCategory', async (event, id, active) => {
  const result = storage.toggleCategory(id, active);
  return result;
});

// Delete operations (Admin only)
ipcMain.handle('storage:deleteTicket', async (event, ticketId) => {
  const deletedTicket = storage.deleteTicket(ticketId);
  cloudChanged();
  // Note: Deleted tickets are not removed from backups for audit trail
  return deletedTicket;
});

ipcMain.handle('storage:deleteExpense', async (event, expenseId) => {
  const deletedExpense = storage.deleteExpense(expenseId);
  if (money) money.onMirrorExpenseDeleted(expenseId);
  cloudChanged();
  // Note: Deleted expenses are not removed from backups for audit trail
  return deletedExpense;
});

ipcMain.handle('storage:deleteCollection', async (event, collectionId) => {
  const deletedCollection = storage.deleteCollection(collectionId);
  if (money) money.onMirrorCollectionDeleted(collectionId);
  cloudChanged();
  // Note: Deleted collections are not removed from backups for audit trail
  return deletedCollection;
});

// Expense template handlers
ipcMain.handle('expenseTemplates:getTemplates', (event, activeOnly) => {
  if (!expenseTemplates) {
    return [];
  }
  return expenseTemplates.getTemplates(activeOnly);
});

ipcMain.handle('expenseTemplates:getTemplatesByCategory', (event, activeOnly) => {
  if (!expenseTemplates) {
    return {};
  }
  return expenseTemplates.getTemplatesByCategory(activeOnly);
});

ipcMain.handle('expenseTemplates:createFromTemplate', async (event, templateId, quantity, customAmount, notes) => {
  if (!expenseTemplates) {
    throw new Error('Expense templates not available');
  }
  
  const expenseId = expenseTemplates.createExpenseFromTemplate(templateId, quantity, customAmount, notes);
  
  const expense = {
    id: expenseId,
    description: notes || 'From template',
    amount: customAmount || 0,
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().split(' ')[0]
  };
  
  // Add to backup files
  if (backupManager) {
    await backupManager.addExpense(expense);
  }
  
  // Add to Excel
  if (excelManager) {
    await excelManager.addExpense(expense);
  }
  
  return expenseId;
});

// Compute-only: resolve a template into { amount, description, pricingKind } WITHOUT
// inserting. The unified expense form calls this, then storage:recordExpense so the
// expense day / paid state / payment source apply uniformly to template expenses too.
ipcMain.handle('expenseTemplates:resolveTemplate', (event, templateId, quantity, customAmount, notes) => {
  if (!expenseTemplates) return { success: false, error: 'Expense templates not available' };
  return expenseTemplates.getTemplateAmountAndDescription(templateId, quantity, customAmount, notes);
});

ipcMain.handle('expenseTemplates:addWoodPurchase', async (event, supplierName, grossWeight, emptyWeight, pricePerKg, deliveryDate, notes) => {
  if (!expenseTemplates) {
    throw new Error('Expense templates not available');
  }
  
  const result = expenseTemplates.addWoodPurchase(supplierName, grossWeight, emptyWeight, pricePerKg, deliveryDate, notes);
  
  const expense = {
    id: result.expenseId,
    description: `خشب - ${supplierName} (${result.netWeight} كغ)`,
    amount: result.totalAmount,
    date: deliveryDate,
    time: new Date().toTimeString().split(' ')[0]
  };
  
  // Add to backup files
  if (backupManager) {
    await backupManager.addExpense(expense);
  }
  
  // Add to Excel
  if (excelManager) {
    await excelManager.addExpense(expense);
  }
  
  return result;
});

ipcMain.handle('expenseTemplates:getWoodPurchases', (event, limit) => {
  if (!expenseTemplates) {
    return [];
  }
  return expenseTemplates.getWoodPurchases(limit);
});

// Reusable expense-type management (create / rename / enable-disable).
// Reuses the existing ExpenseTemplateManager. Types are persistent expense_templates rows.
ipcMain.handle('expenseTemplates:addTemplate', (event, name, category, description) => {
  if (!expenseTemplates) {
    return { success: false, error: 'Expense templates not available' };
  }
  const cleanName = (name == null ? '' : String(name).trim());
  if (!cleanName) {
    return { success: false, error: 'الاسم مطلوب' };
  }
  const id = expenseTemplates.addTemplate(cleanName, (category && String(category).trim()) || 'عام', null, null, null, description || '');
  return { success: true, id };
});

ipcMain.handle('expenseTemplates:updateTemplate', (event, id, name, category, description) => {
  if (!expenseTemplates) {
    return { success: false, error: 'Expense templates not available' };
  }
  const cleanName = (name == null ? '' : String(name).trim());
  if (!cleanName) {
    return { success: false, error: 'الاسم مطلوب' };
  }
  expenseTemplates.updateTemplate(id, cleanName, (category && String(category).trim()) || 'عام', null, null, null, description || '');
  return { success: true };
});

ipcMain.handle('expenseTemplates:toggleTemplate', (event, id, active) => {
  if (!expenseTemplates) {
    return { success: false, error: 'Expense templates not available' };
  }
  expenseTemplates.toggleTemplate(id, active);
  return { success: true };
});

// ─── Wood sellers + wood purchases (Task #4) ────────────────────────
ipcMain.handle('wood:addSeller', (event, name, phone, woodType, defaultPricePerKg, notes) => {
  if (!expenseTemplates) return { success: false, error: 'غير متاح' };
  return expenseTemplates.addWoodSeller(name, phone, woodType, defaultPricePerKg, notes);
});

ipcMain.handle('wood:getSellers', (event, activeOnly) => {
  if (!expenseTemplates) return [];
  return expenseTemplates.getWoodSellers(activeOnly);
});

ipcMain.handle('wood:updateSeller', (event, id, name, phone, woodType, defaultPricePerKg, notes) => {
  if (!expenseTemplates) return { success: false, error: 'غير متاح' };
  return expenseTemplates.updateWoodSeller(id, name, phone, woodType, defaultPricePerKg, notes);
});

ipcMain.handle('wood:toggleSeller', (event, id, active) => {
  if (!expenseTemplates) return { success: false, error: 'غير متاح' };
  return expenseTemplates.toggleWoodSeller(id, active);
});

ipcMain.handle('wood:deleteSeller', (event, id) => {
  if (!expenseTemplates) return { success: false, error: 'غير متاح' };
  return expenseTemplates.deleteWoodSeller(id);
});

ipcMain.handle('wood:recordPurchase', (event, opts) => {
  if (!expenseTemplates) return { success: false, error: 'غير متاح' };
  // New money system: wood follows the same drawer-split rules as any expense.
  if (money && money.isSwitchedOver()) {
    const res = money.recordWoodPurchase(expenseTemplates, opts || {});
    if (res.success) mirrorNewExpense(res.mirrorExpenseId);
    return res;
  }
  // recordWoodPurchase persists the row synchronously (storage.save() writes the
  // DB file) BEFORE we return, so the purchase is durable immediately.
  const result = expenseTemplates.recordWoodPurchase(opts);
  if (!result.success) return result;
  // Mirror the created expense (if paid now) to backups/Excel/cloud in the
  // BACKGROUND. This is a secondary durability copy and must NOT block the save
  // confirmation — awaiting a slow Excel/backup write here was the cause of the
  // purchase "taking a long time to appear / needing a restart" (v2.8.18 bug).
  if (result.expenseId && backupManager) {
    const expense = { id: result.expenseId, description: 'خشب', amount: result.totalAmount, date: (opts && opts.deliveryDate) || new Date().toISOString().split('T')[0], time: new Date().toTimeString().split(' ')[0] };
    Promise.resolve()
      .then(() => backupManager.addExpense(expense))
      .catch(e => console.error('wood expense backup failed', e));
    if (excelManager) {
      Promise.resolve()
        .then(() => excelManager.addExpense(expense))
        .catch(e => console.error('wood expense excel failed', e));
    }
    if (cloudSync) cloudSync.syncExpense(expense).catch(() => {});
  }
  // Return the DB-backed result right away so the renderer confirms + refreshes now.
  return result;
});

ipcMain.handle('wood:payPurchase', (event, woodId, paidDate) => {
  if (!expenseTemplates) return { success: false, error: 'غير متاح' };
  if (money && money.isSwitchedOver()) {
    return { success: false, error: 'دفع الفواتير غير المدفوعة متوفر في الخطوة التالية من نظام المال الجديد' };
  }
  const result = expenseTemplates.payWoodPurchase(woodId, paidDate);
  if (!result.success) return result;
  // Background mirroring (non-blocking) — same reasoning as recordPurchase.
  if (result.expenseId && backupManager) {
    const expense = { id: result.expenseId, description: 'خشب (دفعة)', amount: 0, date: paidDate || new Date().toISOString().split('T')[0], time: new Date().toTimeString().split(' ')[0] };
    Promise.resolve()
      .then(() => backupManager.addExpense(expense))
      .catch(e => console.error('wood pay backup failed', e));
    if (excelManager) {
      Promise.resolve()
        .then(() => excelManager.addExpense(expense))
        .catch(e => console.error('wood pay excel failed', e));
    }
  }
  return result;
});

ipcMain.handle('wood:getPurchases', (event, limit) => {
  if (!expenseTemplates) return [];
  return expenseTemplates.getWoodPurchases(limit || 50);
});

ipcMain.handle('wood:getSellerTypes', (event, sellerId) => {
  if (!expenseTemplates) return [];
  return expenseTemplates.getWoodSellerTypes(sellerId);
});

ipcMain.handle('wood:getOutstanding', (event) => {
  if (!expenseTemplates) return [];
  return expenseTemplates.getOutstandingWoodPurchases();
});

ipcMain.handle('wood:getBySeller', (event) => {
  if (!expenseTemplates) return [];
  return expenseTemplates.getWoodBySeller();
});

ipcMain.handle('wood:getByType', (event) => {
  if (!expenseTemplates) return [];
  return expenseTemplates.getWoodByType();
});

// Clear all data handler (Testing only)
ipcMain.handle('storage:clearAllData', async () => {
  // Clear data from database
  const result = storage.clearAllData();
  // New money system records go too, otherwise cash in hand would stay negative.
  if (money) { money.clearMoneyData(); storage.save(); }
  
  // Also clear backup files
  let backupsCleared = !backupManager;
  if (backupManager) {
    try {
      await backupManager.clearAllBackups();
      backupsCleared = true;
      console.log('Backup files cleared');
    } catch (error) {
      console.warn('Failed to clear backup files:', error.message);
    }
  }

  // The Excel file is rebuilt from the (now empty) database, otherwise it keeps every old row.
  let excelCleared = !excelManager;
  if (excelManager) {
    try {
      await excelManager.rebuildFromDatabase(storage, money);
      excelCleared = true;
    } catch (error) {
      console.warn('Failed to clear Excel:', error.message);
    }
  }

  // The cloud copy of this device. If the internet is down the comparison runs again
  // as soon as the connection is back, so the old rows never stay in the dashboard.
  let cloud = { skipped: true };
  if (cloudSync && cloudSync.enabled) {
    cloud = await cloudSync.wipeCloud();
    if (!cloud.ok) cloudSync.scheduleReconcile(10000);
  }

  // Prove it: re-read the file from disk.
  const verify = storage.verifyWipe();
  return { ...result, backupsCleared, excelCleared, cloud, verify };
});

// Generate test data handler (Testing only)
ipcMain.handle('storage:generateTestData', async (event, period) => {
  try {
    const TestDataGenerator = require('../services/TestDataGenerator');
    const generator = new TestDataGenerator();
    
    // Use existing storage instance
    generator.storage = storage;
    generator.backupManager = backupManager;
    generator.categories = storage.getCategories(false);
    
    if (generator.categories.length === 0) {
      console.log('📋 No categories found, creating default categories...');
      storage.addCategory('رجال', 15);
      storage.addCategory('نساء', 15);
      storage.addCategory('أولاد', 10);
      storage.addCategory('بنات', 10);
      generator.categories = storage.getCategories(false);
    }
    
    let result;
    if (period === 'all') {
      await generator.generateTestPeriods();
      result = { success: true, message: 'Generated all test periods' };
    } else {
      result = await generator.generateSinglePeriod(period);
      result.success = true;
    }
    
    return result;
  } catch (error) {
    console.error('❌ Failed to generate test data:', error);
    return { success: false, error: error.message };
  }
});

// Setup wizard handlers
ipcMain.handle('printer:listPrinters', async () => {
  try {
    if (!printer) {
      printer = new PrintManager();
    }
    return await printer.listPrinters();
  } catch (error) {
    console.error('Failed to list printers:', error);
    return [];
  }
});

ipcMain.handle('printer:testPrint', async (event, printerName) => {
  try {
    if (!printer) {
      printer = new PrintManager();
    }
    await printer.testPrint(printerName);
    return { success: true };
  } catch (error) {
    console.error('Test print failed:', error);
    throw error;
  }
});

ipcMain.handle('email:testConnection', async (event, emailConfig) => {
  try {
    if (!emailService) {
      emailService = new EmailService(storage);
    }
    await emailService.testConnection(emailConfig);
    return { success: true };
  } catch (error) {
    console.error('Email test failed:', error);
    throw error;
  }
});

ipcMain.handle('setup:checkCode', (event, code) => {
  try { const c = CloudSync.decodeConnection(String(code || '')); return { ok: true, name: c.name || null }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('setup:complete', async (event, setupData) => {
  try {
    console.log('Completing setup for:', setupData.hammamName);
    storage.setSetting('ui_language', setupData.language === 'fr' ? 'fr' : 'ar');
    
    // Save hammam settings
    storage.setSetting('hammam_name', setupData.hammamName);
    storage.changeAdminPassword(setupData.adminPassword);
    const recoveryKey = storage.generateRecoveryKey();
    storage.setSetting('printer_name', setupData.printer || '');
    
    // Save email settings
    storage.setSetting('email_enabled', setupData.emailEnabled ? 'true' : 'false');
    if (setupData.emailEnabled) {
      storage.setSetting('email_address', setupData.email);
      storage.setSetting('email_smtp_host', setupData.smtpHost);
      storage.setSetting('email_smtp_port', setupData.smtpPort);
      storage.setSetting('email_password', setupData.emailPassword);
    }
    
    // Cloud link (optional): the app connects when it starts after the wizard
    if (setupData.connectionCode) saveConnectionSettings(CloudSync.decodeConnection(setupData.connectionCode));
    
    // Create categories
    setupData.categories.forEach(category => {
      storage.addCategory(category.name, category.price);
    });
    
    // Initialize Printer
    if (!printer) {
      printer = new PrintManager();
    }
    printer._getSavedPrinter = () => storage.getSetting('printer_name') || null;
    // A printer problem must not stop the setup (it can be fixed in the settings).
    try { await printer.initialize(setupData.printer || null); }
    catch (e) { console.warn('Printer not ready after setup:', e.message); }
    
    console.log('✅ Setup completed successfully');
    return { success: true, recoveryKey };
    
  } catch (error) {
    console.error('Setup completion failed:', error);
    throw error;
  }
});

// ── Admin password recovery ─────────────────────────────────────────────
const maskEmail = (e) => {
  const [name, domain] = String(e || '').split('@');
  if (!name || !domain) return null;
  return name.slice(0, 1) + '***@' + domain;
};

ipcMain.handle('recovery:getStatus', () => {
  const hasMail = !!(storage.getSetting('email_address') && storage.getSetting('email_password'));
  return {
    hasKey: storage.hasRecoveryKey(),
    maskedEmail: hasMail ? maskEmail(storage.getSetting('email_address')) : null,
    lockedMs: storage.getRecoveryLockMs()
  };
});

// Creating a new key needs the current admin password.
ipcMain.handle('recovery:generateKey', (event, currentPassword) => {
  if (!storage.verifyAdminPassword(String(currentPassword || ''))) {
    return { ok: false, reason: 'wrong_password' };
  }
  return { ok: true, key: storage.generateRecoveryKey() };
});

ipcMain.handle('recovery:sendCode', async () => {
  const to = storage.getSetting('email_address');
  if (!to || !storage.getSetting('email_password')) return { ok: false, reason: 'not_configured' };
  const created = storage.createResetCode();
  if (!created.ok) return created;
  try {
    if (!emailService) emailService = new EmailService(storage);
    const name = storage.getSetting('hammam_name') || 'HammamPOS';
    await emailService.sendSecurityEmail(
      to,
      'رمز استرداد كلمة مرور الإدارة - ' + name,
      '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;">' +
      '<p>رمز استرداد كلمة مرور الإدارة:</p>' +
      '<p style="font-size:32px;font-weight:bold;letter-spacing:6px;direction:ltr;">' + created.code + '</p>' +
      '<p>صالح لمدة 15 دقيقة ويُستعمل مرة واحدة. إذا لم تطلبه فتجاهل هذه الرسالة.</p></div>'
    );
    return { ok: true, maskedEmail: maskEmail(to) };
  } catch (error) {
    console.error('Reset code email failed:', error.message);
    storage.clearResetCode();
    return { ok: false, reason: 'send_failed' };
  }
});

ipcMain.handle('recovery:resetWithKey', (event, key, newPassword) => {
  return storage.resetAdminPasswordWithKey(key, newPassword);
});

ipcMain.handle('recovery:resetWithCode', (event, code, newPassword) => {
  return storage.resetAdminPasswordWithCode(code, newPassword);
});

// Update system handlers
ipcMain.handle('update:getStatus', () => {
  if (!updateManager) return { currentVersion: '0.0.0', latestRelease: null };
  return updateManager.getStatus();
});

ipcMain.handle('update:check', async () => {
  if (!updateManager) return null;
  return await updateManager.checkForUpdate();
});

ipcMain.handle('update:download', async () => {
  if (!updateManager) throw new Error('Update manager not ready');
  return await updateManager.downloadUpdate();
});

ipcMain.handle('update:apply', () => {
  if (!updateManager) throw new Error('Update manager not ready');
  const result = updateManager.applyAndRestart();
  // VBS launcher is now running independently (outside Job Object).
  // Give renderer time to acknowledge the response, then exit cleanly
  // so the PS1 script can rename our install directory.
  setTimeout(() => { app.quit(); }, 1000);
  return result;
});

ipcMain.handle('update:revert', async (event, version) => {
  if (!updateManager) throw new Error('Update manager not ready');
  if (version) {
    // Download specific version from GitHub and install it
    const result = await updateManager.downloadAndInstallVersion(version);
    setTimeout(() => { app.quit(); }, 1000);
    return result;
  }
  // Legacy: revert from local backup
  const result = updateManager.revertAndRestart();
  setTimeout(() => { app.quit(); }, 1000);
  return result;
});

ipcMain.handle('update:getProgress', () => {
  if (!updateManager) return 0;
  return updateManager.downloadProgress;
});

ipcMain.handle('update:getReleases', async () => {
  if (!updateManager) return [];
  return await updateManager.fetchAllReleases();
});

ipcMain.on('setup:finished', async () => {
  console.log('Setup finished - initializing services and opening main app');
  
  // Initialize all services now that settings are saved by the wizard
  await initializeServices();
  
  // Open main window first (so window-all-closed doesn't quit the app)
  createWindow();
  
  // Then close setup window
  if (setupWindow) {
    setupWindow.close();
    setupWindow = null;
  }
});

console.log('IPC handlers set up');