/**
 * HammamPOS - PrintManager
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Detects installed 80mm thermal receipt printers and prints tickets via ESC/POS raster.
 * 
 * How it works:
 *   1. Detect receipt printers: 203 DPI + USB/LPT/COM port (universal for all thermal printers)
 *   2. Render ticket HTML in a hidden BrowserWindow (Chromium handles Arabic/RTL perfectly)
 *   3. Capture bitmap at exactly 576px wide (80mm at 203 DPI)
 *   4. Convert to 1-bit monochrome ESC/POS raster (GS v 0 command)
 *   5. Send raw bytes to printer via Win32 WritePrinter API (raw-print.ps1)
 * 
 * DPI scaling is handled at app level with force-device-scale-factor=1
 * so BrowserWindow captures are always 1:1 pixel ratio.
 */

const { BrowserWindow } = require('electron');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execPromise = util.promisify(exec);

// 80mm paper at 203 DPI = 576 dots wide
const TICKET_WIDTH_PX = 576;

class PrintManager {
  constructor() {
    this.printerName = null;
    this.isInitialized = false;
    this.rawPrintScript = path.join(__dirname, 'raw-print.ps1');
    // In production (asar), the script is in extraResources
    if (!fs.existsSync(this.rawPrintScript)) {
      this.rawPrintScript = path.join(process.resourcesPath, 'raw-print.ps1');
    }
    this._getSavedPrinter = null; // injected by main process to read from DB
  }

  // ─── INITIALIZATION ─────────────────────────────────────────────────

  /**
   * Initialize the printer.
   * @param {string|null} savedPrinter - Printer name from settings (user's choice)
   */
  async initialize(savedPrinter = null) {
    try {
      this.printerName = await this.resolvePrinter(savedPrinter);
      this.isInitialized = true;
      console.log(`✅ Printer ready: ${this.printerName}`);
      return { success: true, printerName: this.printerName };
    } catch (error) {
      this.isInitialized = false;
      console.error('❌ Printer init failed:', error.message);
      throw error;
    }
  }

  // ─── PRINTER DETECTION ──────────────────────────────────────────────

  /**
   * Resolve which printer to use.
   * Rules:
   *   - If savedPrinter is set and available → use it
   *   - If only one receipt printer exists → use it automatically
   *   - If multiple exist and none saved → error (user must pick in settings)
   *   - If none exist → error
   */
  async resolvePrinter(savedPrinter = null) {
    const printers = await this.getReceiptPrinters();

    if (printers.length === 0) {
      throw new Error('Aucune imprimante thermique détectée. Branchez une imprimante 80mm via USB.');
    }

    // Saved printer available?
    if (savedPrinter) {
      const found = printers.find(p => p.Name === savedPrinter);
      if (found) {
        console.log(`🖨️ Using saved printer: ${found.Name}`);
        return found.Name;
      }
      console.warn(`⚠️ Saved printer "${savedPrinter}" not found`);
    }

    // Only one → use it automatically
    if (printers.length === 1) {
      console.log(`🖨️ Auto-detected: ${printers[0].Name}`);
      return printers[0].Name;
    }

    // Multiple and none saved → user must choose
    const names = printers.map(p => p.Name).join(', ');
    throw new Error(`Plusieurs imprimantes détectées (${names}). Sélectionnez une imprimante dans Paramètres.`);
  }

  /**
   * Get all receipt printers.
   * Receipt printer = 203 DPI (or lower) + USB/LPT/COM port.
   * This is universally true for ALL thermal receipt printers regardless of brand.
   */
  async getReceiptPrinters() {
    try {
      const { stdout } = await execPromise(
        `powershell -Command "Get-WmiObject Win32_Printer | Where-Object {$_.HorizontalResolution -le 203 -and $_.HorizontalResolution -gt 0} | Select-Object Name, PortName, PrinterStatus | ConvertTo-Json"`
      );
      if (!stdout.trim()) return [];
      const parsed = JSON.parse(stdout.trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      // Physical port only, not in error state
      return list.filter(p =>
        /^(USB|LPT|COM)\d/i.test(p.PortName || '') && p.PrinterStatus !== 1
      );
    } catch (error) {
      console.error('Failed to query printers:', error.message);
      return [];
    }
  }

  /**
   * List printer names (for settings UI)
   */
  async listPrinters() {
    const printers = await this.getReceiptPrinters();
    return printers.map(p => p.Name);
  }

  // ─── TICKET HTML ────────────────────────────────────────────────────

  /**
   * Generate ticket HTML. Fixed 576px width (80mm at 203 DPI).
   * All text is large and readable. Centered layout.
   */
  generateTicketHTML(ticket, hammamData, widthPx = TICKET_WIDTH_PX) {
    const hammamName = hammamData.name || 'حمام';
    const date = new Date(ticket.timestamp || new Date());
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const dateTime = `${day}/${month}/${year} ${hours}:${minutes}`;

    return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: ${widthPx}px;
  font-family: 'Tahoma', 'Arial', sans-serif;
  background: #fff;
  color: #000;
  text-align: center;
}
body { padding: 4px 8px 16px 8px; }
.header { font-size: 28px; font-weight: bold; }
.category { font-size: 40px; font-weight: bold; margin: 4px 0; }
.price { font-size: 30px; font-weight: bold; margin: 2px 0; }
.sep { border-top: 3px dashed #000; margin: 6px 0; }
.serial { font-size: 30px; font-weight: bold; }
.datetime { font-size: 22px; margin-top: 4px; direction: ltr; }
</style>
</head>
<body>
<div class="header">${hammamName}</div>
<div class="category">${ticket.category_name}</div>
<div class="price">${Math.round(ticket.price)} DH</div>
<div class="sep"></div>
<div class="serial">#${ticket.serial_number}/${ticket.year}</div>
<div class="datetime">${dateTime}</div>
</body>
</html>`;
  }

  // ─── PRINT ──────────────────────────────────────────────────────────

  /**
   * Print a ticket. Re-reads saved printer from DB on every call.
   */
  async printTicket(ticket, hammamData = {}) {
    if (!this.isInitialized) {
      throw new Error('Imprimante non initialisée');
    }

    // Re-resolve on every print (handles printer changes in settings)
    const savedPrinter = this._getSavedPrinter ? this._getSavedPrinter() : this.printerName;
    try {
      this.printerName = await this.resolvePrinter(savedPrinter);
    } catch (error) {
      throw new Error(`Imprimante indisponible: ${error.message}`);
    }

    // Render → Capture → Convert → Send
    const bitmap = await this.captureTicket(ticket, hammamData);
    const escpos = this.toEscPosRaster(bitmap.data, bitmap.width, bitmap.height);
    await this.sendRaw(escpos);

    console.log(`✅ Printed: ${ticket.category_name} #${ticket.serial_number}/${ticket.year} → ${this.printerName}`);
    return { success: true };
  }

  /**
   * Capture ticket as a bitmap using a hidden BrowserWindow.
   * Uses a fixed height that fits all ticket content — no dynamic measurement needed.
   */
  async captureTicket(ticket, hammamData) {
    const { screen } = require('electron');
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
    const cssWidth = Math.round(TICKET_WIDTH_PX / scaleFactor);
    const html = this.generateTicketHTML(ticket, hammamData, cssWidth);
    const tempPath = path.join(os.tmpdir(), `ticket_${Date.now()}.html`);
    fs.writeFileSync(tempPath, html, 'utf8');

    // Fixed height that fits 5 lines of text at our font sizes
    const cssHeight = Math.round(250 / scaleFactor);

    const win = new BrowserWindow({
      width: cssWidth,
      height: cssHeight,
      show: false,
      useContentSize: true,
      frame: false,
      webPreferences: { offscreen: false }
    });

    try {
      await win.loadFile(tempPath);
      await this._wait(300);

      // Get actual content height in CSS pixels
      const contentHeight = await win.webContents.executeJavaScript(
        'document.body.offsetHeight'
      );
      win.setContentSize(cssWidth, contentHeight + 10);
      await this._wait(200);

      const image = await win.capturePage();
      const { width, height } = image.getSize();

      // Ensure exact 576px width for printer
      let finalImage = image;
      if (width !== TICKET_WIDTH_PX) {
        const ratio = TICKET_WIDTH_PX / width;
        finalImage = image.resize({
          width: TICKET_WIDTH_PX,
          height: Math.round(height * ratio),
          quality: 'best'
        });
      }

      const finalSize = finalImage.getSize();
      return {
        data: finalImage.toBitmap(),
        width: finalSize.width,
        height: finalSize.height
      };
    } finally {
      win.close();
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }

  /**
   * Convert BGRA bitmap to ESC/POS GS v 0 raster command.
   */
  toEscPosRaster(bitmap, width, height) {
    const widthBytes = Math.ceil(width / 8);
    const imageBytes = Buffer.alloc(widthBytes * height, 0);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4; // BGRA
        const gray = bitmap[i + 2] * 0.299 + bitmap[i + 1] * 0.587 + bitmap[i] * 0.114;
        if (gray < 160) { // black pixel
          imageBytes[y * widthBytes + (x >> 3)] |= (128 >> (x & 7));
        }
      }
    }

    const xL = widthBytes & 0xFF;
    const xH = (widthBytes >> 8) & 0xFF;
    const yL = height & 0xFF;
    const yH = (height >> 8) & 0xFF;

    return Buffer.concat([
      Buffer.from([0x1B, 0x61, 0x01]),                        // center align
      Buffer.from([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]), // GS v 0 raster header
      imageBytes,                                              // image data
      Buffer.from([0x1B, 0x64, 0x01]),                        // feed 1 line
      Buffer.from([0x1D, 0x56, 0x42, 0x00])                   // GS V 66 0 — feed to cut position then cut
    ]);
  }

  /**
   * Send raw bytes to printer via PowerShell Win32 API.
   */
  async sendRaw(buffer) {
    const tempPath = path.join(os.tmpdir(), `escpos_${Date.now()}.bin`);
    fs.writeFileSync(tempPath, buffer);

    try {
      const cmd = `powershell -ExecutionPolicy Bypass -File "${this.rawPrintScript}" -PrinterName "${this.printerName}" -FilePath "${tempPath}"`;
      const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 });

      if (!stdout.trim().includes('SUCCESS')) {
        const err = (stderr || stdout || 'Unknown error').trim().split('\n')[0];
        throw new Error(`Impression échouée: ${err}`);
      }
    } finally {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }

  // ─── TEST & STATUS ──────────────────────────────────────────────────

  async printTest() {
    const testTicket = {
      category_name: 'اختبار',
      serial_number: 999,
      year: new Date().getFullYear(),
      price: 0,
      timestamp: new Date().toISOString()
    };
    return await this.printTicket(testTicket, { name: 'اختبار الطابعة' });
  }

  async testPrint(printerName) {
    const origPrinter = this.printerName;
    const origInit = this.isInitialized;
    this.printerName = printerName;
    this.isInitialized = true;
    try {
      return await this.printTest();
    } finally {
      this.printerName = origPrinter;
      this.isInitialized = origInit;
    }
  }

  getStatus() {
    return {
      initialized: this.isInitialized,
      printerName: this.printerName,
      ready: this.isInitialized && this.printerName !== null
    };
  }

  _wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = PrintManager;
