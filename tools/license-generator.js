/**
 * License Key Generator
 * Simple tool to generate activation keys for HammamPOS premium features
 */

const crypto = require('crypto');

class LicenseGenerator {
  constructor() {
    // Your master secret key - keep this secure!
    this.masterKey = 'HAMMAMPOS-MASTER-SECRET-2026';
  }

  /**
   * Generate license key for a feature and machine
   * @param {string} featureId - Feature identifier (e.g., 'inventory-management')
   * @param {string} machineId - Customer's machine ID
   * @param {number} validMonths - License validity in months (default: 12)
   * @returns {string} License key in format XXXX-XXXX-XXXX-XXXX
   */
  generateLicenseKey(featureId, machineId, validMonths = 12) {
    // Create data to encode
    const expirationDate = new Date();
    expirationDate.setMonth(expirationDate.getMonth() + validMonths);
    
    const licenseData = {
      feature: featureId,
      machine: machineId.substring(0, 16), // First 16 chars of machine ID
      expires: Math.floor(expirationDate.getTime() / 1000), // Unix timestamp
      issued: Math.floor(Date.now() / 1000)
    };

    // Create signature
    const dataString = `${licenseData.feature}|${licenseData.machine}|${licenseData.expires}|${licenseData.issued}`;
    const signature = crypto
      .createHmac('sha256', this.masterKey)
      .update(dataString)
      .digest('hex')
      .substring(0, 16); // First 16 chars

    // Format as license key: XXXX-XXXX-XXXX-XXXX
    const key = signature.toUpperCase();
    return `${key.substring(0, 4)}-${key.substring(4, 8)}-${key.substring(8, 12)}-${key.substring(12, 16)}`;
  }

  /**
   * Validate license key (for verification)
   * @param {string} licenseKey - License key to validate
   * @param {string} featureId - Feature identifier
   * @param {string} machineId - Machine ID
   * @returns {Object} Validation result
   */
  validateLicenseKey(licenseKey, featureId, machineId) {
    try {
      // Remove hyphens
      const cleanKey = licenseKey.replace(/-/g, '').toLowerCase();
      
      // Try different expiration dates to find match (brute force approach)
      const now = Date.now();
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      
      for (let months = 1; months <= 24; months++) {
        const testExpiration = new Date(now + (months * 30 * 24 * 60 * 60 * 1000));
        const testIssued = Math.floor((now - (7 * 24 * 60 * 60 * 1000)) / 1000); // Up to 7 days ago
        
        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
          const licenseData = {
            feature: featureId,
            machine: machineId.substring(0, 16),
            expires: Math.floor(testExpiration.getTime() / 1000),
            issued: testIssued + (dayOffset * 24 * 60 * 60)
          };

          const dataString = `${licenseData.feature}|${licenseData.machine}|${licenseData.expires}|${licenseData.issued}`;
          const expectedSignature = crypto
            .createHmac('sha256', this.masterKey)
            .update(dataString)
            .digest('hex')
            .substring(0, 16);

          if (expectedSignature === cleanKey) {
            return {
              valid: true,
              feature: featureId,
              machineId: machineId,
              expirationDate: new Date(licenseData.expires * 1000),
              issuedDate: new Date(licenseData.issued * 1000)
            };
          }
        }
      }

      return { valid: false, error: 'Invalid license key' };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Generate multiple license keys for different features
   * @param {string} machineId - Customer's machine ID
   * @param {string[]} features - Array of feature IDs
   * @param {number} validMonths - License validity in months
   * @returns {Object} Object with feature IDs as keys and license keys as values
   */
  generateMultipleLicenses(machineId, features, validMonths = 12) {
    const licenses = {};
    features.forEach(feature => {
      licenses[feature] = this.generateLicenseKey(feature, machineId, validMonths);
    });
    return licenses;
  }
}

// Command line interface
if (require.main === module) {
  const generator = new LicenseGenerator();
  
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('🔑 HammamPOS License Generator');
    console.log('');
    console.log('Usage:');
    console.log('  node license-generator.js <feature-id> <machine-id> [months]');
    console.log('');
    console.log('Examples:');
    console.log('  node license-generator.js inventory-management 9d70222b3b897df5');
    console.log('  node license-generator.js spa-appointments 9d70222b3b897df5 24');
    console.log('');
    console.log('Available Features:');
    console.log('  - inventory-management');
    console.log('  - spa-appointments');
    console.log('  - commission-system');
    console.log('  - loyalty-cards');
    console.log('  - analytics-dashboard');
    console.log('  - multi-location');
    console.log('  - communication-tools');
    console.log('  - financial-integration');
    process.exit(1);
  }

  const featureId = args[0];
  const machineId = args[1];
  const validMonths = parseInt(args[2]) || 12;

  console.log('🔑 Generating License Key...');
  console.log('');
  console.log(`Feature: ${featureId}`);
  console.log(`Machine ID: ${machineId}`);
  console.log(`Valid for: ${validMonths} months`);
  console.log('');

  const licenseKey = generator.generateLicenseKey(featureId, machineId, validMonths);
  
  console.log(`License Key: ${licenseKey}`);
  console.log('');
  console.log('✅ Send this key to the customer via WhatsApp');
  
  // Verify the key works
  const validation = generator.validateLicenseKey(licenseKey, featureId, machineId);
  if (validation.valid) {
    console.log(`✅ Key verified - expires: ${validation.expirationDate.toLocaleDateString()}`);
  } else {
    console.log(`❌ Key validation failed: ${validation.error}`);
  }
}

module.exports = LicenseGenerator;