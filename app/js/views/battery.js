/*
 * Battery: status, schedule and manual overrides (force charge / discharge etc).
 */
(function () {
  'use strict';
  var U = SD.util;
  var S = SD.state;
  var MODE_NAMES = {
    SelfUse: 'Self use', Feedin: 'Export first', Backup: 'Hold charge (backup)',
    ForceCharge: 'Force charge', ForceDischarge: 'Force discharge'
  };
  var el = {};

  function durations() {
    return [15, 30, 45, 60, 90, 120, 180, 240, 300, 360].map(function (m) {
      return { value: m, label: m < 60 ? m + ' min' : U.fmtDuration(m / 60).replace(' 00m', '') };
    });
  }
  function maxPowerW() { return SD.maxPowerInfo().w; }
  function floorSoc() { return (S.socSettings && S.socSettings.minSocOnGrid) || 10; }

  function canControl() {
    if (!SD.isDemo() && !SD.isConfigured()) { SD.toast('Connect FoxESS in Settings first', 'error'); return false; }
    if (S.schedule && S.schedule.supported === false) { SD.toast('This inverter does not support scheduled modes via the API', 'error'); return false; }
    return true;
  }

  function overrideDialog(mode, title, explain, fields) {
    if (!canControl()) { return; }
    var maxW = maxPowerW();
    var values = { minutes: 60, powerW: maxW, socLimit: mode === 'ForceCharge' ? 100 : Math.max(floorSoc(), 20) };
    var body = U.h('div', { 'class': 'form' }, [U.h('p', { 'class': 'modal-body', text: explain })]);
    body.appendChild(SD.stepper({ label: 'For', values: durations(), value: 60, onChange: function (v) { values.minutes = v; } }));
    if (fields.power) {
      var steps = SD.range(1000, Math.floor(maxW / 500) * 500, 500, function (w) { return (w / 1000).toFixed(1) + ' kW'; });
      if (!steps.length || steps[steps.length - 1].value !== maxW) { steps.push({ value: maxW, label: (maxW / 1000).toFixed(1) + ' kW (max)' }); }
      body.appendChild(SD.stepper({ label: 'Power', values: steps, value: maxW, onChange: function (v) { values.powerW = v; } }));
    }
    if (fields.soc) {
      var socVals = mode === 'ForceCharge'
        ? SD.range(Math.max(floorSoc(), 20), 100, 5, function (v) { return v + '%'; })
        : SD.range(floorSoc(), 95, 5, function (v) { return v + '%'; });
      body.appendChild(SD.stepper({
        label: mode === 'ForceCharge' ? 'Stop at' : 'Stop at', values: socVals, value: values.socLimit,
        onChange: function (v) { values.socLimit = v; }
      }));
    }
    var mp = SD.maxPowerInfo();
    body.appendChild(U.h('p', { 'class': 'field-hint', text: 'Press OK on a setting, then ‹ › to change it.' +
      (fields.power ? '  Max ' + (mp.w / 1000).toFixed(1) + ' kW (from ' + mp.source + '; change in Settings → Max battery power).' : '') }));

    SD.modal({
      title: title, body: body, danger: mode === 'ForceDischarge' || mode === 'ForceCharge',
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Start', primary: true, onClick: function (m) {
            var end = new Date(Date.now() + values.minutes * 60000);
            SD.toast('Sending to inverter…');
            SD.control.apply(mode, values, function (err) {
              if (err) { SD.toast('Failed: ' + err.message, 'error'); return; }
              SD.toast(MODE_NAMES[mode] + ' until ' + U.fmtTime(end), 'ok');
              render();
            });
          }
        }
      ]
    });
  }

  function limitsDialog() {
    if (!canControl()) { return; }
    var cur = S.socSettings || { minSoc: 10, minSocOnGrid: 10 };
    var v = { minSoc: cur.minSoc, minSocOnGrid: cur.minSocOnGrid };
    var vals = SD.range(10, 100, 5, function (x) { return x + '%'; });
    var body = U.h('div', { 'class': 'form' }, [
      U.h('p', { 'class': 'modal-body', text: 'Minimum battery levels. "On grid" is the normal floor; "Off grid" is kept in reserve for blackouts.' }),
      SD.stepper({ label: 'On grid', values: vals, value: v.minSocOnGrid, onChange: function (x) { v.minSocOnGrid = x; } }),
      SD.stepper({ label: 'Off grid', values: vals, value: v.minSoc, onChange: function (x) { v.minSoc = x; } })
    ]);
    SD.modal({
      title: 'Battery limits', body: body,
      buttons: [{ label: 'Cancel' }, {
        label: 'Save', primary: true, onClick: function () {
          SD.control.setMinSoc(v.minSoc, v.minSocOnGrid, function (err) {
            SD.toast(err ? 'Failed: ' + err.message : 'Battery limits saved', err ? 'error' : 'ok');
            render();
          });
        }
      }]
    });
  }

  function endOverride() {
    SD.modal({
      title: 'End override?', body: 'Your previous schedule (if any) will be restored and the inverter returns to its normal mode.',
      buttons: [{ label: 'Keep it' }, {
        label: 'End now', primary: true, onClick: function () {
          SD.control.restore(function (err) {
            SD.toast(err ? 'Failed: ' + err.message : 'Override ended', err ? 'error' : 'ok');
            render();
          });
        }
      }]
    });
  }

  function action(label, sub, fn, cls) {
    return U.h('button', { 'class': 'action focusable ' + (cls || ''), onclick: fn }, [
      U.h('span', { 'class': 'action-title', text: label }),
      U.h('span', { 'class': 'action-sub', text: sub })
    ]);
  }

  function build(root) {
    el.soc = U.h('div', { 'class': 'soc-big', text: '--' });
    el.power = U.h('div', { 'class': 'bat-line' });
    el.mode = U.h('div', { 'class': 'mode-line' });
    el.limits = U.h('div', { 'class': 'bat-line dim' });
    el.groups = U.h('div', { 'class': 'groups' });
    el.endBtn = action('End override', 'Restore your normal schedule now', endOverride, 'action-warn');

    root.appendChild(U.h('div', { 'class': 'battery' }, [
      U.h('section', { 'class': 'card bat-status' }, [
        U.h('h3', { 'class': 'card-title', text: 'Status' }),
        el.soc, el.power, el.mode, el.limits,
        U.h('h3', { 'class': 'card-title sub', text: 'Inverter schedule (repeats daily)' }),
        el.groups
      ]),
      U.h('section', { 'class': 'card bat-actions' }, [
        U.h('h3', { 'class': 'card-title', text: 'Controls' }),
        U.h('div', { 'class': 'actions-grid' }, [
          action('Charge from grid', 'Force charge now, e.g. when prices are low', function () {
            overrideDialog('ForceCharge', 'Charge from grid', 'The battery charges from the grid (and solar) at the chosen power until the time ends or it reaches the stop level.', { power: true, soc: true });
          }, 'action-charge'),
          action('Discharge to grid', 'Force export from the battery, e.g. during a spike', function () {
            overrideDialog('ForceDischarge', 'Discharge to grid', 'The battery exports to the grid at the chosen power until the time ends or it falls to the stop level.', { power: true, soc: true });
          }, 'action-discharge'),
          action('Export solar first', 'Send solar to the grid before the battery', function () {
            overrideDialog('Feedin', 'Export solar first', 'Solar goes to the house, then the grid. The battery only takes what is left over.', {});
          }),
          action('Hold battery', 'Stop discharging, keep charge in reserve', function () {
            overrideDialog('Backup', 'Hold battery', 'The battery stops discharging to the house and keeps its charge.', {});
          }),
          action('Battery limits', 'Minimum charge on and off grid', limitsDialog),
          action('Refresh', 'Re-read schedule from the inverter', function () { load(); }),
          el.endBtn
        ]),
        U.h('p', { 'class': 'field-hint', text: 'FoxESS schedules repeat every day. When an override ends, Solar Dash restores your previous schedule (via the background service, or while the app is open).' })
      ])
    ]));
  }

  function load() {
    if (!SD.isDemo() && !SD.isConfigured()) { return; }
    SD.data.schedule(function (err) { if (err) { SD.toast('Schedule: ' + err.message, 'error'); } render(); });
  }

  function render() {
    var l = S.live;
    if (l) {
      el.soc.textContent = U.isNum(l.soc) ? Math.round(l.soc) + '%' : '--';
      el.power.textContent = l.batPower > 0.05 ? 'Charging ' + U.fmtPower(l.batPower) : (l.batPower < -0.05 ? 'Discharging ' + U.fmtPower(-l.batPower) : 'Idle');
    }
    var o = SD.control.override();
    if (o) {
      el.mode.textContent = 'Override: ' + MODE_NAMES[o.mode] + ' until ' + U.fmtTime(o.until) +
        (o.mode === 'ForceCharge' || o.mode === 'ForceDischarge' ? ' (' + (o.powerW / 1000).toFixed(1) + ' kW, stop at ' + o.socLimit + '%)' : '');
      el.mode.className = 'mode-line active';
    } else if (S.schedule) {
      el.mode.textContent = S.schedule.enabled ? 'Following inverter schedule' : 'Normal mode (no schedule active)';
      el.mode.className = 'mode-line';
    }
    el.endBtn.classList.toggle('hidden', !o);
    var ss = S.socSettings;
    el.limits.textContent = ss ? 'Minimum charge: ' + ss.minSocOnGrid + '% on grid  ·  ' + ss.minSoc + '% off grid' : '';

    el.groups.innerHTML = '';
    var groups = (S.schedule && S.schedule.groups) || [];
    var active = groups.filter(function (g) { return g.enable === 1 || g.enable === '1' || g.enable === true; });
    if (!S.schedule) { el.groups.appendChild(U.h('div', { 'class': 'dim', text: 'Loading…' })); return; }
    if (!active.length) { el.groups.appendChild(U.h('div', { 'class': 'dim', text: 'No time segments set' })); }
    U.each(active, function (g) {
      el.groups.appendChild(U.h('div', { 'class': 'group-row' + (S.schedule.enabled ? '' : ' off') }, [
        U.h('span', { 'class': 'group-time', text: U.pad2(+g.startHour) + ':' + U.pad2(+g.startMinute) + ' - ' + U.pad2(+g.endHour) + ':' + U.pad2(+g.endMinute) }),
        U.h('span', { 'class': 'group-mode', text: MODE_NAMES[g.workMode] || g.workMode }),
        U.h('span', { 'class': 'dim', text: g.workMode === 'ForceCharge' || g.workMode === 'ForceDischarge' ? (g.fdPwr / 1000).toFixed(1) + ' kW → ' + g.fdSoc + '%' : '' })
      ]));
    });
  }

  SD.views.battery = {
    title: 'Battery',
    build: build,
    onShow: function () { render(); load(); },
    onUpdate: function (key) { if (key === 'live' || key === 'schedule' || key === 'soc' || key === 'override') { render(); } }
  };
})();
