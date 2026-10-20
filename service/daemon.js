/*
 * Solar Dash background daemon (rooted TVs only).
 *
 * Started at boot by /var/lib/webosbrew/init.d/solardash (see init/solardash.sh),
 * runs as root under the TV's Node 0.12, independent of whichever app is on screen.
 *
 *  - Polls Amber and shows the price as a webOS notification (the "ticker") on a
 *    timer, when the price moves, and immediately on spikes. Notifications never
 *    take the remote away from Netflix/HDMI etc.
 *  - Restores the user's FoxESS schedule when a battery override expires, even if
 *    the Solar Dash app is closed.
 *  - Talks to the app over http://127.0.0.1:8643 (config in, status out).
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;
var proxy = require('./lib/proxy');
var bands = require('./lib/bands'); // copied from app/js/bands.js at package time

var VERSION = '0.2.8';
var PORT = 8643;
var APP_ID = 'com.solardash.tv';
var DIR = process.env.SOLARDASH_DIR || '/home/root/.solardash';
var CONFIG_FILE = path.join(DIR, 'config.json');
var OVERRIDE_FILE = path.join(DIR, 'override.json');
var LUNA_SEND = process.env.LUNA_SEND || '/usr/bin/luna-send';

var DEFAULT_TICKER = {
  enabled: true,
  intervalMin: 15,     // 0 = no timed notifications
  changeCents: 5,      // 0 = ignore price moves
  spikes: true,
  fields: 'price',     // 'price' | 'price-soc' | 'price-soc-solar' | 'all'
  holdSec: 30          // how long each notification stays up (-1 = always)
};

var config = readJson(CONFIG_FILE, {});
var override = readJson(OVERRIDE_FILE, null);
var state = {
  started: Date.now(),
  price: null,
  priceAt: 0,
  priceError: null,
  live: null,
  liveAt: 0,
  lastToastAt: Date.now(), // don't notify just because the daemon (re)started
  lastToastBuy: null,
  lastSpikeStatus: 'none',
  lastToast: null,
  lastRestore: null,
  priceStats: null,
  priceStatsDay: null
};

// ---------- utils ----------
function log(msg) {
  var line = new Date().toISOString() + ' ' + msg;
  console.log(line);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, value) {
  try {
    if (!fs.existsSync(DIR)) { fs.mkdirSync(DIR); }
    if (value === null) { if (fs.existsSync(file)) { fs.unlinkSync(file); } return; }
    fs.writeFileSync(file, JSON.stringify(value), { mode: 384 }); // 0600: contains API keys
  } catch (e) { log('write failed ' + file + ': ' + e.message); }
}
function ticker() {
  var t = config.ticker || {};
  var out = {};
  for (var k in DEFAULT_TICKER) { if (DEFAULT_TICKER.hasOwnProperty(k)) { out[k] = t[k] != null ? t[k] : DEFAULT_TICKER[k]; } }
  return out;
}
function cents(c) {
  if (typeof c !== 'number' || !isFinite(c)) { return '--'; }
  return String(Math.round(c)) + 'c';
}
function kw(v) {
  if (typeof v !== 'number' || !isFinite(v)) { return '--'; }
  return (Math.abs(v) < 10 ? v.toFixed(1) : String(Math.round(v))) + ' kW';
}
function luna(uri, payload, cb) {
  execFile(LUNA_SEND, ['-w', '5000', '-n', '1', '-a', APP_ID, uri, JSON.stringify(payload)], { timeout: 8000 }, function (err, stdout) {
    var res = null;
    try { res = JSON.parse(stdout); } catch (e) { /* ignore */ }
    if (cb) { cb(err, res); }
  });
}

// ---------- notifications ----------
function buildMessage(reason, fieldsOverride) {
  var p = state.price || {};
  var t = ticker();
  if (fieldsOverride) { t.fields = fieldsOverride; }
  // Kept deliberately short: the user wants the smallest possible notification.
  var parts = ['Buy ' + cents(p.buy), 'Sell ' + cents(p.sell)];
  if (t.fields === 'all') {
    var band = bands.buyBand(p.buy, state.priceStats, config.referenceCents, p.spikeStatus);
    if (band) { parts.push(band.label); }
  }
  var l = state.live;
  if (l && t.fields !== 'price') {
    if (typeof l.soc === 'number') { parts.push('Bat ' + Math.round(l.soc) + '%'); }
    if (t.fields === 'price-soc-solar' || t.fields === 'all') { parts.push('Solar ' + kw(l.pv)); }
    if (t.fields === 'all') {
      parts.push('Home ' + kw(l.load));
      if (typeof l.grid === 'number') { parts.push(l.grid >= 0 ? 'Import ' + kw(l.grid) : 'Export ' + kw(-l.grid)); }
    }
  }
  var title = reason === 'spike' ? 'SPIKE ' : (reason === 'potential' ? 'Spike? ' : '');
  return title + parts.join(' \u00b7 ');
}

/*
 * A webOS toast only stays up ~5 s. Re-sending it every 4 s keeps a single toast
 * on screen without flicker, so "hold" repeats it until the hold time ends.
 */
var hold = { until: 0, reason: null, fields: null, timer: null };
var REPEAT_MS = 4000;

function startHold(reason, opts) {
  var t = ticker();
  var holdSec = opts && opts.holdSec != null ? opts.holdSec : t.holdSec;
  hold.reason = reason;
  hold.fields = opts && opts.fields ? opts.fields : null;
  hold.until = holdSec < 0 ? Infinity : Date.now() + Math.max(5, holdSec) * 1000;
  if (hold.timer) { return; } // already running; just extended
  (function tick() {
    if (Date.now() >= hold.until || !ticker().enabled) { hold.timer = null; return; }
    hold.timer = 'pending'; // keep startHold() from starting a second loop
    // Never re-send while the screensaver (or standby) is up: a new toast would wake the screen.
    luna('luna://com.webos.service.tvpower/power/getPowerState', {}, function (err, pw) {
      if (pw && pw.state && pw.state !== 'Active') { hold.timer = null; hold.until = 0; return; }
      toast(buildMessage(hold.reason, hold.fields));
      hold.timer = setTimeout(tick, REPEAT_MS);
    });
  })();
}

function stopHold() {
  hold.until = 0;
  if (hold.timer && hold.timer !== 'pending') { clearTimeout(hold.timer); }
  hold.timer = null;
}

function toast(message) {
  state.lastToast = { at: Date.now(), message: message };
  luna('luna://com.webos.notification/createToast', {
    sourceId: APP_ID, message: message, onclick: { appId: APP_ID }
  }, function (err, res) {
    if (err || !res || res.returnValue === false) { log('toast failed: ' + (err ? err.message : JSON.stringify(res))); }
  });
}

// Only notify while the screen is on and the Solar Dash app isn't already showing.
function canNotify(cb) {
  luna('luna://com.webos.service.tvpower/power/getPowerState', {}, function (err, pw) {
    if (pw && pw.state && pw.state !== 'Active') { return cb(false); }
    luna('luna://com.webos.applicationManager/getForegroundAppInfo', {}, function (err2, fg) {
      cb(!(fg && fg.appId === APP_ID));
    });
  });
}

function tickerCheck() {
  var t = ticker();
  var p = state.price;
  if (!t.enabled || !p || Date.now() - state.priceAt > 10 * 60000) { return; }
  var now = Date.now();
  var reason = null;
  var spikeNow = p.spikeStatus === 'spike' || p.descriptor === 'spike' ? 'spike' : (p.spikeStatus === 'potential' ? 'potential' : 'none');

  if (t.spikes && spikeNow !== 'none' && spikeNow !== state.lastSpikeStatus) { reason = spikeNow; }
  else if (t.spikes && spikeNow === 'spike' && now - state.lastToastAt > 5 * 60000) { reason = 'spike'; }
  else if (t.changeCents > 0 && state.lastToastBuy != null && Math.abs(p.buy - state.lastToastBuy) >= t.changeCents) { reason = 'change'; }
  else if (t.intervalMin > 0 && now - state.lastToastAt >= t.intervalMin * 60000) { reason = 'interval'; }
  state.lastSpikeStatus = spikeNow;

  var always = t.holdSec < 0;
  if (!always && (!reason || now - state.lastToastAt < 60000)) { return; }
  canNotify(function (ok) {
    if (!ok) { stopHold(); return; }
    if (always && !reason && hold.timer) { return; } // already showing continuously
    state.lastToastAt = Date.now();
    state.lastToastBuy = p.buy;
    startHold(reason || 'interval');
  });
}

// ---------- data ----------
function pollPrice() {
  if (!config.amberToken || !config.amberSiteId) { return; }
  proxy.amber({ token: config.amberToken, path: '/sites/' + config.amberSiteId + '/prices/current', query: { previous: 0, next: 0, resolution: 5 } }, function (err, res) {
    if (err || !res.returnValue) { state.priceError = err ? err.message : res.errorText; return; }
    var p = {};
    (res.result || []).forEach(function (it) {
      if (it.type !== 'CurrentInterval') { return; }
      if (it.channelType === 'general') {
        p.buy = it.perKwh; p.descriptor = it.descriptor; p.spikeStatus = it.spikeStatus; p.renewables = it.renewables; p.end = it.endTime;
      } else if (it.channelType === 'feedIn') {
        p.sell = -it.perKwh; // Amber feed-in is negative when you get paid
      }
    });
    if (state.lastToastBuy == null) { state.lastToastBuy = p.buy; } // baseline for 'price moves'
    state.price = p;
    state.priceAt = Date.now();
    state.priceError = null;
    tickerCheck();
  });
}

// 4 weeks of Amber prices (7-day requests), refreshed once a day, for price bands
function loadPriceHistory() {
  if (!config.amberToken || !config.amberSiteId) { return; }
  var day = new Date().toDateString() + ':' + config.amberSiteId;
  if (state.priceStatsDay === day) { return; }
  var ranges = bands.historyRanges();
  var all = [];
  (function next(i) {
    if (i >= ranges.length) {
      state.priceStats = bands.buildStats(all);
      state.priceStatsDay = day;
      log('price history loaded: ' + state.priceStats.n + ' intervals');
      return;
    }
    proxy.amber({ token: config.amberToken, path: '/sites/' + config.amberSiteId + '/prices',
      query: { startDate: ranges[i].startDate, endDate: ranges[i].endDate, resolution: 30 } }, function (err, res) {
      if (!err && res && res.returnValue) { all = all.concat(res.result || []); }
      next(i + 1);
    });
  })(0);
}

function needsLive() {
  var t = ticker();
  return t.enabled && t.fields !== 'price' && config.foxApiKey && config.foxSn;
}

function pollLive(cb, force) {
  cb = cb || function () {};
  if (!force && !needsLive()) { return cb(); }
  if (!config.foxApiKey || !config.foxSn) { return cb(); }
  proxy.foxess({
    apiKey: config.foxApiKey, baseUrl: config.foxBaseUrl, method: 'POST', path: '/op/v1/device/real/query',
    body: { sns: [config.foxSn], variables: ['pvPower', 'loadsPower', 'SoC', 'gridConsumptionPower', 'feedinPower'] }
  }, function (err, res) {
    if (err || !res.returnValue) { return cb(); }
    var v = {};
    (((res.result || [])[0] || {}).datas || []).forEach(function (d) { v[d.variable] = Number(d.value); });
    state.live = { pv: v.pvPower, load: v.loadsPower, soc: v.SoC, grid: (v.gridConsumptionPower || 0) - (v.feedinPower || 0) };
    state.liveAt = Date.now();
    cb();
  });
}

// ---------- battery override expiry ----------
function restoreOverride() {
  var o = override;
  if (!o || Date.now() < o.until || !config.foxApiKey || !o.sn) { return; }
  var b = o.backup || { enabled: false, groups: [] };
  function call(p, body, cb) {
    proxy.foxess({ apiKey: config.foxApiKey, baseUrl: config.foxBaseUrl, method: 'POST', path: p, body: body }, function (err, res) {
      cb(err || (res && !res.returnValue ? new Error(res.errorText) : null));
    });
  }
  function done(err) {
    if (err) { log('restore failed: ' + err.message); state.lastRestore = { at: Date.now(), error: err.message }; return; }
    log('override expired - schedule restored');
    state.lastRestore = { at: Date.now(), ok: true };
    override = null;
    writeJson(OVERRIDE_FILE, null);
    toast('Battery override ended \u00b7 normal schedule restored');
  }
  if (b.groups && b.groups.length) {
    call('/op/v1/device/scheduler/enable', { deviceSN: o.sn, groups: b.groups }, function (err) {
      if (err) { return done(err); }
      call('/op/v1/device/scheduler/set/flag', { deviceSN: o.sn, enable: b.enabled ? 1 : 0 }, done);
    });
  } else {
    call('/op/v1/device/scheduler/set/flag', { deviceSN: o.sn, enable: 0 }, done);
  }
}

// ---------- local API for the app ----------
function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  var body = '';
  req.on('data', function (c) { body += c; if (body.length > 200000) { req.destroy(); } });
  req.on('end', function () {
    try { cb(null, body ? JSON.parse(body) : {}); } catch (e) { cb(e); }
  });
}

var server = http.createServer(function (req, res) {
  var url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { return send(res, 204, {}); }

  if (url === '/status' && req.method === 'GET') {
    return send(res, 200, {
      version: VERSION, uptimeSec: Math.round((Date.now() - state.started) / 1000),
      configured: { amber: !!(config.amberToken && config.amberSiteId), fox: !!(config.foxApiKey && config.foxSn) },
      ticker: ticker(), price: state.price, priceAt: state.priceAt, priceError: state.priceError,
      historyIntervals: state.priceStats ? state.priceStats.n : 0,
      lastToast: state.lastToast, override: override ? { mode: override.mode, until: override.until } : null,
      lastRestore: state.lastRestore
    });
  }
  if (url === '/config' && req.method === 'POST') {
    return readBody(req, function (err, body) {
      if (err) { return send(res, 400, { ok: false, error: 'Bad JSON' }); }
      var amberChanged = body.amberToken !== config.amberToken || body.amberSiteId !== config.amberSiteId;
      config = {
        foxApiKey: body.foxApiKey || '', foxBaseUrl: body.foxBaseUrl || '', foxSn: body.foxSn || '',
        amberToken: body.amberToken || '', amberSiteId: body.amberSiteId || '', ticker: body.ticker || {},
        referenceCents: Number(body.referenceCents) || bands.DEFAULT_REFERENCE
      };
      writeJson(CONFIG_FILE, config);
      if (amberChanged) { state.priceStatsDay = null; pollPrice(); loadPriceHistory(); }
      send(res, 200, { ok: true });
    });
  }
  if (url === '/override' && req.method === 'POST') {
    return readBody(req, function (err, body) {
      if (err) { return send(res, 400, { ok: false, error: 'Bad JSON' }); }
      override = body && body.until ? body : null;
      writeJson(OVERRIDE_FILE, override);
      send(res, 200, { ok: true });
    });
  }
  if (url === '/quit' && req.method === 'POST') {
    send(res, 200, { ok: true });
    log('quit requested');
    return setTimeout(function () { process.exit(0); }, 100);
  }
  if (url === '/test' && req.method === 'POST') {
    // Show exactly what the app's settings screen has selected (may not be saved yet)
    return readBody(req, function (err, body) {
      body = body || {};
      var fields = body.fields || ticker().fields;
      var holdSec = body.holdSec != null ? Number(body.holdSec) : ticker().holdSec;
      if (holdSec < 0 || holdSec > 30) { holdSec = 30; } // keep tests short
      send(res, 200, { ok: true });
      if (!state.price) { return toast('Solar Dash notifications are working'); }
      var fresh = state.live && Date.now() - state.liveAt < 10 * 60000;
      if (fields === 'price' || fresh) { return startHold('test', { fields: fields, holdSec: holdSec }); }
      pollLive(function () { startHold('test', { fields: fields, holdSec: holdSec }); }, true);
    });
  }
  send(res, 404, { ok: false, error: 'Not found' });
});

server.on('error', function (e) {
  log('server error: ' + e.message);
  if (e.code === 'EADDRINUSE') { process.exit(3); } // another daemon is already running
});
server.listen(PORT, '127.0.0.1', function () {
  log('Solar Dash daemon ' + VERSION + ' listening on 127.0.0.1:' + PORT + ' (node ' + process.version + ')');
});

pollPrice();
setInterval(pollPrice, 60000);
setTimeout(loadPriceHistory, 3000);
setInterval(loadPriceHistory, 3600000);
setTimeout(function () { pollLive(); }, 5000);
setInterval(function () { pollLive(); }, 5 * 60000);
setInterval(restoreOverride, 30000);
setInterval(tickerCheck, 30000);
