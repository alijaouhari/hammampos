/**
 * HammamPOS - RemoteCommands
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * Unauthorized copying or distribution is strictly prohibited.
 *
 * Runs commands the manager sends from the dashboard (table device_commands).
 *  - Live: a Supabase Realtime subscription delivers new commands in about a second.
 *  - Safety net: poll() (called every 15 s by the heartbeat) picks up anything missed.
 *  - Each command is claimed once on the server (claim_device_command), which also
 *    refuses commands older than 10 minutes by the SERVER clock.
 *  - Only actions in ALLOWED_ACTIONS run; anything else is answered "not allowed".
 *  - A handler may return { result, after } — the result is reported first and
 *    after() runs 1.5 s later (restart app / restart PC / install update).
 */

const ALLOWED_ACTIONS = ['ping', 'sync_now', 'diagnostics', 'restart_app', 'restart_pc', 'install_update', 'backup_now'];
const MAX_RESULT_CHARS = 60000;

class RemoteCommands {
  /**
   * @param {CloudSync} cloud  provides .supabase and .locationId
   * @param {Object<string, function(object): any>} handlers  action -> handler
   */
  constructor(cloud, handlers = {}, options = {}) {
    this.cloud = cloud;
    this.handlers = handlers;
    this.channel = null;
    this.live = false;
    this.busy = new Set();
    this.lastCommandAt = null;
    this.delayMs = options.afterDelayMs != null ? options.afterDelayMs : 1500;
  }

  get sb() { return this.cloud.supabase; }

  /** (Re)subscribe to this location's commands and catch up on pending ones. */
  async start() {
    if (!this.sb || !this.cloud.locationId) return;
    this.stop();
    const loc = this.cloud.locationId;
    try {
      if (typeof this.sb.channel === 'function') {
        this.channel = this.sb.channel('device-commands-' + loc)
          .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'device_commands', filter: 'location_id=eq.' + loc },
            (payload) => { this.handle(payload.new).catch(() => {}); })
          .subscribe((status) => { this.live = status === 'SUBSCRIBED'; });
      }
    } catch (error) {
      this.live = false;
      console.warn('Remote commands: live channel unavailable:', error.message);
    }
    await this.poll();
  }

  stop() {
    if (this.channel) {
      try { this.sb.removeChannel(this.channel); } catch (_) {}
    }
    this.channel = null;
    this.live = false;
  }

  /** Safety net: run pending commands that the live channel did not deliver. */
  async poll() {
    if (!this.sb || !this.cloud.locationId) return;
    const { data, error } = await this.sb.from('device_commands').select('*')
      .eq('location_id', this.cloud.locationId).eq('status', 'pending').order('id', { ascending: true }).limit(10);
    if (error || !data) return;
    for (const cmd of data) await this.handle(cmd);
    // the live link dropped: try to open it again
    if (!this.live && this.channel === null) this.start().catch(() => {});
  }

  async handle(cmd) {
    if (!cmd || !cmd.id || cmd.status !== 'pending' || this.busy.has(cmd.id)) return;
    this.busy.add(cmd.id);
    let after = null;
    try {
      const { data: claimed, error } = await this.sb.rpc('claim_device_command', { cmd_id: cmd.id });
      if (error || !claimed || !claimed.id) return; // already taken, expired, or not ours
      this.lastCommandAt = new Date().toISOString();
      const handler = ALLOWED_ACTIONS.includes(claimed.action) ? this.handlers[claimed.action] : null;
      if (!handler) {
        await this._finish(claimed.id, 'failed', { error: 'الإجراء غير مسموح: ' + claimed.action });
        return;
      }
      try {
        const out = await handler(claimed.args || {});
        const isWrapped = out && typeof out === 'object' && typeof out.after === 'function';
        if (isWrapped) after = out.after;
        await this._finish(claimed.id, 'done', isWrapped ? (out.result || {}) : (out === undefined ? {} : out));
      } catch (e) {
        await this._finish(claimed.id, 'failed', { error: String((e && e.message) || e) });
      }
    } finally {
      setTimeout(() => this.busy.delete(cmd.id), 10 * 60 * 1000).unref?.();
    }
    if (after) {
      const t = setTimeout(() => { try { after(); } catch (e) { console.error('Remote command action failed:', e.message); } }, this.delayMs);
      if (t.unref && this.delayMs > 5000) t.unref();
    }
  }

  async _finish(id, status, result) {
    let json = result;
    try {
      const text = JSON.stringify(result);
      if (text && text.length > MAX_RESULT_CHARS) json = { truncated: true, text: text.slice(0, MAX_RESULT_CHARS) };
    } catch (_) { json = { error: 'result not serializable' }; }
    await this.sb.from('device_commands').update({ status, result: json }).eq('id', id);
  }
}

RemoteCommands.ALLOWED_ACTIONS = ALLOWED_ACTIONS;
module.exports = RemoteCommands;
