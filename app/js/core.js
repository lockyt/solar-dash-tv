/*
 * Solar Dash core: namespace, helpers, events and settings storage.
 *
 * Everything in app/js is hand-written ES5 with no build step, because webOS 3.x
 * runs a Chromium 38-era engine (no arrow functions, let/const, fetch, CSS vars).
 */
var SD = window.SD = {};

(function () {
  'use strict';

  // ---------- small helpers ----------
  var U = SD.util = {};

  U.isNum = function (v) { return typeof v === 'number' && isFinite(v); };
  U.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  U.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  U.extend = function (dst) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) { continue; }
      for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) { dst[k] = src[k]; } }
    }
    return dst;
  };
  U.each = function (arr, fn) { for (var i = 0; i < arr.length; i++) { fn(arr[i], i); } };
  U.map = function (arr, fn) { var out = []; for (var i = 0; i < arr.length; i++) { out.push(fn(arr[i], i)); } return out; };
  U.sum = function (arr) { var s = 0; for (var i = 0; i < arr.length; i++) { if (U.isNum(arr[i])) { s += arr[i]; } } return s; };
  U.max = function (arr) { var m = -Infinity; for (var i = 0; i < arr.length; i++) { if (U.isNum(arr[i]) && arr[i] > m) { m = arr[i]; } } return m; };
  U.min = function (arr) { var m = Infinity; for (var i = 0; i < arr.length; i++) { if (U.isNum(arr[i]) && arr[i] < m) { m = arr[i]; } } return m; };

  // Power in kW -> "4.2 kW" / "850 W"
  U.fmtPower = function (kw) {
    if (!U.isNum(kw)) { return '--'; }
    var a = Math.abs(kw);
    if (a < 1) { return Math.round(a * 1000) + ' W'; }
    return (a < 10 ? a.toFixed(2) : a.toFixed(1)) + ' kW';
  };
  U.fmtEnergy = function (kwh) {
    if (!U.isNum(kwh)) { return '--'; }
    return (Math.abs(kwh) < 100 ? kwh.toFixed(1) : Math.round(kwh)) + ' kWh';
  };
  // Price in c/kWh
  U.fmtCents = function (c) {
    if (!U.isNum(c)) { return '--'; }
    return (Math.abs(c) < 10 ? c.toFixed(1) : Math.round(c)) + '¢';
  };
  U.fmtTime = function (d) {
    if (!(d instanceof Date)) { d = new Date(d); }
    if (isNaN(d.getTime())) { return '--:--'; }
    return U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  };
  U.fmtDuration = function (hours) {
    if (!U.isNum(hours) || hours < 0) { return '--'; }
    var h = Math.floor(hours), m = Math.round((hours - h) * 60);
    if (m === 60) { h += 1; m = 0; }
    return h > 0 ? h + 'h ' + U.pad2(m) + 'm' : m + 'm';
  };
  U.ago = function (ts) {
    if (!ts) { return 'never'; }
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) { return s + 's ago'; }
    if (s < 3600) { return Math.round(s / 60) + 'm ago'; }
    return Math.round(s / 3600) + 'h ago';
  };
  U.startOfDay = function (d) {
    var x = new Date(d || Date.now());
    x.setHours(0, 0, 0, 0);
    return x;
  };
  U.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // Build DOM: U.h('div', {class: 'x', text: 'hi'}, [children])
  U.h = function (tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) { continue; }
      var v = attrs[k];
      if (v == null || v === false) { continue; }
      if (k === 'text') { el.textContent = v; }
      else if (k === 'html') { el.innerHTML = v; }
      else if (k === 'class') { el.className = v; }
      else if (k.indexOf('on') === 0 && typeof v === 'function') { el.addEventListener(k.slice(2), v); }
      else { el.setAttribute(k, v === true ? '' : v); }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c == null || c === false) { continue; }
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return el;
  };

  // ---------- events ----------
  var listeners = {};
  SD.on = function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); };
  SD.off = function (name, fn) {
    var l = listeners[name] || [];
    for (var i = l.length - 1; i >= 0; i--) { if (l[i] === fn) { l.splice(i, 1); } }
  };
  SD.emit = function (name, data) {
    var l = (listeners[name] || []).slice();
    for (var i = 0; i < l.length; i++) {
      try { l[i](data); } catch (e) { if (window.console) { console.error(e); } }
    }
  };

  // ---------- settings (localStorage, guarded) ----------
  var KEY = 'solardash.settings.v1';
  var DEFAULTS = {
    foxApiKey: '',
    foxServer: 'global',     // 'global' | 'us'
    foxSn: '',
    amberToken: '',
    amberSiteId: '',
    refreshSec: 90,          // FoxESS real-time poll; 1440 calls/day/inverter budget
    batteryKwh: 0,           // 0 = auto from device detail
    maxPowerKw: 0,           // 0 = auto from inverter (force charge/discharge limit)
    pixelShift: true,        // OLED burn-in protection
    dimMinutes: 15,          // dim after N idle minutes (0 = off)
    tvScreensaverMin: 3,     // let LG's screensaver start after N idle minutes (1 = TV default)
    referenceCents: 32,      // typical retail buy price for comparison (c/kWh)
    tickerEnabled: true,     // background price notifications (rooted TVs, needs the daemon)
    tickerInterval: 15,      // minutes between notifications (0 = only on change/spike)
    tickerChange: 5,         // notify when buy price moves by this many c/kWh (0 = off)
    tickerSpikes: true,
    tickerFields: 'price',   // 'price' | 'price-soc' | 'price-soc-solar' | 'all'
    tickerHoldSec: 30,       // seconds each notification stays up (-1 = always)
    demo: false
  };

  function load(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  SD.settings = U.extend({}, DEFAULTS, load(KEY, {}));
  if (/[?&]demo=1/.test(window.location.search)) { SD.settings.demo = true; }

  SD.saveSettings = function (patch) {
    U.extend(SD.settings, patch || {});
    save(KEY, SD.settings);
    SD.emit('settings', SD.settings);
  };
  SD.store = { load: load, save: save };

  SD.isConfigured = function () {
    return !!(SD.settings.foxApiKey && SD.settings.foxSn);
  };
  SD.isDemo = function () {
    return SD.settings.demo || !SD.isConfigured();
  };
  SD.foxBaseUrl = function () {
    return SD.settings.foxServer === 'us' ? 'https://portal.foxesscloud.us' : 'https://www.foxesscloud.com';
  };
})();
