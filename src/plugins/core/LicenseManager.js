/**
 * HammamPOS - LicenseManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * 
 * Unauthorized copying or distribution is strictly prohibited.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Hardware-Based Licensing System - Handles license activation, validation, and hardware fingerprinting
 */

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

class LicenseManager {
  constructor(licenseDir = null) {
    this.licenseDir = licenseDir || path.join(process.cwd(), 'data', 'licenses');
    this.hardwareFingerprint = null;
    this.activeLicenses = new Map();
    this.isInitialized = false;
  }

  /**
   * Initialize license manager
   */
  async initialize() {
    try {
      console.log('🔐 Initializing License Manager...');
      
      // Create license directory
      if (!fs.existsSync(this.licenseDir)) {
        fs.mkdirSync(this.licenseDir, { recursive: true });
      }

      // Generate hardware fingerprint
      this.hardwareFingerprint = await this.generateHardwareFingerprint();
      console.log(`🖥️ Hardware Fingerprint: ${this.hardwareFingerprint.substring(0, 8)}...`);

      // Load existing licenses
      await this.loadExistingLicenses();

      this.isInitialized = true;
      console.log('✅ License Manager initialized');
      
      return { success: true };
    } catch (error) {
      console.error('❌ License Manager initialization failed:', error);
      throw error;
    }
  }

  /**
   * Generate unique hardware fingerprint
   * @returns {string} Hardware fingerprint hash
   */
  async generateHardwareFingerprint() {
    try {
      const components = [];

      // CPU information
      const cpus = os.cpus();
      if (cpus.length > 0) {
        components.push(cpus[0].model);
      }

      // System information
      components.push(os.platform());
      components.push(os.arch());
      components.push(os.hostname());

      // Memory information
      components.push(os.totalmem().toString());

      // Network interfaces (MAC addresses)
      const networkInterfaces = os.networkInterfaces();
      for (const interfaceName in networkInterfaces) {
        const interfaces = networkInterfaces[interfaceName];
        for (const iface of interfaces) {
          if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
            components.push(iface.mac);
            break; // Use first valid MAC address
          }
        }
      }

      // Create hash from components
      const fingerprint = crypto
        .createHash('sha256')
        .update(components.join('|'))
        .digest('hex');

      return fingerprint;
    } catch (error) {
      console.error('❌ Failed to generate hardware fingerprint:', error);
      // Fallback fingerprint based on basic system info
      return crypto
        .createHash('sha256')
        .update(`${os.platform()}-${os.arch()}-${os.hostname()}`)
        .digest('hex');
    }
  }

  /**
   * Activate license with provided key
   * @param {string} licenseKey - License activation key
   * @param {string} featureId - Feature identifier
   * @returns {LicenseResult} Activation result
   */
  async activateLicense(licenseKey, featureId) {
    try {
      console.log(`🔑 Activating license for feature: ${featureId}`);

      // Validate license key format
      if (!this.validateLicenseKeyFormat(licenseKey)) {
        return {
          success: false,
          error: 'Invalid license key format'
        };
      }

      // Generate license data
      const licenseData = {
        featureId,
        licenseKey,
        hardwareFingerprint: this.hardwareFingerprint,
        activationDate: new Date().toISOString(),
        expirationDate: this.calculateExpirationDate(licenseKey),
        status: 'active'
      };

      // Encrypt and save license
      const encryptedLicense = this.encryptLicenseData(licenseData);
      const licensePath = path.join(this.licenseDir, `${featureId}.license`);
      
      fs.writeFileSync(licensePath, JSON.stringify(encryptedLicense));

      // Add to active licenses
      this.activeLicenses.set(featureId, licenseData);

      console.log(`✅ License activated for feature: ${featureId}`);

      return {
        success: true,
        licenseId: this.generateLicenseId(featureId),
        expirationDate: new Date(licenseData.expirationDate),
        features: [featureId]
      };
    } catch (error) {
      console.error(`❌ License activation failed for ${featureId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Validate license for specific feature
   * @param {string} featureId - Feature identifier
   * @returns {boolean} True if license is valid
   */
  async validateLicense(featureId) {
    try {
      const license = this.activeLicenses.get(featureId);
      
      if (!license) {
        console.log(`⚠️ No license found for feature: ${featureId}`);
        return false;
      }

      // Check hardware fingerprint
      if (license.hardwareFingerprint !== this.hardwareFingerprint) {
        console.log(`⚠️ Hardware fingerprint mismatch for feature: ${featureId}`);
        return false;
      }

      // Check expiration
      if (license.expirationDate && new Date() > new Date(license.expirationDate)) {
        console.log(`⚠️ License expired for feature: ${featureId}`);
        return false;
      }

      // Check status
      if (license.status !== 'active') {
        console.log(`⚠️ License not active for feature: ${featureId}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error(`❌ License validation failed for ${featureId}:`, error);
      return false;
    }
  }

  /**
   * Get license status for feature
   * @param {string} featureId - Feature identifier
   * @returns {LicenseStatus} License status information
   */
  getLicenseStatus(featureId) {
    const license = this.activeLicenses.get(featureId);
    
    if (!license) {
      return {
        isValid: false,
        expirationDate: null,
        daysRemaining: 0,
        requiresReactivation: false
      };
    }

    const now = new Date();
    const expiration = new Date(license.expirationDate);
    const daysRemaining = Math.max(0, Math.ceil((expiration - now) / (1000 * 60 * 60 * 24)));
    
    return {
      isValid: this.validateLicense(featureId),
      expirationDate: expiration,
      daysRemaining,
      requiresReactivation: license.hardwareFingerprint !== this.hardwareFingerprint
    };
  }

  /**
   * Deactivate license for feature
   * @param {string} featureId - Feature identifier
   */
  async deactivateLicense(featureId) {
    try {
      console.log(`🔓 Deactivating license for feature: ${featureId}`);

      // Remove from active licenses
      this.activeLicenses.delete(featureId);

      // Delete license file
      const licensePath = path.join(this.licenseDir, `${featureId}.license`);
      if (fs.existsSync(licensePath)) {
        fs.unlinkSync(licensePath);
      }

      console.log(`✅ License deactivated for feature: ${featureId}`);
    } catch (error) {
      console.error(`❌ License deactivation failed for ${featureId}:`, error);
    }
  }

  /**
   * Load existing licenses from disk
   */
  async loadExistingLicenses() {
    try {
      if (!fs.existsSync(this.licenseDir)) {
        return;
      }

      const licenseFiles = fs.readdirSync(this.licenseDir)
        .filter(file => file.endsWith('.license'));

      for (const file of licenseFiles) {
        const licensePath = path.join(this.licenseDir, file);
        const featureId = path.basename(file, '.license');

        try {
          const encryptedData = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
          const licenseData = this.decryptLicenseData(encryptedData);
          
          this.activeLicenses.set(featureId, licenseData);
          console.log(`📄 Loaded license for feature: ${featureId}`);
        } catch (error) {
          console.error(`❌ Failed to load license for ${featureId}:`, error);
        }
      }

      console.log(`📦 Loaded ${this.activeLicenses.size} licenses`);
    } catch (error) {
      console.error('❌ Failed to load existing licenses:', error);
    }
  }

  /**
   * Validate license key format
   * @param {string} licenseKey - License key to validate
   * @returns {boolean} True if format is valid
   */
  validateLicenseKeyFormat(licenseKey) {
    // Expected format: XXXX-XXXX-XXXX-XXXX (16 characters + 3 hyphens)
    const keyPattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
    return keyPattern.test(licenseKey);
  }

  /**
   * Calculate expiration date from license key
   * @param {string} licenseKey - License key
   * @returns {string} ISO date string
   */
  calculateExpirationDate(licenseKey) {
    // For now, set expiration to 1 year from activation
    // In production, this would be encoded in the license key
    const expiration = new Date();
    expiration.setFullYear(expiration.getFullYear() + 1);
    return expiration.toISOString();
  }

  /**
   * Encrypt license data
   * @param {Object} licenseData - License data to encrypt
   * @returns {Object} Encrypted license data
   */
  encryptLicenseData(licenseData) {
    const key = crypto.scryptSync(this.hardwareFingerprint, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(licenseData), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return {
      encrypted,
      iv: iv.toString('hex'),
      algorithm: 'aes-256-cbc'
    };
  }

  /**
   * Decrypt license data
   * @param {Object} encryptedData - Encrypted license data
   * @returns {Object} Decrypted license data
   */
  decryptLicenseData(encryptedData) {
    const key = crypto.scryptSync(this.hardwareFingerprint, 'salt', 32);
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  }

  /**
   * Generate license ID
   * @param {string} featureId - Feature identifier
   * @returns {string} License ID
   */
  generateLicenseId(featureId) {
    return crypto
      .createHash('md5')
      .update(`${featureId}-${this.hardwareFingerprint}`)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Get hardware fingerprint
   * @returns {string} Hardware fingerprint
   */
  getHardwareFingerprint() {
    return this.hardwareFingerprint;
  }

  /**
   * Get all active licenses
   * @returns {Object} Active licenses map
   */
  getActiveLicenses() {
    const licenses = {};
    for (const [featureId, license] of this.activeLicenses) {
      licenses[featureId] = {
        featureId: license.featureId,
        activationDate: license.activationDate,
        expirationDate: license.expirationDate,
        status: license.status
      };
    }
    return licenses;
  }
}

module.exports = LicenseManager;