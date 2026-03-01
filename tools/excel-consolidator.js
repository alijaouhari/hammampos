/**
 * Excel Consolidator - Multi-Hammam Data Merger
 * Combines Excel files from multiple hammams into a single owner dashboard file
 * Usage: node tools/excel-consolidator.js
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

class ExcelConsolidator {
  constructor() {
    this.hammams = [];
    this.consolidatedWorkbook = null;
  }

  /**
   * Add a hammam Excel file to consolidation
   */
  addHammam(name, excelPath) {
    if (!fs.existsSync(excelPath)) {
      console.warn(`⚠️ Excel file not found for ${name}: ${excelPath}`);
      return false;
    }
    
    this.hammams.push({
      name,
      path: excelPath
    });
    
    console.log(`✅ Added ${name}: ${excelPath}`);
    return true;
  }

  /**
   * Consolidate all hammam Excel files
   */
  async consolidate(outputPath = null) {
    try {
      console.log('🔄 Starting Excel consolidation...');
      
      if (this.hammams.length === 0) {
        throw new Error('No hammam Excel files added');
      }
      
      // Create consolidated workbook
      this.consolidatedWorkbook = new ExcelJS.Workbook();
      
      // Create summary sheets
      await this.createOwnerSummarySheet();
      await this.createConsolidatedTicketsSheet();
      await this.createConsolidatedExpensesSheet();
      await this.createConsolidatedDailySummarySheet();
      
      // Save consolidated file
      const finalOutputPath = outputPath || path.join(process.cwd(), 'data', 'owner-dashboard.xlsx');
      await this.consolidatedWorkbook.xlsx.writeFile(finalOutputPath);
      
      console.log(`✅ Consolidated Excel file created: ${finalOutputPath}`);
      return { success: true, outputPath: finalOutputPath };
      
    } catch (error) {
      console.error('❌ Consolidation failed:', error);
      throw error;
    }
  }

  /**
   * Create owner summary sheet with KPIs from all hammams
   */
  async createOwnerSummarySheet() {
    const summarySheet = this.consolidatedWorkbook.addWorksheet('Owner Summary');
    
    // Headers
    summarySheet.columns = [
      { header: 'الحمام', key: 'hammam', width: 20 },
      { header: 'تذاكر اليوم', key: 'todayTickets', width: 15 },
      { header: 'مبيعات اليوم', key: 'todaySales', width: 15 },
      { header: 'مصروفات اليوم', key: 'todayExpenses', width: 15 },
      { header: 'صافي اليوم', key: 'todayNet', width: 15 },
      { header: 'النقد في الصندوق', key: 'cashInHand', width: 20 },
      { header: 'إجمالي الإيرادات', key: 'totalRevenue', width: 20 },
      { header: 'آخر تحديث', key: 'lastUpdate', width: 20 }
    ];
    
    const today = new Date().toISOString().split('T')[0];
    let totalTodayTickets = 0;
    let totalTodaySales = 0;
    let totalTodayExpenses = 0;
    let totalCashInHand = 0;
    let totalRevenue = 0;
    
    // Process each hammam
    for (const hammam of this.hammams) {
      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(hammam.path);
        
        // Get today's data
        const ticketsSheet = workbook.getWorksheet('Tickets');
        const expensesSheet = workbook.getWorksheet('Expenses');
        
        let todayTickets = 0;
        let todaySales = 0;
        let todayExpenses = 0;
        let totalHammamRevenue = 0;
        
        // Count today's tickets and sales
        if (ticketsSheet) {
          ticketsSheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header
            
            const date = row.getCell(6).value; // Date column
            const price = row.getCell(5).value; // Price column
            const deleted = row.getCell(8).value; // Deleted column
            
            if (deleted === 'Yes') return; // Skip deleted tickets
            
            if (price) totalHammamRevenue += parseFloat(price);
            
            if (date && date.toString().includes(today)) {
              todayTickets++;
              if (price) todaySales += parseFloat(price);
            }
          });
        }
        
        // Count today's expenses
        if (expensesSheet) {
          expensesSheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header
            
            const date = row.getCell(3).value; // Date column
            const amount = row.getCell(2).value; // Amount column
            const deleted = row.getCell(5).value; // Deleted column
            
            if (deleted === 'Yes') return; // Skip deleted expenses
            
            if (date && date.toString().includes(today) && amount) {
              todayExpenses += parseFloat(amount);
            }
          });
        }
        
        // Calculate cash in hand (simplified - would need collections data for accuracy)
        const cashInHand = totalHammamRevenue - todayExpenses;
        
        // Add row to summary
        summarySheet.addRow({
          hammam: hammam.name,
          todayTickets,
          todaySales: `${todaySales} درهم`,
          todayExpenses: `${todayExpenses} درهم`,
          todayNet: `${todaySales - todayExpenses} درهم`,
          cashInHand: `${cashInHand} درهم`,
          totalRevenue: `${totalHammamRevenue} درهم`,
          lastUpdate: new Date().toLocaleString('ar-MA')
        });
        
        // Add to totals
        totalTodayTickets += todayTickets;
        totalTodaySales += todaySales;
        totalTodayExpenses += todayExpenses;
        totalCashInHand += cashInHand;
        totalRevenue += totalHammamRevenue;
        
      } catch (error) {
        console.error(`❌ Failed to process ${hammam.name}:`, error.message);
        
        // Add error row
        summarySheet.addRow({
          hammam: hammam.name,
          todayTickets: 'خطأ',
          todaySales: 'خطأ',
          todayExpenses: 'خطأ',
          todayNet: 'خطأ',
          cashInHand: 'خطأ',
          totalRevenue: 'خطأ',
          lastUpdate: 'خطأ في القراءة'
        });
      }
    }
    
    // Add totals row
    summarySheet.addRow({});
    summarySheet.addRow({
      hammam: 'الإجمالي',
      todayTickets: totalTodayTickets,
      todaySales: `${totalTodaySales} درهم`,
      todayExpenses: `${totalTodayExpenses} درهم`,
      todayNet: `${totalTodaySales - totalTodayExpenses} درهم`,
      cashInHand: `${totalCashInHand} درهم`,
      totalRevenue: `${totalRevenue} درهم`,
      lastUpdate: new Date().toLocaleString('ar-MA')
    });
    
    // Style the sheet
    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getRow(summarySheet.rowCount).font = { bold: true };
    
    console.log('✅ Owner summary sheet created');
  }

  /**
   * Create consolidated tickets sheet
   */
  async createConsolidatedTicketsSheet() {
    const ticketsSheet = this.consolidatedWorkbook.addWorksheet('All Tickets');
    
    // Headers
    ticketsSheet.columns = [
      { header: 'الحمام', key: 'hammam', width: 15 },
      { header: 'رقم التذكرة', key: 'serial', width: 15 },
      { header: 'السنة', key: 'year', width: 10 },
      { header: 'الفئة', key: 'category', width: 15 },
      { header: 'السعر', key: 'price', width: 12 },
      { header: 'التاريخ', key: 'date', width: 15 },
      { header: 'الوقت', key: 'time', width: 12 },
      { header: 'محذوف؟', key: 'deleted', width: 10 }
    ];
    
    // Consolidate tickets from all hammams
    for (const hammam of this.hammams) {
      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(hammam.path);
        const sourceSheet = workbook.getWorksheet('Tickets');
        
        if (sourceSheet) {
          sourceSheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header
            
            ticketsSheet.addRow({
              hammam: hammam.name,
              serial: row.getCell(1).value,
              year: row.getCell(2).value,
              category: row.getCell(3).value,
              price: row.getCell(5).value,
              date: row.getCell(6).value,
              time: row.getCell(7).value,
              deleted: row.getCell(8).value || 'No'
            });
          });
        }
      } catch (error) {
        console.error(`❌ Failed to consolidate tickets from ${hammam.name}:`, error.message);
      }
    }
    
    console.log('✅ Consolidated tickets sheet created');
  }

  /**
   * Create consolidated expenses sheet
   */
  async createConsolidatedExpensesSheet() {
    const expensesSheet = this.consolidatedWorkbook.addWorksheet('All Expenses');
    
    // Headers
    expensesSheet.columns = [
      { header: 'الحمام', key: 'hammam', width: 15 },
      { header: 'الوصف', key: 'description', width: 30 },
      { header: 'المبلغ', key: 'amount', width: 12 },
      { header: 'التاريخ', key: 'date', width: 15 },
      { header: 'الوقت', key: 'time', width: 12 },
      { header: 'محذوف؟', key: 'deleted', width: 10 }
    ];
    
    // Consolidate expenses from all hammams
    for (const hammam of this.hammams) {
      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(hammam.path);
        const sourceSheet = workbook.getWorksheet('Expenses');
        
        if (sourceSheet) {
          sourceSheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header
            
            expensesSheet.addRow({
              hammam: hammam.name,
              description: row.getCell(1).value,
              amount: row.getCell(2).value,
              date: row.getCell(3).value,
              time: row.getCell(4).value,
              deleted: row.getCell(5).value || 'No'
            });
          });
        }
      } catch (error) {
        console.error(`❌ Failed to consolidate expenses from ${hammam.name}:`, error.message);
      }
    }
    
    console.log('✅ Consolidated expenses sheet created');
  }

  /**
   * Create consolidated daily summary sheet
   */
  async createConsolidatedDailySummarySheet() {
    const summarySheet = this.consolidatedWorkbook.addWorksheet('Daily Summary');
    
    // Headers
    summarySheet.columns = [
      { header: 'الحمام', key: 'hammam', width: 15 },
      { header: 'التاريخ', key: 'date', width: 15 },
      { header: 'التذاكر', key: 'tickets', width: 12 },
      { header: 'الإيرادات', key: 'revenue', width: 15 },
      { header: 'المصروفات', key: 'expenses', width: 15 },
      { header: 'الصافي', key: 'net', width: 15 }
    ];
    
    // Consolidate daily summaries from all hammams
    for (const hammam of this.hammams) {
      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(hammam.path);
        const sourceSheet = workbook.getWorksheet('DailySummary');
        
        if (sourceSheet) {
          sourceSheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header
            
            summarySheet.addRow({
              hammam: hammam.name,
              date: row.getCell(1).value,
              tickets: row.getCell(2).value,
              revenue: row.getCell(3).value,
              expenses: row.getCell(4).value,
              net: row.getCell(5).value
            });
          });
        }
      } catch (error) {
        console.error(`❌ Failed to consolidate daily summary from ${hammam.name}:`, error.message);
      }
    }
    
    console.log('✅ Consolidated daily summary sheet created');
  }
}

// Example usage
async function main() {
  try {
    const consolidator = new ExcelConsolidator();
    
    // Add hammam Excel files (update paths as needed)
    consolidator.addHammam('حمام الأندلس', path.join(process.cwd(), 'data', 'hammam1.xlsx'));
    consolidator.addHammam('حمام الزهراء', path.join(process.cwd(), 'data', 'hammam2.xlsx'));
    
    // You can add more hammams here:
    // consolidator.addHammam('حمام الثالث', path.join(process.cwd(), 'data', 'hammam3.xlsx'));
    
    // Consolidate
    const result = await consolidator.consolidate();
    
    if (result.success) {
      console.log('🎉 Excel consolidation completed successfully!');
      console.log(`📊 Owner dashboard file: ${result.outputPath}`);
    }
    
  } catch (error) {
    console.error('❌ Consolidation failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = ExcelConsolidator;