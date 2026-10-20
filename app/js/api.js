/*
 * Transport + FoxESS / Amber API wrappers.
 *
 * On the TV, calls go to our JS service over luna (PalmServiceBridge).
 * In a desktop browser, they go to dev/server.js at /api/<method>.
 * In demo mode, SD.demo answers with simulated raw API responses.
 */
(function () {
  'use strict';
  var U = SD.util;
  var SERVICE = 'luna://com.solardash.tv.service/';

  SD.callCount = SD.store.load('solardash.calls', { day: '', fox: 0, amber: 0 });
  function countCall(kind) {
    var today = U.startOfDay().toDateString();
    if (SD.callCount.day !== today) { SD.callCount = { day: today, fox: 0, amber: 0 }; }
    SD.callCount[kind] += 1;
    SD.store.save('solardash.calls', SD.callCount);
  }

  var bridges = {};
  var bridgeSeq = 0;

  // If the TV kills our service mid-request (it does under memory pressure), the
  // reply never comes; time out so the FoxESS queue and polling loops keep going.
  var LUNA_TIMEOUT_MS = 45000;

  function callLuna(method, params, cb) {
    var id = ++bridgeSeq;
    var done = false;
    var bridge = new window.PalmServiceBridge();
    bridges[id] = bridge; // keep a reference until the reply arrives
    var timer = setTimeout(function () {
      if (done) { return; }
      done = true;
      delete bridges[id];
      try { bridge.cancel(); } catch (e) { /* ignore */ }
      cb(new Error('Background service did not reply'));
    }, LUNA_TIMEOUT_MS);
    bridge.onservicecallback = function (msg) {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      delete bridges[id];
      var res;
      try { res = JSON.parse(msg); } catch (e) { return cb(new Error('Bad service reply')); }
      cb(null, res);
    };
    bridge.call(SERVICE + method, JSON.stringify(params));
  }

  function callHttp(method, params, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/' + method, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 30000;
    xhr.onload = function () {
      var res;
      try { res = JSON.parse(xhr.responseText); } catch (e) { return cb(new Error('Bad server reply')); }
      cb(null, res);
    };
    xhr.onerror = function () { cb(new Error('Dev server unreachable')); };
    xhr.ontimeout = function () { cb(new Error('Request timed out')); };
    xhr.send(JSON.stringify(params));
  }

  // cb(err, result) where err is an Error with .message, result is the API "result" payload
  // opts.live forces a real request even when demo data is on (used by setup discovery)
  SD.call = function (method, params, cb, opts) {
    var done = function (err, res) {
      if (err) { return cb(err); }
      if (!res || res.returnValue === false) {
        var e = new Error((res && res.errorText) || 'Request failed');
        e.errno = res && res.errno;
        return cb(e);
      }
      cb(null, res.result);
    };
    if (SD.isDemo() && !(opts && opts.live)) { return SD.demo.handle(method, params, done); }
    countCall(method === 'amber' ? 'amber' : 'fox');
    if (window.PalmServiceBridge) { return callLuna(method, params, done); }
    if (window.location.protocol.indexOf('http') === 0) { return callHttp(method, params, done); }
    cb(new Error('No service available'));
  };

  // ---------- FoxESS ----------
  // FoxESS allows one call per second per endpoint; serialise everything with a gap.
  var queue = [];
  var busy = false;
  var lastAt = 0;
  var GAP_MS = 1100;

  function pump() {
    if (busy || !queue.length) { return; }
    busy = true;
    var job = queue.shift();
    var wait = Math.max(0, lastAt + GAP_MS - Date.now());
    if (SD.isDemo() && !(job.opts && job.opts.live)) { wait = 0; }
    setTimeout(function () {
      lastAt = Date.now();
      SD.call('foxess', job.params, function (err, result) {
        busy = false;
        try { job.cb(err, result); } finally { pump(); }
      }, job.opts);
    }, wait);
  }

  function fox(method, path, payload, cb, opts) {
    var params = {
      apiKey: SD.settings.foxApiKey,
      baseUrl: SD.foxBaseUrl(),
      method: method,
      path: path
    };
    if (method === 'GET') { params.query = payload; } else { params.body = payload; }
    queue.push({ params: params, cb: cb, opts: opts });
    pump();
  }

  var REAL_VARS = [
    'pvPower', 'pv1Power', 'pv2Power', 'pv3Power', 'pv4Power',
    'loadsPower', 'gridConsumptionPower', 'feedinPower', 'meterPower',
    'batChargePower', 'batDischargePower', 'invBatPower',
    'SoC', 'SOH', 'batTemperature', 'ResidualEnergy', 'batStatusV2',
    'generationPower', 'epsPower', 'runningState', 'currentFault', 'ambientTemperation', 'todayYield'
  ];
  var REPORT_VARS = ['generation', 'feedin', 'gridConsumption', 'chargeEnergyToTal', 'dischargeEnergyToTal', 'PVEnergyTotal'];
  var HISTORY_VARS = ['pvPower', 'loadsPower', 'SoC', 'gridConsumptionPower', 'feedinPower', 'batChargePower', 'batDischargePower'];

  SD.fox = {
    REAL_VARS: REAL_VARS,
    REPORT_VARS: REPORT_VARS,
    HISTORY_VARS: HISTORY_VARS,

    listDevices: function (cb) {
      fox('POST', '/op/v0/device/list', { currentPage: 1, pageSize: 50 }, function (err, r) {
        cb(err, r && r.data ? r.data : []);
      }, { live: true });
    },
    detail: function (sn, cb) { fox('GET', '/op/v1/device/detail', { sn: sn }, cb); },

    // -> { vars: {name: {value, unit, name}}, time }
    real: function (sn, cb) {
      fox('POST', '/op/v1/device/real/query', { sns: [sn], variables: REAL_VARS }, function (err, r) {
        if (err) { return cb(err); }
        var dev = (r && r[0]) || {};
        var vars = {};
        var time = null;
        U.each(dev.datas || [], function (d) {
          vars[d.variable] = { value: Number(d.value), unit: d.unit, name: d.name };
          if (d.time && !time) { time = d.time; }
        });
        cb(null, { vars: vars, time: time });
      });
    },

    // -> { varName: [{t: ms, v: number}] }
    history: function (sn, begin, end, cb) {
      fox('POST', '/op/v0/device/history/query', { sn: sn, variables: HISTORY_VARS, begin: begin, end: end }, function (err, r) {
        if (err) { return cb(err); }
        var out = {};
        var dev = (r && r[0]) || {};
        U.each(dev.datas || [], function (d) {
          out[d.variable] = U.map(d.data || [], function (p) {
            return { t: SD.fox.parseTime(p.time), v: Number(p.value) };
          });
        });
        cb(null, out);
      });
    },

    // dimension 'day' -> hourly values, 'month' -> daily, 'year' -> monthly. -> { varName: [numbers] }
    report: function (sn, dimension, date, cb) {
      var body = { sn: sn, dimension: dimension, year: date.getFullYear(), variables: REPORT_VARS };
      if (dimension !== 'year') { body.month = date.getMonth() + 1; }
      if (dimension === 'day') { body.day = date.getDate(); }
      fox('POST', '/op/v0/device/report/query', body, function (err, r) {
        if (err) { return cb(err); }
        var out = {};
        U.each(r || [], function (row) { out[row.variable] = U.map(row.values || [], Number); });
        cb(null, out);
      });
    },

    socGet: function (sn, cb) { fox('GET', '/op/v0/device/battery/soc/get', { sn: sn }, cb); },
    socSet: function (sn, minSoc, minSocOnGrid, cb) {
      fox('POST', '/op/v0/device/battery/soc/set', { sn: sn, minSoc: minSoc, minSocOnGrid: minSocOnGrid }, cb);
    },
    schedulerFlag: function (sn, cb) { fox('POST', '/op/v1/device/scheduler/get/flag', { deviceSN: sn }, cb); },
    schedulerSetFlag: function (sn, on, cb) { fox('POST', '/op/v1/device/scheduler/set/flag', { deviceSN: sn, enable: on ? 1 : 0 }, cb); },
    schedulerGet: function (sn, cb) { fox('POST', '/op/v1/device/scheduler/get', { deviceSN: sn }, cb); },
    schedulerSet: function (sn, groups, cb) { fox('POST', '/op/v1/device/scheduler/enable', { deviceSN: sn, groups: groups }, cb); },
    settingGet: function (sn, key, cb) { fox('POST', '/op/v0/device/setting/get', { sn: sn, key: key }, cb); },
    settingSet: function (sn, key, value, cb) { fox('POST', '/op/v0/device/setting/set', { sn: sn, key: key, value: String(value) }, cb); },

    // FoxESS times look like "2024-01-02 13:45:00 AEDT+1100" or ISO-ish UTC strings.
    parseTime: function (s) {
      if (!s) { return NaN; }
      var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
      if (!m) { return new Date(s).getTime(); }
      var off = /([+-])(\d{2}):?(\d{2})\s*$/.exec(s);
      var utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (off) {
        var mins = (+off[2]) * 60 + (+off[3]);
        return utc - (off[1] === '-' ? -1 : 1) * mins * 60000;
      }
      if (/Z\s*$|UTC/.test(s)) { return utc; }
      return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    }
  };

  // ---------- Amber ----------
  function amber(path, query, cb, opts) {
    SD.call('amber', { token: SD.settings.amberToken, path: path, query: query }, cb, opts);
  }

  SD.amber = {
    enabled: function () { return SD.isDemo() || !!(SD.settings.amberToken && SD.settings.amberSiteId); },
    sites: function (cb) { amber('/sites', null, cb, { live: true }); },
    // resolution 5 or 30; returns raw interval array (general + feedIn channels)
    prices: function (next, resolution, cb) {
      amber('/sites/' + SD.settings.amberSiteId + '/prices/current', { previous: 0, next: next, resolution: resolution }, cb);
    }
  };
})();
