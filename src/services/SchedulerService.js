/**
 * HammamPOS - SchedulerService
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * 
 * Unauthorized copying or distribution is strictly prohibited.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Automatic Task Scheduling - Handles automatic day close, yearly reset, and email reports
 * REQ-9: Automatic day close at 23:59
 * REQ-10: Yearly serial reset on January 1st
 * REQ-14: Automatic email reports
 */

const cron = require('node-cron');

class SchedulerService {
  constructor(storageManager, emailService = null) {
    this.storage = storageManager;
    this.email = emailService;
    this.jobs = new Map();
    this.isInitialized = false;
  }

  /**
   * Initialize scheduler with all cron jobs
   */
  initialize() {
    try {
      console.log('🕐 Initializing SchedulerService...');
      
      // Schedule automatic day close at 23:59:00 daily
      this.scheduleDayClose();
      
      // Schedule yearly reset at 00:00:00 on January 1st
      this.scheduleYearlyReset();
      
      // Schedule email reports at 23:59:30 daily (after day close)
      this.scheduleEmailReport();
      
      this.isInitialized = true;
      console.log('✅ SchedulerService initialized with all jobs');
      
      return { success: true };
    } catch (error) {
      console.error('❌ SchedulerService initialization failed:', error);
      throw error;
    }
  }

  /**
   * Schedule automatic day close at 23:59:00 daily
   * REQ-9.1: Automatic day close at 23:59
   */
  scheduleDayClose() {
    const job = cron.schedule('59 23 * * *', async () => {
      try {
        console.log('🌙 Starting automatic day close...');
        
        const today = new Date().toISOString().split('T')[0];
        
        // Get today's data
        const tickets = await this.storage.getTicketsForDate(today);
        const expenses = await this.storage.getExpensesForDate(today);
        
        // Calculate totals
        let totalRevenue = 0;
        let totalExpenses = 0;
        let totalTickets = tickets.length;
        const categoryBreakdown = {};
        
        // Calculate revenue and category breakdown
        tickets.forEach(ticket => {
          totalRevenue += ticket.price;
          if (!categoryBreakdown[ticket.category_name]) {
            categoryBreakdown[ticket.category_name] = 0;
          }
          categoryBreakdown[ticket.category_name]++;
        });
        
        // Calculate expenses
        expenses.forEach(expense => {
          totalExpenses += expense.amount;
        });
        
        const netRevenue = totalRevenue - totalExpenses;
        const cashInHand = this.storage.getCashInHand();
        
        // Create daily summary record
        const summaryData = {
          date: today,
          total_tickets: totalTickets,
          total_revenue: totalRevenue,
          total_expenses: totalExpenses,
          net_revenue: netRevenue,
          cash_in_hand: cashInHand,
          category_breakdown: JSON.stringify(categoryBreakdown)
        };
        
        // Save to database (if not already exists)
        try {
          this.storage.db.run(`
            INSERT OR REPLACE INTO daily_summary 
            (date, total_tickets, total_revenue, total_expenses, net_revenue, cash_in_hand, category_breakdown)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `, [
            summaryData.date,
            summaryData.total_tickets,
            summaryData.total_revenue,
            summaryData.total_expenses,
            summaryData.net_revenue,
            summaryData.cash_in_hand,
            summaryData.category_breakdown
          ]);
          
          this.storage.save();
        } catch (dbError) {
          console.warn('Daily summary already exists or DB error:', dbError.message);
        }
        
        // Log the day close
        this.storage.logAudit('DAY_CLOSE', 'system', null, 
          `Revenue: ${totalRevenue}, Expenses: ${totalExpenses}, Net: ${netRevenue}, Tickets: ${totalTickets}`);
        
        console.log(`✅ Day close completed for ${today}:`);
        console.log(`   📊 Tickets: ${totalTickets}`);
        console.log(`   💰 Revenue: ${totalRevenue} درهم`);
        console.log(`   💸 Expenses: ${totalExpenses} درهم`);
        console.log(`   📈 Net: ${netRevenue} درهم`);
        console.log(`   🏦 Cash in Hand: ${cashInHand} درهم`);
        
      } catch (error) {
        console.error('❌ Automatic day close failed:', error);
        this.storage.logAudit('DAY_CLOSE_ERROR', 'system', null, error.message);
      }
    }, {
      scheduled: false,
      timezone: 'Africa/Casablanca' // Morocco timezone
    });
    
    job.start();
    this.jobs.set('dayClose', job);
    console.log('📅 Day close scheduled for 23:59:00 daily');
  }

  /**
   * Schedule yearly reset at 00:00:00 on January 1st
   * REQ-10.1: Yearly serial reset on January 1st
   */
  scheduleYearlyReset() {
    const job = cron.schedule('0 0 1 1 *', async () => {
      try {
        console.log('🎊 Starting yearly reset...');
        
        const newYear = new Date().getFullYear();
        
        // Reset all category serial counters to 0 (next ticket will be 1)
        this.storage.db.run('UPDATE categories SET serial_counter = 0');
        this.storage.save();
        
        // Log the reset
        this.storage.logAudit('YEARLY_RESET', 'system', null, `Year ${newYear} - All serials reset to 1`);
        
        // Record the reset event
        this.storage.db.run(`
          INSERT INTO serial_resets (year, reset_date) 
          VALUES (?, ?)
        `, [newYear, new Date().toISOString().split('T')[0]]);
        
        this.storage.save();
        
        console.log(`✅ Yearly reset completed for ${newYear}`);
        console.log('   🔄 All category serial numbers reset to 1');
        
      } catch (error) {
        console.error('❌ Yearly reset failed:', error);
        this.storage.logAudit('YEARLY_RESET_ERROR', 'system', null, error.message);
      }
    }, {
      scheduled: false,
      timezone: 'Africa/Casablanca' // Morocco timezone
    });
    
    job.start();
    this.jobs.set('yearlyReset', job);
    console.log('🎆 Yearly reset scheduled for 00:00:00 on January 1st');
  }

  /**
   * Schedule email reports at 23:59:30 daily (after day close)
   * REQ-14.1: Automatic email reports
   */
  scheduleEmailReport() {
    const job = cron.schedule('30 23 * * *', async () => {
      try {
        // Check if email reports are enabled
        const emailEnabled = this.storage.getSetting('email_enabled');
        if (emailEnabled !== 'true') {
          console.log('📧 Email reports disabled, skipping...');
          return;
        }
        
        if (!this.email) {
          console.log('📧 Email service not available, skipping report...');
          return;
        }
        
        console.log('📧 Sending daily email report...');
        
        const today = new Date().toISOString().split('T')[0];
        
        // Get today's data
        const tickets = await this.storage.getTicketsForDate(today);
        const expenses = await this.storage.getExpensesForDate(today);
        
        // Generate report
        const report = await this.generateDailyReport(today, tickets, expenses);
        
        // Send email
        const emailAddress = this.storage.getSetting('email_address');
        if (emailAddress) {
          await this.email.sendDailyReport(emailAddress, report);
          console.log(`✅ Daily report sent to ${emailAddress}`);
        } else {
          console.log('⚠️ No email address configured');
        }
        
      } catch (error) {
        console.error('❌ Email report failed:', error);
        this.storage.logAudit('EMAIL_REPORT_ERROR', 'system', null, error.message);
      }
    }, {
      scheduled: false,
      timezone: 'Africa/Casablanca' // Morocco timezone
    });
    
    job.start();
    this.jobs.set('emailReport', job);
    console.log('📧 Email reports scheduled for 23:59:30 daily');
  }

  /**
   * Generate daily report data
   */
  async generateDailyReport(date, tickets, expenses) {
    const categoryBreakdown = {};
    let totalRevenue = 0;
    let totalExpenses = 0;
    
    // Calculate category breakdown and revenue
    tickets.forEach(ticket => {
      totalRevenue += ticket.price;
      if (!categoryBreakdown[ticket.category_name]) {
        categoryBreakdown[ticket.category_name] = { count: 0, revenue: 0 };
      }
      categoryBreakdown[ticket.category_name].count++;
      categoryBreakdown[ticket.category_name].revenue += ticket.price;
    });
    
    // Calculate expenses
    expenses.forEach(expense => {
      totalExpenses += expense.amount;
    });
    
    const netRevenue = totalRevenue - totalExpenses;
    const cashInHand = this.storage.getCashInHand();
    
    return {
      date,
      totalTickets: tickets.length,
      totalRevenue,
      totalExpenses,
      netRevenue,
      cashInHand,
      categoryBreakdown,
      tickets,
      expenses
    };
  }

  /**
   * Stop all scheduled jobs
   */
  stopAll() {
    console.log('🛑 Stopping all scheduled jobs...');
    
    this.jobs.forEach((job, name) => {
      job.stop();
      console.log(`   ⏹️ Stopped ${name}`);
    });
    
    this.jobs.clear();
    this.isInitialized = false;
    
    console.log('✅ All scheduled jobs stopped');
  }

  /**
   * Get status of all jobs
   */
  getStatus() {
    const status = {
      initialized: this.isInitialized,
      jobs: {}
    };
    
    this.jobs.forEach((job, name) => {
      status.jobs[name] = {
        running: job.running || false,
        scheduled: true
      };
    });
    
    return status;
  }

  /**
   * Manually trigger day close (for testing)
   */
  async triggerDayClose() {
    console.log('🔧 Manually triggering day close...');
    
    try {
      // Get the day close job and execute its task
      const job = this.jobs.get('dayClose');
      if (job && job.task) {
        await job.task();
        return { success: true };
      } else {
        throw new Error('Day close job not found');
      }
    } catch (error) {
      console.error('Manual day close failed:', error);
      throw error;
    }
  }

  /**
   * Manually trigger yearly reset (for testing)
   */
  async triggerYearlyReset() {
    console.log('🔧 Manually triggering yearly reset...');
    
    try {
      // Get the yearly reset job and execute its task
      const job = this.jobs.get('yearlyReset');
      if (job && job.task) {
        await job.task();
        return { success: true };
      } else {
        throw new Error('Yearly reset job not found');
      }
    } catch (error) {
      console.error('Manual yearly reset failed:', error);
      throw error;
    }
  }
}

module.exports = SchedulerService;