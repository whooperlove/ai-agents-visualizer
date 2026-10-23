/* Local, read-only session observer. */
'use strict';

const Http = require('node:http');
const Fs = require('node:fs');
const Path = require('node:path');
const Os = require('node:os');
const Zlib = require('node:zlib');
const I18n = require('./src/i18n');
const Model = require('./src/model');
const Supplement = require('./src/supplement');
const PUBLIC_ROOT = Path.join(__dirname, 'public');
const STATIC_FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
STATIC_FILES['/office-model.js'] = ['office-model.js', 'text/javascript; charset=utf-8'];
STATIC_FILES['/character-model.js'] = ['character-model.js', 'text/javascript; charset=utf-8'];
STATIC_FILES['/office-scene.js'] = ['office-scene.js', 'text/javascript; charset=utf-8'];
STATIC_FILES['/office-scene.css'] = ['office-scene.css', 'text/css; charset=utf-8'];
STATIC_FILES['/assets/office-characters.png'] = ['assets/office-characters.png', 'image/png'];
['i18n.js', 'locales/html.js', 'locales/app.js', 'locales/scene.js', 'locales/server.js'].forEach(function(file)
{
  STATIC_FILES['/' + file] = [file, 'text/javascript; charset=utf-8'];
});

// Supplement files placed here are loaded automatically. The folder follows the usual per-user config
// location (~/.config/<app>) under the observed home directory, so --home moves it along.
function defaultSupplementDir(home)
{
  return Path.join(home, '.config', 'ai-agents-visualizer', 'supplements');
}

function parseOptions(args)
{
  const options = { port: 4317, home: Os.homedir(), pollIntervalMs: 2500, supplements: [] };
  var customSupplement = false;
  var useSupplementDir = true;
  // The first option problem is reported after the loop so that a later --lang still decides its language.
  var failure = null;
  for (var index = 0; index < args.length; index++)
  {
    const arg = args[index];
    if (arg === '--no-supplement') { options.supplements = []; customSupplement = true; useSupplementDir = false; continue; }
    if (arg === '--help') { options.help = true; continue; }
    if (!['--port', '--home', '--poll-ms', '--supplement', '--lang'].includes(arg) || !args[index + 1])
    {
      failure = failure || function() { return I18n.t('cli.server.optionUnknown', { option: arg }); };
      continue;
    }
    const value = args[++index];
    if (arg === '--port') options.port = Number(value);
    if (arg === '--home') options.home = Path.resolve(value);
    if (arg === '--poll-ms') options.pollIntervalMs = Number(value);
    if (arg === '--supplement')
    {
      if (!customSupplement) options.supplements = [];
      customSupplement = true;
      options.supplements.push(Path.resolve(value));
    }
    if (arg === '--lang')
    {
      const locale = I18n.normalizeLocale(value);
      if (locale) I18n.setLocale(locale);
      else failure = failure || function() { return I18n.t('cli.server.langInvalid', { value: value }); };
    }
  }
  if (failure) throw new Error(failure());
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error(I18n.t('cli.server.portInvalid'));
  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 250) throw new Error(I18n.t('cli.server.pollMsInvalid'));
  options.supplementDir = useSupplementDir ? defaultSupplementDir(options.home) : null;
  return options;
}

// A supplement error is either a plain Node error (it has a code) or an error from the supplement
// validator, whose message already is message-token text for the browser to render.
function supplementErrorMessage(error)
{
  if (error.code) return I18n.token('msg.supplementReadError', { code: error.code });
  return limitLines(error.message, 1500);
}

// Keeps whole lines only: cutting through a message token would leave it unreadable.
function limitLines(text, limit)
{
  const lines = String(text).split('\n');
  var length = 0;
  var count = 0;
  while (count < lines.length && (count === 0 || length + lines[count].length + 1 <= limit))
  {
    length += lines[count].length + 1;
    count++;
  }
  return lines.slice(0, count).join('\n');
}

function sendText(response, status, text)
{
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function createObserverServer(options)
{
  const Sessions = require('./src/sources/sessions');
  const Bridge = require('./src/sources/bridge');
  const clients = new Set();
  const supplementDic = new Map();
  const supplementErrors = new Map();
  // Files found in options.supplementDir (when set); they come and go with the folder contents.
  const folderSupplements = new Set();
  const explicitSupplements = new Set(options.supplements || []);
  // Paths whose read results still count: a read that finishes after its file left the folder is dropped.
  const activeSupplements = new Set();
  var folderTimer = null;
  const collectors = [Sessions.createSessionCollector(options, scheduleRefresh), Bridge.createBridgeCollector(options, scheduleRefresh)];
  var version = 0;
  var pending = collectors.length;
  var timer = null;
  var stopped = false;
  var serialized = '';
  var cachedGzip = null;
  var current = { version: 0, generatedAt: new Date().toISOString(), nodes: [], edges: [], diagnostics: [], stats: { loading: true }, sourceStatus: [] };
  serialized = JSON.stringify(current);
  const server = Http.createServer(handleRequest);
  const heartbeat = setInterval(function()
  {
    clients.forEach(function(response) { response.write(': heartbeat\n\n'); });
  }, 15 * 1000);
  heartbeat.unref();
  const recencyTimer = setInterval(scheduleRefresh, 30 * 1000);
  recencyTimer.unref();

  function scheduleRefresh()
  {
    if (stopped || timer) return;
    timer = setTimeout(refresh, 500);
  }

  function refresh()
  {
    timer = null;
    if (stopped) return;
    const snapshots = collectors.map(function(collector) { return collector.snapshot(); });
    current = Model.buildGraph(snapshots, Array.from(supplementDic.values()), ++version);
    current.stats.loading = current.stats.loading || pending > 0;
    supplementErrors.forEach(function(message, path)
    {
      // Both texts are message tokens: the browser renders them in the viewer's language.
      const detail = supplementDic.has(path) ? I18n.token('msg.supplementKeptLastValid') : I18n.token('msg.supplementNotApplied');
      current.diagnostics.push({ level: 'error', code: 'supplement-invalid', message: message, source: { kind: 'supplement', path: path, detail: detail } });
    });
    serialized = JSON.stringify(current);
    cachedGzip = null;
    clients.forEach(function(response)
    {
      if (response.writableLength > 64 * 1024) { response.destroy(); clients.delete(response); return; }
      response.write('event: update\ndata: ' + JSON.stringify({ version: version }) + '\n\n');
    });
  }

  function readSupplement(path)
  {
    Supplement.loadSupplement(path, function(error, document)
    {
      if (stopped || !activeSupplements.has(path)) return;
      if (error)
      {
        if (error.code === 'ENOENT') supplementDic.delete(path);
        // A file that was removed from the supplement folder is a deliberate change, not a problem.
        if (error.code === 'ENOENT' && folderSupplements.has(path)) supplementErrors.delete(path);
        else supplementErrors.set(path, supplementErrorMessage(error));
      }
      else
      {
        supplementDic.set(path, { path: path, document: document });
        supplementErrors.delete(path);
      }
      scheduleRefresh();
    });
  }

  function watchSupplement(path)
  {
    activeSupplements.add(path);
    readSupplement(path);
    Fs.watchFile(path, { interval: options.pollIntervalMs, persistent: false }, function(currentStat, previous)
    {
      if (currentStat.mtimeMs !== previous.mtimeMs || currentStat.size !== previous.size || currentStat.ino !== previous.ino) readSupplement(path);
    });
  }

  function scanSupplementDir()
  {
    const directory = options.supplementDir;
    if (stopped || typeof directory !== 'string') return;
    Fs.readdir(directory, function(error, names)
    {
      if (stopped) return;
      const found = new Set();
      if (error)
      {
        // A missing folder just means there is nothing to load.
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') supplementErrors.set(directory, supplementErrorMessage(error));
      }
      else
      {
        supplementErrors.delete(directory);
        names.filter(function(name) { return /\.json$/i.test(name) && name.charAt(0) !== '.'; }).sort().forEach(function(name)
        {
          const path = Path.join(directory, name);
          if (!explicitSupplements.has(path)) found.add(path);
        });
      }
      found.forEach(function(path)
      {
        if (folderSupplements.has(path)) return;
        folderSupplements.add(path);
        watchSupplement(path);
      });
      Array.from(folderSupplements).forEach(function(path)
      {
        if (found.has(path)) return;
        folderSupplements.delete(path);
        activeSupplements.delete(path);
        Fs.unwatchFile(path);
        supplementDic.delete(path);
        supplementErrors.delete(path);
        scheduleRefresh();
      });
    });
  }

  function handleRequest(request, response)
  {
    const address = server.address();
    const allowedHosts = ['127.0.0.1:' + address.port, 'localhost:' + address.port];
    if (!allowedHosts.includes(request.headers.host))
    {
      sendText(response, 403, I18n.t('cli.http.hostNotAllowed')); return;
    }
    if (request.headers.origin && !allowedHosts.some(function(host) { return request.headers.origin === 'http://' + host; }))
    {
      sendText(response, 403, I18n.t('cli.http.originNotAllowed')); return;
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'");
    if (request.method !== 'GET' && request.method !== 'HEAD')
    {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    const route = request.url.split('?')[0];
    if (route === '/api/events')
    {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (request.method === 'HEAD') { response.end(); return; }
      response.write('event: update\ndata: ' + JSON.stringify({ version: version }) + '\n\n');
      clients.add(response);
      request.on('close', function() { clients.delete(response); });
      return;
    }
    if (route === '/api/snapshot')
    {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Vary', 'Accept-Encoding');
      if (request.method === 'HEAD') { response.end(); return; }
      if (/\bgzip\b/.test(request.headers['accept-encoding'] || ''))
      {
        response.setHeader('Content-Encoding', 'gzip');
        if (cachedGzip) { response.end(cachedGzip); return; }
        const compressedVersion = version;
        Zlib.gzip(serialized, function(error, buffer)
        {
          if (error) { response.destroy(); return; }
          if (version === compressedVersion) cachedGzip = buffer;
          response.end(buffer);
        });
      }
      else response.end(serialized);
      return;
    }
    if (route === '/api/health')
    {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(request.method === 'HEAD' ? '' : JSON.stringify({ app: 'ai-agents-visualizer', processId: process.pid, ok: true, version: version, loading: current.stats.loading, host: '127.0.0.1', readOnly: true }));
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(STATIC_FILES, route)) { sendText(response, 404, I18n.t('cli.http.notFound')); return; }
    const entry = STATIC_FILES[route];
    Fs.readFile(Path.join(PUBLIC_ROOT, entry[0]), function(error, data)
    {
      if (error) { sendText(response, 503, I18n.t('cli.http.notReady')); return; }
      response.writeHead(200, { 'Content-Type': entry[1] });
      response.end(request.method === 'HEAD' ? '' : data);
    });
  }

  function start(callback)
  {
    server.listen(options.port, '127.0.0.1', function()
    {
      (options.supplements || []).forEach(watchSupplement);
      scanSupplementDir();
      folderTimer = setInterval(scanSupplementDir, options.pollIntervalMs);
      folderTimer.unref();
      collectors.forEach(function(collector)
      {
        collector.start(function() { pending--; scheduleRefresh(); });
      });
      if (callback) callback(null, server.address());
    });
  }

  function stop(callback)
  {
    stopped = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    clearInterval(recencyTimer);
    collectors.forEach(function(collector) { collector.stop(); });
    clearInterval(folderTimer);
    (options.supplements || []).forEach(function(path) { Fs.unwatchFile(path); });
    folderSupplements.forEach(function(path) { Fs.unwatchFile(path); });
    clients.forEach(function(response) { response.end(); });
    server.close(callback);
    server.closeIdleConnections();
  }
  return { start: start, stop: stop, server: server, snapshot: function() { return current; } };
}

if (require.main === module)
{
  try
  {
    const options = parseOptions(process.argv.slice(2));
    if (options.help)
    {
      console.log(I18n.t('cli.server.usage'));
    }
    else
    {
      const app = createObserverServer(options);
      app.server.on('error', function(error) { console.error(I18n.t('cli.server.startFailed', { code: error.code || error.message })); app.stop(); process.exitCode = 1; });
      app.start(function(error, address) { console.log(I18n.t('cli.server.listening', { url: 'http://127.0.0.1:' + address.port })); });
      ['SIGINT', 'SIGTERM'].forEach(function(signal) { process.once(signal, function() { app.stop(function() { process.exitCode = 0; }); }); });
    }
  }
  catch (error)
  {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseOptions: parseOptions, createObserverServer: createObserverServer, defaultSupplementDir: defaultSupplementDir };
