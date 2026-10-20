/*
 * Battery overrides via the FoxESS scheduler ("time segments").
 *
 * FoxESS scheduler segments repeat DAILY. To run a one-off "force charge for 2 h"
 * we back up the user's existing schedule, write a temporary segment, and restore
 * the backup when it expires. Expiry is checked on every live poll, so in phase 1
 * the app must be running (or be reopened) for the restore to happen; the root
 * background daemon in phase 2 will take this over.
 */
(function () {
  'use strict';
  var U = SD.util;
  var KEY = 'solardash.override.v1';
  var GROUP_FIELDS = ['enable', 'startHour', 'startMinute', 'endHour', 'endMinute', 'workMode', 'minSocOnGrid', 'fdSoc', 'fdPwr', 'maxSoc'];

  function cleanGroup(g) {
    var out = {};
    U.each(GROUP_FIELDS, function (k) { if (g[k] != null && g[k] !== '') { out[k] = typeof g[k] === 'string' && k !== 'workMode' ? Number(g[k]) : g[k]; } });
    if (out.enable == null) { out.enable = 1; }
    return out;
  }

  // Segments are within one day; split a window that crosses midnight.
  function buildGroups(startMs, endMs, base) {
    var s = new Date(startMs);
    var e = new Date(endMs);
    function seg(sh, sm, eh, em) {
      return U.extend({ enable: 1, startHour: sh, startMinute: sm, endHour: eh, endMinute: em }, base);
    }
    if (s.toDateString() === e.toDateString()) {
      return [seg(s.getHours(), s.getMinutes(), e.getHours(), e.getMinutes())];
    }
    var groups = [seg(s.getHours(), s.getMinutes(), 23, 59)];
    if (e.getHours() > 0 || e.getMinutes() > 0) { groups.push(seg(0, 0, e.getHours(), e.getMinutes())); }
    return groups;
  }

  function getOverride() { return SD.store.load(KEY, null); }
  function setOverride(o) { SD.store.save(KEY, o); SD.emit('update', 'override'); }

  var busy = false;

  SD.control = {
    override: getOverride,
    busy: function () { return busy; },

    /*
     * mode: 'ForceCharge' | 'ForceDischarge' | 'Feedin' | 'SelfUse' | 'Backup'
     * opts: { minutes, powerW, socLimit }
     *   ForceCharge: socLimit = stop charging at this SoC
     *   ForceDischarge: socLimit = stop discharging at this SoC
     */
    apply: function (mode, opts, cb) {
      if (busy) { return cb(new Error('Another change is in progress')); }
      busy = true;
      var sn = SD.settings.foxSn;
      var existing = getOverride();
      var floor = (SD.state.socSettings && SD.state.socSettings.minSocOnGrid) || 10;

      function finish(err) { busy = false; cb(err); }

      SD.fox.schedulerGet(sn, function (err, cur) {
        if (err) { return finish(err); }
        SD.fox.schedulerFlag(sn, function (err2, flag) {
          // Only back up the user's own schedule, never one of our overrides.
          var backup = existing ? existing.backup : {
            enabled: flag ? !!flag.enable : (cur.enable === '1' || cur.enable === 1),
            groups: U.map(cur.groups || [], cleanGroup)
          };

          var now = Date.now();
          var start = now - (now % 60000);
          var end = start + opts.minutes * 60000;
          var socLimit = U.clamp(Math.round(opts.socLimit || (mode === 'ForceCharge' ? 100 : floor)), floor, 100);
          var base = {
            workMode: mode,
            minSocOnGrid: floor,
            fdSoc: mode === 'ForceCharge' || mode === 'ForceDischarge' ? socLimit : floor,
            fdPwr: Math.round(opts.powerW || 0),
            maxSoc: 100
          };
          if (!base.fdPwr) { base.fdPwr = SD.maxPowerInfo().w; }

          var groups = buildGroups(start, end, base);
          SD.fox.schedulerSet(sn, groups, function (err3) {
            if (err3) { return finish(err3); }
            SD.fox.schedulerSetFlag(sn, true, function () {
              var record = { mode: mode, start: start, until: end, powerW: base.fdPwr, socLimit: base.fdSoc, backup: backup };
              setOverride(record);
              if (SD.daemon) { SD.daemon.pushOverride(record); }
              SD.data.schedule(function () { finish(null); });
            });
          });
        });
      });
    },

    // Put back whatever schedule the user had before the override.
    restore: function (cb) {
      cb = cb || function () {};
      var o = getOverride();
      if (!o) { return cb(null); }
      if (busy) { return cb(new Error('Another change is in progress')); }
      busy = true;
      var sn = SD.settings.foxSn;
      function finish(err) {
        busy = false;
        if (!err) { setOverride(null); if (SD.daemon) { SD.daemon.pushOverride(null); } }
        SD.data.schedule(function () { cb(err); });
      }
      var b = o.backup || { enabled: false, groups: [] };
      if (b.groups && b.groups.length) {
        SD.fox.schedulerSet(sn, b.groups, function (err) {
          if (err) { return finish(err); }
          SD.fox.schedulerSetFlag(sn, b.enabled, finish);
        });
      } else {
        SD.fox.schedulerSetFlag(sn, false, finish);
      }
    },

    checkExpiry: function () {
      var o = getOverride();
      if (o && Date.now() >= o.until && !busy) {
        SD.control.restore(function (err) {
          SD.emit('notice', err ? 'Could not end override: ' + err.message : 'Battery override ended - schedule restored');
        });
      }
    },

    setMinSoc: function (minSoc, minSocOnGrid, cb) {
      SD.fox.socSet(SD.settings.foxSn, minSoc, minSocOnGrid, function (err) {
        if (err) { return cb(err); }
        SD.data.schedule(function () { cb(null); });
      });
    }
  };
})();
