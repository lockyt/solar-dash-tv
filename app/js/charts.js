/*
 * Minimal SVG charts (no libraries; must run on Chromium 38).
 */
(function () {
  'use strict';
  var U = SD.util;
  var NS = 'http://www.w3.org/2000/svg';

  function s(tag, attrs, parent) {
    var el = document.createElementNS(NS, tag);
    for (var k in attrs) { if (attrs.hasOwnProperty(k) && attrs[k] != null) { el.setAttribute(k, attrs[k]); } }
    if (parent) { parent.appendChild(el); }
    return el;
  }
  function text(parent, x, y, str, cls, anchor) {
    var t = s('text', { x: x, y: y, 'class': cls || 'ch-label', 'text-anchor': anchor || 'middle' }, parent);
    t.textContent = str;
    return t;
  }

  // Round an axis max up to a tidy value
  function niceMax(v) {
    if (!(v > 0)) { return 1; }
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var n = v / p;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * p;
  }

  /*
   * Line/area chart over time.
   * opts: { width, height, xMin, xMax, yMin, yMax, y2Max, series: [{ data:[{t,v}], color, area, axis2, width }],
   *         xTicks: [{t, label}], yFmt, y2Fmt, now }
   */
  function line(opts) {
    var W = opts.width, H = opts.height;
    var padL = 84, padR = opts.y2Max ? 84 : 24, padT = 16, padB = 44;
    var iw = W - padL - padR, ih = H - padT - padB;
    var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'class': 'chart' });

    var yMin = opts.yMin != null ? opts.yMin : 0;
    var yMax = opts.yMax;
    if (yMax == null) {
      var m = 0;
      U.each(opts.series, function (se) { if (!se.axis2) { m = Math.max(m, U.max(U.map(se.data, function (p) { return p.v; }))); } });
      yMax = niceMax(m);
    }
    var y2Max = opts.y2Max || 100;
    function x(t) { return padL + (t - opts.xMin) / (opts.xMax - opts.xMin) * iw; }
    function y(v) { return padT + ih - (v - yMin) / (yMax - yMin) * ih; }
    function y2(v) { return padT + ih - v / y2Max * ih; }

    // grid + y labels
    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var val = yMin + (yMax - yMin) * i / steps;
      var yy = y(val);
      s('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, 'class': val === 0 ? 'ch-zero' : 'ch-grid' }, svg);
      text(svg, padL - 12, yy + 8, opts.yFmt ? opts.yFmt(val) : String(val), 'ch-label', 'end');
      if (opts.y2Max) { text(svg, W - padR + 12, yy + 8, (opts.y2Fmt || String)(y2Max * i / steps), 'ch-label', 'start'); }
    }
    U.each(opts.xTicks || [], function (tk) {
      text(svg, x(tk.t), H - 10, tk.label, 'ch-label', 'middle');
    });

    U.each(opts.series, function (se) {
      if (!se.data || se.data.length < 2) { return; }
      var fy = se.axis2 ? y2 : y;
      var d = '';
      U.each(se.data, function (p, idx) {
        if (!U.isNum(p.v) || !U.isNum(p.t)) { return; }
        d += (d ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + fy(p.v).toFixed(1);
      });
      if (se.area) {
        var first = se.data[0], last = se.data[se.data.length - 1];
        var base = fy(Math.max(yMin, 0));
        s('path', { d: d + 'L' + x(last.t).toFixed(1) + ',' + base + 'L' + x(first.t).toFixed(1) + ',' + base + 'Z',
          fill: se.color, 'fill-opacity': 0.18, stroke: 'none' }, svg);
      }
      s('path', { d: d, fill: 'none', stroke: se.color, 'stroke-width': se.width || 3, 'stroke-linejoin': 'round',
        'stroke-dasharray': se.dash || null }, svg);
    });

    if (opts.now && opts.now > opts.xMin && opts.now < opts.xMax) {
      s('line', { x1: x(opts.now), x2: x(opts.now), y1: padT, y2: padT + ih, 'class': 'ch-now' }, svg);
    }
    return svg;
  }

  /*
   * Bar chart. opts: { width, height, labels: [], series: [{ values: [], color, colorFn(v,i) }],
   *   yFmt, yMin, labelEvery, highlight (index) }
   * Multiple series are drawn side by side.
   */
  function bars(opts) {
    var W = opts.width, H = opts.height;
    var padL = 84, padR = 20, padT = 16, padB = 44;
    var iw = W - padL - padR, ih = H - padT - padB;
    var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'class': 'chart' });
    var n = opts.labels.length;
    var all = [];
    U.each(opts.series, function (se) { all = all.concat(se.values); });
    var yMax = opts.yMax || niceMax(U.max(all));
    var yMin = opts.yMin != null ? opts.yMin : Math.min(0, -niceMax(-U.min(all)));
    if (!(yMin < 0)) { yMin = 0; }
    function y(v) { return padT + ih - (v - yMin) / (yMax - yMin) * ih; }

    for (var i = 0; i <= 4; i++) {
      var val = yMin + (yMax - yMin) * i / 4;
      s('line', { x1: padL, x2: W - padR, y1: y(val), y2: y(val), 'class': Math.abs(val) < 1e-9 ? 'ch-zero' : 'ch-grid' }, svg);
      text(svg, padL - 12, y(val) + 8, opts.yFmt ? opts.yFmt(val) : String(val), 'ch-label', 'end');
    }
    if (yMin < 0) { s('line', { x1: padL, x2: W - padR, y1: y(0), y2: y(0), 'class': 'ch-zero' }, svg); }

    var slot = iw / n;
    var gap = Math.max(2, slot * 0.18);
    var bw = (slot - gap) / opts.series.length;
    var every = opts.labelEvery || 1;
    for (var j = 0; j < n; j++) {
      var x0 = padL + j * slot + gap / 2;
      if (opts.highlight === j) {
        s('rect', { x: padL + j * slot, y: padT, width: slot, height: ih, 'class': 'ch-hl' }, svg);
      }
      for (var k = 0; k < opts.series.length; k++) {
        var se = opts.series[k];
        var v = se.values[j];
        if (!U.isNum(v)) { continue; }
        var top = y(Math.max(v, 0)), bot = y(Math.min(v, 0));
        s('rect', { x: x0 + k * bw, y: top, width: Math.max(1, bw - 1), height: Math.max(1, bot - top), rx: 2,
          fill: se.colorFn ? se.colorFn(v, j) : se.color }, svg);
      }
      if (j % every === 0) { text(svg, padL + j * slot + slot / 2, H - 10, opts.labels[j], 'ch-label', 'middle'); }
    }
    return svg;
  }

  SD.chart = { line: line, bars: bars, niceMax: niceMax };
})();
