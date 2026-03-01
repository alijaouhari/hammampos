/**
 * HammamPOS - Inventory Management Plugin
 * Copyright (c) 2024 HammamPOS Solutions. All rights reserved.
 * 
 * This software is proprietary and confidential.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Premium feature for comprehensive inventory tracking
 */

class InventoryManagementPlugin {
  constructor() {
    this.id = 'inventory-management';
    this.name = 'Inventory Management';
    this.version = '1.0.0';
    this.isActive = false;
    this.context = null;
  }

  /**
   * Initialize plugin with system context
   * @param {PluginContext} context - System context
   */
  async initialize(context) {
    try {
      console.log('📦 Initializing Inventory Management Plugin...');
      
      this.context = context;
      
      // Apply database migrations
      await this.applyDatabaseMigrations();
      
      // Register UI components
      this.registerUIComponents();
      
      // Set up event listeners
      this.setupEventListeners();
      
      this.isActive = true;
      console.log('✅ Inventory Management Plugin initialized');
      
      return { success: true };
    } catch (error) {
      console.error('❌ Inventory Management Plugin initialization failed:', error);
      throw error;
    }
  }

  /**
   * Shutdown plugin
   */
  async shutdown() {
    try {
      console.log('🔄 Shutting down Inventory Management Plugin...');
      
      // Clean up event listeners
      this.removeEventListeners();
      
      this.isActive = false;
      console.log('✅ Inventory Management Plugin shutdown complete');
    } catch (error) {
      console.error('❌ Inventory Management Plugin shutdown failed:', error);
    }
  }

  /**
   * Apply database migrations for inventory tables
   */
  async applyDatabaseMigrations() {
    if (!this.context?.database) {
      throw new Error('Database context not available');
    }

    const db = this.context.database.db;

    // Create inventory_items table
    db.run(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(50),
        current_quantity DECIMAL(10,2) NOT NULL DEFAULT 0,
        minimum_threshold DECIMAL(10,2) NOT NULL DEFAULT 0,
        unit_cost DECIMAL(10,2),
        supplier_id INTEGER,
        barcode VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create inventory_transactions table
    db.run(`
      CREATE TABLE IF NOT EXISTS inventory_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        transaction_type VARCHAR(20) NOT NULL,
        quantity DECIMAL(10,2) NOT NULL,
        unit_cost DECIMAL(10,2),
        reference_id INTEGER,
        reference_type VARCHAR(50),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_id) REFERENCES inventory_items(id)
      )
    `);

    // Create suppliers table
    db.run(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(100) NOT NULL,
        contact_person VARCHAR(100),
        phone VARCHAR(20),
        email VARCHAR(100),
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.context.database.save();
    console.log('📊 Inventory database tables created');
  }

  /**
   * Register UI components with the main application
   */
  registerUIComponents() {
    // This would integrate with the main UI system
    console.log('🎨 Inventory UI components registered');
  }

  /**
   * Set up event listeners for inventory operations
   */
  setupEventListeners() {
    if (this.context?.events) {
      // Listen for service completion to deduct inventory
      this.context.events.on('serviceCompleted', this.handleServiceCompleted.bind(this));
      
      // Listen for inventory updates
      this.context.events.on('inventoryReceived', this.handleInventoryReceived.bind(this));
    }
  }

  /**
   * Remove event listeners
   */
  removeEventListeners() {
    if (this.context?.events) {
      this.context.events.removeAllListeners('serviceCompleted');
      this.context.events.removeAllListeners('inventoryReceived');
    }
  }

  /**
   * Handle service completion - deduct inventory
   * @param {Object} serviceData - Service completion data
   */
  async handleServiceCompleted(serviceData) {
    try {
      // Deduct inventory items used in service
      console.log('📦 Processing inventory deduction for service:', serviceData.serviceId);
      
      // Implementation would go here
      // - Look up service requirements
      // - Deduct quantities from inventory
      // - Create transaction records
      // - Check for low stock alerts
      
    } catch (error) {
      console.error('❌ Failed to process inventory deduction:', error);
    }
  }

  /**
   * Handle inventory received - update quantities
   * @param {Object} inventoryData - Inventory receipt data
   */
  async handleInventoryReceived(inventoryData) {
    try {
      console.log('📦 Processing inventory receipt:', inventoryData);
      
      // Implementation would go here
      // - Update item quantities
      // - Record transaction
      // - Update costs if provided
      
    } catch (error) {
      console.error('❌ Failed to process inventory receipt:', error);
    }
  }

  /**
   * Get UI components for main application integration
   * @returns {UIComponent[]} Array of UI components
   */
  getUIComponents() {
    return [
      {
        id: 'inventory-menu',
        type: 'menu',
        label: 'المخزون',
        icon: 'inventory',
        onClick: () => this.openInventoryPanel(),
        props: {
          position: 'main-menu'
        }
      },
      {
        id: 'inventory-dashboard',
        type: 'panel',
        label: 'لوحة المخزون',
        icon: 'dashboard',
        onClick: () => this.openInventoryDashboard(),
        props: {
          size: 'large'
        }
      }
    ];
  }

  /**
   * Get database migrations
   * @returns {DatabaseMigration[]} Array of migrations
   */
  getDatabaseMigrations() {
    return [
      {
        version: '1.0.0',
        description: 'Create inventory management tables',
        up: () => this.applyDatabaseMigrations(),
        down: () => this.rollbackDatabaseMigrations()
      }
    ];
  }

  /**
   * Get menu items for main application
   * @returns {Object[]} Array of menu items
   */
  getMenuItems() {
    return [
      {
        id: 'inventory',
        label: 'إدارة المخزون',
        icon: 'inventory',
        submenu: [
          {
            id: 'inventory-items',
            label: 'عناصر المخزون',
            onClick: () => this.openInventoryItems()
          },
          {
            id: 'inventory-transactions',
            label: 'حركات المخزون',
            onClick: () => this.openInventoryTransactions()
          },
          {
            id: 'suppliers',
            label: 'الموردين',
            onClick: () => this.openSuppliers()
          },
          {
            id: 'inventory-reports',
            label: 'تقارير المخزون',
            onClick: () => this.openInventoryReports()
          }
        ]
      }
    ];
  }

  /**
   * Get plugin settings
   * @returns {Object} Plugin settings
   */
  getSettings() {
    return {
      autoDeductInventory: true,
      lowStockAlerts: true,
      barcodeScanning: false,
      defaultSupplier: null
    };
  }

  /**
   * Open inventory panel
   */
  openInventoryPanel() {
    console.log('📦 Opening inventory panel...');
    // Implementation would show inventory management interface
  }

  /**
   * Open inventory dashboard
   */
  openInventoryDashboard() {
    console.log('📊 Opening inventory dashboard...');
    // Implementation would show inventory analytics and KPIs
  }

  /**
   * Open inventory items management
   */
  openInventoryItems() {
    console.log('📦 Opening inventory items...');
    // Implementation would show items list and management
  }

  /**
   * Open inventory transactions
   */
  openInventoryTransactions() {
    console.log('📋 Opening inventory transactions...');
    // Implementation would show transaction history
  }

  /**
   * Open suppliers management
   */
  openSuppliers() {
    console.log('🏪 Opening suppliers...');
    // Implementation would show supplier management
  }

  /**
   * Open inventory reports
   */
  openInventoryReports() {
    console.log('📊 Opening inventory reports...');
    // Implementation would show various inventory reports
  }

  /**
   * Rollback database migrations
   */
  async rollbackDatabaseMigrations() {
    if (!this.context?.database) return;

    const db = this.context.database.db;
    
    db.run('DROP TABLE IF EXISTS inventory_transactions');
    db.run('DROP TABLE IF EXISTS inventory_items');
    db.run('DROP TABLE IF EXISTS suppliers');
    
    this.context.database.save();
    console.log('🔄 Inventory database tables removed');
  }
}

module.exports = InventoryManagementPlugin;