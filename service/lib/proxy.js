/*
 * Shared request proxy for FoxESS Cloud and Amber Electric.
 *
 * Used by the webOS JS service on the TV and by dev/server.js on a computer.
 * Written in ES5 with no dependencies: webOS 3.x ships Node 0.12.
 *
 * The browser can't call FoxESS Cloud directly (no CORS headers), so every
 * request goes through here. Credentials are passed in by the caller on each
 * request and are never stored by this module.
 */
'use strict';

var https = require('https');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var urlLib = require('url');
var qs = require('querystring');

var FOXESS_HOSTS = {
  'www.foxesscloud.com': true,
  'portal.foxesscloud.us': true
};
var AMBER_HOST = 'api.amber.com.au';
var TIMEOUT_MS = 20000;
var USER_AGENT = 'Mozilla/5.0 (SolarDash webOS) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';

// Old webOS firmware ships an outdated CA bundle, so we carry the roots we need.
var CA = null;
try {
  var pem = fs.readFileSync(path.join(__dirname, '..', 'certs', 'ca.pem'), 'utf8');
  CA = pem.split(/(?=-----BEGIN CERTIFICATE-----)/).filter(function (c) {
    return c.indexOf('-----BEGIN CERTIFICATE-----') === 0;
  });
} catch (e) {
  CA = null;
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/*
 * FoxESS signature. Their reference code builds the string with a Python raw
 * f-string, so the separators are the four literal characters \ r \ n, not CR LF.
 */
function foxessSignature(apiPath, token, timestamp) {
  return md5(apiPath + '\\r\\n' + token + '\\r\\n' + timestamp);
}

function request(opts, cb) {
  var done = false;
  function finish(err, res) {
    if (done) { return; }
    done = true;
    cb(err, res);
  }

  var reqOpts = {
    host: opts.host,
    port: 443,
    path: opts.path,
    method: opts.method,
    headers: opts.headers
  };
  if (CA && CA.length) { reqOpts.ca = CA; }

  var req = https.request(reqOpts, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var text = Buffer.concat(chunks).toString('utf8');
      var data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (e) { data = text; }
      }
      finish(null, { status: res.statusCode, data: data });
    });
  });
  req.setTimeout(TIMEOUT_MS, function () {
    req.abort();
    finish(new Error('Request timed out'));
  });
  req.on('error', function (err) { finish(err); });
  if (opts.body) { req.write(opts.body); }
  req.end();
}

function fail(cb, message) {
  cb(null, { returnValue: false, errorText: message });
}

/*
 * params: { apiKey, baseUrl, method: 'GET'|'POST', path: '/op/...', query, body }
 */
function foxess(params, cb) {
  params = params || {};
  var apiKey = String(params.apiKey || '').trim();
  var apiPath = String(params.path || '');
  var method = String(params.method || 'POST').toUpperCase();
  var base = urlLib.parse(params.baseUrl || 'https://www.foxesscloud.com');

  if (!apiKey) { return fail(cb, 'Missing FoxESS API key'); }
  if (!FOXESS_HOSTS[base.hostname]) { return fail(cb, 'Unsupported FoxESS server: ' + base.hostname); }
  if (!/^\/op\/v\d\/[A-Za-z0-9\/]+$/.test(apiPath)) { return fail(cb, 'Invalid FoxESS path'); }
  if (method !== 'GET' && method !== 'POST') { return fail(cb, 'Invalid method'); }

  var timestamp = String(Date.now());
  var headers = {
    'Content-Type': 'application/json',
    'token': apiKey,
    'timestamp': timestamp,
    'signature': foxessSignature(apiPath, apiKey, timestamp),
    'lang': 'en',
    'User-Agent': USER_AGENT
  };

  var fullPath = apiPath;
  var body = null;
  if (method === 'GET') {
    if (params.query) { fullPath += '?' + qs.stringify(params.query); }
  } else {
    body = JSON.stringify(params.body || {});
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  request({ host: base.hostname, path: fullPath, method: method, headers: headers, body: body }, function (err, res) {
    if (err) { return fail(cb, 'FoxESS request failed: ' + err.message); }
    if (res.status === 401) { return fail(cb, 'FoxESS rejected the API key (401)'); }
    if (res.status >= 400) { return fail(cb, 'FoxESS HTTP ' + res.status); }
    var data = res.data || {};
    if (typeof data !== 'object') { return fail(cb, 'Unexpected FoxESS response'); }
    if (data.errno !== 0) {
      var msg = data.msg || ('error ' + data.errno);
      if (data.errno === 40400) { msg = 'FoxESS rate limit hit - slowing down'; }
      return cb(null, { returnValue: false, errno: data.errno, errorText: 'FoxESS: ' + msg });
    }
    cb(null, { returnValue: true, result: data.result });
  });
}

/*
 * params: { token, path: '/sites' | '/sites/{id}/prices/current' | ..., query }
 */
function amber(params, cb) {
  params = params || {};
  var token = String(params.token || '').trim();
  var apiPath = String(params.path || '');

  if (!token) { return fail(cb, 'Missing Amber API token'); }
  if (!/^\/sites(\/[A-Za-z0-9]+(\/(prices|prices\/current|usage))?)?$/.test(apiPath)) {
    return fail(cb, 'Invalid Amber path');
  }

  var fullPath = '/v1' + apiPath;
  if (params.query) { fullPath += '?' + qs.stringify(params.query); }

  request({
    host: AMBER_HOST,
    path: fullPath,
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': USER_AGENT }
  }, function (err, res) {
    if (err) { return fail(cb, 'Amber request failed: ' + err.message); }
    if (res.status === 401 || res.status === 403) { return fail(cb, 'Amber rejected the API token'); }
    if (res.status === 429) { return fail(cb, 'Amber rate limit hit - slowing down'); }
    if (res.status >= 400) { return fail(cb, 'Amber HTTP ' + res.status); }
    cb(null, { returnValue: true, result: res.data });
  });
}

module.exports = {
  foxess: foxess,
  amber: amber,
  foxessSignature: foxessSignature
};
