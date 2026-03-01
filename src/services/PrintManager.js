/**
 * HammamPOS - PrintManager
 * Copyright (c) 2024 HammamPOS Solutions. All rights reserved.
 * 
 * This software is proprietary and confidential.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Thermal Printer Integration - Handles thermal printing using Windows notepad command
 * REQ-15: Thermal printing with Windows installed printers
 */

const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execPromise = util.promisify(exec);

class PrintManager {
  constructor() {
    this.printerName = null;
    this.isInitialized = false;
    this.paperWidth = 58;
  }

  /**
   * Initialize printer
   */
  async initialize(printerName = null, paperWidth = 58) {
    try {
      if (!printerName) {
        printerName = await this.findThermalPrinter();
      }

      this.printerName = printerName;
      this.paperWidth = paperWidth;
      this.isInitialized = true;
      
      console.log(`✅ Printer initialized: ${printerName} (${paperWidth}mm)`);
      
      return { success: true, printerName, paperWidth };
    } catch (error) {
      console.error('❌ Printer initialization failed:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Find thermal printer
   */
  async findThermalPrinter() {
    const thermalKeywords = ['pos', 'thermal', 'receipt', 'xprinter', 'epson', 'star', 'bixolon'];
    
    try {
      const printers = await this.listPrinters();
      
      for (const keyword of thermalKeywords) {
        const found = printers.find(p => p.toLowerCase().includes(keyword));
        if (found) {
          console.log(`🔍 Found thermal printer: ${found}`);
          return found;
        }
      }
      
      if (printers.length > 0) {
        console.log(`⚠️ No thermal printer found, using first printer: ${printers[0]}`);
        return printers[0];
      }
      
      throw new Error('No printers found');
    } catch (error) {
      console.error('Failed to find thermal printer:', error);
      throw error;
    }
  }

  /**
   * List all Windows printers
   */
  async listPrinters() {
    try {
      const { stdout } = await execPromise('powershell -Command "Get-Printer | Select-Object -ExpandProperty Name"');
      const printers = stdout.trim().split('\n').map(p => p.trim()).filter(p => p);
      console.log('🖨️ Available printers:', printers);
      return printers;
    } catch (error) {
      console.error('Failed to list printers:', error);
      return [];
    }
  }

  /**
   * Print ticket using minimal format to save paper
   */
  async printTicket(ticket, hammamData = {}) {
    if (!this.isInitialized) {
      throw new Error('Printer not initialized');
    }

    try {
      const hammamName = hammamData.name || 'حمام';
      
      // Format date and time
      const date = new Date(ticket.timestamp || new Date());
      const formattedDate = date.toLocaleDateString('ar-MA');
      const formattedTime = date.toLocaleTimeString('ar-MA', { hour12: false });
      
      // Build minimal ticket - no separators, just blank lines
      let ticketText = '';
      
      // Hammam name (centered manually)
      const centerPadding = Math.max(0, Math.floor((20 - hammamName.length) / 2));
      ticketText += ' '.repeat(centerPadding) + hammamName + '\n';
      
      // Blank line
      ticketText += '\n';
      
      // Serial number
      ticketText += `#${ticket.serial_number}/${ticket.year}\n`;
      
      // Date and time on one line
      ticketText += `${formattedDate} ${formattedTime}\n`;
      
      // Blank line
      ticketText += '\n';
      
      // Category
      ticketText += `${ticket.category_name}\n`;
      
      // Price
      ticketText += `${ticket.price} درهم\n`;
      
      // Final blank line
      ticketText += '\n';
      
      // Create temp file
      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, `ticket_${Date.now()}.txt`);
      fs.writeFileSync(tempFile, ticketText, { encoding: 'utf8' });
      
      console.log('📄 Minimal ticket file created:', tempFile);
      console.log('🖨️ Printing to:', this.printerName);
      
      // Check if printer exists first
      const printers = await this.listPrinters();
      if (!printers.includes(this.printerName)) {
        throw new Error(`Printer "${this.printerName}" not found. Available printers: ${printers.join(', ')}`);
      }
      
      // Try direct copy to printer first
      try {
        const copyCommand = `type "${tempFile}" > "\\\\localhost\\${this.printerName}"`;
        console.log('🔧 Direct copy command:', copyCommand);
        
        const { stdout, stderr } = await execPromise(copyCommand, { timeout: 10000 });
        
        if (stderr && stderr.trim()) {
          console.warn('⚠️ Direct copy stderr:', stderr);
        }
        
        console.log('✅ Direct copy successful');
        
      } catch (directError) {
        console.warn('❌ Direct copy failed, trying notepad:', directError.message);
        
        // Fallback to notepad method
        const notepadCommand = `notepad /pt "${tempFile}" "${this.printerName}"`;
        await execPromise(notepadCommand, { timeout: 15000 });
        console.log('✅ Notepad fallback successful');
      }
      
      // Wait a bit for print job to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        // Ignore cleanup errors
      }
      
      console.log(`✅ Ticket printed: ${ticket.category_name} #${ticket.serial_number}/${ticket.year}`);
      
      return { success: true };
    } catch (error) {
      console.error('❌ Print failed:', error);
      throw error;
    }
  }

  /**
   * Center text within given width
   */
  centerText(text, width) {
    if (text.length >= width) return text;
    const padding = Math.floor((width - text.length) / 2);
    return ' '.repeat(padding) + text;
  }

  /**
   * Format two pieces of text on same line (left and right aligned)
   */
  formatLine(leftText, rightText, width) {
    const totalTextLength = leftText.length + rightText.length;
    if (totalTextLength >= width) {
      // If too long, put on separate lines
      return leftText + '\n' + rightText;
    }
    
    const spaces = width - totalTextLength;
    return leftText + ' '.repeat(spaces) + rightText;
  }

  /**
   * Print test ticket
   */
  async printTest() {
    if (!this.isInitialized) {
      throw new Error('Printer not initialized');
    }

    try {
      const testTicket = {
        category_name: 'اختبار الطابعة',
        serial_number: 999,
        year: new Date().getFullYear(),
        price: 0,
        date: new Date().toISOString().split('T')[0],
        time: new Date().toTimeString().split(' ')[0],
        timestamp: new Date().toISOString()
      };
      
      await this.printTicket(testTicket, { name: 'اختبار الطابعة الحرارية' });
      
      console.log('✅ Test print successful');
      return { success: true };
    } catch (error) {
      console.error('❌ Test print failed:', error);
      throw error;
    }
  }

  /**
   * Test print with specific printer (for setup wizard)
   */
  async testPrint(printerName) {
    try {
      const testTicket = {
        category_name: 'اختبار الطابعة',
        serial_number: 999,
        year: new Date().getFullYear(),
        price: 0,
        date: new Date().toISOString().split('T')[0],
        time: new Date().toTimeString().split(' ')[0],
        timestamp: new Date().toISOString()
      };
      
      // Temporarily set printer for test
      const originalPrinter = this.printerName;
      const originalInitialized = this.isInitialized;
      
      this.printerName = printerName;
      this.isInitialized = true;
      
      try {
        await this.printTicket(testTicket, { name: 'اختبار الطابعة الحرارية' });
        console.log(`✅ Test print successful on ${printerName}`);
        return { success: true };
      } finally {
        // Restore original settings
        this.printerName = originalPrinter;
        this.isInitialized = originalInitialized;
      }
      
    } catch (error) {
      console.error(`❌ Test print failed on ${printerName}:`, error);
      throw error;
    }
  }

  /**
   * Get printer status
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      printerName: this.printerName,
      paperWidth: this.paperWidth,
      ready: this.isInitialized && this.printerName !== null
    };
  }

  /**
   * Set printer
   */
  async setPrinter(printerName, paperWidth = 58) {
    return await this.initialize(printerName, paperWidth);
  }
}

module.exports = PrintManager;