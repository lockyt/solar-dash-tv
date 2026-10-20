/*
 * Overview: live energy flow, battery, price and today's totals.
 */
(function () {
  'use strict';
  var U = SD.util;
  var NS = 'http://www.w3.org/2000/svg';
  var S = SD.state;

  function s(tag, attrs, parent) {
    var el = document.createElementNS(NS, tag);
    for (var k in attrs) { if (attrs.hasOwnProperty(k)) { el.setAttribute(k, attrs[k]); } }
    if (parent) { parent.appendChild(el); }
    return el;
  }
  function stext(parent, x, y, cls, str) {
    var t = s('text', { x: x, y: y, 'class': cls, 'text-anchor': 'middle' }, parent);
    t.textContent = str || '';
    return t;
  }

  // ---------- energy flow diagram ----------
  var W = 1000, H = 740;
  var HUB = { x: 500, y: 370 };
  var NODES = {
    solar: { x: 500, y: 150, label: 'Solar', cls: 'c-solar' },
    grid: { x: 128, y: 370, label: 'Grid', cls: 'c-grid' },
    home: { x: 872, y: 370, label: 'Home', cls: 'c-home' },
    battery: { x: 500, y: 590, label: 'Battery', cls: 'c-battery' }
  };
  var R = 84;

  function icon(name, g, x, y) {
    if (name === 'solar') {
      s('circle', { cx: x, cy: y - 14, r: 20, 'class': 'ico-fill' }, g);
      for (var i = 0; i < 8; i++) {
        var a = i * Math.PI / 4;
        s('line', { x1: x + Math.cos(a) * 28, y1: y - 14 + Math.sin(a) * 28, x2: x + Math.cos(a) * 38, y2: y - 14 + Math.sin(a) * 38, 'class': 'ico-stroke' }, g);
      }
    } else if (name === 'home') {
      s('path', { d: 'M' + (x - 30) + ',' + (y - 10) + ' L' + x + ',' + (y - 40) + ' L' + (x + 30) + ',' + (y - 10) +
        ' L' + (x + 30) + ',' + (y + 14) + ' L' + (x - 30) + ',' + (y + 14) + ' Z', 'class': 'ico-fill' }, g);
    } else if (name === 'grid') {
      s('path', { d: 'M' + (x - 22) + ',' + (y + 16) + ' L' + x + ',' + (y - 42) + ' L' + (x + 22) + ',' + (y + 16) +
        ' M' + (x - 30) + ',' + (y - 22) + ' L' + (x + 30) + ',' + (y - 22) + ' M' + (x - 24) + ',' + (y - 6) + ' L' + (x + 24) + ',' + (y - 6),
        'class': 'ico-stroke', fill: 'none' }, g);
    }
  }

  function buildFlow() {
    var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'class': 'flow-svg' });
    var refs = { lines: {}, values: {}, nodes: {} };

    // links (drawn first so nodes sit on top)
    U.each(['solar', 'grid', 'home', 'battery'], function (k) {
      var n = NODES[k];
      var dx = HUB.x - n.x, dy = HUB.y - n.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      var x1 = n.x + dx / len * R, y1 = n.y + dy / len * R;
      var x2 = HUB.x - dx / len * 34, y2 = HUB.y - dy / len * 34;
      var d = 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2;
      s('path', { d: d, 'class': 'link-base' }, svg);
      refs.lines[k] = s('path', { d: d, 'class': 'link-flow ' + n.cls }, svg);
    });
    s('circle', { cx: HUB.x, cy: HUB.y, r: 34, 'class': 'hub' }, svg);
    s('rect', { x: HUB.x - 14, y: HUB.y - 18, width: 28, height: 36, rx: 4, 'class': 'hub-ico' }, svg);

    U.each(['solar', 'grid', 'home', 'battery'], function (k) {
      var n = NODES[k];
      var g = s('g', { 'class': 'node ' + n.cls }, svg);
      s('circle', { cx: n.x, cy: n.y, r: R, 'class': 'node-ring' }, g);
      if (k === 'battery') {
        s('rect', { x: n.x - 26, y: n.y - 50, width: 52, height: 72, rx: 6, 'class': 'bat-shell' }, g);
        s('rect', { x: n.x - 10, y: n.y - 58, width: 20, height: 8, rx: 2, 'class': 'bat-cap' }, g);
        refs.batFill = s('rect', { x: n.x - 20, y: n.y + 16, width: 40, height: 0, rx: 3, 'class': 'bat-fill' }, g);
        refs.soc = stext(g, n.x, n.y - 4, 'bat-soc', '--');
      } else {
        icon(k, g, n.x, n.y);
      }
      stext(g, n.x, n.y + 50, 'node-label', n.label);
      // value badge outside the circle
      var vy = k === 'solar' ? n.y - R - 24 : n.y + R + 46;
      refs.values[k] = stext(svg, n.x, vy, 'node-value ' + n.cls, '--');
      refs.nodes[k] = g;
    });
    refs.svg = svg;
    return refs;
  }

  // Direction: toward hub = 'in', away = 'out'. Speed scales with power.
  /*
   * Flow dots: a CSS stroke-dashoffset animation keeps the old webOS renderer
   * at ~90% CPU, which also delays the app's own timers. Instead we step the
   * offset ourselves at 4 fps, only while the overview is on screen.
   */
  var DASH = 27;       // matches stroke-dasharray 1 26
  var FPS = 4;
  var flows = [];      // { line, speed (px/s, signed), offset }
  var flowTimer = null;
  var flowVisible = false;

  function flowFor(line) {
    for (var i = 0; i < flows.length; i++) { if (flows[i].line === line) { return flows[i]; } }
    var f = { line: line, speed: 0, offset: 0 };
    flows.push(f);
    return f;
  }

  function stepFlows() {
    if (!flowVisible || document.hidden || document.webkitHidden || document.body.classList.contains('dimmed')) { return; }
    for (var i = 0; i < flows.length; i++) {
      var f = flows[i];
      if (!f.speed) { continue; }
      f.offset = (f.offset - f.speed / FPS) % DASH;
      if (f.offset < 0) { f.offset += DASH; }
      f.line.setAttribute('stroke-dashoffset', f.offset.toFixed(1));
    }
  }

  function setFlowRunning(on) {
    flowVisible = on;
    if (on && !flowTimer) { flowTimer = setInterval(stepFlows, 1000 / FPS); }
    if (!on && flowTimer) { clearInterval(flowTimer); flowTimer = null; }
  }

  function setFlow(line, kw, dirIn) {
    var a = U.isNum(kw) ? Math.abs(kw) : 0;
    var f = flowFor(line);
    var base = line.getAttribute('class').replace(/ ?active/g, '');
    if (a < 0.05) { line.setAttribute('class', base); f.speed = 0; return; }
    line.setAttribute('class', base + ' active');
    var secsPerDash = U.clamp(2.6 - Math.log(1 + a) * 0.9, 0.45, 2.6);
    f.speed = (DASH / secsPerDash) * (dirIn ? 1 : -1); // + moves dots along the path toward the hub
    line.style.strokeWidth = U.clamp(4 + a * 1.1, 4, 14) + 'px';
  }

  // ---------- price helpers (shared with prices view) ----------
  SD.priceClass = function (descriptor) {
    return 'p-' + (descriptor || 'neutral');
  };
  SD.priceLabel = function (descriptor) {
    return {
      negative: 'Negative', extremelyLow: 'Extremely low', veryLow: 'Very low', low: 'Low',
      neutral: 'Average', high: 'High', spike: 'SPIKE'
    }[descriptor] || '--';
  };

  // ---------- view ----------
  var refs, el = {};

  function card(title, body, extraCls) {
    return U.h('section', { 'class': 'card ' + (extraCls || '') }, [U.h('h3', { 'class': 'card-title', text: title }), body]);
  }

  function stat(label, key, cls) {
    el[key] = U.h('div', { 'class': 'stat-value ' + (cls || ''), text: '--' });
    return U.h('div', { 'class': 'stat' }, [el[key], U.h('div', { 'class': 'stat-label', text: label })]);
  }

  function build(root) {
    refs = buildFlow();
    el.override = U.h('div', { 'class': 'override-banner hidden' });

    var flowCard = U.h('section', { 'class': 'card flow-card' }, [refs.svg, el.override]);

    // Battery card
    el.socBig = U.h('div', { 'class': 'soc-big', text: '--' });
    el.socBar = U.h('div', { 'class': 'soc-bar-fill' });
    el.batLine1 = U.h('div', { 'class': 'bat-line', text: '' });
    el.batLine2 = U.h('div', { 'class': 'bat-line dim', text: '' });
    var batCard = card('Battery', U.h('div', {}, [
      U.h('div', { 'class': 'soc-row' }, [el.socBig, U.h('div', { 'class': 'soc-bar' }, [el.socBar])]),
      el.batLine1, el.batLine2
    ]), 'bat-card');

    // Price card
    el.buy = U.h('div', { 'class': 'price-big', text: '--' });
    el.sell = U.h('div', { 'class': 'price-big sell', text: '--' });
    el.priceTag = U.h('span', { 'class': 'pill', text: '--' });
    el.priceMeta = U.h('div', { 'class': 'price-meta dim', text: '' });
    el.priceBody = U.h('div', {}, [
      U.h('div', { 'class': 'price-row' }, [
        U.h('div', { 'class': 'price-col' }, [U.h('div', { 'class': 'stat-label', text: 'Buy' }), el.buy]),
        U.h('div', { 'class': 'price-col' }, [U.h('div', { 'class': 'stat-label', text: 'Sell' }), el.sell]),
        U.h('div', { 'class': 'price-col tag-col' }, [el.priceTag])
      ]),
      el.priceMeta
    ]);
    el.priceEmpty = U.h('div', { 'class': 'empty hidden', text: 'Add your Amber API token in Settings to see live prices.' });
    el.priceCard = card('Amber price now', U.h('div', {}, [el.priceBody, el.priceEmpty]), 'price-card');

    // Today card
    var todayCard = card('Today', U.h('div', { 'class': 'stats-grid' }, [
      stat('Solar', 'tSolar', 'c-solar'), stat('Home', 'tHome', 'c-home'), stat('Self-powered', 'tSelf', ''),
      stat('Imported', 'tImp', 'c-grid'), stat('Exported', 'tExp', 'c-export'), stat('Charged / used', 'tBat', 'c-battery')
    ]), 'today-card');

    // Forecast strip
    el.strip = U.h('div', { 'class': 'strip-chart' });
    var stripCard = U.h('section', { 'class': 'card strip-card' }, [
      U.h('h3', { 'class': 'card-title', text: 'Price forecast - next 12 hours (buy, c/kWh)' }), el.strip
    ]);

    root.appendChild(U.h('div', { 'class': 'overview' }, [
      U.h('div', { 'class': 'ov-left' }, [flowCard]),
      U.h('div', { 'class': 'ov-right' }, [batCard, el.priceCard, todayCard]),
      stripCard
    ]));
    render();
  }

  function renderLive() {
    var l = S.live;
    if (!l) { return; }
    refs.values.solar.textContent = U.fmtPower(l.pv);
    refs.values.home.textContent = U.fmtPower(l.load);
    var gridTxt = l.grid > 0.05 ? 'Importing ' + U.fmtPower(l.grid) : (l.grid < -0.05 ? 'Exporting ' + U.fmtPower(-l.grid) : 'Idle');
    refs.values.grid.textContent = gridTxt;
    refs.values.grid.setAttribute('class', 'node-value ' + (l.grid < -0.05 ? 'c-export' : 'c-grid'));
    var batTxt = l.batPower > 0.05 ? 'Charging ' + U.fmtPower(l.batPower) : (l.batPower < -0.05 ? 'Discharging ' + U.fmtPower(-l.batPower) : 'Idle');
    refs.values.battery.textContent = batTxt;

    setFlow(refs.lines.solar, l.pv, true);
    setFlow(refs.lines.home, l.load, false);
    setFlow(refs.lines.grid, l.grid, l.grid > 0);
    setFlow(refs.lines.battery, l.batPower, l.batPower < 0);
    refs.lines.grid.setAttribute('class', refs.lines.grid.getAttribute('class').replace(/c-(grid|export)/, l.grid < 0 ? 'c-export' : 'c-grid'));

    var soc = U.isNum(l.soc) ? l.soc : 0;
    refs.soc.textContent = U.isNum(l.soc) ? Math.round(l.soc) + '%' : '--';
    var fillH = 60 * soc / 100;
    refs.batFill.setAttribute('y', NODES.battery.y + 16 - fillH);
    refs.batFill.setAttribute('height', fillH);
    refs.batFill.setAttribute('class', 'bat-fill' + (soc < 20 ? ' low' : ''));

    el.socBig.textContent = U.isNum(l.soc) ? Math.round(l.soc) + '%' : '--';
    el.socBar.style.width = soc + '%';
    el.socBar.className = 'soc-bar-fill' + (soc < 20 ? ' low' : '');
    var cap = SD.batteryKwh();
    var stored = cap && U.isNum(l.soc) ? cap * l.soc / 100 : l.residualKwh;
    var parts = [];
    if (U.isNum(stored)) { parts.push(U.fmtEnergy(stored) + (cap ? ' of ' + Math.round(cap) + ' kWh' : '')); }
    parts.push(batTxt);
    el.batLine1.textContent = parts.join('  ·  ');
    var p2 = [];
    if (l.etaHours != null && l.etaHours < 48) { p2.push(U.fmtDuration(l.etaHours) + ' ' + l.etaLabel); }
    if (U.isNum(l.batTemp)) { p2.push(l.batTemp.toFixed(1) + '°C'); }
    if (U.isNum(l.soh)) { p2.push('Health ' + Math.round(l.soh) + '%'); }
    el.batLine2.textContent = p2.join('  ·  ');
  }

  function renderPrice() {
    var enabled = SD.amber.enabled();
    el.priceBody.classList.toggle('hidden', !enabled);
    el.priceEmpty.classList.toggle('hidden', enabled);
    var p = S.price;
    if (!p) { return; }
    el.buy.textContent = U.fmtCents(p.buy);
    el.sell.textContent = U.fmtCents(p.sell);
    var band = SD.buyBand(p);
    el.buy.className = 'price-big';
    el.buy.style.color = band ? band.color : '';
    el.priceTag.textContent = p.spikeStatus === 'potential' ? 'Possible spike' : (band ? band.label : '--');
    el.priceTag.className = 'pill';
    el.priceTag.style.color = p.spikeStatus === 'potential' ? SDBands.COLORS.pricey : (band ? band.color : '');
    var meta = [];
    if (band && SDBands.vsRefText(band)) { meta.push(SDBands.vsRefText(band)); }
    if (U.isNum(p.renewables)) { meta.push(Math.round(p.renewables) + '% renewables'); }
    if (p.end) { meta.push('until ' + U.fmtTime(p.end)); }
    if (p.estimate) { meta.push('estimate'); }
    el.priceMeta.textContent = meta.join('  ·  ');
    el.priceCard.classList.toggle('spiking', p.spikeStatus === 'spike' || p.descriptor === 'spike');
  }

  function renderToday() {
    var t = S.today;
    if (!t) { return; }
    el.tSolar.textContent = U.fmtEnergy(t.solar);
    el.tHome.textContent = U.fmtEnergy(t.home);
    el.tImp.textContent = U.fmtEnergy(t.imp);
    el.tExp.textContent = U.fmtEnergy(t.exp);
    el.tBat.textContent = t.charged.toFixed(1) + ' / ' + t.discharged.toFixed(1);
    el.tSelf.textContent = t.selfSufficiency != null ? Math.round(t.selfSufficiency * 100) + '%' : '--';
  }

  function renderStrip() {
    if (!SD.amber.enabled()) { el.strip.innerHTML = '<div class="empty">Price forecast needs Amber (Settings).</div>'; return; }
    var rows = S.forecast.slice(0, 24);
    if (!rows.length) { return; }
    var labels = U.map(rows, function (r) { return U.fmtTime(r.start); });
    el.strip.innerHTML = '';
    el.strip.appendChild(SD.chart.bars({
      width: 1776, height: 200, labels: labels, labelEvery: 2,
      series: [{ values: U.map(rows, function (r) { return r.buy; }), colorFn: function (v, i) { var b = SD.buyBand(rows[i]); return b ? b.color : '#f5b82e'; } }],
      yFmt: function (v) { return Math.round(v) + '¢'; }
    }));
  }

  function renderOverride() {
    var o = SD.control.override();
    if (!o) { el.override.classList.add('hidden'); return; }
    var names = { ForceCharge: 'Force charging', ForceDischarge: 'Force discharging', Feedin: 'Exporting first', Backup: 'Holding charge', SelfUse: 'Self use' };
    el.override.textContent = (names[o.mode] || o.mode) + ' until ' + U.fmtTime(o.until);
    el.override.classList.remove('hidden');
  }

  function render() {
    renderLive(); renderPrice(); renderToday(); renderStrip(); renderOverride();
  }

  SD.views = SD.views || {};
  SD.views.overview = {
    title: 'Overview',
    build: build,
    onShow: function () { render(); setFlowRunning(true); },
    onHide: function () { setFlowRunning(false); },
    onUpdate: function (key) {
      if (key === 'live' || key === 'device' || key === 'soc') { renderLive(); }
      if (key === 'price') { renderPrice(); }
      if (key === 'today') { renderToday(); }
      if (key === 'forecast') { renderStrip(); }
      if (key === 'priceStats') { renderPrice(); renderStrip(); }
      if (key === 'override') { renderOverride(); }
    }
  };
})();
