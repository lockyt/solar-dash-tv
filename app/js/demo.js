/*
 * Demo mode: answers FoxESS and Amber calls with simulated raw API responses,
 * so the app can be tried without an inverter and the parsing code is exercised.
 * Models a 10 kW H3 with a 42 kWh battery on an Amber tariff.
 */
(function () {
  'use strict';
  var U = SD.util;

  var SN = 'DEMO-H3-SMART-01';
  var CAP_KWH = 42;
  var PV_PEAK = 9.6;
  var MAX_BAT_KW = 10.5;
  var STEP_MIN = 5;

  var state = {
    minSoc: 10,
    minSocOnGrid: 10,
    schedEnable: false,
    groups: []
  };

  function gauss(x, mu, sigma) { return Math.exp(-0.5 * Math.pow((x - mu) / sigma, 2)); }
  // deterministic pseudo-random in [0,1) from a number
  function rnd(seed) { var x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

  function pvAt(h, daySeed) {
    if (h < 6 || h > 19.3) { return 0; }
    var base = Math.pow(Math.max(0, Math.sin(Math.PI * (h - 6) / 13.3)), 1.4) * PV_PEAK;
    var cloud = 1 - 0.35 * rnd(daySeed + Math.floor(h * 4)) * (rnd(daySeed) > 0.5 ? 1 : 0.3);
    return base * cloud;
  }
  function loadAt(h, daySeed) {
    return 0.45 + 1.4 * gauss(h, 7.5, 0.9) + 2.6 * gauss(h, 18.6, 1.5) + 0.6 * gauss(h, 13, 2) +
      0.35 * rnd(daySeed * 3 + Math.floor(h * 12));
  }

  function activeGroup(date) {
    if (!state.schedEnable) { return null; }
    var m = date.getHours() * 60 + date.getMinutes();
    for (var i = 0; i < state.groups.length; i++) {
      var g = state.groups[i];
      if (!g.enable) { continue; }
      var s = g.startHour * 60 + g.startMinute;
      var e = g.endHour * 60 + g.endMinute;
      if (m >= s && m <= e) { return g; }
    }
    return null;
  }

  // Simulate one 5-minute step. Returns the power flows and updated SoC.
  function step(date, soc, daySeed, noise) {
    var h = date.getHours() + date.getMinutes() / 60;
    var pv = pvAt(h, daySeed);
    var load = loadAt(h, daySeed) + (noise || 0);
    var g = activeGroup(date);
    var mode = g ? g.workMode : 'SelfUse';
    var floor = g ? Math.max(g.minSocOnGrid || 10, 10) : state.minSocOnGrid;
    var charge = 0, discharge = 0;
    var room = (100 - soc) / 100 * CAP_KWH;
    var avail = (soc - floor) / 100 * CAP_KWH;
    var stepH = STEP_MIN / 60;

    if (mode === 'ForceCharge' && soc < (g.fdSoc || 100)) {
      charge = Math.min((g.fdPwr || 10000) / 1000, MAX_BAT_KW, room / stepH);
    } else if (mode === 'ForceDischarge' && soc > (g.fdSoc || floor)) {
      discharge = Math.min((g.fdPwr || 10000) / 1000, MAX_BAT_KW, avail / stepH);
    } else if (mode === 'Feedin') {
      charge = 0;
    } else {
      var surplus = pv - load;
      if (surplus > 0) { charge = Math.min(surplus, MAX_BAT_KW, room / stepH); }
      else { discharge = Math.min(-surplus, MAX_BAT_KW, Math.max(0, avail) / stepH); }
    }
    var grid = load - pv + charge - discharge; // + import, - export
    var newSoc = U.clamp(soc + (charge - discharge) * stepH / CAP_KWH * 100, 0, 100);
    return { t: date.getTime(), pv: pv, load: load, charge: charge, discharge: discharge,
      imp: Math.max(0, grid), exp: Math.max(0, -grid), soc: newSoc, mode: mode };
  }

  // Simulate today from midnight to now in 5-minute steps (cached per step).
  var simCache = { key: '', rows: [] };
  function simulateToday() {
    var now = new Date();
    var mid = U.startOfDay(now);
    var daySeed = mid.getDate() + mid.getMonth() * 31;
    var stepsNow = Math.floor((now - mid) / (STEP_MIN * 60000));
    var key = mid.getTime() + ':' + stepsNow + ':' + JSON.stringify(state);
    if (simCache.key === key) { return simCache.rows; }
    var rows = [];
    var soc = 48;
    for (var i = 0; i <= stepsNow; i++) {
      var r = step(new Date(mid.getTime() + i * STEP_MIN * 60000), soc, daySeed);
      soc = r.soc;
      rows.push(r);
    }
    simCache = { key: key, rows: rows };
    return rows;
  }

  function fmtFoxTime(ms) {
    var d = new Date(ms);
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    off = Math.abs(off);
    return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()) + ' ' +
      U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes()) + ':' + U.pad2(d.getSeconds()) +
      ' LOC' + sign + U.pad2(Math.floor(off / 60)) + U.pad2(off % 60);
  }

  function realNow() {
    var rows = simulateToday();
    var last = rows[rows.length - 1];
    var jitter = (Math.random() - 0.5) * 0.25;
    var r = step(new Date(), last.soc, U.startOfDay().getDate() + U.startOfDay().getMonth() * 31, jitter);
    var t = fmtFoxTime(Date.now());
    function v(name, value, unit) { return { variable: name, value: Math.round(value * 1000) / 1000, unit: unit, name: name, time: t }; }
    var batPower = r.discharge - r.charge;
    return [{
      deviceSN: SN,
      datas: [
        v('pvPower', r.pv, 'kW'), v('pv1Power', r.pv * 0.52, 'kW'), v('pv2Power', r.pv * 0.48, 'kW'),
        v('loadsPower', r.load, 'kW'), v('gridConsumptionPower', r.imp, 'kW'), v('feedinPower', r.exp, 'kW'),
        v('meterPower', r.imp - r.exp, 'kW'),
        v('batChargePower', r.charge, 'kW'), v('batDischargePower', r.discharge, 'kW'), v('invBatPower', batPower, 'kW'),
        v('SoC', Math.round(last.soc), '%'), v('SOH', 99, '%'), v('batTemperature', 24.5 + Math.random(), '℃'),
        v('ResidualEnergy', last.soc / 100 * CAP_KWH, 'kWh'), v('generationPower', r.pv - r.charge + r.discharge, 'kW'),
        v('runningState', 163, ''), v('currentFault', 0, ''), v('ambientTemperation', 31, '℃')
      ]
    }];
  }

  function history(body) {
    var rows = simulateToday();
    var map = {
      pvPower: 'pv', loadsPower: 'load', SoC: 'soc', gridConsumptionPower: 'imp',
      feedinPower: 'exp', batChargePower: 'charge', batDischargePower: 'discharge'
    };
    var datas = [];
    U.each(body.variables || [], function (name) {
      var key = map[name];
      if (!key) { return; }
      datas.push({
        variable: name, unit: name === 'SoC' ? '%' : 'kW', name: name,
        data: U.map(rows, function (r) { return { time: fmtFoxTime(r.t), value: Math.round(r[key] * 1000) / 1000 }; })
      });
    });
    return [{ deviceSN: SN, datas: datas }];
  }

  function report(body) {
    var vars = body.variables || [];
    var series = {};
    U.each(vars, function (v) { series[v] = []; });
    function push(gen, fin, imp, ch, dis) {
      var vals = { generation: gen, PVEnergyTotal: gen * 1.02, feedin: fin, gridConsumption: imp, chargeEnergyToTal: ch, dischargeEnergyToTal: dis };
      U.each(vars, function (v) { series[v].push(Math.round((vals[v] || 0) * 100) / 100); });
    }
    if (body.dimension === 'day') {
      var rows = simulateToday();
      for (var hr = 0; hr < 24; hr++) {
        var acc = { pv: 0, exp: 0, imp: 0, charge: 0, discharge: 0 };
        U.each(rows, function (r) {
          if (new Date(r.t).getHours() !== hr) { return; }
          for (var k in acc) { if (acc.hasOwnProperty(k)) { acc[k] += r[k] * STEP_MIN / 60; } }
        });
        push(acc.pv, acc.exp, acc.imp, acc.charge, acc.discharge);
      }
    } else if (body.dimension === 'month') {
      var days = new Date(body.year, body.month, 0).getDate();
      var today = new Date();
      for (var d = 1; d <= days; d++) {
        var future = body.year === today.getFullYear() && body.month === today.getMonth() + 1 && d > today.getDate();
        if (future) { push(0, 0, 0, 0, 0); continue; }
        var s = rnd(d + body.month * 31);
        var gen = 28 + 26 * s;
        push(gen, gen * 0.32, 6 + 10 * (1 - s), 14 + 8 * s, 13 + 8 * s);
      }
    } else {
      for (var m = 1; m <= 12; m++) {
        var season = 0.65 + 0.35 * Math.cos((m - 1) / 12 * 2 * Math.PI); // southern hemisphere
        var future2 = body.year === new Date().getFullYear() && m > new Date().getMonth() + 1;
        if (future2) { push(0, 0, 0, 0, 0); continue; }
        push(1300 * season, 420 * season, 380 / season, 520, 500);
      }
    }
    var out = [];
    U.each(vars, function (v) { out.push({ variable: v, unit: 'kWh', values: series[v] }); });
    return out;
  }

  // ---------- Amber ----------
  function buyAt(ms) {
    var d = new Date(ms);
    var h = d.getHours() + d.getMinutes() / 60;
    var seed = rnd(Math.floor(ms / 1800000));
    var price = 24 + 14 * gauss(h, 7.5, 1.2) + 34 * gauss(h, 18.5, 1.6) - 26 * gauss(h, 12.5, 2.3) + 4 * seed;
    // A demo price spike in the early evening
    var spike = gauss(h, 18.25, 0.35) * 160;
    return price + spike;
  }
  function descriptor(c) {
    if (c < 0) { return 'negative'; }
    if (c < 5) { return 'extremelyLow'; }
    if (c < 12) { return 'veryLow'; }
    if (c < 22) { return 'low'; }
    if (c < 40) { return 'neutral'; }
    if (c < 100) { return 'high'; }
    return 'spike';
  }
  function interval(type, start, dur, channel) {
    var buy = buyAt(start + dur * 30000);
    var sell = buy * 0.62 - 9;
    var per = channel === 'general' ? buy : -sell;
    var iso = function (ms) { return new Date(ms).toISOString(); };
    var it = {
      type: type, duration: dur, spotPerKwh: Math.round((buy * 0.7 - 5) * 100) / 100,
      perKwh: Math.round(per * 100) / 100, date: iso(start).slice(0, 10), nemTime: iso(start + dur * 60000),
      startTime: iso(start), endTime: iso(start + dur * 60000),
      renewables: Math.round(30 + 40 * gauss(new Date(start).getHours(), 12.5, 3)),
      channelType: channel, spikeStatus: buy >= 100 ? 'spike' : (buy >= 70 ? 'potential' : 'none'),
      descriptor: descriptor(buy), estimate: type !== 'ActualInterval'
    };
    if (type === 'ForecastInterval') {
      it.advancedPrice = { low: Math.round(per * 0.8 * 100) / 100, predicted: it.perKwh, high: Math.round(per * 1.35 * 100) / 100 };
    }
    return it;
  }
  function prices(query) {
    var res = Number(query && query.resolution) || 30;
    var next = Number(query && query.next) || 0;
    var now = Date.now();
    var start = Math.floor(now / (res * 60000)) * res * 60000;
    var out = [];
    U.each(['general', 'feedIn'], function (ch) {
      out.push(interval('CurrentInterval', start, res, ch));
      for (var i = 1; i <= next; i++) { out.push(interval('ForecastInterval', start + i * res * 60000, res, ch)); }
    });
    return out;
  }

  // ---------- router ----------
  function foxess(p) {
    var body = p.body || {};
    var q = p.query || {};
    switch (p.path) {
      case '/op/v0/device/list':
        return { data: [{ deviceSN: SN, moduleSN: 'DEMO-LOGGER', stationID: 'demo', stationName: 'Demo Home', status: 1,
          hasPV: true, hasBattery: true, deviceType: 'H3-10.0-Smart', productType: 'H3 Smart' }], total: 1 };
      case '/op/v1/device/detail':
        return { deviceSN: q.sn || SN, stationName: 'Demo Home', status: 1, capacity: 10, masterVersion: '1.30', managerVersion: '1.35',
          function: { scheduler: true },
          batteryList: [{ batterySN: 'DEMO-BAT', type: 'master', model: 'EQ4800 x9', capicty: CAP_KWH * 1000, version: '1.12' }] };
      case '/op/v1/device/real/query': return realNow();
      case '/op/v0/device/history/query': return history(body);
      case '/op/v0/device/report/query': return report(body);
      case '/op/v0/device/battery/soc/get': return { minSoc: state.minSoc, minSocOnGrid: state.minSocOnGrid };
      case '/op/v0/device/battery/soc/set':
        state.minSoc = body.minSoc; state.minSocOnGrid = body.minSocOnGrid; return {};
      case '/op/v1/device/scheduler/get/flag': return { support: true, enable: state.schedEnable };
      case '/op/v1/device/scheduler/set/flag': state.schedEnable = !!body.enable; return { enable: body.enable };
      case '/op/v1/device/scheduler/get':
        return {
          enable: state.schedEnable ? '1' : '0',
          groups: JSON.parse(JSON.stringify(state.groups)),
          properties: {
            fdPwr: { unit: 'W', precision: 1, range: { min: 0, max: MAX_BAT_KW * 1000 } },
            fdSoc: { unit: '%', precision: 1, range: { min: 10, max: 100 } },
            minSocOnGrid: { unit: '%', precision: 1, range: { min: 10, max: 100 } },
            maxSoc: { unit: '%', precision: 1, range: { min: 10, max: 100 } }
          }
        };
      case '/op/v1/device/scheduler/enable':
        state.groups = JSON.parse(JSON.stringify(body.groups || []));
        state.schedEnable = true;
        return body;
      case '/op/v0/device/setting/get':
        return body.key === 'WorkMode' ? { value: 'SelfUse' } : { value: '' };
      case '/op/v0/device/setting/set': return body;
      default:
        throw new Error('Demo: unsupported path ' + p.path);
    }
  }

  function amber(p) {
    if (p.path === '/sites') {
      return [{ id: 'DEMOSITE', nmi: '6000000000', network: 'Ausgrid', status: 'active', intervalLength: 5,
        channels: [{ identifier: 'E1', type: 'general', tariff: 'EA116' }, { identifier: 'B1', type: 'feedIn', tariff: 'EA116' }] }];
    }
    if (/\/prices\/current$/.test(p.path)) { return prices(p.query); }
    if (/\/prices$/.test(p.path)) {
      var q = p.query || {};
      var s0 = new Date(q.startDate + 'T00:00:00').getTime(), e0 = new Date(q.endDate + 'T00:00:00').getTime() + 864e5;
      var hist = [];
      for (var t = s0; t < Math.min(e0, Date.now()); t += 1800000) {
        hist.push(interval('ActualInterval', t, 30, 'general'));
        hist.push(interval('ActualInterval', t, 30, 'feedIn'));
      }
      return hist;
    }
    throw new Error('Demo: unsupported Amber path');
  }

  SD.demo = {
    handle: function (method, params, done) {
      setTimeout(function () {
        try {
          var result = method === 'amber' ? amber(params) : foxess(params);
          done(null, { returnValue: true, result: result });
        } catch (e) {
          done(null, { returnValue: false, errorText: e.message });
        }
      }, 120 + Math.random() * 200);
    }
  };
})();
