/*
 * App shell: header, tabs, remote keys, OLED protection, scaling and startup.
 */
(function () {
  'use strict';
  var U = SD.util;
  var KEY = SD.KEY;
  var TABS = ['overview', 'history', 'prices', 'battery', 'settings'];
  var current = null;
  var built = {};
  var el = {};

  // ---------- header ----------
  function buildHeader() {
    el.tabs = U.h('nav', { 'class': 'tabs' }, U.map(TABS, function (id, i) {
      var colorKey = ['red', 'green', 'yellow', 'blue', ''][i];
      return U.h('button', { 'class': 'tab focusable', 'data-tab': id, onclick: function () { show(id); } }, [
        colorKey ? U.h('i', { 'class': 'key-dot ' + colorKey }) : null,
        SD.views[id].title
      ]);
    }));
    el.demo = U.h('span', { 'class': 'badge demo hidden', text: 'DEMO DATA' });
    el.err = U.h('span', { 'class': 'badge err hidden' });
    el.updated = U.h('span', { 'class': 'dim' });
    el.clock = U.h('span', { 'class': 'clock' });
    return U.h('header', { 'class': 'header' }, [
      U.h('div', { 'class': 'brand' }, [U.h('span', { 'class': 'brand-dot' }), 'Solar Dash']),
      el.tabs,
      U.h('div', { 'class': 'hdr-right' }, [el.demo, el.err, el.updated, el.clock])
    ]);
  }

  function renderHeader() {
    el.clock.textContent = U.fmtTime(new Date());
    el.demo.classList.toggle('hidden', !SD.isDemo());
    var name = SD.state.device && SD.state.device.name;
    var fresh = SD.state.updated.liveData;
    el.updated.textContent = (name ? name + '  ·  ' : '') + (fresh ? 'inverter data ' + U.ago(fresh) : '');
    el.updated.classList.toggle('stale', !!fresh && Date.now() - fresh > 12 * 60000);
    var errs = [];
    for (var k in SD.state.errors) { if (SD.state.errors[k]) { errs.push(SD.state.errors[k]); } }
    el.err.classList.toggle('hidden', !errs.length);
    el.err.textContent = errs.length ? '⚠ ' + errs[0] : '';
  }

  // ---------- views ----------
  function show(id) {
    if (current === id) { return; }
    if (current && SD.views[current].onHide) { SD.views[current].onHide(); }
    U.each(U.$$('.view'), function (v) { v.classList.toggle('hidden', v.getAttribute('data-view') !== id); });
    if (!built[id]) {
      var root = U.h('div', { 'class': 'view', 'data-view': id });
      el.main.appendChild(root);
      SD.views[id].build(root);
      built[id] = root;
    }
    built[id].classList.remove('hidden');
    current = id;
    U.each(U.$$('.tab', el.tabs), function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === id); });
    if (SD.views[id].onShow) { SD.views[id].onShow(); }
    SD.focus(U.$('.tab[data-tab="' + id + '"]'));
    try { window.sessionStorage.setItem('solardash.tab', id); } catch (e) { /* ignore */ }
  }

  SD.on('update', function (key) {
    if (current && SD.views[current].onUpdate) { SD.views[current].onUpdate(key); }
    renderHeader();
  });
  SD.on('settings', renderHeader);

  // ---------- price spike alert ----------
  SD.on('spike', function (p) {
    var spiking = p.spikeStatus === 'spike' || p.descriptor === 'spike';
    el.spike.classList.toggle('hidden', !spiking);
    if (spiking) {
      el.spike.textContent = 'PRICE SPIKE  ·  Buy ' + U.fmtCents(p.buy) + '  ·  Sell ' + U.fmtCents(p.sell) + '  ·  until ' + U.fmtTime(p.end);
      wake();
    } else if (p.spikeStatus === 'potential') {
      SD.toast('Possible price spike - buy ' + U.fmtCents(p.buy), 'warn');
    }
  });

  // ---------- OLED protection ----------
  var idleTimer = null;
  var dimmed = false;
  function wake() {
    if (dimmed) { dimmed = false; document.body.classList.remove('dimmed'); }
    clearTimeout(idleTimer);
    var mins = Number(SD.settings.dimMinutes) || 0;
    if (mins > 0) {
      idleTimer = setTimeout(function () { dimmed = true; document.body.classList.add('dimmed'); }, mins * 60000);
    }
  }
  function pixelShift() {
    var dx = 0, dy = 0;
    if (SD.settings.pixelShift) { dx = Math.round(Math.random() * 12 - 6); dy = Math.round(Math.random() * 8 - 4); }
    el.shift.style.webkitTransform = 'translate(' + dx + 'px,' + dy + 'px)';
    el.shift.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }

  /*
   * LG's own screensaver starts after about a minute without remote input.
   * The TV asks running apps first (tvpower registerScreenSaverRequest); we say
   * "not yet" until the user has been idle for the chosen number of minutes.
   */
  var lastInput = Date.now();
  var ssBridge = null;
  SD.screensaverLog = [];
  function respondScreensaver(ts, ack) {
    var b = new window.PalmServiceBridge();
    b.onservicecallback = function () {};
    b.call('luna://com.webos.service.tvpower/power/responseScreenSaverRequest',
      JSON.stringify({ clientName: 'com.solardash.tv', ack: ack, timestamp: ts }));
  }
  /*
   * Registered clients that don't answer block the screensaver, so we only
   * register while Solar Dash is on screen, always answer, and drop the
   * registration as soon as another app or input takes over.
   */
  function isHidden() { return !!(document.hidden || document.webkitHidden); }

  function startScreensaverControl() {
    if (!window.PalmServiceBridge || ssBridge || isHidden()) { return; }
    var mins = Number(SD.settings.tvScreensaverMin) || 1;
    if (mins <= 1) { return; } // TV default: don't interfere at all
    ssBridge = new window.PalmServiceBridge();
    ssBridge.onservicecallback = function (msg) {
      var m;
      try { m = JSON.parse(msg); } catch (e) { return; }
      if (m.timestamp == null) { return; }
      var limit = (Number(SD.settings.tvScreensaverMin) || 1) * 60000;
      var idle = Date.now() - lastInput;
      var ack = isHidden() || idle >= limit;
      try { respondScreensaver(m.timestamp, ack); } catch (e) { /* ignore */ }
      SD.screensaverLog.push({ at: Date.now(), idleSec: Math.round(idle / 1000), ack: ack });
      if (SD.screensaverLog.length > 20) { SD.screensaverLog.shift(); }
    };
    ssBridge.call('luna://com.webos.service.tvpower/power/registerScreenSaverRequest',
      JSON.stringify({ subscribe: true, clientName: 'com.solardash.tv' }));
  }

  function stopScreensaverControl() {
    if (!ssBridge) { return; }
    try { ssBridge.cancel(); } catch (e) { /* ignore */ }
    ssBridge = null;
  }

  /*
   * Rooted TVs: the Homebrew Channel's own boot hook doesn't always fire on webOS 3.x,
   * which leaves update blocking, SSH and our notification service off after a reboot.
   * Asking it to run its startup on every launch (as its own app does) fixes that;
   * it does nothing if startup already ran this boot, or if the TV isn't rooted.
   */
  function runRootStartup() {
    if (!window.PalmServiceBridge) { return; }
    try {
      var b = new window.PalmServiceBridge();
      SD.rootStartupBridge = b;
      b.onservicecallback = function (msg) { SD.rootStartupReply = msg; };
      b.call('luna://org.webosbrew.hbchannel.service/autostart', '{}');
    } catch (e) { /* not rooted */ }
  }

  // ---------- keys ----------
  function onKey(e) {
    lastInput = Date.now();
    var wasDimmed = dimmed;
    wake();
    if (wasDimmed) { e.preventDefault(); return; }
    var k = e.keyCode;
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';

    if (k === KEY.BACK || k === KEY.ESC || (k === KEY.BACKSPACE && !typing)) {
      e.preventDefault();
      if (typing) { document.activeElement.blur(); return; }
      var f = SD.focused();
      if (f && f.isEditing && f.isEditing()) { f.stopEditing(); return; }
      if (SD.closeTopModal()) { return; }
      if (current !== 'overview') { show('overview'); return; }
      if (window.PalmSystem && window.PalmSystem.platformBack) { window.PalmSystem.platformBack(); }
      return;
    }
    if (!typing && !U.$('.modal-layer.open')) {
      var colour = {}; colour[KEY.RED] = 0; colour[KEY.GREEN] = 1; colour[KEY.YELLOW] = 2; colour[KEY.BLUE] = 3;
      if (colour.hasOwnProperty(k)) { show(TABS[colour[k]]); e.preventDefault(); return; }
      if (k >= 49 && k <= 53) { show(TABS[k - 49]); e.preventDefault(); return; }
    }
    SD.handleNavKey(e);
  }

  // ---------- scaling (desktop browsers; the TV is already 1920x1080) ----------
  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    var x = (window.innerWidth - 1920 * s) / 2, y = (window.innerHeight - 1080 * s) / 2;
    var t = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
    el.stage.style.webkitTransform = t;
    el.stage.style.transform = t;
  }

  // Pause polling while the app is in the background to save API calls
  function onVisibility() {
    if (isHidden()) { SD.data.stop(); stopScreensaverControl(); }
    else { SD.data.start(); wake(); lastInput = Date.now(); startScreensaverControl(); }
  }

  function init() {
    el.stage = U.$('#stage');
    el.shift = U.h('div', { 'class': 'shift' });
    el.main = U.h('main', { 'class': 'main' });
    el.spike = U.h('div', { 'class': 'spike-banner hidden' });
    el.shift.appendChild(buildHeader());
    el.shift.appendChild(el.spike);
    el.shift.appendChild(el.main);
    el.stage.appendChild(el.shift);
    el.stage.appendChild(U.h('div', { 'class': 'modal-layer' }));
    el.stage.appendChild(U.h('div', { 'class': 'toasts' }));

    fit();
    window.addEventListener('resize', fit);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousemove', function () { lastInput = Date.now(); if (dimmed) { wake(); } });
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('webkitvisibilitychange', onVisibility);
    document.addEventListener('webOSRelaunch', function () { show('overview'); wake(); });

    var start = 'overview';
    try { start = window.sessionStorage.getItem('solardash.tab') || start; } catch (e) { /* ignore */ }
    var tabParam = /[?&]tab=(\w+)/.exec(window.location.search);
    if (tabParam) { start = tabParam[1]; }
    if (!SD.isConfigured() && !SD.settings.demo) { start = 'overview'; }
    show(TABS.indexOf(start) >= 0 ? start : 'overview');
    renderHeader();
    setInterval(renderHeader, 15000);
    setInterval(pixelShift, 120000);
    wake();
    SD.data.start();
    startScreensaverControl();
    runRootStartup();
    SD.on('settings', function () { stopScreensaverControl(); startScreensaverControl(); });
    SD.daemon.pushConfig();
    SD.on('settings', function () { SD.daemon.pushConfig(); });

    if (!SD.isConfigured() && !SD.settings.demo) {
      setTimeout(function () {
        SD.modal({
          title: 'Welcome to Solar Dash',
          body: 'You are looking at demo data. To see your own system, add your FoxESS Cloud API key in Settings (and optionally your Amber API token).',
          buttons: [{ label: 'Keep exploring' }, { label: 'Open Settings', primary: true, autofocus: true, onClick: function () { setTimeout(function () { show('settings'); }, 0); } }]
        });
      }, 600);
    }
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
