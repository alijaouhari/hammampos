/**
 * WebDashboard - Remote Access Web Server
 * Provides secure web-based access to HammamPOS data
 */

const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

class WebDashboard {
  constructor(storage = null) {
    this.storage = storage;
    this.app = express();
    this.server = null;
    this.isRunning = false;
    this.port = 3000;
    this.httpsPort = 3443;
    this.jwtSecret = this.generateJWTSecret();
    this.setupMiddleware();
    this.setupRoutes();
  }

  generateJWTSecret() {
    return require('crypto').randomBytes(64).toString('hex');
  }

  setupMiddleware() {
    this.app.use(cors({
      origin: ['http://localhost:3000', 'https://localhost:3443'],
      credentials: true
    }));

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    const staticPath = path.join(__dirname, '..', 'renderer', 'dashboard');
    if (fs.existsSync(staticPath)) {
      this.app.use(express.static(staticPath));
    }

    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      next();
    });
  }

  setupRoutes() {
    this.app.post('/api/auth/login', this.handleLogin.bind(this));
    this.app.post('/api/auth/logout', this.handleLogout.bind(this));
    this.app.get('/api/auth/verify', this.authenticateToken.bind(this), this.handleVerify.bind(this));

    this.app.use('/api', this.authenticateToken.bind(this));
    
    this.app.get('/api/dashboard/summary', this.getDashboardSummary.bind(this));
    this.app.get('/api/dashboard/today', this.getTodayData.bind(this));
    this.app.get('/api/dashboard/revenue', this.getRevenueData.bind(this));
    
    this.app.get('/api/tickets', this.getTickets.bind(this));
    this.app.get('/api/expenses', this.getExpenses.bind(this));
    this.app.get('/api/collections', this.getCollections.bind(this));
    this.app.get('/api/categories', this.getCategories.bind(this));
    this.app.get('/api/reports/daily', this.getDailyReports.bind(this));
    
    this.app.get('/api/status', this.getSystemStatus.bind(this));

    this.app.get('/', (req, res) => {
      const dashboardPath = path.join(__dirname, '..', 'renderer', 'dashboard', 'index.html');
      if (fs.existsSync(dashboardPath)) {
        res.sendFile(dashboardPath);
      } else {
        res.send(this.getDefaultDashboardHTML());
      }
    });

    this.app.use((req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });

    this.app.use((error, req, res, next) => {
      console.error('Dashboard API Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async start(port = 3000, httpsPort = 3443) {
    try {
      console.log('🌐 Starting Web Dashboard...');
      
      this.port = port;
      this.httpsPort = httpsPort;

      this.server = http.createServer(this.app);
      
      await new Promise((resolve, reject) => {
        this.server.listen(this.port, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      this.isRunning = true;
      console.log(`✅ Web Dashboard running on http://localhost:${this.port}`);
      console.log(`📊 Dashboard URL: http://localhost:${this.port}`);
      
      return { 
        success: true, 
        url: `http://localhost:${this.port}`,
        port: this.port
      };
      
    } catch (error) {
      console.error('❌ Failed to start Web Dashboard:', error);
      throw error;
    }
  }

  async stop() {
    try {
      if (this.server && this.isRunning) {
        console.log('🛑 Stopping Web Dashboard...');
        
        await new Promise((resolve) => {
          this.server.close(() => {
            resolve();
          });
        });
        
        this.isRunning = false;
        console.log('✅ Web Dashboard stopped');
      }
    } catch (error) {
      console.error('❌ Failed to stop Web Dashboard:', error);
    }
  }

  authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, this.jwtSecret, (error, user) => {
      if (error) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    });
  }

  async handleLogin(req, res) {
    try {
      const { password } = req.body;
      
      if (!password) {
        return res.status(400).json({ error: 'Password required' });
      }

      if (!this.storage || !this.storage.verifyAdminPassword(password)) {
        return res.status(401).json({ error: 'Invalid password' });
      }

      const token = jwt.sign(
        { role: 'admin', timestamp: Date.now() },
        this.jwtSecret,
        { expiresIn: '24h' }
      );

      res.json({
        success: true,
        token,
        expiresIn: '24h'
      });

    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  }

  handleLogout(req, res) {
    res.json({ success: true, message: 'Logged out successfully' });
  }

  handleVerify(req, res) {
    res.json({ 
      success: true, 
      user: req.user,
      message: 'Token is valid' 
    });
  }

  getDashboardSummary(req, res) {
    try {
      if (!this.storage) {
        return res.status(503).json({ error: 'Storage not available' });
      }

      const summary = {
        cashInHand: this.storage.getCashInHand(),
        lifetimeRevenue: this.storage.getLifetimeRevenue(),
        todayTickets: this.storage.getTodayTickets().length,
        categories: this.storage.getCategories().length
      };

      res.json(summary);
    } catch (error) {
      console.error('Dashboard summary error:', error);
      res.status(500).json({ error: 'Failed to get dashboard summary' });
    }
  }

  getTodayData(req, res) {
    try {
      if (!this.storage) {
        return res.status(503).json({ error: 'Storage not available' });
      }

      const today = new Date().toISOString().split('T')[0];
      
      const data = {
        tickets: this.storage.getTicketsForDate(today),
        expenses: this.storage.getExpensesForDate(today),
        collections: this.storage.getCollections(today, today)
      };

      res.json(data);
    } catch (error) {
      console.error('Today data error:', error);
      res.status(500).json({ error: 'Failed to get today data' });
    }
  }

  getRevenueData(req, res) {
    try {
      if (!this.storage) {
        return res.status(503).json({ error: 'Storage not available' });
      }

      const { days = 30 } = req.query;
      const summaries = this.storage.getDailySummariesWithDetails(parseInt(days));

      res.json(summaries);
    } catch (error) {
      console.error('Revenue data error:', error);
      res.status(500).json({ error: 'Failed to get revenue data' });
    }
  }

  getTickets(req, res) {
    try {
      if (!this.storage) {
        return res.status(503).json({ error: 'Storage not available' });
      }

      const { startDate, endDate, limit = 100 } = req.query;
      
      let tickets;
      if (startDate && endDate) {
        tickets = this.storage.getTickets(startDate, endDate);
      } else {
        const today = new Date();
        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        tickets = this.storage.getTickets(
          thirtyDaysAgo.toISOString().split('T')[0],
          today.toISOString().split('T')[0]
        );
      }

      if (limit) {
        tickets = tickets.slice(0, parseInt(limit));
      }

      res.json(tickets);
    } catch (error) {
      console.error('Get tickets error:', error);
      res.status(500).json({ error: 'Failed to get tickets' });
    }
  }

  getExpenses(req, res) {
    try {
      if (!this.storage) {
        return res.status(503).json({ error: 'Storage not available' });
      }

      const { startDate, endDate, limit = 100 } = req.query;
      
      let expenses;
      if (startDate && endDate) {
        expenses = this.storage.getExpenses(startDate, endDate);
      } else {
        const today = new Date();
        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        expenses = this.storage.getExpenses(
          thirtyDaysAgo.toISOString().split('T')[0],
          today.toISOString().split('T')[0]
        );
      }

      if (limit) {
        expenses = expenses.slice(0, parseInt(limit));
      }

      res.json(expenses);
    } catch (error) {
      console.error('Get expenses error:', error);
      res.status(500).json({ error: 'Failed to get expenses' });
    }
  }

  getCollections(req, res) {
    try {
      if (!this.storage) {
        return res.status(503).json({ error: 'Storage not available' });
      }

      const { startDate, endDate, limit = 100 } = req.query;
      
      let collections;
      if (startDate && endDate) {
        collections = this.storage.getCollections(startDate, endDate);
      } else {
        const today = new Date();
        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        collections = this.storage.getCollections(
          thirtyDaysAgo.toISOString().split('T')[0],
          today.toISOString().split('T')[0]
        );
      }

      if (limit) {
        collections = collections.slice(0, parseInt(limit));
      }

      res.json(collections);
    } catch (error) {
      console.error('Get collections error:', error);
      res.status(500).json({ error: 'Failed to get collections' });
    }
  }

  getCategories(req, res) {
    try {
      if (!this.storage) {
        return res.status(503).json({ error: 'Storage not available' });
      }

      const { activeOnly = false } = req.query;
      const categories = this.storage.getCategories(activeOnly === 'true');

      res.json(categories);
    } catch (error) {
      console.error('Get categories error:', error);
      res.status(500).json({ error: 'Failed to get categories' });
    }
  }

  getDailyReports(req, res) {
    try {
      if (!this.storage) {
        return res.status(503).json({ error: 'Storage not available' });
      }

      const { limit = 30 } = req.query;
      const reports = this.storage.getDailySummariesWithDetails(parseInt(limit));

      res.json(reports);
    } catch (error) {
      console.error('Get daily reports error:', error);
      res.status(500).json({ error: 'Failed to get daily reports' });
    }
  }

  getSystemStatus(req, res) {
    try {
      const status = {
        server: {
          running: this.isRunning,
          port: this.port,
          uptime: process.uptime()
        },
        database: {
          connected: this.storage !== null,
          categories: this.storage ? this.storage.getCategories().length : 0
        },
        timestamp: new Date().toISOString()
      };

      res.json(status);
    } catch (error) {
      console.error('Get system status error:', error);
      res.status(500).json({ error: 'Failed to get system status' });
    }
  }

  getDefaultDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HammamPOS Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container {
            background: white;
            padding: 2rem;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            text-align: center;
            max-width: 500px;
            width: 90%;
        }
        h1 { color: #333; margin-bottom: 1rem; }
        .status { color: #28a745; font-size: 1.2rem; margin-bottom: 2rem; }
        .info { color: #666; line-height: 1.6; }
        .api-info {
            background: #f8f9fa;
            padding: 1rem;
            border-radius: 5px;
            margin-top: 1rem;
            text-align: left;
        }
        .endpoint { 
            font-family: monospace; 
            background: #e9ecef; 
            padding: 0.2rem 0.5rem; 
            border-radius: 3px; 
            margin: 0.2rem 0;
            display: block;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🏛️ HammamPOS Dashboard</h1>
        <div class="status">✅ Server Running</div>
        <div class="info">
            <p>Web Dashboard is active and ready for remote access.</p>
            <div class="api-info">
                <strong>Available API Endpoints:</strong>
                <code class="endpoint">POST /api/auth/login</code>
                <code class="endpoint">GET /api/dashboard/summary</code>
                <code class="endpoint">GET /api/tickets</code>
                <code class="endpoint">GET /api/expenses</code>
                <code class="endpoint">GET /api/collections</code>
                <code class="endpoint">GET /api/reports/daily</code>
            </div>
        </div>
    </div>
</body>
</html>`;
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      port: this.port,
      url: this.isRunning ? `http://localhost:${this.port}` : null,
      hasStorage: this.storage !== null
    };
  }
}

module.exports = WebDashboard;
