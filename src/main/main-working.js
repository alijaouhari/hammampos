/**
 * HammamPOS - Main Process
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * Unauthorized copying or distribution is strictly prohibited.
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const StorageManager = require('../services/StorageManager');
const BackupManager = require('../services/BackupManager');
const ExcelManager = require('../services/ExcelManager');
const PrintManager = require('../services/PrintManager');
const SchedulerService = require('../services/SchedulerService');
const EmailService = require('../services/EmailService');
const ExpenseTemplateManager = require('../services/ExpenseTemplateManager');
const PluginManager = require('../plugins/core/PluginManager');
const LicenseManager = require('../plugins/core/LicenseManager');
// const CloudSyncManager = require('../services/CloudSyncManager'); // REMOVED
const CloudSync = require('../services/CloudSync');

// Keep a global reference of the window object
let mainWindow;
let setupWindow;
let licenseWindow;
let storage;
let backupManager;
let excelManager;
let printer;
let scheduler;
let emailService;
let expenseTemplates;
let pluginManager;
let licenseManager;
let cloudSync;

function createLicenseWindow() {
  // Create the license activation window
  licenseWindow = new BrowserWindow({
    width: 600,
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
      experimentalFeatures: true
    }
  });

  // Load the license activation HTML
  const licensePath = path.join(__dirname, '../renderer/license-activation.html');
  console.log('Loading License Activation from:', licensePath);
  licenseWindow.loadFile(licensePath);

  // Open DevTools in development mode
  if (process.argv.includes('--dev')) {
    licenseWindow.webContents.openDevTools();
  }

  licenseWindow.on('closed', () => {
    licenseWindow = null;
  });
}

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
      experimentalFeatures: true
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
      experimentalFeatures: true
    }
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

// Initialize backend services
app.whenReady().then(async () => {
  console.log('HammamPOS Main Process Started');
  
  try {
    // Initialize License Manager FIRST
    licenseManager = new LicenseManager();
    try {
      await licenseManager.initialize();
      console.log('✅ License Manager ready');
      console.log(`🖥️ Machine ID: ${licenseManager.getHardwareFingerprint().substring(0, 16)}...`);
    } catch (error) {
      console.error('❌ License Manager initialization failed:', error);
      licenseManager = null;
    }
    
    // Check base license BEFORE anything else — BYPASSED FOR TESTING
    const hasBaseLicense = licenseManager && await licenseManager.validateLicense('hammampos-core');
    
    if (!hasBaseLicense) {
      console.log('⚠️ LICENSE BYPASS: No valid license but continuing for testing');
    } else {
      console.log('✅ Base license validated - continuing startup');
    }
    
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
      return;
    }
    
    // Initialize Backup Manager (replaces Excel)
    try {
      console.log('🔧 Initializing Backup Manager...');
      backupManager = new BackupManager();
      console.log('✅ Backup Manager initialized successfully');
      
      // Test backup writing
      console.log('🧪 Testing backup writing...');
      // Backup manager doesn't need initialization test - it's simpler than Excel
      
    } catch (error) {
      console.error('❌ Backup Manager initialization failed:', error);
      console.error('Backup error stack:', error.stack);
      backupManager = null;
    }
    
    // Initialize Excel Manager (works alongside BackupManager)
    try {
      console.log('📊 Initializing Excel Manager...');
      excelManager = new ExcelManager();
      await excelManager.initialize();
      console.log('✅ Excel Manager initialized successfully');
      
    } catch (error) {
      console.error('❌ Excel Manager initialization failed:', error);
      console.error('Excel error stack:', error.stack);
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
        // Update scheduler with email service
        scheduler.email = emailService;
      } else {
        console.log('📧 Email service not configured or disabled');
      }
    } catch (error) {
      console.warn('⚠️ Email service not initialized:', error.message);
    }
    
    // Initialize Plugin Manager
    pluginManager = new PluginManager();
    try {
      // Create plugin context
      const pluginContext = {
        database: storage,
        ui: null, // Will be set when UI is ready
        licensing: licenseManager,
        events: new (require('events').EventEmitter)(),
        config: storage, // Using storage for config management
        logger: console,
        storage: storage,
        excel: excelManager
      };
      
      await pluginManager.initialize(pluginContext);
      console.log('✅ Plugin Manager ready');
      
      // Load all available plugins
      const loadResult = await pluginManager.loadAllPlugins();
      console.log(`🔌 Loaded ${loadResult.loadedPlugins.length} plugins`);
      
      if (loadResult.errors.length > 0) {
        console.warn(`⚠️ ${loadResult.errors.length} plugins failed to load`);
        loadResult.errors.forEach(error => {
          console.warn(`   - ${error.pluginId}: ${error.error}`);
        });
      }
      
    } catch (error) {
      console.error('❌ Plugin Manager initialization failed:', error);
      pluginManager = null;
    }
    
    // Initialize Cloud Sync Manager - DISABLED (removed feature)
    // Initialize Cloud Sync (optional — only if configured)
    cloudSync = new CloudSync(storage);
    try {
      await cloudSync.initialize();
    } catch (error) {
      console.warn('☁️ Cloud sync not available:', error.message);
      cloudSync = null;
    }
    
    createWindow();
    
  } catch (error) {
    console.error('Failed to initialize backend:', error);
    createWindow(); // Still create window even if backend fails
  }
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

// License operations
ipcMain.handle('license:getMachineId', async () => {
  if (!licenseManager) {
    throw new Error('License Manager not initialized');
  }
  return licenseManager.getHardwareFingerprint();
});

ipcMain.handle('license:activate', async (event, licenseKey, featureId) => {
  if (!licenseManager) {
    return { success: false, error: 'License Manager not initialized' };
  }
  return await licenseManager.activateLicense(licenseKey, featureId);
});

ipcMain.on('license:activated', () => {
  console.log('License activated - closing license window and continuing startup');
  
  if (licenseWindow) {
    licenseWindow.close();
    licenseWindow = null;
  }
  
  // Restart the initialization process
  initializeApplication();
});

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

ipcMain.handle('storage:getCashInHand', () => {
  return storage.getCashInHand();
});

ipcMain.handle('storage:getLifetimeRevenue', () => {
  return storage.getLifetimeRevenue();
});

ipcMain.handle('storage:getDailySummariesWithDetails', (event, limit) => {
  return storage.getDailySummariesWithDetails(limit);
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

// Rebuild Excel from database
ipcMain.handle('excel:rebuild', async () => {
  if (!excelManager || !storage) {
    return { error: 'Excel Manager or storage not initialized' };
  }
  return await excelManager.rebuildFromDatabase(storage);
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
  return await backupManager.rebuildFromDatabase(storage);
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

ipcMain.handle('storage:getCollections', (event, startDate, endDate) => {
  return storage.getCollections(startDate, endDate);
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
  return storage.getAllSettings();
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
  // Note: Deleted tickets are not removed from backups for audit trail
  return deletedTicket;
});

ipcMain.handle('storage:deleteExpense', async (event, expenseId) => {
  const deletedExpense = storage.deleteExpense(expenseId);
  // Note: Deleted expenses are not removed from backups for audit trail
  return deletedExpense;
});

ipcMain.handle('storage:deleteCollection', async (event, collectionId) => {
  const deletedCollection = storage.deleteCollection(collectionId);
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

// Clear all data handler (Testing only)
ipcMain.handle('storage:clearAllData', async () => {
  // Clear data from database
  const result = storage.clearAllData();
  
  // Also clear backup files
  if (backupManager) {
    try {
      await backupManager.clearAllBackups();
      console.log('✅ Backup files cleared');
    } catch (error) {
      console.warn('⚠️ Failed to clear backup files:', error.message);
    }
  }
  
  return result;
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

ipcMain.handle('setup:complete', async (event, setupData) => {
  try {
    console.log('Completing setup with data:', setupData);
    
    // Save hammam settings
    storage.setSetting('hammam_name', setupData.hammamName);
    storage.changeAdminPassword(setupData.adminPassword);
    storage.setSetting('printer_name', setupData.printer || '');
    
    // Save email settings
    storage.setSetting('email_enabled', setupData.emailEnabled ? 'true' : 'false');
    if (setupData.emailEnabled) {
      storage.setSetting('email_address', setupData.email);
      storage.setSetting('email_smtp_host', setupData.smtpHost);
      storage.setSetting('email_smtp_port', setupData.smtpPort);
      storage.setSetting('email_password', setupData.emailPassword);
    }
    
    // Save cloud sync settings (optional)
    if (setupData.cloudUrl) {
      storage.setSetting('cloud_url', setupData.cloudUrl);
      storage.setSetting('cloud_key', setupData.cloudKey);
      storage.setSetting('location_name', setupData.locationName || setupData.hammamName);
    }
    
    // Create categories
    setupData.categories.forEach(category => {
      storage.addCategory(category.name, category.price);
    });
    
    // Initialize Printer
    if (!printer) {
      printer = new PrintManager();
    }
    printer._getSavedPrinter = () => storage.getSetting('printer_name') || null;
    await printer.initialize(setupData.printer || null);
    
    console.log('✅ Setup completed successfully');
    return { success: true };
    
  } catch (error) {
    console.error('Setup completion failed:', error);
    throw error;
  }
});

ipcMain.on('setup:finished', async () => {
  console.log('Setup finished - closing setup window and initializing all services');
  
  if (setupWindow) {
    setupWindow.close();
    setupWindow = null;
  }
  
  // Re-run full initialization now that settings are saved
  // (First run exits early before initializing services like CloudSync, Scheduler, etc.)
  try {
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
      await excelManager.initialize();
      console.log('✅ Excel Manager initialized');
    } catch (error) {
      console.error('❌ Excel Manager initialization failed:', error);
      excelManager = null;
    }
    
    // Initialize Scheduler
    scheduler = new SchedulerService(storage);
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
      }
    } catch (error) {
      console.warn('⚠️ Email service not initialized:', error.message);
    }
    
    // Initialize Cloud Sync
    cloudSync = new CloudSync(storage);
    try {
      await cloudSync.initialize();
      console.log('✅ Cloud sync initialized after setup');
    } catch (error) {
      console.warn('☁️ Cloud sync not available:', error.message);
      cloudSync = null;
    }
    
  } catch (error) {
    console.error('❌ Post-setup initialization failed:', error);
  }
  
  // Create main window
  createWindow();
});

console.log('IPC handlers set up');