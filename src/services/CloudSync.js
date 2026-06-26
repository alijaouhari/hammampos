/**
 * HammamPOS - CloudSync
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Syncs tickets, expenses, and collections to Supabase in realtime.
 * Handles offline mode with a queue table in local SQLite.
 * 
 * Config (stored in settings):
 *   - cloud_url: Supabase project URL
 *   - cloud_key: Supabase anon key
 *   - location_id: UUID assigned to this installation
 *   - location_name: Human-readable name for this location
 */

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

class CloudSync {
  constructor(storage) {
    this.storage = storage;
    this.supabase = null;
    this.locationId = null;
    this.enabled = false;
    this.syncing = false;
    this.retryInterval = null;
  }

  /**
   * Initialize cloud sync. Returns silently if not configured.
   */
  async initialize() {
    const url = this.storage.getSetting('cloud_url');
    const key = this.storage.getSetting('cloud_key');

    if (!url || !key) {
      console.log('☁️ Cloud sync not configured (no URL/key)');
      return { success: false, reason: 'not_configured' };
    }

    try {
      this.supabase = createClient(url, key, {
        realtime: { transport: WebSocket }
      });
      
      // Create local sync queue table if not exists
      this.storage.db.run(`CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        local_id INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(table_name, local_id)
      )`);
      this.storage.save();

      // Register or retrieve location
      await this.ensureLocation();
      
      this.enabled = true;
      
      // Process any queued items from previous offline period
      await this.processQueue();
      
      // Retry queue every 30 seconds
      this.retryInterval = setInterval(() => this.processQueue(), 30000);

      console.log(`☁️ Cloud sync ready: ${this.storage.getSetting('location_name')} (${this.locationId})`);
      return { success: true, locationId: this.locationId };
    } catch (error) {
      console.error('☁️ Cloud sync init failed:', error.message);
      return { success: false, reason: error.message };
    }
  }

  /**
   * Register this location in Supabase if not already done.
   */
  async ensureLocation() {
    let locationId = this.storage.getSetting('location_id');
    const locationName = this.storage.getSetting('location_name') || this.storage.getSetting('hammam_name') || 'Unknown';

    if (locationId) {
      // Verify it still exists in Supabase
      const { data } = await this.supabase
        .from('locations')
        .select('id')
        .eq('id', locationId)
        .single();

      if (data) {
        this.locationId = locationId;
        return;
      }
      // If not found, re-register
    }

    // Create new location
    const { data, error } = await this.supabase
      .from('locations')
      .insert({ name: locationName })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to register location: ${error.message}`);

    this.locationId = data.id;
    this.storage.setSetting('location_id', data.id);
    console.log(`☁️ Location registered: ${locationName} → ${data.id}`);
  }

  // ─── SYNC METHODS ───────────────────────────────────────────────────

  /**
   * Sync a ticket to the cloud. Called after every sale.
   */
  async syncTicket(ticket) {
    if (!this.enabled) return;

    const row = {
      location_id: this.locationId,
      local_id: ticket.id,
      serial_number: ticket.serial_number,
      year: ticket.year,
      category_name: ticket.category_name,
      price: ticket.price,
      date: ticket.date,
      time: ticket.time
    };

    try {
      const { error } = await this.supabase
        .from('tickets')
        .upsert(row, { onConflict: 'location_id,local_id' });

      if (error) throw error;
    } catch (error) {
      this.queueItem('tickets', ticket.id, row);
    }
  }

  /**
   * Sync an expense to the cloud.
   */
  async syncExpense(expense) {
    if (!this.enabled) return;

    const row = {
      location_id: this.locationId,
      local_id: expense.id,
      description: expense.description,
      amount: expense.amount,
      date: expense.date,
      time: expense.time
    };

    try {
      const { error } = await this.supabase
        .from('expenses')
        .upsert(row, { onConflict: 'location_id,local_id' });

      if (error) throw error;
    } catch (error) {
      this.queueItem('expenses', expense.id, row);
    }
  }

  /**
   * Sync a collection to the cloud.
   */
  async syncCollection(collection) {
    if (!this.enabled) return;

    const row = {
      location_id: this.locationId,
      local_id: collection.id,
      amount: collection.amount,
      notes: collection.notes || null,
      date: collection.date,
      time: collection.time
    };

    try {
      const { error } = await this.supabase
        .from('collections')
        .upsert(row, { onConflict: 'location_id,local_id' });

      if (error) throw error;
    } catch (error) {
      this.queueItem('collections', collection.id, row);
    }
  }

  // ─── OFFLINE QUEUE ──────────────────────────────────────────────────

  /**
   * Add a failed sync to the local queue for retry.
   */
  queueItem(tableName, localId, data) {
    try {
      this.storage.db.run(
        `INSERT OR REPLACE INTO sync_queue (table_name, local_id, data) VALUES (?, ?, ?)`,
        [tableName, localId, JSON.stringify(data)]
      );
      this.storage.save();
    } catch (error) {
      console.error('☁️ Failed to queue sync item:', error.message);
    }
  }

  /**
   * Process all queued items. Called on init and every 30s.
   */
  async processQueue() {
    if (this.syncing || !this.enabled) return;
    this.syncing = true;

    try {
      const result = this.storage.db.exec('SELECT id, table_name, local_id, data FROM sync_queue ORDER BY id LIMIT 50');
      if (!result.length || !result[0].values.length) {
        this.syncing = false;
        return;
      }

      const rows = result[0].values;
      const processed = [];

      for (const [id, tableName, localId, dataJson] of rows) {
        try {
          const data = JSON.parse(dataJson);
          const { error } = await this.supabase
            .from(tableName)
            .upsert(data, { onConflict: 'location_id,local_id' });

          if (!error) {
            processed.push(id);
          }
        } catch (_) {
          // Still offline, stop trying
          break;
        }
      }

      // Remove successfully synced items
      if (processed.length > 0) {
        this.storage.db.run(`DELETE FROM sync_queue WHERE id IN (${processed.join(',')})`);
        this.storage.save();
        console.log(`☁️ Synced ${processed.length} queued items`);
      }
    } catch (error) {
      // Silently fail — will retry next interval
    }

    this.syncing = false;
  }

  // ─── STATUS & CLEANUP ───────────────────────────────────────────────

  getStatus() {
    let queueSize = 0;
    try {
      const result = this.storage.db.exec('SELECT COUNT(*) FROM sync_queue');
      if (result.length) queueSize = result[0].values[0][0];
    } catch (_) {}

    return {
      enabled: this.enabled,
      locationId: this.locationId,
      locationName: this.storage.getSetting('location_name'),
      queueSize
    };
  }

  async stop() {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
    this.enabled = false;
  }
}

module.exports = CloudSync;
