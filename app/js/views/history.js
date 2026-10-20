/*
 * History: today's power curves, this month's daily energy, this year's monthly energy.
 */
(function () {
  'use strict';
  var U = SD.util;
  var S = SD.state;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var COLORS = { solar: '#f5b82e', home: '#4fa3ff', imp: '#ff6b6b', exp: '#b48cff', soc: '#3ddc97', charge: '#3ddc97', discharge: '#1f9e6b' };

  var mode = 'today';
  var el = {};

  function tab(id, label) {
    return U.h('button', {
      'class': 'seg focusable', 'data-mode': id, text: label,
      onclick: function () { setMode(id); }
    });
  }
  function legend(items) {
    return U.h('div', { 'class': 'legend' }, U.map(items, function (it) {
      return U.h('span', { 'class': 'legend-item' }, [U.h('i', { style: 'background:' + it[1] + (it[2] ? ';opacity:.6' : '') }), it[0]]);
    }));
  }
  function tile(label, value, cls) {
    return U.h('div', { 'class': 'stat' }, [U.h('div', { 'class': 'stat-value ' + (cls || ''), text: value }), U.h('div', { 'class': 'stat-label', text: label })]);
  }

  function build(root) {
    el.segs = U.h('div', { 'class': 'segs' }, [tab('today', 'Today'), tab('month', 'This month'), tab('year', 'This year')]);
    el.status = U.h('span', { 'class': 'dim history-status' });
    el.chart = U.h('div', { 'class': 'chart-host' });
    el.legend = U.h('div', {});
    el.tiles = U.h('div', { 'class': 'stats-row' });
    root.appendChild(U.h('div', { 'class': 'history' }, [
      U.h('div', { 'class': 'toolbar' }, [el.segs, el.status]),
      U.h('section', { 'class': 'card chart-card' }, [el.legend, el.chart]),
      U.h('section', { 'class': 'card' }, [el.tiles])
    ]));
  }

  function setMode(m) {
    mode = m;
    U.each(U.$$('.seg', el.segs), function (b) { b.classList.toggle('active', b.getAttribute('data-mode') === m); });
    load(false);
    render();
  }

  function load(force) {
    if (!SD.isDemo() && !SD.isConfigured()) { el.status.textContent = 'Connect FoxESS in Settings'; return; }
    el.status.textContent = 'Loading…';
    var done = function (err) { el.status.textContent = err ? err.message : ''; };
    if (mode === 'today') { SD.data.history(force, done); }
    else { SD.data.period(mode, force, done); }
  }

  function series(name) {
    return (S.history && S.history[name]) || [];
  }

  function renderToday() {
    var start = U.startOfDay().getTime();
    var end = start + 24 * 3600000;
    var ticks = [];
    for (var h = 0; h <= 24; h += 3) { ticks.push({ t: start + h * 3600000, label: U.pad2(h % 24) + ':00' }); }
    var negDischarge = U.map(series('batDischargePower'), function (p) { return { t: p.t, v: p.v }; });
    el.legend.innerHTML = '';
    el.legend.appendChild(legend([['Solar', COLORS.solar], ['Home', COLORS.home], ['Import', COLORS.imp], ['Export', COLORS.exp],
      ['Battery charge', COLORS.charge], ['Battery discharge', COLORS.discharge], ['Battery %', COLORS.soc, true]]));
    el.chart.innerHTML = '';
    el.chart.appendChild(SD.chart.line({
      width: 1776, height: 560, xMin: start, xMax: end, xTicks: ticks, now: Date.now(),
      yFmt: function (v) { return v.toFixed(v < 10 ? 1 : 0) + ' kW'; },
      y2Max: 100, y2Fmt: function (v) { return Math.round(v) + '%'; },
      series: [
        { data: series('pvPower'), color: COLORS.solar, area: true },
        { data: series('loadsPower'), color: COLORS.home },
        { data: series('gridConsumptionPower'), color: COLORS.imp, width: 2 },
        { data: series('feedinPower'), color: COLORS.exp, width: 2 },
        { data: series('batChargePower'), color: COLORS.charge, width: 2 },
        { data: negDischarge, color: COLORS.discharge, width: 2, dash: '8,6' },
        { data: series('SoC'), color: COLORS.soc, axis2: true, width: 2, dash: '2,6' }
      ]
    }));
    var t = S.today;
    el.tiles.innerHTML = '';
    if (t) {
      U.each([
        ['Solar', U.fmtEnergy(t.solar), 'c-solar'], ['Home', U.fmtEnergy(t.home), 'c-home'],
        ['Imported', U.fmtEnergy(t.imp), 'c-grid'], ['Exported', U.fmtEnergy(t.exp), 'c-export'],
        ['Charged', U.fmtEnergy(t.charged), 'c-battery'], ['Discharged', U.fmtEnergy(t.discharged), 'c-battery'],
        ['Peak solar', U.fmtPower(U.max(U.map(series('pvPower'), function (p) { return p.v; }))), 'c-solar']
      ], function (x) { el.tiles.appendChild(tile(x[0], x[1], x[2])); });
    }
  }

  function renderPeriod() {
    var rep = S[mode];
    el.legend.innerHTML = '';
    el.legend.appendChild(legend([['Solar', COLORS.solar], ['Home (calc.)', COLORS.home], ['Import', COLORS.imp], ['Export', COLORS.exp]]));
    el.chart.innerHTML = '';
    el.tiles.innerHTML = '';
    if (!rep) { return; }
    var solar = rep.PVEnergyTotal && U.sum(rep.PVEnergyTotal) > 0 ? rep.PVEnergyTotal : (rep.generation || []);
    var imp = rep.gridConsumption || [], exp = rep.feedin || [];
    var ch = rep.chargeEnergyToTal || [], dis = rep.dischargeEnergyToTal || [];
    var n = solar.length;
    var home = [];
    for (var i = 0; i < n; i++) { home.push(Math.max(0, (solar[i] || 0) + (imp[i] || 0) + (dis[i] || 0) - (exp[i] || 0) - (ch[i] || 0))); }
    var labels = [];
    for (var j = 0; j < n; j++) { labels.push(mode === 'year' ? MONTHS[j] : String(j + 1)); }
    var now = new Date();
    el.chart.appendChild(SD.chart.bars({
      width: 1776, height: 560, labels: labels, labelEvery: mode === 'month' ? 2 : 1,
      highlight: mode === 'month' ? now.getDate() - 1 : now.getMonth(),
      yFmt: function (v) { return Math.round(v) + ' kWh'; },
      series: [
        { values: solar, color: COLORS.solar }, { values: home, color: COLORS.home },
        { values: imp, color: COLORS.imp }, { values: exp, color: COLORS.exp }
      ]
    }));
    U.each([
      ['Solar', U.fmtEnergy(U.sum(solar)), 'c-solar'], ['Home', U.fmtEnergy(U.sum(home)), 'c-home'],
      ['Imported', U.fmtEnergy(U.sum(imp)), 'c-grid'], ['Exported', U.fmtEnergy(U.sum(exp)), 'c-export'],
      ['Charged', U.fmtEnergy(U.sum(ch)), 'c-battery'], ['Discharged', U.fmtEnergy(U.sum(dis)), 'c-battery'],
      ['Self-powered', U.sum(home) > 0 ? Math.round(U.clamp(1 - U.sum(imp) / U.sum(home), 0, 1) * 100) + '%' : '--', '']
    ], function (x) { el.tiles.appendChild(tile(x[0], x[1], x[2])); });
  }

  function render() {
    if (mode === 'today') { renderToday(); } else { renderPeriod(); }
  }

  SD.views.history = {
    title: 'History',
    build: build,
    onShow: function () { setMode(mode); },
    onUpdate: function (key) {
      if (key === 'history' || key === 'today') { if (mode === 'today') { renderToday(); } }
      if (mode !== 'today' && key === mode) { renderPeriod(); }
    }
  };
})();
