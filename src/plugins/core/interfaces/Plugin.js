/**
 * HammamPOS - Plugin System Interfaces
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * 
 * Unauthorized copying or distribution is strictly prohibited.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Defines the contracts for HammamPOS plugin architecture
 */

/**
 * @typedef {Object} PluginDescriptor
 * @property {string} id - Unique plugin identifier
 * @property {string} name - Human-readable plugin name
 * @property {string} version - Plugin version (semver)
 * @property {string[]} dependencies - Array of required plugin IDs
 * @property {boolean} licenseRequired - Whether plugin requires license activation
 * @property {string} entryPoint - Main plugin file path
 * @property {string} author - Plugin author
 * @property {string} description - Plugin description
 * @property {Object} permissions - Required system permissions
 */

/**
 * @typedef {Object} PluginContext
 * @property {Object} database - Database manager instance
 * @property {Object} ui - UI manager for interface integration
 * @property {Object} licensing - License manager for validation
 * @property {Object} events - Event bus for inter-plugin communication
 * @property {Object} config - Configuration manager
 * @property {Object} logger - Logging system
 * @property {Object} storage - Storage manager instance
 * @property {Object} excel - Excel manager instance
 */

/**
 * @typedef {Object} Plugin
 * @property {string} id - Plugin identifier
 * @property {string} name - Plugin name
 * @property {string} version - Plugin version
 * @property {boolean} isActive - Plugin activation status
 * @property {Function} initialize - Initialize plugin with context
 * @property {Function} shutdown - Clean shutdown of plugin
 * @property {Function} getUIComponents - Get UI components for integration
 * @property {Function} getDatabaseMigrations - Get database schema changes
 * @property {Function} getMenuItems - Get menu items for main interface
 * @property {Function} getSettings - Get plugin-specific settings
 */

/**
 * @typedef {Object} UIComponent
 * @property {string} id - Component identifier
 * @property {string} type - Component type (button, panel, modal, etc.)
 * @property {string} label - Display label
 * @property {string} icon - Icon identifier
 * @property {Function} onClick - Click handler
 * @property {Object} props - Component properties
 */

/**
 * @typedef {Object} DatabaseMigration
 * @property {string} version - Migration version
 * @property {string} description - Migration description
 * @property {Function} up - Apply migration
 * @property {Function} down - Rollback migration
 */

/**
 * @typedef {Object} PluginLoadResult
 * @property {boolean} success - Load operation success
 * @property {Plugin[]} loadedPlugins - Successfully loaded plugins
 * @property {Object[]} errors - Load errors with details
 * @property {string[]} loadOrder - Order in which plugins were loaded
 */

/**
 * @typedef {Object} LicenseResult
 * @property {boolean} success - License validation success
 * @property {string} licenseId - License identifier
 * @property {Date} expirationDate - License expiration
 * @property {string[]} features - Licensed features
 * @property {string} error - Error message if validation failed
 */

/**
 * @typedef {Object} LicenseStatus
 * @property {boolean} isValid - License validity
 * @property {Date} expirationDate - Expiration date
 * @property {number} daysRemaining - Days until expiration
 * @property {boolean} requiresReactivation - Reactivation needed
 */

module.exports = {
  // Export types for JSDoc validation
  // Actual interfaces are defined in comments above
};