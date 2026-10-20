/*
 * Prices: Amber 24 h forecast with cheapest / priciest windows.
 */
(function () {
  'use strict';
  var U = SD.util;
  var S = SD.state;

  var PRICE_COLORS = {
    negative: '#2ec4b6', extremelyLow: '#3ddc97', veryLow: '#7bd88f', low: '#b8d86b',
    neutral: '#f5b82e', high: '#ff8c42', spike: '#ff3b5c'
  };
  SD.priceColor = function (d) { return PRICE_COLORS[d] || PRICE_COLORS.neutral; };

  var el = {};

  // Best/worst run of `len` consecutive intervals by average of field
  function bestWindow(rows, len, field, wantMax) {
    var best = null;
    for (var i = 0; i + len <= rows.length; i++) {
      var sum = 0, ok = true;
      for (var j = i; j < i + len; j++) { if (!U.isNum(rows[j][field])) { ok = false; break; } sum += rows[j][field]; }
      if (!ok) { continue; }
      var avg = sum / len;
      if (!best || (wantMax ? avg > best.avg : avg < best.avg)) { best = { avg: avg, start: rows[i].start, end: rows[i + len - 1].end }; }
    }
    return best;
  }

  function tile(label, value, sub, cls) {
    return U.h('div', { 'class': 'stat' }, [
      U.h('div', { 'class': 'stat-value ' + (cls || ''), text: value }),
      U.h('div', { 'class': 'stat-label', text: label }),
      sub ? U.h('div', { 'class': 'stat-sub dim', text: sub }) : null
    ]);
  }

  function build(root) {
    el.chart = U.h('div', { 'class': 'chart-host' });
    el.tiles = U.h('div', { 'class': 'stats-row' });
    el.empty = U.h('div', { 'class': 'empty hidden', text: 'Add your Amber API token in Settings to see prices and spike alerts.' });
    root.appendChild(U.h('div', { 'class': 'prices' }, [
      el.empty,
      U.h('section', { 'class': 'card' }, [el.tiles]),
      U.h('section', { 'class': 'card chart-card' }, [
        U.h('div', { 'class': 'legend' }, [
          U.h('span', { 'class': 'legend-item' }, [U.h('i', { style: 'background:linear-gradient(90deg,#3ddc97,#f5b82e,#ff3b5c)' }), 'Buy price (coloured by price band)']),
          U.h('span', { 'class': 'legend-item' }, [U.h('i', { style: 'background:#b48cff' }), 'Sell (feed-in) price'])
        ]),
        el.chart
      ])
    ]));
  }

  function render() {
    var enabled = SD.amber.enabled();
    el.empty.classList.toggle('hidden', enabled);
    var rows = S.forecast || [];
    el.chart.innerHTML = '';
    el.tiles.innerHTML = '';
    if (!enabled || !rows.length) { return; }

    var p = S.price || rows[0];
    var buys = U.map(rows, function (r) { return r.buy; });
    var cheap = bestWindow(rows, 4, 'buy', false);
    var dear = bestWindow(rows, 4, 'buy', true);
    var sellBest = bestWindow(rows, 4, 'sell', true);
    function span(w) { return w ? U.fmtTime(w.start) + ' - ' + U.fmtTime(w.end) : ''; }

    U.each([
      tile('Buy now', U.fmtCents(p.buy), (SD.buyBand(p) || {}).label + ' \u00b7 ' + SDBands.vsRefText(SD.buyBand(p))),
      tile('Sell now', U.fmtCents(p.sell), (SD.sellBand(p) || {}).label || ''),
      tile('Cheapest 2 h', cheap ? U.fmtCents(cheap.avg) : '--', span(cheap), 'p-veryLow'),
      tile('Priciest 2 h', dear ? U.fmtCents(dear.avg) : '--', span(dear), 'p-high'),
      tile('Best 2 h to export', sellBest ? U.fmtCents(sellBest.avg) : '--', span(sellBest), 'c-export'),
      tile('24 h range', U.fmtCents(U.min(buys)) + ' - ' + U.fmtCents(U.max(buys)), 'average ' + U.fmtCents(U.sum(buys) / buys.length))
    ], function (t) { el.tiles.appendChild(t); });

    el.chart.appendChild(SD.chart.bars({
      width: 1776, height: 600, labelEvery: 4,
      labels: U.map(rows, function (r) { return U.fmtTime(r.start); }),
      yFmt: function (v) { return Math.round(v) + '¢'; },
      series: [
        { values: buys, colorFn: function (v, i) { var b = SD.buyBand(rows[i]); return b ? b.color : '#f5b82e'; } },
        { values: U.map(rows, function (r) { return r.sell; }), color: '#b48cff' }
      ]
    }));
  }

  SD.views.prices = {
    title: 'Prices',
    build: build,
    onShow: render,
    onUpdate: function (key) { if (key === 'forecast' || key === 'price' || key === 'priceStats') { render(); } }
  };
})();
