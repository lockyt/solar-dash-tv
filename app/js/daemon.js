/*
 * Client for the background daemon (rooted TVs): service/daemon.js listening on
 * http://127.0.0.1:8643. The daemon shows price notifications over other apps
 * and restores expired battery overrides while this app is closed.
 */
(function () {
  'use strict';
  var BASE = 'http://127.0.0.1:8643';
  var SERVICE_DIR = '/media/developer/apps/usr/palm/services/com.solardash.tv.service';
  var INIT = '/var/lib/webosbrew/init.d/solardash';

  function req(method, path, body, cb) {
    // The daemon only exists on a rooted TV; don't spam connection errors elsewhere.
    if (!window.PalmServiceBridge) { if (cb) { cb(new Error('Background service only runs on the TV')); } return; }
    var xhr = new XMLHttpRequest();
    xhr.open(method, BASE + path, true);
    xhr.timeout = 4000;
    if (body) { xhr.setRequestHeader('Content-Type', 'application/json'); }
    xhr.onload = function () {
      var res = null;
      try { res = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (cb) { cb(xhr.status === 200 ? null : new Error('HTTP ' + xhr.status), res); }
    };
    xhr.onerror = function () { if (cb) { cb(new Error('Background service not running')); } };
    xhr.ontimeout = xhr.onerror;
    xhr.send(body ? JSON.stringify(body) : null);
  }

  // Root shell via the Homebrew Channel's elevated service
  function rootExec(command, cb) {
    if (!window.PalmServiceBridge) { return cb(new Error('Only available on the TV')); }
    var b = new window.PalmServiceBridge();
    SD.daemon._bridge = b;
    b.onservicecallback = function (msg) {
      var r = {};
      try { r = JSON.parse(msg); } catch (e) { /* ignore */ }
      if (r.returnValue === false) { return cb(new Error(r.errorText || 'Root command failed - is the TV rooted?')); }
      cb(null, r.stdoutString || '');
    };
    b.call('luna://org.webosbrew.hbchannel.service/exec', JSON.stringify({ command: command }));
  }

  // On/off isn't part of this: it's held by the service and starts Off after every restart
  function tickerConfig() {
    var s = SD.settings;
    return {
      intervalMin: Number(s.tickerInterval) || 0,
      changeCents: Number(s.tickerChange) || 0, spikes: !!s.tickerSpikes, fields: s.tickerFields || 'price',
      holdSec: Number(s.tickerHoldSec) || 30
    };
  }

  SD.daemon = {
    status: function (cb) { req('GET', '/status', null, cb); },
    setNotifications: function (on, cb) { req('POST', '/notifications', { enabled: !!on }, cb); },
    test: function (opts, cb) { req('POST', '/test', opts || {}, cb); },

    pushConfig: function (cb) {
      if (SD.settings.demo) { return cb && cb(null); }
      var s = SD.settings;
      req('POST', '/config', {
        foxApiKey: s.foxApiKey, foxBaseUrl: SD.foxBaseUrl(), foxSn: s.foxSn,
        amberToken: s.amberToken, amberSiteId: s.amberSiteId, ticker: tickerConfig(), referenceCents: s.referenceCents
      }, cb);
    },

    pushOverride: function (o) {
      if (SD.isDemo()) { return; }
      req('POST', '/override', o ? {
        mode: o.mode, until: o.until, sn: SD.settings.foxSn, backup: o.backup
      } : {}, function () {});
    },

    // Copy the boot script into the Homebrew Channel's init.d and start it now.
    install: function (cb) {
      var cmd = 'mkdir -p /var/lib/webosbrew/init.d && cp ' + SERVICE_DIR + '/init/solardash.sh ' + INIT +
        ' && chmod 755 ' + INIT + ' && ' + INIT + ' && echo installed';
      rootExec(cmd, function (err) {
        if (err) { return cb(err); }
        // give node a moment to start, then send it our settings
        setTimeout(function () { SD.daemon.pushConfig(cb); }, 3000);
      });
    },

    uninstall: function (cb) {
      rootExec('rm -f ' + INIT + ' /tmp/solardash-daemon.token; wget -q -O /dev/null --post-data=quit http://127.0.0.1:8643/quit; echo removed', cb);
    }
  };
})();
