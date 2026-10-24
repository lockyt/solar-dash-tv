/*
 * Settings: FoxESS + Amber credentials, device/site discovery, display options.
 * Typing on a TV: the webOS keyboard opens on OK, and the LG ThinQ phone app
 * can type into it, which is much easier for long API keys.
 */
(function () {
  'use strict';
  var U = SD.util;
  var el = {};
  var draft = {};

  function section(title, children) {
    return U.h('section', { 'class': 'card settings-card' }, [U.h('h3', { 'class': 'card-title', text: title })].concat(children));
  }
  function button(label, fn, cls) {
    return U.h('button', { 'class': 'btn focusable ' + (cls || ''), text: label, onclick: fn });
  }

  function findInverters() {
    if (!draft.foxApiKey) { SD.toast('Enter your FoxESS API key first', 'error'); return; }
    SD.settings.foxApiKey = draft.foxApiKey;
    SD.settings.foxServer = draft.foxServer;
    el.foxStatus.textContent = 'Looking up inverters…';
    SD.fox.listDevices(function (err, list) {
      if (err) { el.foxStatus.textContent = err.message; return; }
      if (!list.length) { el.foxStatus.textContent = 'No inverters found on this account.'; return; }
      var values = U.map(list, function (d) {
        return { value: d.deviceSN, label: d.deviceSN + ' · ' + (d.deviceType || d.productType || '') + (d.stationName ? ' · ' + d.stationName : '') };
      });
      var pick = draft.foxSn && values.some(function (v) { return v.value === draft.foxSn; }) ? draft.foxSn : values[0].value;
      el.sn.setValues(values, pick);
      draft.foxSn = pick;
      el.foxStatus.textContent = 'Found ' + list.length + ' inverter' + (list.length > 1 ? 's' : '') + '. Press Save.';
    });
  }

  function findSites() {
    if (!draft.amberToken) { SD.toast('Enter your Amber API token first', 'error'); return; }
    SD.settings.amberToken = draft.amberToken;
    el.amberStatus.textContent = 'Looking up sites…';
    SD.amber.sites(function (err, sites) {
      if (err) { el.amberStatus.textContent = err.message; return; }
      sites = (sites || []).filter(function (s) { return s.status !== 'closed'; });
      if (!sites.length) { el.amberStatus.textContent = 'No active Amber sites found.'; return; }
      var values = U.map(sites, function (s) { return { value: s.id, label: 'NMI ' + s.nmi + ' · ' + (s.network || '') + ' · ' + s.status }; });
      el.site.setValues(values, values[0].value);
      draft.amberSiteId = values[0].value;
      el.amberStatus.textContent = 'Found ' + sites.length + ' site' + (sites.length > 1 ? 's' : '') + '. Press Save.';
    });
  }

  function save() {
    var patch = U.extend({}, draft);
    if (patch.foxApiKey && patch.foxSn && SD.settings.demo && !draft.demoTouched) { patch.demo = false; }
    delete patch.demoTouched;
    SD.resetState();
    SD.saveSettings(patch);
    setTimeout(refreshDaemon, 1500);
    SD.toast(SD.isDemo() ? 'Saved - showing demo data' : 'Saved - connecting…', 'ok');
    renderStats();
  }

  // ---------- TV notifications (background daemon, rooted TVs) ----------
  function buildNotifications() {
    el.daemonStatus = U.h('div', { 'class': 'status-line dim', text: 'Checking background service\u2026' });
    el.installBtn = button('Install background service', function () {
      el.daemonStatus.textContent = 'Installing\u2026';
      SD.daemon.install(function (err) {
        el.daemonStatus.textContent = err ? 'Install failed: ' + err.message : 'Installed and running';
        refreshDaemon();
      });
    });
    el.uninstallBtn = button('Uninstall', function () {
      SD.modal({
        title: 'Uninstall background service?',
        body: 'Price notifications stop, and battery overrides will only be restored while Solar Dash is open. You can reinstall it any time.',
        buttons: [{ label: 'Cancel' }, {
          label: 'Uninstall', primary: true, onClick: function () {
            el.daemonStatus.textContent = 'Uninstalling\u2026';
            SD.daemon.uninstall(function (err) {
              el.daemonStatus.textContent = err ? 'Uninstall failed: ' + err.message : 'Background service removed';
              setTimeout(refreshDaemon, 2000);
            });
          }
        }]
      });
    });
    el.testBtn = button('Send test', function () {
      // Test exactly what's selected on screen, even before Save
      SD.daemon.test({ fields: draft.tickerFields, holdSec: draft.tickerHoldSec }, function (err) {
        SD.toast(err ? err.message : 'Test notification sent', err ? 'error' : 'ok');
      });
    });
    // Everything in this card applies straight away (no Save needed)
    function apply(key) {
      return function (v) {
        draft[key] = v;
        SD.settings[key] = v;
        SD.store.save('solardash.settings.v1', SD.settings);
        SD.daemon.pushConfig();
      };
    }
    el.notifSwitch = SD.stepper({ label: 'Notifications', values: [{ value: false, label: 'Off' }, { value: true, label: 'On' }], value: false,
      hint: 'Always starts Off after the TV restarts',
      onChange: function (v) {
        SD.daemon.setNotifications(v, function (err) {
          SD.toast(err ? err.message : (v ? 'Price notifications on' : 'Price notifications off'), err ? 'error' : 'ok');
        });
      } });
    return section('TV notifications', [
      U.h('p', { 'class': 'field-hint card-hint', text: 'Changes here apply immediately.' }),
      el.notifSwitch,
      SD.stepper({ label: 'Every', values: [{ value: 0, label: 'Only on change' }, { value: 5, label: '5 min' }, { value: 10, label: '10 min' },
        { value: 15, label: '15 min' }, { value: 30, label: '30 min' }, { value: 60, label: '60 min' }], value: draft.tickerInterval,
        onChange: apply('tickerInterval') }),
      SD.stepper({ label: 'Price moves', values: [{ value: 0, label: 'Ignore' }, { value: 2, label: '\u00b1 2c' }, { value: 5, label: '\u00b1 5c' },
        { value: 10, label: '\u00b1 10c' }, { value: 20, label: '\u00b1 20c' }], value: draft.tickerChange,
        onChange: apply('tickerChange') }),
      SD.stepper({ label: 'Keep on screen', values: [{ value: 5, label: '5 s' }, { value: 15, label: '15 s' }, { value: 30, label: '30 s' },
        { value: 60, label: '1 min' }, { value: -1, label: 'Always' }], value: draft.tickerHoldSec,
        hint: 'LG fixes the position (top right). "Always" keeps a static box on an OLED - burn-in risk.',
        onChange: apply('tickerHoldSec') }),
      SD.stepper({ label: 'Spike alerts', values: [{ value: true, label: 'On' }, { value: false, label: 'Off' }], value: draft.tickerSpikes,
        onChange: apply('tickerSpikes') }),
      SD.stepper({ label: 'Show', values: [{ value: 'price', label: 'Buy + sell' }, { value: 'price-soc', label: '+ battery %' },
        { value: 'price-soc-solar', label: '+ battery % + solar' }, { value: 'all', label: 'Everything' }], value: draft.tickerFields,
        onChange: apply('tickerFields') }),
      U.h('div', { 'class': 'row-btns' }, [el.installBtn, el.testBtn, el.uninstallBtn]),
      el.daemonStatus
    ]);
  }

  function refreshDaemon() {
    if (!el.daemonStatus) { return; }
    SD.daemon.status(function (err, st) {
      var running = !err && st;
      el.installBtn.textContent = running ? 'Reinstall' : 'Install background service';
      el.testBtn.classList.toggle('hidden', !running);
      el.uninstallBtn.classList.toggle('hidden', !running);
      if (!running) {
        el.daemonStatus.textContent = window.PalmServiceBridge ? 'Background service not installed' : 'Background service only runs on the TV';
        return;
      }
      if (el.notifSwitch && st.ticker && !el.notifSwitch.isEditing()) {
        el.notifSwitch.setValues([{ value: false, label: 'Off' }, { value: true, label: 'On' }], !!st.ticker.enabled);
      }
      var p = st.price;
      el.daemonStatus.textContent = 'Running v' + st.version + (p ? '  \u00b7  last price ' + Math.round(p.buy) + 'c / ' + Math.round(p.sell) + 'c' : '') +
        (st.priceError ? '  \u00b7  ' + st.priceError : '');
    });
  }

  function build(root) {
    draft = U.extend({}, SD.settings);

    var snValues = draft.foxSn ? [{ value: draft.foxSn, label: draft.foxSn }] : [{ value: '', label: 'Press "Find inverters"' }];
    el.sn = SD.stepper({ label: 'Inverter', values: snValues, value: draft.foxSn, onChange: function (v) { draft.foxSn = v; } });
    var siteValues = draft.amberSiteId ? [{ value: draft.amberSiteId, label: draft.amberSiteId }] : [{ value: '', label: 'Press "Find sites"' }];
    el.site = SD.stepper({ label: 'Site', values: siteValues, value: draft.amberSiteId, onChange: function (v) { draft.amberSiteId = v; } });
    el.foxStatus = U.h('div', { 'class': 'status-line dim' });
    el.amberStatus = U.h('div', { 'class': 'status-line dim' });
    el.stats = U.h('div', { 'class': 'status-line dim' });

    var fox = section('FoxESS Cloud', [
      SD.textField({
        label: 'API key', value: draft.foxApiKey, secret: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        hint: 'foxesscloud.com → User Profile → API Management → Generate API key',
        onChange: function (v) { draft.foxApiKey = v; }
      }),
      SD.stepper({ label: 'Server', values: [{ value: 'global', label: 'Global / Australia' }, { value: 'us', label: 'United States' }],
        value: draft.foxServer, onChange: function (v) { draft.foxServer = v; } }),
      el.sn,
      U.h('div', { 'class': 'row-btns' }, [button('Find inverters', findInverters)]),
      el.foxStatus
    ]);

    var amber = section('Amber Electric (optional)', [
      SD.textField({
        label: 'API token', value: draft.amberToken, secret: true, placeholder: 'psk_...',
        hint: 'app.amber.com.au → Developers → Generate new token',
        onChange: function (v) { draft.amberToken = v; }
      }),
      el.site,
      SD.stepper({ label: 'Typical retail', values: SD.range(20, 50, 1, function (v) { return v + 'c/kWh'; }), value: draft.referenceCents,
        hint: 'Price bands compare against this and your last 4 weeks of Amber prices', onChange: function (v) { draft.referenceCents = v; } }),
      U.h('div', { 'class': 'row-btns' }, [button('Find sites', findSites)]),
      el.amberStatus
    ]);

    var display = section('Display', [
      SD.stepper({ label: 'Refresh every', values: SD.range(60, 300, 30, function (v) { return v + ' s'; }), value: draft.refreshSec,
        hint: 'FoxESS allows 1,440 calls per inverter per day', onChange: function (v) { draft.refreshSec = v; } }),
      SD.stepper({ label: 'Battery size', values: [{ value: 0, label: 'Auto-detect' }].concat(SD.range(5, 100, 0.5, function (v) { return v + ' kWh'; })),
        value: draft.batteryKwh, onChange: function (v) { draft.batteryKwh = v; } }),
      SD.stepper({ label: 'Max battery power', values: [{ value: 0, label: 'Auto (from inverter)' }].concat(SD.range(3, 30, 0.5, function (v) { return v + ' kW'; })),
        value: draft.maxPowerKw, hint: 'Upper limit for force charge / discharge', onChange: function (v) { draft.maxPowerKw = v; } }),
      SD.stepper({ label: 'Pixel shift', values: [{ value: true, label: 'On' }, { value: false, label: 'Off' }], value: draft.pixelShift,
        hint: 'Moves the screen slightly to protect OLED panels', onChange: function (v) { draft.pixelShift = v; } }),
      SD.stepper({ label: 'TV screensaver', values: [{ value: 1, label: 'TV default (~1 min)' }, { value: 3, label: 'After 3 min' },
        { value: 5, label: 'After 5 min' }, { value: 10, label: 'After 10 min' }, { value: 15, label: 'After 15 min' }, { value: 30, label: 'After 30 min' }],
        value: draft.tvScreensaverMin, hint: "Delays LG's screensaver while Solar Dash is open", onChange: function (v) { draft.tvScreensaverMin = v; } }),
      SD.stepper({ label: 'Dim when idle', values: [{ value: 0, label: 'Never' }, { value: 5, label: '5 min' }, { value: 10, label: '10 min' },
        { value: 15, label: '15 min' }, { value: 30, label: '30 min' }, { value: 60, label: '60 min' }], value: draft.dimMinutes,
        onChange: function (v) { draft.dimMinutes = v; } }),
      SD.stepper({ label: 'Demo data', values: [{ value: false, label: 'Off' }, { value: true, label: 'On' }], value: draft.demo,
        onChange: function (v) { draft.demo = v; draft.demoTouched = true; } }),
      el.stats
    ]);

    root.appendChild(U.h('div', { 'class': 'settings' }, [
      U.h('div', { 'class': 'settings-actions' }, [
        button('Save', save, 'btn-primary'),
        U.h('span', { 'class': 'dim', text: 'Tip: the LG ThinQ phone app can type into the TV keyboard.' })
      ]),
      U.h('div', { 'class': 'settings-cols' }, [
        U.h('div', { 'class': 'settings-col' }, [fox, amber]),
        U.h('div', { 'class': 'settings-col' }, [display]),
        U.h('div', { 'class': 'settings-col' }, [buildNotifications()])
      ])
    ]));
    renderStats();
  }

  function renderStats() {
    if (!el.stats) { return; }
    var c = SD.callCount || {};
    var mode = SD.isDemo() ? 'Demo data' : 'Live';
    var errs = [];
    for (var k in SD.state.errors) { if (SD.state.errors[k]) { errs.push(SD.state.errors[k]); } }
    el.stats.textContent = mode + '  ·  API calls today: FoxESS ' + (c.fox || 0) + ' / 1440, Amber ' + (c.amber || 0) +
      (errs.length ? '  ·  ' + errs[0] : '');
  }

  SD.views.settings = {
    title: 'Settings',
    build: build,
    onShow: function () { renderStats(); refreshDaemon(); },
    onUpdate: function (key) { if (key === 'errors' || key === 'live') { renderStats(); } }
  };
})();
