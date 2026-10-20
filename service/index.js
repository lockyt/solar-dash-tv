/*
 * webOS JS service entry point (luna://com.solardash.tv.service/...).
 * Thin wrapper: all logic lives in lib/proxy.js so the dev server can share it.
 */
'use strict';

var Service = require('webos-service');
var proxy = require('./lib/proxy');

var service = new Service('com.solardash.tv.service');

function bind(name, fn) {
  service.register(name, function (message) {
    fn(message.payload || {}, function (err, res) {
      if (err) {
        message.respond({ returnValue: false, errorText: String(err.message || err) });
      } else {
        message.respond(res);
      }
    });
  });
}

bind('foxess', proxy.foxess);
bind('amber', proxy.amber);

service.register('ping', function (message) {
  message.respond({ returnValue: true, version: '0.2.9', node: process.version });
});
