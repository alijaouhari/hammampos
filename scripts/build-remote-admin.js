#!/usr/bin/env node
/**
 * Builds dashboard-deploy/admin.html (remote admin panel) from the app's own screen.
 *   node scripts/build-remote-admin.js
 * Run before every dashboard deploy so the remote panel matches the app version.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/renderer/hammampos.html'), 'utf8');
const osk = fs.readFileSync(path.join(root, 'src/services/OnScreenKeyboard.js'), 'utf8');
const dash = fs.readFileSync(path.join(root, 'dashboard-deploy/index.html'), 'utf8');
const version = require(path.join(root, 'package.json')).version;

// The installation's settings come from the dashboard (one place to change per customer).
const m = dash.match(/const CONFIG = (\{[\s\S]*?\n\});/);
if (!m) throw new Error('CONFIG block not found in dashboard-deploy/index.html');

const head = [
  '<meta name="robots" content="noindex">',
  '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
  '<script>window.HPOS_CONFIG = ' + m[1] + ';</script>',
  '<script>window.__OSK_MODULE = (function () { var module = { exports: {} }; var exports = module.exports;\n' + osk + '\nreturn module.exports; })();</script>',
  '<script src="remote-shim.js?v=' + version + '"></script>'
].join('\n');

if (!/<head>/i.test(app)) throw new Error('<head> not found in hammampos.html');
const out = app.replace(/<head>/i, '<head>\n<!-- Remote admin panel built from HammamPOS v' + version + ' -->\n' + head + '\n');
fs.writeFileSync(path.join(root, 'dashboard-deploy/admin.html'), out, 'utf8');
console.log('dashboard-deploy/admin.html built from v' + version + ' (' + Math.round(out.length / 1024) + ' KB)');
