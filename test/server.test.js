'use strict';
const Test = require('node:test');
const Assert = require('node:assert/strict');
const ChildProcess = require('node:child_process');
const Fs = require('node:fs');
const Net = require('node:net');
const Os = require('node:os');
const Path = require('node:path');
const Http = require('node:http');
const Server = require('../server');
const Supplement = require('../src/supplement');
const I18n = require('../src/i18n');
const Helpers = require('./helpers/i18n');

const SERVER_PATH = Path.join(__dirname, '..', 'server.js');
// Renders message tokens the way the browser does; loaded after ../server so it is a separate catalog instance.
const BrowserI18n = Helpers.loadNodeI18n();

// Runs the in-process code under one process locale and restores the previous one afterwards.
function useLocale(t, locale)
{
  const previous = I18n.getLocale();
  I18n.setLocale(locale);
  t.after(function() { I18n.setLocale(previous); });
}

function processEnv(overrides)
{
  return Object.assign({}, process.env, { WAS_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: '' }, overrides);
}

function runServer(args, env)
{
  return ChildProcess.spawnSync(process.execPath, [SERVER_PATH].concat(args), { env: processEnv(env), encoding: 'utf8', timeout: 15000 });
}

function tempHome(t)
{
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'visualizer-server-'));
  t.after(function() { Fs.rmSync(home, { recursive: true, force: true }); });
  return home;
}

function get(port, options, callback)
{
  const request = Http.request({ host: '127.0.0.1', port: port, path: options.path || '/', method: options.method || 'GET', headers: options.headers || {} }, function(response)
  {
    var body = '';
    response.setEncoding('utf8');
    response.on('data', function(chunk) { body += chunk; });
    response.on('end', function() { callback(null, response, body); });
  });
  request.on('error', callback);
  request.end();
}

// Starts server.js as a child process, waits for its "listening" line, then stops it.
function startProcess(t, args, env, callback)
{
  const child = ChildProcess.spawn(process.execPath, [SERVER_PATH].concat(args), { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  var output = '';
  var finished = false;
  const deadline = setTimeout(function() { finish(new Error('server did not start: ' + output)); }, 10000);
  function finish(error, line)
  {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    child.kill('SIGTERM');
    callback(error, line);
  }
  t.after(function() { clearTimeout(deadline); child.kill('SIGTERM'); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function(chunk)
  {
    output += chunk;
    const match = /^.*http:\/\/127\.0\.0\.1:\d+/m.exec(output);
    if (match) finish(null, match[0]);
  });
  child.on('error', finish);
}

Test('local HTTP stays read-only and guarded (host, origin, paths); supplement changes show up live', function(t, done)
{
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'visualizer-server-'));
  const supplementPath = Path.join(home, 'supplement.json');
  function document(name) { return { schemaVersion: 1, sessions: [{ id: 'codex:fixture', name: name }], relations: [] }; }
  Fs.writeFileSync(supplementPath, JSON.stringify(document('first')));
  const app = Server.createObserverServer({ home: home, port: 0, pollIntervalMs: 50, supplements: [supplementPath] });
  var events = null;
  t.after(function(context, next)
  {
    if (events) events.destroy();
    app.stop(function() { Fs.rmSync(home, { recursive: true, force: true }); next(); });
  });
  app.start(function(error, address)
  {
    Assert.ifError(error);
    const javascript = /^text\/javascript/;
    const cases = [
      { path: '/api/health', expected: 200 },
      { path: '/character-model.js', expected: 200 },
      { path: '/i18n.js', expected: 200, type: javascript },
      { path: '/locales/html.js', expected: 200, type: javascript },
      { path: '/locales/app.js', expected: 200, type: javascript },
      { path: '/locales/scene.js', expected: 200, type: javascript },
      { path: '/locales/server.js', expected: 200, type: javascript },
      { path: '/locales/cli.js', expected: 404 },
      { path: '/locales/', expected: 404 },
      { path: '/spatial-model.js', expected: 404 },
      { path: '/spatial-scene.js', expected: 404 },
      { path: '/spatial-scene.css', expected: 404 },
      { path: '/api/snapshot', method: 'POST', expected: 405 },
      { path: '/api/snapshot', headers: { Host: 'evil.example' }, expected: 403 },
      { path: '/api/snapshot', headers: { Origin: 'https://evil.example' }, expected: 403 },
      { path: '/../../etc/passwd', expected: 404 }
    ];
    function nextCase()
    {
      const testCase = cases.shift();
      if (!testCase) return watchUpdates();
      const request = Http.request({ host: '127.0.0.1', port: address.port, path: testCase.path, method: testCase.method || 'GET', headers: testCase.headers || {} }, function(response)
      {
        response.resume();
        Assert.equal(response.statusCode, testCase.expected, testCase.path);
        if (testCase.type) Assert.match(response.headers['content-type'], testCase.type, testCase.path);
        response.on('end', nextCase);
      });
      request.on('error', done);
      request.end();
    }
    function watchUpdates()
    {
      var stage = 0;
      const deadline = setTimeout(function() { done(new Error('SSE live update timeout')); }, 6000);
      t.after(function() { clearTimeout(deadline); });
      events = Http.get({ host: '127.0.0.1', port: address.port, path: '/api/events' }, function(response)
      {
        response.on('data', function()
        {
          const snapshot = app.snapshot();
          const node = snapshot.nodes.find(function(item) { return item.id === 'codex:fixture'; });
          const invalid = snapshot.diagnostics.find(function(item) { return item.code === 'supplement-invalid'; });
          if (stage === 0 && node && node.name === 'first')
          {
            stage = 1;
            Fs.writeFileSync(supplementPath, JSON.stringify(document('changed')));
          }
          else if (stage === 1 && node && node.name === 'changed')
          {
            stage = 2;
            Fs.writeFileSync(supplementPath, '{broken');
          }
          else if (stage === 2 && invalid)
          {
            Assert.equal(node.name, 'changed');
            // The browser renders these texts: the server only sends message tokens, never translated text.
            Assert.equal(invalid.source.detail, I18n.token('msg.supplementKeptLastValid'));
            Assert.equal(BrowserI18n.resolve(invalid.source.detail, 'ko'), '마지막 유효본 유지 중');
            Assert.match(invalid.message, /⟦msg\./);
            ['ko', 'en'].forEach(function(locale)
            {
              Assert.ok(!/[⟦⟧]/.test(BrowserI18n.resolve(invalid.message, locale)), 'unresolved token in ' + locale);
              Assert.ok(!/[⟦⟧]/.test(BrowserI18n.resolve(invalid.source.detail, locale)), 'unresolved token in ' + locale);
            });
            stage = 3;
            Fs.unlinkSync(supplementPath);
          }
          else if (stage === 3 && !node)
          {
            Assert.equal(invalid.message, I18n.token('msg.supplementReadError', { code: 'ENOENT' }));
            Assert.equal(invalid.source.detail, I18n.token('msg.supplementNotApplied'));
            Assert.equal(BrowserI18n.resolve(invalid.source.detail, 'ko'), '적용되지 않음');
            stage = 4;
            clearTimeout(deadline);
            done();
          }
        });
      });
      events.on('error', done);
    }
    nextCase();
  });
});

Test('supplement problems reach the browser as whole message tokens, bounded in size', function(t, done)
{
  const original = Supplement.loadSupplement;
  t.after(function() { Supplement.loadSupplement = original; });
  const lines = [];
  for (var number = 0; number < 300; number++) lines.push(I18n.token('msg.supplementLine', { number: number, field: 'a b&c' }));
  Supplement.loadSupplement = function(path, callback)
  {
    if (path.endsWith('many.json')) return callback(new Error(lines.join('\n')));
    callback(Object.assign(new Error('permission denied, open ' + path), { code: 'EACCES' }));
  };
  const home = tempHome(t);
  const app = Server.createObserverServer({ home: home, port: 0, pollIntervalMs: 250, supplements: [Path.join(home, 'many.json'), Path.join(home, 'denied.json')] });
  t.after(function(context, next) { app.stop(next); });
  app.start(function(error)
  {
    Assert.ifError(error);
    const started = Date.now();
    const timer = setInterval(function()
    {
      const found = app.snapshot().diagnostics.filter(function(item) { return item.code === 'supplement-invalid'; });
      if (found.length < 2)
      {
        if (Date.now() - started > 5000) { clearInterval(timer); done(new Error('supplement diagnostics never appeared')); }
        return;
      }
      clearInterval(timer);
      const many = found.find(function(item) { return item.source.path.endsWith('many.json'); });
      const denied = found.find(function(item) { return item.source.path.endsWith('denied.json'); });
      const kept = many.message.split('\n');
      Assert.ok(kept.length >= 1 && kept.length < lines.length, 'message is cut at a line boundary');
      Assert.ok(many.message.length <= 1500);
      Assert.deepEqual(kept, lines.slice(0, kept.length), 'only whole tokens are kept');
      Assert.equal(many.source.detail, I18n.token('msg.supplementNotApplied'));
      Assert.equal(denied.message, I18n.token('msg.supplementReadError', { code: 'EACCES' }));
      Assert.ok(!denied.message.includes('permission denied'), 'a Node error message is not forwarded');
      done();
    }, 20);
  });
});

Test('HTTP error bodies are plain text in the process locale', function(t, done)
{
  const home = tempHome(t);
  const app = Server.createObserverServer({ home: home, port: 0, pollIntervalMs: 250, supplements: [] });
  t.after(function(context, next) { app.stop(next); });
  const originalReadFile = Fs.readFile;
  t.after(function() { Fs.readFile = originalReadFile; });
  useLocale(t, I18n.getLocale());
  app.start(function(error, address)
  {
    Assert.ifError(error);
    const cases = [
      { locale: 'ko', status: 403, headers: { Host: 'evil.example' }, body: '허용하지 않는 호스트' },
      { locale: 'en', status: 403, headers: { Host: 'evil.example' }, body: 'Host not allowed' },
      { locale: 'ko', status: 403, headers: { Origin: 'https://evil.example' }, body: '허용하지 않는 출처' },
      { locale: 'en', status: 403, headers: { Origin: 'https://evil.example' }, body: 'Origin not allowed' },
      { locale: 'ko', status: 404, path: '/missing', body: '찾을 수 없음' },
      { locale: 'en', status: 404, path: '/missing', body: 'Not found' },
      { locale: 'ko', status: 503, path: '/', unreadable: true, body: '화면 준비 중' },
      { locale: 'en', status: 503, path: '/', unreadable: true, body: 'Preparing the page' }
    ];
    function nextCase()
    {
      const testCase = cases.shift();
      if (!testCase) return done();
      I18n.setLocale(testCase.locale);
      Fs.readFile = testCase.unreadable ? function(path, callback)
      {
        if (String(path).endsWith('index.html')) return callback(new Error('unavailable'));
        return originalReadFile.apply(Fs, arguments);
      } : originalReadFile;
      get(address.port, { path: testCase.path || '/api/snapshot', headers: testCase.headers }, function(requestError, response, body)
      {
        Fs.readFile = originalReadFile;
        Assert.ifError(requestError);
        Assert.equal(response.statusCode, testCase.status);
        Assert.equal(body, testCase.body);
        Assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        nextCase();
      });
    }
    nextCase();
  });
});

Test('parseOptions reports option errors in the process locale', function(t)
{
  useLocale(t, 'ko');
  Assert.throws(function() { Server.parseOptions(['--port', '70000']); }, /port는 0~65535 정수여야 합니다\./);
  Assert.throws(function() { Server.parseOptions(['--poll-ms', '10']); }, /poll-ms는 250 이상의 정수여야 합니다\./);
  Assert.throws(function() { Server.parseOptions(['--bogus']); }, /알 수 없거나 값이 없는 옵션: --bogus/);
  Assert.throws(function() { Server.parseOptions(['--port']); }, /알 수 없거나 값이 없는 옵션: --port/);
  Assert.throws(function() { Server.parseOptions(['--lang', 'fr']); }, /--lang은 en 또는 ko여야 합니다: fr/);
  I18n.setLocale('en');
  Assert.throws(function() { Server.parseOptions(['--port', '70000']); }, /port must be an integer from 0 to 65535\./);
  Assert.throws(function() { Server.parseOptions(['--poll-ms', '10']); }, /poll-ms must be an integer of 250 or more\./);
  Assert.throws(function() { Server.parseOptions(['--bogus']); }, /Unknown option or missing value: --bogus/);
  Assert.throws(function() { Server.parseOptions(['--port']); }, /Unknown option or missing value: --port/);
  Assert.throws(function() { Server.parseOptions(['--lang', 'fr']); }, /--lang must be en or ko: fr/);
});

Test('--lang switches the process locale, whatever its position, and keeps the other options', function(t)
{
  useLocale(t, 'en');
  const options = Server.parseOptions(['--lang', 'ko', '--port', '4400']);
  Assert.equal(I18n.getLocale(), 'ko');
  Assert.equal(options.port, 4400);
  Server.parseOptions(['--poll-ms', '500', '--lang', 'en']);
  Assert.equal(I18n.getLocale(), 'en');
  Server.parseOptions(['--lang', 'ko_KR']);
  Assert.equal(I18n.getLocale(), 'ko', 'a region suffix is accepted like in WAS_LANG');
  I18n.setLocale('en');
  Assert.throws(function() { Server.parseOptions(['--lang', 'fr']); }, /--lang must be en or ko: fr/);
  Assert.equal(I18n.getLocale(), 'en', 'an invalid value leaves the locale alone');
  Assert.throws(function() { Server.parseOptions(['--bogus', '--lang', 'ko']); }, /알 수 없거나 값이 없는 옵션: --bogus/, 'a later --lang decides the language of an earlier option error');
  Assert.equal(Server.parseOptions(['--help']).help, true);
});

Test('--help prints the usage in the process locale and --lang overrides it', function()
{
  const english = runServer(['--help'], { WAS_LANG: 'en' });
  Assert.equal(english.status, 0, english.stderr);
  Assert.match(english.stdout, /^node server\.js \[--port 4317\] \[--supplement \/absolute\/path\.json\] \[--no-supplement\] \[--home \/home\/to\/observe\] \[--poll-ms 2500\] \[--lang en\|ko\]\n$/);
  const korean = runServer(['--help'], { WAS_LANG: 'ko' });
  Assert.equal(korean.status, 0, korean.stderr);
  Assert.match(korean.stdout, /^node server\.js \[--port 4317\] \[--supplement \/절대\/경로\.json\] \[--no-supplement\] \[--home \/관찰할\/home\] \[--poll-ms 2500\] \[--lang en\|ko\]\n$/);
  Assert.match(runServer(['--help', '--lang', 'ko'], { WAS_LANG: 'en' }).stdout, /\/절대\/경로\.json/);
  Assert.match(runServer(['--lang', 'en', '--help'], { WAS_LANG: 'ko' }).stdout, /\/absolute\/path\.json/);
});

Test('the process locale comes from WAS_LANG, LC_ALL, LC_MESSAGES, LANG in that order, else English', function()
{
  function usageLanguage(env)
  {
    return /절대/.test(runServer(['--help'], env).stdout) ? 'ko' : 'en';
  }
  Assert.equal(usageLanguage({ LANG: 'ko_KR.UTF-8' }), 'ko');
  Assert.equal(usageLanguage({ LANG: 'ko_KR.UTF-8', LC_ALL: 'en_US.UTF-8' }), 'en');
  Assert.equal(usageLanguage({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'ko_KR.UTF-8' }), 'ko');
  Assert.equal(usageLanguage({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'ko_KR.UTF-8', WAS_LANG: 'en' }), 'en');
  Assert.equal(usageLanguage({ LC_ALL: 'C', LANG: 'ko_KR.UTF-8' }), 'ko', 'an unsupported value falls through to the next variable');
  Assert.equal(usageLanguage({ LANG: 'fr_FR.UTF-8' }), 'en');
  Assert.equal(usageLanguage({}), 'en');
});

Test('an invalid --lang or other bad option exits with status 1 and a localized message on stderr', function()
{
  const english = runServer(['--lang', 'fr'], { WAS_LANG: 'en' });
  Assert.equal(english.status, 1);
  Assert.equal(english.stdout, '');
  Assert.equal(english.stderr.trim(), '--lang must be en or ko: fr');
  const korean = runServer(['--lang', 'fr'], { WAS_LANG: 'ko' });
  Assert.equal(korean.status, 1);
  Assert.equal(korean.stderr.trim(), '--lang은 en 또는 ko여야 합니다: fr');
  Assert.equal(runServer(['--port', 'abc'], { WAS_LANG: 'en' }).stderr.trim(), 'port must be an integer from 0 to 65535.');
  Assert.equal(runServer(['--port', 'abc', '--lang', 'ko'], { WAS_LANG: 'en' }).stderr.trim(), 'port는 0~65535 정수여야 합니다.');
  Assert.equal(runServer(['--poll-ms', '1'], { WAS_LANG: 'ko' }).stderr.trim(), 'poll-ms는 250 이상의 정수여야 합니다.');
  Assert.equal(runServer(['--nope'], { WAS_LANG: 'en' }).stderr.trim(), 'Unknown option or missing value: --nope');
});

Test('a busy port fails startup with a localized message and exit status 1', function(t, done)
{
  const home = tempHome(t);
  const blocker = Net.createServer();
  t.after(function() { blocker.close(); });
  blocker.listen(0, '127.0.0.1', function()
  {
    const port = String(blocker.address().port);
    const english = runServer(['--port', port, '--home', home], { WAS_LANG: 'en' });
    Assert.equal(english.status, 1, english.stdout);
    Assert.equal(english.stderr.trim(), 'Server failed to start: EADDRINUSE');
    const korean = runServer(['--port', port, '--home', home, '--lang', 'ko'], { WAS_LANG: 'en' });
    Assert.equal(korean.status, 1, korean.stdout);
    Assert.equal(korean.stderr.trim(), '서버 시작 실패: EADDRINUSE');
    done();
  });
});

Test('the startup line follows the process locale and --lang', function(t, done)
{
  const home = tempHome(t);
  startProcess(t, ['--port', '0', '--home', home], { WAS_LANG: 'en' }, function(englishError, englishLine)
  {
    Assert.ifError(englishError);
    Assert.match(englishLine, /^AI Agents Visualizer \(read-only\): http:\/\/127\.0\.0\.1:\d+$/);
    startProcess(t, ['--port', '0', '--home', home], { WAS_LANG: 'ko' }, function(koreanError, koreanLine)
    {
      Assert.ifError(koreanError);
      Assert.match(koreanLine, /^AI Agents Visualizer \(읽기 전용\): http:\/\/127\.0\.0\.1:\d+$/);
      startProcess(t, ['--port', '0', '--home', home, '--lang', 'en'], { WAS_LANG: 'ko' }, function(overrideError, overrideLine)
      {
        Assert.ifError(overrideError);
        Assert.match(overrideLine, /^AI Agents Visualizer \(read-only\): /);
        done();
      });
    });
  });
});

Test('the supplement folder defaults to <home>/.config/ai-agents-visualizer/supplements and --no-supplement turns it off', function()
{
  const home = Path.join(Os.tmpdir(), 'a-home');
  const folder = Path.join(home, '.config', 'ai-agents-visualizer', 'supplements');
  Assert.equal(Server.defaultSupplementDir(home), folder);
  Assert.equal(Server.parseOptions(['--home', home]).supplementDir, folder);
  Assert.deepEqual(Server.parseOptions(['--home', home]).supplements, []);
  const withFile = Server.parseOptions(['--home', home, '--supplement', '/tmp/extra.json']);
  Assert.equal(withFile.supplementDir, folder, 'an explicit file adds to the folder instead of replacing it');
  Assert.deepEqual(withFile.supplements, [Path.resolve('/tmp/extra.json')]);
  const off = Server.parseOptions(['--home', home, '--no-supplement']);
  Assert.equal(off.supplementDir, null);
  Assert.deepEqual(off.supplements, []);
  const offThenFile = Server.parseOptions(['--home', home, '--no-supplement', '--supplement', '/tmp/extra.json']);
  Assert.equal(offThenFile.supplementDir, null);
  Assert.deepEqual(offThenFile.supplements, [Path.resolve('/tmp/extra.json')]);
});

async function waitFor(check, message)
{
  const started = Date.now();
  while (!check())
  {
    if (Date.now() - started > 5000) throw new Error('timed out waiting for ' + message);
    await new Promise(function(resolve) { setTimeout(resolve, 25); });
  }
}

Test('supplement folder files are loaded, followed, removed and reported one by one', async function(t)
{
  const home = tempHome(t);
  const folder = Server.defaultSupplementDir(home);
  function document(id, name) { return JSON.stringify({ schemaVersion: 1, sessions: [{ id: id, name: name }], relations: [] }); }
  const app = Server.createObserverServer({ home: home, port: 0, pollIntervalMs: 50, supplements: [], supplementDir: folder });
  t.after(function() { return new Promise(function(resolve) { app.stop(resolve); }); });
  await new Promise(function(resolve, reject) { app.start(function(error) { return error ? reject(error) : resolve(); }); });
  function ids() { return app.snapshot().nodes.map(function(node) { return node.id; }); }
  function nameOf(id) { const found = app.snapshot().nodes.find(function(node) { return node.id === id; }); return found && found.name; }
  function problems() { return app.snapshot().diagnostics.filter(function(item) { return item.code === 'supplement-invalid'; }); }

  await new Promise(function(resolve) { setTimeout(resolve, 250); });
  Assert.equal(problems().length, 0, 'a missing folder is not an error');

  Fs.mkdirSync(folder, { recursive: true });
  Fs.writeFileSync(Path.join(folder, 'a.json'), document('codex:folder-a', 'first a'));
  Fs.writeFileSync(Path.join(folder, '.hidden.json'), document('codex:hidden', 'hidden'));
  Fs.writeFileSync(Path.join(folder, 'notes.txt'), 'not a supplement');
  await waitFor(function() { return ids().includes('codex:folder-a'); }, 'a.json to load');
  Assert.ok(!ids().includes('codex:hidden'), 'dot files are ignored');

  Fs.writeFileSync(Path.join(folder, 'b.json'), document('codex:folder-b', 'first b'));
  await waitFor(function() { return ids().includes('codex:folder-b'); }, 'b.json to load');

  Fs.writeFileSync(Path.join(folder, 'bad.json'), '{broken');
  await waitFor(function() { return problems().length === 1; }, 'the broken file to be reported');
  Assert.ok(problems()[0].source.path.endsWith('bad.json'));
  Assert.ok(ids().includes('codex:folder-a') && ids().includes('codex:folder-b'), 'the other files keep working');

  Fs.writeFileSync(Path.join(folder, 'b.json'), document('codex:folder-b', 'changed b'));
  await waitFor(function() { return nameOf('codex:folder-b') === 'changed b'; }, 'b.json edit to show up');

  Fs.unlinkSync(Path.join(folder, 'a.json'));
  await waitFor(function() { return !ids().includes('codex:folder-a'); }, 'a.json removal to show up');
  Assert.equal(problems().length, 1, 'removing a file is not reported as a problem');

  Fs.unlinkSync(Path.join(folder, 'bad.json'));
  await waitFor(function() { return problems().length === 0; }, 'the broken file report to clear');
  Assert.ok(ids().includes('codex:folder-b'));
});

Test('the supplement folder is ignored when it is not configured or turned off', async function(t)
{
  const home = tempHome(t);
  const folder = Server.defaultSupplementDir(home);
  Fs.mkdirSync(folder, { recursive: true });
  Fs.writeFileSync(Path.join(folder, 'a.json'), JSON.stringify({ schemaVersion: 1, sessions: [{ id: 'codex:folder-a', name: 'a' }], relations: [] }));
  for (const supplementDir of [undefined, null])
  {
    const app = Server.createObserverServer({ home: home, port: 0, pollIntervalMs: 50, supplements: [], supplementDir: supplementDir });
    await new Promise(function(resolve, reject) { app.start(function(error) { return error ? reject(error) : resolve(); }); });
    await new Promise(function(resolve) { setTimeout(resolve, 300); });
    const loaded = app.snapshot().nodes.some(function(node) { return node.id === 'codex:folder-a'; });
    await new Promise(function(resolve) { app.stop(resolve); });
    Assert.equal(loaded, false, 'supplementDir=' + String(supplementDir) + ' must not read the folder');
  }
});

Test('a file given with --supplement that also sits in the folder is loaded once', async function(t)
{
  const home = tempHome(t);
  const folder = Server.defaultSupplementDir(home);
  Fs.mkdirSync(folder, { recursive: true });
  const file = Path.join(folder, 'a.json');
  Fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessions: [{ id: 'codex:folder-a', name: 'a' }], relations: [] }));
  const app = Server.createObserverServer({ home: home, port: 0, pollIntervalMs: 50, supplements: [file], supplementDir: folder });
  t.after(function() { return new Promise(function(resolve) { app.stop(resolve); }); });
  await new Promise(function(resolve, reject) { app.start(function(error) { return error ? reject(error) : resolve(); }); });
  await waitFor(function() { return app.snapshot().nodes.some(function(node) { return node.id === 'codex:folder-a'; }); }, 'the file to load');
  await new Promise(function(resolve) { setTimeout(resolve, 300); });
  Assert.equal(app.snapshot().nodes.filter(function(node) { return node.id === 'codex:folder-a'; }).length, 1);
  Assert.equal(app.snapshot().diagnostics.filter(function(item) { return item.code === 'supplement-invalid'; }).length, 0);
});

Test('a read that finishes after its file left the supplement folder leaves no stale problem behind', async function(t)
{
  const original = Supplement.loadSupplement;
  t.after(function() { Supplement.loadSupplement = original; });
  var slow = false;
  Supplement.loadSupplement = function(path, callback)
  {
    if (!slow) return original(path, callback);
    // A re-read that is still in flight when the file is removed, and then reports "no such file".
    setTimeout(function() { callback(Object.assign(new Error('no such file'), { code: 'ENOENT' })); }, 400);
  };
  const home = tempHome(t);
  const folder = Server.defaultSupplementDir(home);
  Fs.mkdirSync(folder, { recursive: true });
  const file = Path.join(folder, 'a.json');
  Fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessions: [{ id: 'codex:folder-a', name: 'a' }], relations: [] }));
  const app = Server.createObserverServer({ home: home, port: 0, pollIntervalMs: 50, supplements: [], supplementDir: folder });
  t.after(function() { return new Promise(function(resolve) { app.stop(resolve); }); });
  await new Promise(function(resolve, reject) { app.start(function(error) { return error ? reject(error) : resolve(); }); });
  await waitFor(function() { return app.snapshot().nodes.some(function(node) { return node.id === 'codex:folder-a'; }); }, 'the file to load');
  slow = true;
  Fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessions: [{ id: 'codex:folder-a', name: 'edited' }], relations: [] }));
  await new Promise(function(resolve) { setTimeout(resolve, 150); });
  Fs.unlinkSync(file);
  await waitFor(function() { return !app.snapshot().nodes.some(function(node) { return node.id === 'codex:folder-a'; }); }, 'the removal to show up');
  await new Promise(function(resolve) { setTimeout(resolve, 700); });
  Assert.equal(app.snapshot().diagnostics.filter(function(item) { return item.code === 'supplement-invalid'; }).length, 0);
});
