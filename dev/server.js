/*
 * Local dev server: serves app/ and exposes the same proxy the TV service uses.
 *   node dev/server.js        ->  http://localhost:8642
 * Open http://localhost:8642/?demo=1 to force demo data.
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var proxy = require('../service/lib/proxy');

var PORT = Number(process.env.PORT) || 8642;
var ROOT = path.join(__dirname, '..', 'app');
var TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

http.createServer(function (req, res) {
  var url = req.url.split('?')[0];

  var api = /^\/api\/(foxess|amber)$/.exec(url);
  if (api && req.method === 'POST') {
    var body = '';
    req.on('data', function (c) { body += c; if (body.length > 1e6) { req.destroy(); } });
    req.on('end', function () {
      var params;
      try { params = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, 'application/json', '{"returnValue":false,"errorText":"Bad JSON"}'); }
      proxy[api[1]](params, function (err, out) {
        if (err) { out = { returnValue: false, errorText: String(err.message || err) }; }
        send(res, 200, 'application/json', JSON.stringify(out));
      });
    });
    return;
  }

  var file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : decodeURIComponent(url)));
  if (file.indexOf(ROOT) !== 0) { return send(res, 403, 'text/plain', 'Forbidden'); }
  fs.readFile(file, function (err, data) {
    if (err) { return send(res, 404, 'text/plain', 'Not found'); }
    send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', data);
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('Solar Dash dev server on http://localhost:' + PORT);
});
