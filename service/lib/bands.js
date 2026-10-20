/*
 * Solar Dash price bands.
 *
 * Amber's own "descriptor" rates prices against the wholesale market, so a 26c
 * retail price can show as "very low". Instead we rank each price against the
 * household's own last 4 weeks of Amber prices, and sanity-check buy prices
 * against a typical retail price (default 32c/kWh, roughly the 2025-26 national
 * average).
 *
 * Shared by the app (window.SDBands) and the TV daemon (require('./bands')).
 * `npm run package` copies this file to service/lib/bands.js. ES5 only.
 */
(function (root) {
  'use strict';

  var B = {};
  B.DEFAULT_REFERENCE = 32;
  B.HISTORY_DAYS = 28;

  B.COLORS = {
    negative: '#2ec4b6', veryCheap: '#3ddc97', cheap: '#7bd88f', typical: '#f5b82e',
    pricey: '#ff8c42', veryPricey: '#ff5a4f', spike: '#ff3b5c',
    great: '#3ddc97', good: '#7bd88f', poor: '#8592a3', costly: '#ff8c42'
  };
  var BUY_LABELS = {
    negative: 'Negative', veryCheap: 'Very cheap', cheap: 'Cheap', typical: 'Typical',
    pricey: 'Pricey', veryPricey: 'Very pricey', spike: 'Spike'
  };
  var SELL_LABELS = { great: 'Great to export', good: 'Good to export', typical: 'Typical export', poor: 'Poor export', costly: 'Costs to export' };
  var ORDER = ['negative', 'veryCheap', 'cheap', 'typical', 'pricey', 'veryPricey', 'spike'];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // Percentage of history at or below v (0-100)
  function percentile(sorted, v) {
    if (!sorted || !sorted.length) { return null; }
    var lo = 0, hi = sorted.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (sorted[mid] <= v) { lo = mid + 1; } else { hi = mid; } }
    return lo / sorted.length * 100;
  }
  B.percentile = percentile;

  /*
   * Build stats from Amber interval lists (any resolution). Only past intervals count.
   * Returns { buy: [sorted c/kWh], sell: [sorted c/kWh], n, avgBuy, from, to }
   */
  B.buildStats = function (intervals, now) {
    now = now || Date.now();
    var buy = [], sell = [], from = Infinity, to = 0;
    for (var i = 0; i < (intervals || []).length; i++) {
      var it = intervals[i];
      var t = Date.parse(it.startTime);
      if (!(t < now) || !isNum(it.perKwh)) { continue; }
      if (it.channelType === 'general') { buy.push(it.perKwh); }
      else if (it.channelType === 'feedIn') { sell.push(-it.perKwh); }
      if (t < from) { from = t; }
      if (t > to) { to = t; }
    }
    buy.sort(function (a, b) { return a - b; });
    sell.sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var j = 0; j < buy.length; j++) { sum += buy[j]; }
    return { buy: buy, sell: sell, n: buy.length, avgBuy: buy.length ? sum / buy.length : null, from: from, to: to, builtAt: now };
  };

  function worse(a, b) { return ORDER.indexOf(a) > ORDER.indexOf(b) ? a : b; }
  function better(a, b) { return ORDER.indexOf(a) < ORDER.indexOf(b) ? a : b; }

  /*
   * Buy price band. stats may be null (no history yet): then only the reference is used.
   * -> { key, label, color, pct (percentile in own history), vsRef (fraction vs reference) }
   */
  B.buyBand = function (buy, stats, reference, spikeStatus) {
    if (!isNum(buy)) { return null; }
    var ref = reference > 0 ? reference : B.DEFAULT_REFERENCE;
    var vsRef = buy / ref - 1;
    var pct = stats && stats.n >= 48 ? percentile(stats.buy, buy) : null;
    var key;
    if (spikeStatus === 'spike') { key = 'spike'; }
    else if (buy < 0) { key = 'negative'; }
    else {
      if (pct == null) {
        key = vsRef <= -0.5 ? 'veryCheap' : vsRef <= -0.2 ? 'cheap' : vsRef < 0.2 ? 'typical' : vsRef < 0.6 ? 'pricey' : 'veryPricey';
      } else {
        key = pct <= 10 ? 'veryCheap' : pct <= 30 ? 'cheap' : pct <= 70 ? 'typical' : pct <= 90 ? 'pricey' : 'veryPricey';
        // Keep it honest against normal retail prices
        if (vsRef >= 0) { key = worse(key, 'typical'); }
        if (vsRef >= 0.5) { key = worse(key, 'pricey'); }
        if (vsRef <= -0.5) { key = better(key, 'cheap'); }
      }
    }
    return { key: key, label: BUY_LABELS[key], color: B.COLORS[key], pct: pct, vsRef: vsRef };
  };

  // Sell (feed-in) band: higher is better, ranked against own export prices.
  B.sellBand = function (sell, stats) {
    if (!isNum(sell)) { return null; }
    var key;
    if (sell < 0) { key = 'costly'; }
    else {
      var pct = stats && stats.sell && stats.sell.length >= 48 ? percentile(stats.sell, sell) : null;
      if (pct == null) { key = sell >= 15 ? 'good' : sell >= 5 ? 'typical' : 'poor'; }
      else { key = pct >= 90 ? 'great' : pct >= 70 ? 'good' : pct >= 30 ? 'typical' : 'poor'; }
    }
    return { key: key, label: SELL_LABELS[key], color: B.COLORS[key] };
  };

  // "20% below typical" / "35% above typical"
  B.vsRefText = function (band) {
    if (!band || !isNum(band.vsRef)) { return ''; }
    var p = Math.round(Math.abs(band.vsRef) * 100);
    if (p < 3) { return 'about typical retail'; }
    return p + '% ' + (band.vsRef < 0 ? 'below' : 'above') + ' typical retail';
  };

  // Date ranges (YYYY-MM-DD, local) for fetching HISTORY_DAYS in 7-day chunks (Amber's limit)
  B.historyRanges = function (now) {
    function d(x) { return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
    var out = [];
    var end = new Date(now || Date.now());
    for (var k = 0; k < B.HISTORY_DAYS / 7; k++) {
      var e = new Date(end.getTime() - k * 7 * 864e5);
      var s = new Date(e.getTime() - 6 * 864e5);
      out.push({ startDate: d(s), endDate: d(e) });
    }
    return out;
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = B; } else { root.SDBands = B; }
})(this);
