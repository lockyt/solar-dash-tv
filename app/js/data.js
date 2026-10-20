/*
 * Polling + normalised state. Views listen for SD.on('update', key) and read SD.state.
 *
 * FoxESS budget is 1,440 calls per inverter per day. Defaults:
 *   live data every 90 s (~960/day), today's report every 10 min (~144/day),
 *   history/month/year only while the History screen is open.
 */
(function () {
  'use strict';
  var U = SD.util;

  var S = SD.state = {
    device: null,
    live: null,
    today: null,
    history: null,
    month: null,
    year: null,
    price: null,
    forecast: [],
    schedule: null,
    socSettings: null,
    errors: {},
    updated: {}
  };

  var timers = {};
  var running = false;

  function setError(key, err) {
    var msg = err ? (err.message || String(err)) : null;
    if (S.errors[key] !== msg) {
      S.errors[key] = msg;
      SD.emit('update', 'errors');
    }
  }

  function every(name, ms, fn) {
    clearTimeout(timers[name]);
    function tick() {
      if (!running) { return; }
      fn(function () {
        if (running) { timers[name] = setTimeout(tick, ms); }
      });
    }
    tick();
  }

  // ---------- normalisation ----------
  function num(vars, name) {
    var v = vars[name];
    return v && U.isNum(v.value) ? v.value : null;
  }

  SD.batteryKwh = function () {
    if (SD.settings.batteryKwh > 0) { return SD.settings.batteryKwh; }
    if (S.device && S.device.batteryKwh) { return S.device.batteryKwh; }
    var l = S.live;
    if (l && U.isNum(l.residualKwh) && l.soc > 5) { return l.residualKwh / (l.soc / 100); }
    return null;
  };

  // Force charge/discharge power limit in W, and where it came from.
  // FoxESS reports the fdPwr range either at the top level or per time segment.
  SD.maxPowerInfo = function () {
    if (SD.settings.maxPowerKw > 0) { return { w: SD.settings.maxPowerKw * 1000, source: 'your setting' }; }
    var sch = S.schedule;
    var cands = [];
    if (sch && sch.properties) { cands.push(sch.properties); }
    U.each((sch && sch.rawGroups) || [], function (g) { if (g && g.properties) { cands.push(g.properties); } });
    for (var i = 0; i < cands.length; i++) {
      var r = cands[i].fdPwr && cands[i].fdPwr.range;
      if (r && Number(r.max) > 0) { return { w: Number(r.max), source: 'inverter' }; }
    }
    if (S.device && S.device.capacityKw > 0) { return { w: S.device.capacityKw * 1000, source: 'inverter rating' }; }
    return { w: 10000, source: 'default' };
  };

  function normaliseLive(r) {
    var v = r.vars;
    var charge = num(v, 'batChargePower');
    var discharge = num(v, 'batDischargePower');
    var inv = num(v, 'invBatPower');
    if (charge == null && discharge == null && inv != null) {
      charge = inv < 0 ? -inv : 0;
      discharge = inv > 0 ? inv : 0;
    }
    var strings = [];
    for (var i = 1; i <= 4; i++) {
      var p = num(v, 'pv' + i + 'Power');
      if (p != null) { strings.push(p); }
    }
    var live = {
      pv: num(v, 'pvPower'),
      strings: strings,
      load: num(v, 'loadsPower'),
      imp: num(v, 'gridConsumptionPower'),
      exp: num(v, 'feedinPower'),
      charge: charge || 0,
      discharge: discharge || 0,
      soc: num(v, 'SoC'),
      soh: num(v, 'SOH'),
      batTemp: num(v, 'batTemperature'),
      residualKwh: num(v, 'ResidualEnergy'),
      status: v.batStatusV2 ? v.batStatusV2.value : null,
      runningState: num(v, 'runningState'),
      fault: num(v, 'currentFault'),
      time: r.time ? SD.fox.parseTime(r.time) : Date.now()
    };
    live.batPower = live.charge - live.discharge; // + charging, - discharging
    live.grid = (live.imp || 0) - (live.exp || 0); // + importing, - exporting
    if (live.load == null && live.pv != null) {
      live.load = Math.max(0, live.pv + live.grid - live.batPower);
    }

    var cap = SD.batteryKwh();
    var floor = S.socSettings ? S.socSettings.minSocOnGrid : 10;
    live.etaHours = null;
    if (cap && U.isNum(live.soc)) {
      if (live.batPower > 0.05) { live.etaHours = (100 - live.soc) / 100 * cap / live.batPower; live.etaLabel = 'to full'; }
      else if (live.batPower < -0.05) { live.etaHours = Math.max(0, live.soc - floor) / 100 * cap / -live.batPower; live.etaLabel = 'to ' + floor + '%'; }
    }
    return live;
  }

  function normaliseDay(rep) {
    var solarArr = rep.PVEnergyTotal && U.sum(rep.PVEnergyTotal) > 0 ? rep.PVEnergyTotal : (rep.generation || []);
    var t = {
      solar: U.sum(solarArr),
      exp: U.sum(rep.feedin || []),
      imp: U.sum(rep.gridConsumption || []),
      charged: U.sum(rep.chargeEnergyToTal || []),
      discharged: U.sum(rep.dischargeEnergyToTal || []),
      hourly: rep
    };
    t.home = Math.max(0, t.solar + t.imp + t.discharged - t.exp - t.charged);
    t.selfSufficiency = t.home > 0 ? U.clamp(1 - t.imp / t.home, 0, 1) : null;
    return t;
  }

  function normalisePrices(list) {
    var byStart = {};
    var order = [];
    U.each(list || [], function (it) {
      var k = it.startTime;
      if (!byStart[k]) { byStart[k] = { start: Date.parse(it.startTime), end: Date.parse(it.endTime), type: it.type }; order.push(k); }
      var row = byStart[k];
      if (it.channelType === 'general') {
        row.buy = it.perKwh;
        row.descriptor = it.descriptor;
        row.spikeStatus = it.spikeStatus;
        row.renewables = it.renewables;
        row.spot = it.spotPerKwh;
        row.estimate = it.estimate;
        if (it.advancedPrice) { row.low = it.advancedPrice.low; row.high = it.advancedPrice.high; }
      } else if (it.channelType === 'feedIn') {
        row.sell = -it.perKwh; // Amber feed-in prices are negative when you get paid
      } else if (it.channelType === 'controlledLoad') {
        row.controlledLoad = it.perKwh;
      }
    });
    var rows = U.map(order, function (k) { return byStart[k]; });
    rows.sort(function (a, b) { return a.start - b.start; });
    return rows;
  }

  // ---------- loaders ----------
  function loadDevice(done) {
    SD.fox.detail(SD.settings.foxSn, function (err, d) {
      if (err) { setError('device', err); return done(); }
      setError('device', null);
      var kwh = 0;
      U.each(d.batteryList || [], function (b) {
        var c = Number(b.capicty || b.capacity || 0);
        kwh += c > 200 ? c / 1000 : c; // Wh vs kWh
      });
      S.device = {
        sn: d.deviceSN, name: d.stationName, capacityKw: d.capacity, status: d.status,
        batteries: d.batteryList || [], batteryKwh: kwh || null,
        firmware: d.masterVersion, scheduler: d['function'] ? d['function'].scheduler : null
      };
      SD.emit('update', 'device');
      done();
    });
  }

  /*
   * FoxESS Cloud only receives new inverter data every few minutes (5 min on an
   * H3 Smart), so polling faster just returns the same numbers. We watch for the
   * values to change, learn the cadence, and poll just after the next expected update.
   */
  var cadence = { last: null, value: null, sig: null };

  function liveSig(l) {
    return [l.pv, l.load, l.imp, l.exp, l.charge, l.discharge, l.soc].join('|');
  }

  function loadLive(done) {
    SD.fox.real(SD.settings.foxSn, function (err, r) {
      if (err) { setError('fox', err); return done(false); }
      setError('fox', null);
      S.live = normaliseLive(r);
      var now = Date.now();
      S.updated.live = now;
      var sig = liveSig(S.live);
      var changed = sig !== cadence.sig;
      if (changed) {
        if (cadence.sig !== null && cadence.last) {
          var gap = now - cadence.last;
          if (gap > 45000 && gap < 20 * 60000) {
            // round to the nearest minute; FoxESS uploads on whole-minute intervals
            cadence.value = Math.round(gap / 60000) * 60000;
          }
        }
        cadence.sig = sig;
        cadence.last = now;
        S.updated.liveData = now;
      }
      SD.emit('update', 'live');
      if (SD.control) { SD.control.checkExpiry(); }
      done(changed);
    });
  }

  function nextLiveDelay(changed) {
    var fallback = U.clamp(Number(SD.settings.refreshSec) || 90, 60, 600) * 1000;
    if (!cadence.value || !cadence.last) { return fallback; }
    var due = cadence.last + cadence.value + 20000 - Date.now(); // 20 s after the expected upload
    if (changed || due > 0) { return Math.max(15000, due); }
    // Expected data hasn't arrived yet: check again soon, then back off.
    var late = -due;
    if (late < 2 * 60000) { return 30000; }
    return fallback;
  }

  // Safety net: if live data hasn't refreshed for a long time while we're
  // supposedly running, restart all the polling loops.
  var watchdog = null;
  function startWatchdog() {
    clearInterval(watchdog);
    watchdog = setInterval(function () {
      if (!running || SD.isDemo()) { return; }
      var limit = Math.max(3 * ((cadence.value || 300000)), 15 * 60000);
      if (S.updated.live && Date.now() - S.updated.live > limit) {
        SD.data.start();
      }
    }, 60000);
  }

  function liveLoop() {
    if (!running) { return; }
    loadLive(function (changed) {
      if (!running) { return; }
      clearTimeout(timers.live);
      timers.live = setTimeout(liveLoop, nextLiveDelay(changed));
    });
  }

  function loadToday(done) {
    SD.fox.report(SD.settings.foxSn, 'day', new Date(), function (err, rep) {
      if (err) { setError('report', err); return done(); }
      setError('report', null);
      S.today = normaliseDay(rep);
      S.updated.today = Date.now();
      SD.emit('update', 'today');
      done();
    });
  }

  function loadSocSettings(done) {
    SD.fox.socGet(SD.settings.foxSn, function (err, r) {
      if (!err && r) { S.socSettings = { minSoc: r.minSoc, minSocOnGrid: r.minSocOnGrid }; SD.emit('update', 'soc'); }
      done();
    });
  }

  function loadPriceNow(done) {
    if (!SD.amber.enabled()) { return done(); }
    SD.amber.prices(0, 5, function (err, list) {
      if (err) { setError('amber', err); return done(); }
      setError('amber', null);
      var rows = normalisePrices(list);
      var prev = S.price;
      S.price = rows[0] || null;
      S.updated.price = Date.now();
      SD.emit('update', 'price');
      if (S.price && (!prev || prev.spikeStatus !== S.price.spikeStatus)) { SD.emit('spike', S.price); }
      done();
    });
  }

  function loadForecast(done) {
    if (!SD.amber.enabled()) { return done(); }
    SD.amber.prices(48, 30, function (err, list) {
      if (err) { setError('amber', err); return done(); }
      S.forecast = normalisePrices(list);
      S.updated.forecast = Date.now();
      SD.emit('update', 'forecast');
      done();
    });
  }

  // ---------- price history for bands (4 weeks, refreshed daily) ----------
  var HIST_KEY = 'solardash.priceStats.v1';
  function loadPriceHistory(done) {
    if (!SD.amber.enabled()) { return done(); }
    var today = U.startOfDay().toDateString() + (SD.isDemo() ? ':demo' : ':' + SD.settings.amberSiteId);
    var cached = SD.store.load(HIST_KEY, null);
    if (cached && cached.key === today && cached.stats) {
      S.priceStats = cached.stats;
      SD.emit('update', 'priceStats');
      return done();
    }
    var ranges = SDBands.historyRanges();
    var all = [];
    (function next(i) {
      if (i >= ranges.length) {
        S.priceStats = SDBands.buildStats(all);
        SD.store.save(HIST_KEY, { key: today, stats: S.priceStats });
        SD.emit('update', 'priceStats');
        return done();
      }
      SD.call('amber', {
        token: SD.settings.amberToken, path: '/sites/' + SD.settings.amberSiteId + '/prices',
        query: { startDate: ranges[i].startDate, endDate: ranges[i].endDate, resolution: 30 }
      }, function (err, list) {
        if (!err && list) { all = all.concat(list); }
        next(i + 1);
      });
    })(0);
  }

  // Band for a normalised price row ({buy, sell, spikeStatus})
  SD.buyBand = function (row) {
    return row ? SDBands.buyBand(row.buy, S.priceStats, Number(SD.settings.referenceCents) || SDBands.DEFAULT_REFERENCE, row.spikeStatus) : null;
  };
  SD.sellBand = function (row) { return row ? SDBands.sellBand(row.sell, S.priceStats) : null; };

  // Clear cached data, e.g. when switching between demo and a real inverter
  SD.resetState = function () {
    S.device = S.live = S.today = S.history = S.month = S.year = S.price = S.schedule = S.socSettings = null;
    S.forecast = [];
    S.priceStats = null;
    S.errors = {};
    S.updated = {};
    cadence = { last: null, value: null, sig: null };
  };

  // ---------- on-demand (History / Battery screens) ----------
  SD.data = {
    start: function () {
      SD.data.stop();
      running = true;
      if (!SD.isDemo() && !SD.isConfigured()) { return; }
      loadDevice(function () {
        loadSocSettings(function () {
          liveLoop();
          startWatchdog();
          every('today', 10 * 60000, loadToday);
        });
      });
      every('price', 60000, loadPriceNow);
      every('forecast', 5 * 60000, loadForecast);
      every('priceHistory', 6 * 3600000, loadPriceHistory);
    },
    stop: function () {
      running = false;
      clearInterval(watchdog);
      for (var k in timers) { if (timers.hasOwnProperty(k)) { clearTimeout(timers[k]); } }
      timers = {};
    },
    refreshLive: function () { loadLive(function () {}); },
    cadence: function () { return cadence; },

    history: function (force, cb) {
      if (!force && S.history && Date.now() - S.updated.history < 10 * 60000) { return cb && cb(); }
      var end = Date.now();
      SD.fox.history(SD.settings.foxSn, U.startOfDay().getTime(), end, function (err, h) {
        if (err) { setError('history', err); return cb && cb(err); }
        setError('history', null);
        S.history = h;
        S.updated.history = Date.now();
        SD.emit('update', 'history');
        if (cb) { cb(); }
      });
    },
    period: function (dimension, force, cb) {
      var key = dimension === 'month' ? 'month' : 'year';
      if (!force && S[key] && Date.now() - S.updated[key] < 60 * 60000) { return cb && cb(); }
      SD.fox.report(SD.settings.foxSn, dimension, new Date(), function (err, rep) {
        if (err) { setError(key, err); return cb && cb(err); }
        setError(key, null);
        S[key] = rep;
        S.updated[key] = Date.now();
        SD.emit('update', key);
        if (cb) { cb(); }
      });
    },
    schedule: function (cb) {
      var sn = SD.settings.foxSn;
      SD.fox.schedulerGet(sn, function (err, r) {
        if (err) { setError('schedule', err); return cb && cb(err); }
        SD.fox.schedulerFlag(sn, function (err2, f) {
          setError('schedule', null);
          S.schedule = {
            enabled: f ? !!f.enable : r.enable === '1' || r.enable === 1,
            supported: f ? f.support !== false : true,
            groups: r.groups || [],
            rawGroups: r.groups || [],
            properties: r.properties || {}
          };
          SD.emit('update', 'schedule');
          loadSocSettings(function () { if (cb) { cb(); } });
        });
      });
    }
  };

  SD.on('settings', function () { SD.data.start(); });
})();
