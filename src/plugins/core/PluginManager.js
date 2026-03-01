/**
 * HammamPOS - PluginManager
 * Copyright (c) 2024 HammamPOS Solutions. All rights reserved.
 * 
 * This software is proprietary and confidential.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Core Plugin System Management - Handles plugin lifecycle, registration, and coordination
 */

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const chokidar = require('chokidar');

class PluginManager extends EventEmitter {
  constructor(pluginsPath = null) {
    super();
    this.pluginsPath = pluginsPath || path.join(__dirname, '..', 'features');
    this.loadedPlugins = new Map();
    this.pluginRegistry = new Map();
    this.isInitialized = false;
    this.context = null;
    this.watcher = null;
    this.hotReloadEnabled = true;
  }

  /**
   * Initialize plugin manager with system context
   * @param {PluginContext} context - System context for plugins
   */
  async initialize(context) {
    try {
      console.log('🔌 Initializing Plugin Manager...');
      
      this.context = context;
      
      // Create plugins directory if it doesn't exist
      if (!fs.existsSync(this.pluginsPath)) {
        fs.mkdirSync(this.pluginsPath, { recursive: true });
        console.log(`📁 Created plugins directory: ${this.pluginsPath}`);
      }

      // Initialize plugin registry in database
      await this.initializePluginRegistry();
      
      // Start file system watcher for hot reloading
      if (this.hotReloadEnabled) {
        this.startFileWatcher();
      }
      
      this.isInitialized = true;
      console.log('✅ Plugin Manager initialized');
      
      this.emit('initialized');
      return { success: true };
    } catch (error) {
      console.error('❌ Plugin Manager initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize plugin registry database table
   */
  async initializePluginRegistry() {
    if (!this.context?.database) {
      throw new Error('Database context not available');
    }

    // Create plugin registry table
    this.context.database.db.run(`
      CREATE TABLE IF NOT EXISTS plugin_registry (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        version VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'unloaded',
        license_required BOOLEAN DEFAULT FALSE,
        load_order INTEGER,
        last_loaded TIMESTAMP,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.context.database.save();
    console.log('📊 Plugin registry table initialized');
  }

  /**
   * Discover all available plugins
   * @returns {PluginDescriptor[]} Array of plugin descriptors
   */
  async discoverPlugins() {
    const plugins = [];
    
    try {
      if (!fs.existsSync(this.pluginsPath)) {
        console.log('📁 No plugins directory found');
        return plugins;
      }

      const entries = fs.readdirSync(this.pluginsPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pluginPath = path.join(this.pluginsPath, entry.name);
          const descriptor = await this.loadPluginDescriptor(pluginPath);
          
          if (descriptor) {
            plugins.push(descriptor);
            console.log(`🔍 Discovered plugin: ${descriptor.name} v${descriptor.version}`);
          }
        }
      }
      
      console.log(`📦 Discovered ${plugins.length} plugins`);
      return plugins;
    } catch (error) {
      console.error('❌ Plugin discovery failed:', error);
      return plugins;
    }
  }

  /**
   * Load plugin descriptor from plugin.json
   * @param {string} pluginPath - Path to plugin directory
   * @returns {PluginDescriptor|null} Plugin descriptor or null if invalid
   */
  async loadPluginDescriptor(pluginPath) {
    try {
      const manifestPath = path.join(pluginPath, 'plugin.json');
      
      if (!fs.existsSync(manifestPath)) {
        console.warn(`⚠️ No plugin.json found in ${pluginPath}`);
        return null;
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf8');
      const descriptor = JSON.parse(manifestContent);

      // Validate required fields
      if (!descriptor.id || !descriptor.name || !descriptor.version || !descriptor.entryPoint) {
        console.warn(`⚠️ Invalid plugin descriptor in ${pluginPath}`);
        return null;
      }

      // Set defaults
      descriptor.dependencies = descriptor.dependencies || [];
      descriptor.licenseRequired = descriptor.licenseRequired || false;
      descriptor.author = descriptor.author || 'Unknown';
      descriptor.description = descriptor.description || '';
      descriptor.permissions = descriptor.permissions || {};

      // Resolve entry point path
      descriptor.entryPointPath = path.join(pluginPath, descriptor.entryPoint);

      return descriptor;
    } catch (error) {
      console.error(`❌ Failed to load plugin descriptor from ${pluginPath}:`, error);
      return null;
    }
  }

  /**
   * Load a specific plugin
   * @param {PluginDescriptor} descriptor - Plugin descriptor
   * @returns {Plugin|null} Loaded plugin instance or null if failed
   */
  async loadPlugin(descriptor) {
    try {
      console.log(`🔄 Loading plugin: ${descriptor.name}`);

      // Check if already loaded
      if (this.loadedPlugins.has(descriptor.id)) {
        console.log(`⚠️ Plugin ${descriptor.id} already loaded`);
        return this.loadedPlugins.get(descriptor.id);
      }

      // Validate license if required
      if (descriptor.licenseRequired && this.context?.licensing) {
        const isLicensed = await this.context.licensing.validateLicense(descriptor.id);
        if (!isLicensed) {
          throw new Error(`License required for plugin: ${descriptor.id}`);
        }
      }

      // Load plugin module
      if (!fs.existsSync(descriptor.entryPointPath)) {
        throw new Error(`Entry point not found: ${descriptor.entryPointPath}`);
      }

      // Clear require cache to enable hot reloading
      delete require.cache[require.resolve(descriptor.entryPointPath)];
      
      const PluginClass = require(descriptor.entryPointPath);
      const plugin = new PluginClass();

      // Set plugin metadata
      plugin.id = descriptor.id;
      plugin.name = descriptor.name;
      plugin.version = descriptor.version;
      plugin.isActive = false;

      // Initialize plugin with context
      if (typeof plugin.initialize === 'function') {
        await plugin.initialize(this.context);
        plugin.isActive = true;
      }

      // Register plugin
      this.loadedPlugins.set(descriptor.id, plugin);
      this.pluginRegistry.set(descriptor.id, descriptor);

      // Update database registry
      await this.updatePluginRegistry(descriptor, 'loaded', null);

      console.log(`✅ Plugin loaded: ${descriptor.name}`);
      this.emit('pluginLoaded', plugin);

      return plugin;
    } catch (error) {
      console.error(`❌ Failed to load plugin ${descriptor.id}:`, error);
      
      // Update database registry with error
      await this.updatePluginRegistry(descriptor, 'error', error.message);
      
      this.emit('pluginLoadError', descriptor, error);
      return null;
    }
  }

  /**
   * Unload a plugin
   * @param {string} pluginId - Plugin identifier
   */
  async unloadPlugin(pluginId) {
    try {
      const plugin = this.loadedPlugins.get(pluginId);
      if (!plugin) {
        console.warn(`⚠️ Plugin ${pluginId} not loaded`);
        return;
      }

      console.log(`🔄 Unloading plugin: ${plugin.name}`);

      // Shutdown plugin
      if (typeof plugin.shutdown === 'function') {
        await plugin.shutdown();
      }

      // Remove from registry
      this.loadedPlugins.delete(pluginId);
      
      // Update database registry
      const descriptor = this.pluginRegistry.get(pluginId);
      if (descriptor) {
        await this.updatePluginRegistry(descriptor, 'unloaded', null);
      }

      console.log(`✅ Plugin unloaded: ${plugin.name}`);
      this.emit('pluginUnloaded', plugin);
    } catch (error) {
      console.error(`❌ Failed to unload plugin ${pluginId}:`, error);
    }
  }

  /**
   * Load all discovered plugins with dependency resolution
   * @returns {PluginLoadResult} Load operation result
   */
  async loadAllPlugins() {
    try {
      console.log('🚀 Loading all plugins...');
      
      const descriptors = await this.discoverPlugins();
      const loadedPlugins = [];
      const errors = [];
      const loadOrder = [];

      // Sort plugins by dependencies (topological sort)
      const sortedDescriptors = this.resolveDependencies(descriptors);

      for (const descriptor of sortedDescriptors) {
        const plugin = await this.loadPlugin(descriptor);
        
        if (plugin) {
          loadedPlugins.push(plugin);
          loadOrder.push(descriptor.id);
        } else {
          errors.push({
            pluginId: descriptor.id,
            error: `Failed to load plugin: ${descriptor.name}`
          });
        }
      }

      console.log(`✅ Loaded ${loadedPlugins.length}/${descriptors.length} plugins`);
      
      return {
        success: true,
        loadedPlugins,
        errors,
        loadOrder
      };
    } catch (error) {
      console.error('❌ Failed to load plugins:', error);
      return {
        success: false,
        loadedPlugins: [],
        errors: [{ error: error.message }],
        loadOrder: []
      };
    }
  }

  /**
   * Resolve plugin dependencies and return sorted array
   * @param {PluginDescriptor[]} descriptors - Plugin descriptors
   * @returns {PluginDescriptor[]} Dependency-sorted descriptors
   */
  resolveDependencies(descriptors) {
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (descriptor) => {
      if (visiting.has(descriptor.id)) {
        throw new Error(`Circular dependency detected: ${descriptor.id}`);
      }
      
      if (visited.has(descriptor.id)) {
        return;
      }

      visiting.add(descriptor.id);

      // Visit dependencies first
      for (const depId of descriptor.dependencies) {
        const depDescriptor = descriptors.find(d => d.id === depId);
        if (depDescriptor) {
          visit(depDescriptor);
        } else {
          console.warn(`⚠️ Dependency not found: ${depId} for plugin ${descriptor.id}`);
        }
      }

      visiting.delete(descriptor.id);
      visited.add(descriptor.id);
      sorted.push(descriptor);
    };

    for (const descriptor of descriptors) {
      if (!visited.has(descriptor.id)) {
        visit(descriptor);
      }
    }

    return sorted;
  }

  /**
   * Update plugin registry in database
   * @param {PluginDescriptor} descriptor - Plugin descriptor
   * @param {string} status - Plugin status
   * @param {string} errorMessage - Error message if any
   */
  async updatePluginRegistry(descriptor, status, errorMessage) {
    if (!this.context?.database) return;

    try {
      this.context.database.db.run(`
        INSERT OR REPLACE INTO plugin_registry 
        (id, name, version, status, license_required, last_loaded, error_message, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'))
      `, [
        descriptor.id,
        descriptor.name,
        descriptor.version,
        status,
        descriptor.licenseRequired ? 1 : 0,
        errorMessage
      ]);

      this.context.database.save();
    } catch (error) {
      console.error('❌ Failed to update plugin registry:', error);
    }
  }

  /**
   * Get all loaded plugins
   * @returns {Plugin[]} Array of loaded plugins
   */
  getLoadedPlugins() {
    return Array.from(this.loadedPlugins.values());
  }

  /**
   * Get plugin by ID
   * @param {string} pluginId - Plugin identifier
   * @returns {Plugin|null} Plugin instance or null
   */
  getPlugin(pluginId) {
    return this.loadedPlugins.get(pluginId) || null;
  }

  /**
   * Check if plugin is loaded
   * @param {string} pluginId - Plugin identifier
   * @returns {boolean} True if plugin is loaded
   */
  isPluginLoaded(pluginId) {
    return this.loadedPlugins.has(pluginId);
  }

  /**
   * Get plugin registry status
   * @returns {Object} Registry status information
   */
  getRegistryStatus() {
    return {
      totalPlugins: this.pluginRegistry.size,
      loadedPlugins: this.loadedPlugins.size,
      pluginsPath: this.pluginsPath,
      isInitialized: this.isInitialized,
      hotReloadEnabled: this.hotReloadEnabled,
      watcherActive: this.watcher !== null
    };
  }

  /**
   * Start file system watcher for hot reloading
   */
  startFileWatcher() {
    try {
      console.log('👁️ Starting plugin file watcher...');
      
      // Watch the plugins directory for changes
      this.watcher = chokidar.watch(this.pluginsPath, {
        ignored: /node_modules/,
        persistent: true,
        ignoreInitial: true,
        depth: 3 // Limit depth to avoid excessive watching
      });

      // Handle file/directory additions
      this.watcher.on('add', (filePath) => {
        this.handleFileChange('add', filePath);
      });

      // Handle file changes
      this.watcher.on('change', (filePath) => {
        this.handleFileChange('change', filePath);
      });

      // Handle file/directory deletions
      this.watcher.on('unlink', (filePath) => {
        this.handleFileChange('unlink', filePath);
      });

      // Handle directory additions
      this.watcher.on('addDir', (dirPath) => {
        this.handleDirectoryChange('addDir', dirPath);
      });

      // Handle directory deletions
      this.watcher.on('unlinkDir', (dirPath) => {
        this.handleDirectoryChange('unlinkDir', dirPath);
      });

      // Handle watcher errors
      this.watcher.on('error', (error) => {
        console.error('❌ Plugin watcher error:', error);
      });

      console.log('✅ Plugin file watcher started');
    } catch (error) {
      console.error('❌ Failed to start plugin file watcher:', error);
      this.watcher = null;
    }
  }

  /**
   * Stop file system watcher
   */
  async stopFileWatcher() {
    if (this.watcher) {
      console.log('🛑 Stopping plugin file watcher...');
      await this.watcher.close();
      this.watcher = null;
      console.log('✅ Plugin file watcher stopped');
    }
  }

  /**
   * Handle file changes for hot reloading
   * @param {string} event - Change event type
   * @param {string} filePath - Changed file path
   */
  async handleFileChange(event, filePath) {
    try {
      const relativePath = path.relative(this.pluginsPath, filePath);
      const pathParts = relativePath.split(path.sep);
      
      if (pathParts.length < 2) return; // Not in a plugin directory
      
      const pluginId = pathParts[0];
      const fileName = path.basename(filePath);
      
      console.log(`🔄 Plugin file ${event}: ${pluginId}/${fileName}`);

      // Handle plugin.json changes
      if (fileName === 'plugin.json') {
        await this.handlePluginManifestChange(event, pluginId);
      }
      
      // Handle main plugin file changes
      else if (fileName.endsWith('.js')) {
        await this.handlePluginCodeChange(event, pluginId, filePath);
      }

      this.emit('fileChanged', { event, pluginId, filePath });
    } catch (error) {
      console.error(`❌ Error handling file change for ${filePath}:`, error);
    }
  }

  /**
   * Handle directory changes for hot reloading
   * @param {string} event - Change event type
   * @param {string} dirPath - Changed directory path
   */
  async handleDirectoryChange(event, dirPath) {
    try {
      const relativePath = path.relative(this.pluginsPath, dirPath);
      const pathParts = relativePath.split(path.sep);
      
      if (pathParts.length !== 1) return; // Not a direct plugin directory
      
      const pluginId = pathParts[0];
      
      console.log(`📁 Plugin directory ${event}: ${pluginId}`);

      if (event === 'addDir') {
        // New plugin directory added
        await this.handleNewPluginDirectory(pluginId);
      } else if (event === 'unlinkDir') {
        // Plugin directory removed
        await this.handleRemovedPluginDirectory(pluginId);
      }

      this.emit('directoryChanged', { event, pluginId, dirPath });
    } catch (error) {
      console.error(`❌ Error handling directory change for ${dirPath}:`, error);
    }
  }

  /**
   * Handle plugin manifest (plugin.json) changes
   * @param {string} event - Change event type
   * @param {string} pluginId - Plugin identifier
   */
  async handlePluginManifestChange(event, pluginId) {
    try {
      if (event === 'unlink') {
        // Plugin manifest deleted - unload plugin
        if (this.isPluginLoaded(pluginId)) {
          console.log(`🔄 Plugin manifest deleted, unloading: ${pluginId}`);
          await this.unloadPlugin(pluginId);
        }
      } else {
        // Plugin manifest added or changed - reload plugin
        if (this.isPluginLoaded(pluginId)) {
          console.log(`🔄 Plugin manifest changed, reloading: ${pluginId}`);
          await this.reloadPlugin(pluginId);
        } else {
          console.log(`🔄 New plugin manifest detected, loading: ${pluginId}`);
          await this.loadPluginById(pluginId);
        }
      }
    } catch (error) {
      console.error(`❌ Error handling manifest change for ${pluginId}:`, error);
    }
  }

  /**
   * Handle plugin code changes
   * @param {string} event - Change event type
   * @param {string} pluginId - Plugin identifier
   * @param {string} filePath - Changed file path
   */
  async handlePluginCodeChange(event, pluginId, filePath) {
    try {
      if (event === 'unlink') {
        // Plugin file deleted - check if it's the main entry point
        const plugin = this.pluginRegistry.get(pluginId);
        if (plugin && filePath.endsWith(plugin.entryPoint)) {
          console.log(`🔄 Plugin entry point deleted, unloading: ${pluginId}`);
          await this.unloadPlugin(pluginId);
        }
      } else {
        // Plugin file added or changed - reload if loaded
        if (this.isPluginLoaded(pluginId)) {
          console.log(`🔄 Plugin code changed, reloading: ${pluginId}`);
          await this.reloadPlugin(pluginId);
        }
      }
    } catch (error) {
      console.error(`❌ Error handling code change for ${pluginId}:`, error);
    }
  }

  /**
   * Handle new plugin directory
   * @param {string} pluginId - Plugin identifier
   */
  async handleNewPluginDirectory(pluginId) {
    try {
      // Wait a bit for files to be fully copied
      setTimeout(async () => {
        const pluginPath = path.join(this.pluginsPath, pluginId);
        const manifestPath = path.join(pluginPath, 'plugin.json');
        
        if (fs.existsSync(manifestPath)) {
          console.log(`🆕 New plugin directory detected: ${pluginId}`);
          await this.loadPluginById(pluginId);
        }
      }, 1000);
    } catch (error) {
      console.error(`❌ Error handling new plugin directory ${pluginId}:`, error);
    }
  }

  /**
   * Handle removed plugin directory
   * @param {string} pluginId - Plugin identifier
   */
  async handleRemovedPluginDirectory(pluginId) {
    try {
      if (this.isPluginLoaded(pluginId)) {
        console.log(`🗑️ Plugin directory removed, unloading: ${pluginId}`);
        await this.unloadPlugin(pluginId);
      }
      
      // Remove from registry
      this.pluginRegistry.delete(pluginId);
    } catch (error) {
      console.error(`❌ Error handling removed plugin directory ${pluginId}:`, error);
    }
  }

  /**
   * Reload a specific plugin
   * @param {string} pluginId - Plugin identifier
   */
  async reloadPlugin(pluginId) {
    try {
      console.log(`🔄 Reloading plugin: ${pluginId}`);
      
      // Unload the plugin first
      await this.unloadPlugin(pluginId);
      
      // Wait a moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Load the plugin again
      await this.loadPluginById(pluginId);
      
      console.log(`✅ Plugin reloaded: ${pluginId}`);
      this.emit('pluginReloaded', pluginId);
    } catch (error) {
      console.error(`❌ Failed to reload plugin ${pluginId}:`, error);
      this.emit('pluginReloadError', pluginId, error);
    }
  }

  /**
   * Load a plugin by ID
   * @param {string} pluginId - Plugin identifier
   */
  async loadPluginById(pluginId) {
    try {
      const pluginPath = path.join(this.pluginsPath, pluginId);
      const descriptor = await this.loadPluginDescriptor(pluginPath);
      
      if (descriptor) {
        await this.loadPlugin(descriptor);
      }
    } catch (error) {
      console.error(`❌ Failed to load plugin by ID ${pluginId}:`, error);
    }
  }

  /**
   * Enable or disable hot reloading
   * @param {boolean} enabled - Whether to enable hot reloading
   */
  async setHotReloadEnabled(enabled) {
    this.hotReloadEnabled = enabled;
    
    if (enabled && !this.watcher && this.isInitialized) {
      this.startFileWatcher();
    } else if (!enabled && this.watcher) {
      await this.stopFileWatcher();
    }
    
    console.log(`🔄 Hot reloading ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Shutdown plugin manager
   */
  async shutdown() {
    try {
      console.log('🔄 Shutting down Plugin Manager...');
      
      // Stop file watcher
      await this.stopFileWatcher();
      
      // Unload all plugins
      const loadedPlugins = Array.from(this.loadedPlugins.keys());
      for (const pluginId of loadedPlugins) {
        await this.unloadPlugin(pluginId);
      }
      
      this.isInitialized = false;
      console.log('✅ Plugin Manager shutdown complete');
    } catch (error) {
      console.error('❌ Plugin Manager shutdown failed:', error);
    }
  }
}

module.exports = PluginManager;