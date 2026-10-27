'use strict';
const Test = require('node:test');
const Assert = require('node:assert/strict');
const ChildProcess = require('node:child_process');
const Fs = require('node:fs');
const Http = require('node:http');
const Net = require('node:net');
const Path = require('node:path');
const Launcher = require('../bin/launcher');
const I18n = require('../src/i18n');

const NO_LOCALE = { WAS_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: '' };

// Runs the in-process code under one process locale and restores the previous one afterwards.
function useLocale(t, locale)
{
    const previous = I18n.getLocale();
    I18n.setLocale(locale);
    t.after(function() { I18n.setLocale(previous); });
}

function fixture(t)
{
    const root = Fs.mkdtempSync(Path.join(__dirname, '..', '.launcher-test-'));
    t.after(function() { Fs.rmSync(root, { recursive: true, force: true }); });
    return root;
}

function unusedPort(callback)
{
    const server = Net.createServer();
    server.listen(0, '127.0.0.1', function()
    {
        const port = server.address().port;
        server.close(function() { callback(port); });
    });
}

function healthServer(t, body, callback)
{
    const server = Http.createServer(function(request, response)
    {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
    });
    t.after(function() { server.close(); });
    server.listen(0, '127.0.0.1', function() { callback(server.address().port); });
}

Test('reuses only a matching read-only visualizer health response', function(t, done)
{
    const root = fixture(t);
    healthServer(t, { app: 'ai-agents-visualizer', ok: true, readOnly: true, host: '127.0.0.1', processId: process.pid }, function(port)
    {
        Launcher.ensureServer({ projectRoot: root, port: port }, function(error, result)
        {
            Assert.ifError(error);
            Assert.equal(result.started, false);
            Assert.equal(result.processId, process.pid);
            Assert.equal(result.url, 'http://127.0.0.1:' + port);
            Assert.equal(Fs.existsSync(Path.join(root, '.runtime')), false);
            done();
        });
    });
});

Test('rejects an occupied port even if another service returns generic health fields', function(t, done)
{
    useLocale(t, 'ko');
    const root = fixture(t);
    healthServer(t, { ok: true, readOnly: true, host: '127.0.0.1', processId: process.pid }, function(port)
    {
        Launcher.ensureServer({ projectRoot: root, port: port }, function(error)
        {
            Assert.match(error.message, /포트가 다른 서비스/);
            Assert.equal(error.message, port + ' 포트가 다른 서비스 또는 이전 visualizer에 사용 중입니다. 기존 프로세스는 변경하지 않았습니다.');
            Assert.equal(Fs.existsSync(Path.join(root, '.runtime')), false);
            I18n.setLocale('en');
            Launcher.ensureServer({ projectRoot: root, port: port }, function(englishError)
            {
                Assert.equal(englishError.message, 'Port ' + port + ' is in use by another service or an earlier visualizer. The existing process was left unchanged.');
                Assert.equal(Fs.existsSync(Path.join(root, '.runtime')), false);
                done();
            });
        });
    });
});

Test('bounds a health probe even when another service keeps streaming a response', function(t, done)
{
    useLocale(t, 'ko');
    const server = Http.createServer(function(request, response)
    {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.flushHeaders();
        const timer = setInterval(function() { response.write(' '); }, 10);
        response.on('close', function() { clearInterval(timer); });
    });
    t.after(function() { server.closeAllConnections(); server.close(); });
    server.listen(0, '127.0.0.1', function()
    {
        const startedAt = Date.now();
        Launcher.probeServer(server.address().port, function(error)
        {
            Assert.match(error.message, /응답 시간이 초과/);
            Assert.ok(Date.now() - startedAt < 1000);
            I18n.setLocale('en');
            Launcher.probeServer(server.address().port, function(englishError)
            {
                Assert.equal(englishError.message, 'The local server did not respond in time.');
                done();
            }, 60);
        }, 60);
    });
});

Test('starts a detached server from a path with spaces and polls until delayed health is ready', function(t, done)
{
    const parent = fixture(t);
    const root = Path.join(parent, 'project with spaces');
    Fs.mkdirSync(root);
    Fs.writeFileSync(Path.join(root, 'server.js'), [
        "const Http = require('node:http');",
        "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
        "setTimeout(function()",
        "{",
        "    Http.createServer(function(request, response)",
        "    {",
        "        response.end(JSON.stringify({app:'ai-agents-visualizer',ok:true,readOnly:true,host:'127.0.0.1',processId:process.pid}));",
        "    }).listen(port, '127.0.0.1');",
        "}, 450);"
    ].join('\n'));
    unusedPort(function(port)
    {
        const startedAt = Date.now();
        Launcher.ensureServer({ projectRoot: root, port: port }, function(error, result)
        {
            Assert.ifError(error);
            Assert.equal(result.started, true);
            Assert.notEqual(result.processId, process.pid);
            t.after(function()
            {
                try { process.kill(result.processId, 'SIGTERM'); }
                catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
            });
            Assert.ok(Date.now() - startedAt >= 450);
            Assert.equal(Fs.existsSync(Path.join(root, '.runtime', 'server.log')), true);
            done();
        });
    });
});

Test('reports an early backend exit without stopping or replacing another process', function(t, done)
{
    useLocale(t, 'ko');
    const root = fixture(t);
    Fs.writeFileSync(Path.join(root, 'server.js'), 'process.exit(7);\n');
    unusedPort(function(port)
    {
        Launcher.ensureServer({ projectRoot: root, port: port }, function(error)
        {
            Assert.match(error.message, /준비 전에 종료되었습니다 \(7\)/);
            Assert.ok(error.message.endsWith('로그: ' + Path.join(root, '.runtime', 'server.log')));
            I18n.setLocale('en');
            unusedPort(function(otherPort)
            {
                Launcher.ensureServer({ projectRoot: root, port: otherPort }, function(englishError)
                {
                    Assert.equal(englishError.message, 'The server exited before it was ready (7). Log: ' + Path.join(root, '.runtime', 'server.log'));
                    done();
                });
            });
        });
    });
});

Test('reports an invalid port and a missing server.js in the process locale', function(t, done)
{
    useLocale(t, 'ko');
    const root = fixture(t);
    Launcher.ensureServer({ projectRoot: root, port: 0 }, function(portError)
    {
        Assert.equal(portError.message, '서버 포트는 1~65535 정수여야 합니다.');
        unusedPort(function(port)
        {
            Launcher.ensureServer({ projectRoot: root, port: port }, function(missingError)
            {
                Assert.equal(missingError.message, '실행할 server.js를 찾지 못했습니다: ' + Path.join(root, 'server.js'));
                I18n.setLocale('en');
                Launcher.ensureServer({ projectRoot: root, port: 70000 }, function(englishPortError)
                {
                    Assert.equal(englishPortError.message, 'The server port must be an integer from 1 to 65535.');
                    Launcher.ensureServer({ projectRoot: root, port: port }, function(englishMissingError)
                    {
                        Assert.equal(englishMissingError.message, 'Could not find server.js to run: ' + Path.join(root, 'server.js'));
                        Assert.equal(Fs.existsSync(Path.join(root, '.runtime')), false);
                        done();
                    });
                });
            });
        });
    });
});

Test('launcher messages exist in both languages, including the plural startup timeout', function()
{
    const english = { count: 15, path: '/tmp/server.log', status: 'SIGTERM', port: 4317, url: 'http://127.0.0.1:4317' };
    Assert.equal(I18n.translate('en', 'cli.launcher.startTimeout', english), 'The server was not ready within 15 seconds. Log: /tmp/server.log');
    Assert.equal(I18n.translate('en', 'cli.launcher.startTimeout', { count: 1, path: '/tmp/server.log' }), 'The server was not ready within 1 second. Log: /tmp/server.log');
    Assert.equal(I18n.translate('ko', 'cli.launcher.startTimeout', english), '15초 안에 서버가 준비되지 않았습니다. 로그: /tmp/server.log');
    Assert.equal(I18n.translate('en', 'cli.launcher.nodeRequired'), 'Node.js 22 or later is required.');
    Assert.equal(I18n.translate('ko', 'cli.launcher.nodeRequired'), 'Node.js 22 이상이 필요합니다.');
    Assert.equal(I18n.translate('en', 'cli.launcher.started'), 'Started the read-only visualizer server.');
    Assert.equal(I18n.translate('ko', 'cli.launcher.started'), '읽기 전용 visualizer 서버를 시작했습니다.');
    Assert.equal(I18n.translate('en', 'cli.launcher.reused'), 'Using the running visualizer server.');
    Assert.equal(I18n.translate('ko', 'cli.launcher.reused'), '실행 중인 visualizer 서버를 사용합니다.');
    Assert.equal(I18n.translate('en', 'cli.launcher.responseAborted'), 'The server response was interrupted.');
    Assert.equal(I18n.translate('ko', 'cli.launcher.responseAborted'), '서버 응답이 중단되었습니다.');
});

function shellFixture(t)
{
    const root = Path.join(fixture(t), 'launcher path with spaces');
    const bin = Path.join(root, 'bin');
    Fs.mkdirSync(bin, { recursive: true });
    ['launch.sh', 'launch-browser.sh', 'launch-messages.sh', 'launcher.js', 'stop.sh'].forEach(function(name)
    {
        Fs.copyFileSync(Path.join(__dirname, '..', 'bin', name), Path.join(bin, name));
    });
    const nodePath = Path.join(bin, 'mock node');
    const osaPath = Path.join(bin, 'mock osascript');
    const openPath = Path.join(bin, 'mock open');
    Fs.writeFileSync(nodePath, '#!/bin/sh\nif [ "$1" = -e ]; then exit 0; fi\nprintf "%s\\n" "$@" > "$VISUALIZER_TEST_ARGS_PATH"\nprintf "%s\\n" "${WAS_LANG-unset}" > "$VISUALIZER_TEST_LANG_PATH"\nprintf "%s\\n" "http://127.0.0.1:4317"\n', { mode: 0o700 });
    Fs.writeFileSync(osaPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$VISUALIZER_TEST_OSA_ARGS_PATH"\ncat > "$VISUALIZER_TEST_AS_PATH"\nif [ "${VISUALIZER_TEST_OSA_FAIL-}" = 1 ]; then printf "%s\\n" "Accessibility denied" >&2; exit 1; fi\n', { mode: 0o700 });
    Fs.writeFileSync(openPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$VISUALIZER_TEST_OPEN_PATH"\nif [ "${VISUALIZER_TEST_OPEN_FAIL-}" = 1 ]; then exit 1; fi\n', { mode: 0o700 });
    Fs.writeFileSync(Path.join(bin, 'uname'), '#!/bin/sh\nprintf "%s\\n" Darwin\n', { mode: 0o700 });
    return {
        root: root,
        launch: Path.join(bin, 'launch.sh'),
        browser: Path.join(bin, 'launch-browser.sh'),
        stop: Path.join(bin, 'stop.sh'),
        // Korean unless a test picks another language: the Korean assertions below predate the English texts.
        env: Object.assign({}, process.env, NO_LOCALE, {
            WAS_LANG: 'ko',
            AI_AGENTS_NODE_BIN: nodePath,
            AI_AGENTS_OSASCRIPT_BIN: osaPath,
            AI_AGENTS_OPEN_BIN: openPath,
            VISUALIZER_TEST_OPEN_PATH: Path.join(root, 'browser-args.txt'),
            VISUALIZER_TEST_ARGS_PATH: Path.join(root, 'args.txt'),
            VISUALIZER_TEST_LANG_PATH: Path.join(root, 'lang.txt'),
            VISUALIZER_TEST_AS_PATH: Path.join(root, 'applescript.txt'),
            VISUALIZER_TEST_OSA_ARGS_PATH: Path.join(root, 'osascript-args.txt'),
            PATH: bin + Path.delimiter + process.env.PATH
        })
    };
}

function runShell(f, script, args, env)
{
    return ChildProcess.spawnSync('/bin/sh', [script].concat(args || []), { cwd: '/', env: Object.assign({}, f.env, env || {}), encoding: 'utf8' });
}

Test('sh --server-only works from any cwd with spaces and never invokes GUI automation', function(t)
{
    const f = shellFixture(t);
    const result = ChildProcess.spawnSync('/bin/sh', [f.launch, '--server-only'], { cwd: '/', env: f.env, encoding: 'utf8' });
    Assert.equal(result.status, 0, result.stderr);
    Assert.equal(result.stdout.trim(), 'http://127.0.0.1:4317');
    Assert.equal(Fs.readFileSync(f.env.VISUALIZER_TEST_ARGS_PATH, 'utf8').trim(), Path.join(f.root, 'bin', 'launcher.js'));
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_AS_PATH), false);
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_OPEN_PATH), false);
});

Test('--browser opens the verified URL with the default opener without VS Code automation', function(t)
{
    const f = shellFixture(t);
    f.env.AI_AGENTS_OSASCRIPT_BIN = Path.join(f.root, 'unavailable-osascript');
    const result = ChildProcess.spawnSync('/bin/sh', [f.launch, '--browser'], { cwd: '/', env: f.env, encoding: 'utf8' });
    Assert.equal(result.status, 0, result.stderr);
    Assert.equal(Fs.readFileSync(f.env.VISUALIZER_TEST_OPEN_PATH, 'utf8'), 'http://127.0.0.1:4317\n');
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_AS_PATH), false);
    Assert.match(result.stdout, /시스템 기본 브라우저/);
    const english = runShell(f, f.launch, ['--browser'], { WAS_LANG: 'en', AI_AGENTS_OSASCRIPT_BIN: f.env.AI_AGENTS_OSASCRIPT_BIN });
    Assert.equal(english.status, 0, english.stderr);
    Assert.match(english.stdout, /Sent the open command to the system default browser\./);
    Assert.doesNotMatch(english.stdout, /[ᄀ-ᇿ㄰-㆏가-힯]/);
});

Test('dedicated browser script opens without arguments or assistive access from any cwd', function(t)
{
    const f = shellFixture(t);
    f.env.AI_AGENTS_OSASCRIPT_BIN = Path.join(f.root, 'unavailable-osascript');
    const script = Path.join(f.root, 'bin', 'launch-browser.sh');
    const result = ChildProcess.spawnSync('/bin/sh', [script], { cwd: '/', env: f.env, encoding: 'utf8' });
    Assert.equal(result.status, 0, result.stderr);
    Assert.equal(Fs.readFileSync(f.env.VISUALIZER_TEST_OPEN_PATH, 'utf8'), 'http://127.0.0.1:4317\n');
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_AS_PATH), false);
    Assert.match(result.stdout, /시스템 기본 브라우저/);
    const english = runShell(f, script, [], { WAS_LANG: 'en' });
    Assert.equal(english.status, 0, english.stderr);
    Assert.match(english.stdout, /Sent the open command to the system default browser\./);
});

Test('default opener failure reports the URL and does not fall back to another app', function(t)
{
    const f = shellFixture(t);
    f.env.VISUALIZER_TEST_OPEN_FAIL = '1';
    const result = ChildProcess.spawnSync('/bin/sh', [f.launch, '--browser'], { cwd: '/', env: f.env, encoding: 'utf8' });
    Assert.equal(result.status, 1);
    Assert.match(result.stderr, /기본 브라우저 열기에 실패/);
    Assert.match(result.stderr, /http:\/\/127\.0\.0\.1:4317/);
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_AS_PATH), false);
    const english = runShell(f, f.launch, ['--browser'], { WAS_LANG: 'en' });
    Assert.equal(english.status, 1);
    Assert.match(english.stderr, /Failed to open the default browser\. The server is ready\./);
    Assert.match(english.stderr, /Please open it in a browser yourself: http:\/\/127\.0\.0\.1:4317/);
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_AS_PATH), false);
});

Test('conflicting browser and server-only options fail before server startup', function(t)
{
    const f = shellFixture(t);
    const result = ChildProcess.spawnSync('/bin/sh', [f.launch, '--browser', '--server-only'], { cwd: '/', env: f.env, encoding: 'utf8' });
    Assert.equal(result.status, 1);
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_ARGS_PATH), false);
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_OPEN_PATH), false);
    Assert.match(result.stderr, /옵션은 --browser 또는 --server-only 중 하나만 사용할 수 있습니다\./);
    const english = runShell(f, f.launch, ['--browser', '--server-only'], { WAS_LANG: 'en' });
    Assert.equal(english.status, 1);
    Assert.equal(english.stderr.trim(), 'Use only one of --browser or --server-only.');
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_ARGS_PATH), false);
});

Test('an unknown option exits with status 1 and names the option in both languages', function(t)
{
    const f = shellFixture(t);
    const korean = runShell(f, f.launch, ['--nope']);
    Assert.equal(korean.status, 1);
    Assert.equal(korean.stderr.trim(), '알 수 없는 옵션: --nope');
    const english = runShell(f, f.launch, ['--nope'], { WAS_LANG: 'en' });
    Assert.equal(english.status, 1);
    Assert.equal(english.stderr.trim(), 'Unknown option: --nope');
    const browserKorean = runShell(f, f.browser, ['--nope']);
    Assert.equal(browserKorean.status, 1);
    Assert.equal(browserKorean.stderr.trim(), 'launch-browser.sh는 옵션 없이 실행해주세요.');
    const browserEnglish = runShell(f, f.browser, ['--nope'], { WAS_LANG: 'en' });
    Assert.equal(browserEnglish.status, 1);
    Assert.equal(browserEnglish.stderr.trim(), 'Run launch-browser.sh without options.');
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_ARGS_PATH), false);
});

Test('--help prints the usage in the chosen language and starts nothing', function(t)
{
    const f = shellFixture(t);
    const binDirectory = Path.join(f.root, 'bin');
    ['-h', '--help'].forEach(function(flag)
    {
        const korean = runShell(f, f.launch, [flag]);
        Assert.equal(korean.status, 0, korean.stderr);
        const koreanLines = korean.stdout.trim().split('\n');
        Assert.equal(koreanLines.length, 6);
        Assert.equal(koreanLines[0], '사용법: sh /경로/ai-agents-visualizer/bin/launch.sh [--browser | --server-only]');
        Assert.equal(koreanLines[1], '기본 동작: 서버 재사용/시작 후 현재 VS Code 창의 내장 브라우저로 열기');
        Assert.equal(koreanLines[2], '--browser: 서버 재사용/시작 후 시스템 기본 브라우저로 열기');
        Assert.equal(koreanLines[3], '기본 브라우저 전용 스크립트: ' + binDirectory + '/launch-browser.sh');
        Assert.equal(koreanLines[4], '--server-only: 브라우저를 열지 않고 서버만 준비');
        Assert.match(koreanLines[5], /^언어: WAS_LANG=en 또는 WAS_LANG=ko/);
        const english = runShell(f, f.launch, [flag], { WAS_LANG: 'en' });
        Assert.equal(english.status, 0, english.stderr);
        const englishLines = english.stdout.trim().split('\n');
        Assert.equal(englishLines.length, 6);
        Assert.equal(englishLines[0], 'Usage: sh /path/to/ai-agents-visualizer/bin/launch.sh [--browser | --server-only]');
        Assert.match(englishLines[1], /^Default: reuse or start the server, then open it in the current VS Code window's integrated browser$/);
        Assert.match(englishLines[2], /^--browser: reuse or start the server, then open it in the system default browser$/);
        Assert.equal(englishLines[3], 'Script for the default browser only: ' + binDirectory + '/launch-browser.sh');
        Assert.equal(englishLines[4], '--server-only: prepare the server without opening a browser');
        Assert.match(englishLines[5], /^Language: set WAS_LANG=en or WAS_LANG=ko/);
        Assert.doesNotMatch(english.stdout, /[ᄀ-ᇿ㄰-㆏가-힯]/);
        const browserKorean = runShell(f, f.browser, [flag]);
        Assert.equal(browserKorean.status, 0, browserKorean.stderr);
        Assert.equal(browserKorean.stdout, '사용법: ' + binDirectory + '/launch-browser.sh\n서버를 재사용/시작하고 시스템 기본 브라우저로 엽니다. VS Code와 손쉬운 사용 권한은 필요하지 않습니다.\n');
        const browserEnglish = runShell(f, f.browser, [flag], { WAS_LANG: 'en' });
        Assert.equal(browserEnglish.status, 0, browserEnglish.stderr);
        Assert.equal(browserEnglish.stdout, 'Usage: ' + binDirectory + '/launch-browser.sh\nReuses or starts the server and opens it in the system default browser. VS Code and Accessibility permission are not required.\n');
    });
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_ARGS_PATH), false);
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_OPEN_PATH), false);
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_AS_PATH), false);
});

Test('the shell scripts choose the language like the Node side and hand it to the launcher', function(t)
{
    const f = shellFixture(t);
    const cases = [
        {},
        { WAS_LANG: 'ko' },
        { WAS_LANG: 'en', LANG: 'ko_KR.UTF-8' },
        { WAS_LANG: 'KO' },
        { WAS_LANG: 'ko-KR' },
        { LANG: 'ko_KR.UTF-8' },
        { LANG: 'ko.UTF-8' },
        { LANG: 'en_US.UTF-8', LC_MESSAGES: 'ko_KR.UTF-8' },
        { LANG: 'ko_KR.UTF-8', LC_ALL: 'en_US.UTF-8' },
        { LC_ALL: 'C', LANG: 'ko_KR.UTF-8' },
        { LC_ALL: 'POSIX', LC_MESSAGES: 'fr_FR.UTF-8', LANG: 'en_GB.UTF-8' },
        { WAS_LANG: 'fr', LANG: 'ko_KR.UTF-8' },
        { LANG: 'fr_FR.UTF-8' },
        { LANG: 'korean' }
    ];
    cases.forEach(function(overrides)
    {
        const env = Object.assign({}, NO_LOCALE, overrides);
        const expected = I18n.processLocale(env);
        const help = runShell(f, f.browser, ['--help'], env);
        Assert.equal(help.status, 0, help.stderr);
        Assert.equal(/^사용법: /.test(help.stdout) ? 'ko' : 'en', expected, JSON.stringify(overrides));
        Fs.rmSync(f.env.VISUALIZER_TEST_LANG_PATH, { force: true });
        const started = runShell(f, f.launch, ['--server-only'], env);
        Assert.equal(started.status, 0, started.stderr);
        Assert.equal(Fs.readFileSync(f.env.VISUALIZER_TEST_LANG_PATH, 'utf8').trim(), expected, 'WAS_LANG seen by the Node launcher: ' + JSON.stringify(overrides));
    });
});

Test('user-run GUI branch targets the existing Code bundle and guards URL typing with the actual AX label', function(t)
{
    const f = shellFixture(t);
    const result = ChildProcess.spawnSync('/bin/sh', [f.launch], { cwd: '/', env: f.env, encoding: 'utf8' });
    Assert.equal(result.status, 0, result.stderr);
    Assert.match(result.stdout, /현재 VS Code 창의 내장 브라우저에 열기 명령을 보냈습니다\./);
    const script = Fs.readFileSync(f.env.VISUALIZER_TEST_AS_PATH, 'utf8');
    Assert.match(script, /com\.microsoft\.VSCode/);
    Assert.match(script, /Browser: Open Integrated Browser/);
    Assert.match(script, /Search or enter URL/);
    Assert.match(script, /entire contents of front window of codeProcess/);
    Assert.match(script, /value of candidate as text\) starts with ">"/);
    Assert.ok(script.indexOf('if not paletteReady then error') < script.indexOf('keystroke "Browser: Open Integrated Browser"'));
    Assert.ok(script.indexOf('if not urlFieldReady then error') < script.indexOf('keystroke targetUrl'));
    Assert.doesNotMatch(script, /open location|do shell script|clipboard/);
});

Test('the GUI script text is fixed; its error messages arrive as osascript arguments in the chosen language', function(t)
{
    const f = shellFixture(t);
    const korean = runShell(f, f.launch);
    Assert.equal(korean.status, 0, korean.stderr);
    const koreanScript = Fs.readFileSync(f.env.VISUALIZER_TEST_AS_PATH, 'utf8');
    const koreanArguments = Fs.readFileSync(f.env.VISUALIZER_TEST_OSA_ARGS_PATH, 'utf8').trim().split('\n');
    Assert.deepEqual(koreanArguments, [
        '-', 'http://127.0.0.1:4317',
        '현재 열린 Visual Studio Code가 없습니다.',
        '현재 열린 Visual Studio Code 창이 없습니다.',
        '명령 팔레트를 확인하지 못했습니다. 검색문을 입력하지 않았습니다.',
        'VS Code 포커스가 바뀌었습니다. 검색문을 입력하지 않았습니다.',
        '내장 브라우저 URL 입력란을 확인하지 못했습니다. URL을 입력하지 않았습니다.',
        'VS Code 포커스가 바뀌었습니다. URL을 입력하지 않았습니다.'
    ]);
    const english = runShell(f, f.launch, [], { WAS_LANG: 'en' });
    Assert.equal(english.status, 0, english.stderr);
    Assert.match(english.stdout, /Sent the open command to the current VS Code window's integrated browser\./);
    const englishArguments = Fs.readFileSync(f.env.VISUALIZER_TEST_OSA_ARGS_PATH, 'utf8').trim().split('\n');
    Assert.deepEqual(englishArguments, [
        '-', 'http://127.0.0.1:4317',
        'Visual Studio Code is not open.',
        'There is no open Visual Studio Code window.',
        'Could not confirm the command palette. Nothing was typed.',
        'VS Code lost focus. Nothing was typed.',
        'Could not confirm the integrated browser URL field. The URL was not typed.',
        'VS Code lost focus. The URL was not typed.'
    ]);
    Assert.equal(Fs.readFileSync(f.env.VISUALIZER_TEST_AS_PATH, 'utf8'), koreanScript, 'the script itself does not depend on the language');
    Assert.doesNotMatch(koreanScript, /[ᄀ-ᇿ㄰-㆏가-힯]/);
    ['noCodeText', 'noWindowText', 'noPaletteText', 'searchFocusText', 'noUrlFieldText', 'urlFocusText'].forEach(function(name)
    {
        Assert.match(koreanScript, new RegExp('error ' + name));
    });
});

Test('a denied accessibility request returns an error and manual browser instructions', function(t)
{
    const f = shellFixture(t);
    f.env.VISUALIZER_TEST_OSA_FAIL = '1';
    const result = ChildProcess.spawnSync('/bin/sh', [f.launch], { cwd: '/', env: f.env, encoding: 'utf8' });
    Assert.equal(result.status, 1);
    Assert.match(result.stderr, /손쉬운 사용/);
    Assert.match(result.stderr, /수동 열기:.*Cmd\+Shift\+P/);
    Assert.match(result.stderr, /기본 브라우저로 열기:.*launch-browser\.sh/);
    Assert.match(result.stderr, /http:\/\/127\.0\.0\.1:4317/);
    const english = runShell(f, f.launch, [], { WAS_LANG: 'en' });
    Assert.equal(english.status, 1);
    Assert.match(english.stderr, /Failed to open the VS Code integrated browser automatically\. The server is ready\./);
    Assert.match(english.stderr, /accessibility error.*Accessibility/);
    Assert.match(english.stderr, /Open manually:.*Cmd\+Shift\+P.*http:\/\/127\.0\.0\.1:4317/);
    Assert.match(english.stderr, /Open in the default browser instead:.*launch-browser\.sh/);
});

Test('a missing Node executable fails before any GUI automation', function(t)
{
    const f = shellFixture(t);
    f.env.AI_AGENTS_NODE_BIN = Path.join(f.root, 'missing-node');
    const result = ChildProcess.spawnSync('/bin/sh', [f.launch], { cwd: '/', env: f.env, encoding: 'utf8' });
    Assert.equal(result.status, 1);
    Assert.match(result.stderr, /Node\.js 22 이상을 찾지 못했습니다/);
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_AS_PATH), false);
    const english = runShell(f, f.launch, [], { WAS_LANG: 'en' });
    Assert.equal(english.status, 1);
    Assert.equal(english.stderr.trim(), 'Could not find Node.js 22 or later. Install Node.js or check your PATH.');
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_AS_PATH), false);
});

// stop.sh talks to the server through curl and to the kernel through lsof; both are mocked so that no test ever
// touches a real visualizer on port 4317. The signalled process is a real, throwaway one owned by the test.
function stopFixture(t)
{
    const f = shellFixture(t);
    const bin = Path.join(f.root, 'bin');
    Fs.writeFileSync(Path.join(bin, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$VISUALIZER_TEST_CURL_ARGS_PATH"\nif [ "${VISUALIZER_TEST_CURL_EXIT-0}" != 0 ]; then exit "$VISUALIZER_TEST_CURL_EXIT"; fi\nprintf "%s" "$VISUALIZER_TEST_HEALTH"\n', { mode: 0o700 });
    // Like the real lsof, it lists the listener only while that process is alive.
    Fs.writeFileSync(Path.join(bin, 'lsof'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$VISUALIZER_TEST_LSOF_ARGS_PATH"\nif kill -0 "$VISUALIZER_TEST_LISTENER_PID" 2>/dev/null; then printf "%s\\n" "$VISUALIZER_TEST_LISTENER_PID"; fi\n', { mode: 0o700 });
    f.env.VISUALIZER_TEST_CURL_ARGS_PATH = Path.join(f.root, 'curl-args.txt');
    f.env.VISUALIZER_TEST_LSOF_ARGS_PATH = Path.join(f.root, 'lsof-args.txt');
    return f;
}

function isAlive(pid)
{
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// Starts a background process whose parent exits at once, so it is reaped by init and never lingers as a zombie.
function spawnTarget(t, command)
{
    const result = ChildProcess.spawnSync('/bin/sh', ['-c', command + ' >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
    const pid = Number(result.stdout.trim());
    Assert.ok(Number.isInteger(pid) && pid > 0, result.stderr);
    t.after(function()
    {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
    });
    return pid;
}

function healthBody(pid, changes)
{
    return JSON.stringify(Object.assign({ app: 'ai-agents-visualizer', processId: pid, ok: true, version: 1, loading: false, host: '127.0.0.1', readOnly: true }, changes || {}));
}

Test('stop.sh stops the process that answers as this visualizer and listens on its port', function(t)
{
    const f = stopFixture(t);
    const pid = spawnTarget(t, 'sleep 30');
    f.env.VISUALIZER_TEST_HEALTH = healthBody(pid);
    f.env.VISUALIZER_TEST_LISTENER_PID = String(pid);
    const result = runShell(f, f.stop);
    Assert.equal(result.status, 0, result.stderr);
    Assert.equal(result.stdout.trim(), 'visualizer 서버를 중지했습니다 (프로세스 ' + pid + ').');
    Assert.equal(isAlive(pid), false);
    Assert.deepEqual(Fs.readFileSync(f.env.VISUALIZER_TEST_CURL_ARGS_PATH, 'utf8').trim().split('\n'), ['-s', '--max-time', '2', 'http://127.0.0.1:4317/api/health']);
    Assert.deepEqual(Fs.readFileSync(f.env.VISUALIZER_TEST_LSOF_ARGS_PATH, 'utf8').trim().split('\n'), ['-nP', '-t', '-iTCP:4317', '-sTCP:LISTEN']);
    const englishPid = spawnTarget(t, 'sleep 30');
    const english = runShell(f, f.stop, [], { WAS_LANG: 'en', VISUALIZER_TEST_HEALTH: healthBody(englishPid), VISUALIZER_TEST_LISTENER_PID: String(englishPid) });
    Assert.equal(english.status, 0, english.stderr);
    Assert.equal(english.stdout.trim(), 'Stopped the visualizer server (process ' + englishPid + ').');
    Assert.doesNotMatch(english.stdout, /[ᄀ-ᇿ㄰-㆏가-힯]/);
    Assert.equal(isAlive(englishPid), false);
});

Test('stop.sh treats a refused connection as already stopped and signals nothing', function(t)
{
    const f = stopFixture(t);
    const bystander = spawnTarget(t, 'sleep 30');
    f.env.VISUALIZER_TEST_CURL_EXIT = '7';
    f.env.VISUALIZER_TEST_LISTENER_PID = String(bystander);
    const result = runShell(f, f.stop);
    Assert.equal(result.status, 0, result.stderr);
    Assert.equal(result.stdout.trim(), '4317 포트에서 실행 중인 visualizer 서버가 없습니다.');
    const english = runShell(f, f.stop, [], { WAS_LANG: 'en' });
    Assert.equal(english.status, 0, english.stderr);
    Assert.equal(english.stdout.trim(), 'No visualizer server is running on port 4317.');
    Assert.equal(isAlive(bystander), true);
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_LSOF_ARGS_PATH), false);
    const failed = runShell(f, f.stop, [], { VISUALIZER_TEST_CURL_EXIT: '28' });
    Assert.equal(failed.status, 1);
    Assert.equal(failed.stderr.trim(), '4317 포트의 서버가 상태 확인에 응답하지 않았습니다. 아무것도 중지하지 않았습니다.');
    Assert.equal(isAlive(bystander), true);
});

Test('stop.sh leaves a port held by another service alone', function(t)
{
    const f = stopFixture(t);
    const bystander = spawnTarget(t, 'sleep 30');
    f.env.VISUALIZER_TEST_LISTENER_PID = String(bystander);
    [
        healthBody(bystander, { app: undefined }),
        healthBody(bystander, { readOnly: false }),
        healthBody(bystander, { host: '0.0.0.0' }),
        healthBody(0),
        'hello',
        ''
    ].forEach(function(body)
    {
        const result = runShell(f, f.stop, [], { VISUALIZER_TEST_HEALTH: body });
        Assert.equal(result.status, 1, body);
        Assert.equal(result.stderr.trim(), '4317 포트를 이 visualizer가 아닌 다른 프로세스가 사용 중입니다. 아무것도 중지하지 않았습니다.', body);
        Assert.equal(isAlive(bystander), true, body);
    });
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_LSOF_ARGS_PATH), false);
    const english = runShell(f, f.stop, [], { WAS_LANG: 'en', VISUALIZER_TEST_HEALTH: 'hello' });
    Assert.equal(english.status, 1);
    Assert.equal(english.stderr.trim(), 'Port 4317 is in use by something other than this visualizer. Nothing was stopped.');
});

Test('stop.sh refuses a process id that the port listener does not confirm', function(t)
{
    const f = stopFixture(t);
    const named = spawnTarget(t, 'sleep 30');
    // The health answer names `named`, but the kernel says another process owns the port.
    f.env.VISUALIZER_TEST_HEALTH = healthBody(named);
    f.env.VISUALIZER_TEST_LISTENER_PID = String(process.pid);
    const result = runShell(f, f.stop);
    Assert.equal(result.status, 1);
    Assert.equal(result.stderr.trim(), '4317 포트를 듣고 있는 프로세스를 확인하지 못했습니다 (lsof가 필요합니다). 아무것도 중지하지 않았습니다.');
    Assert.equal(isAlive(named), true);
    const english = runShell(f, f.stop, [], { WAS_LANG: 'en' });
    Assert.equal(english.status, 1);
    Assert.equal(english.stderr.trim(), 'Could not confirm which process listens on port 4317 (lsof is required). Nothing was stopped.');
    Assert.equal(isAlive(named), true);
});

Test('stop.sh does not claim success while the process keeps listening after SIGTERM', function(t)
{
    const f = stopFixture(t);
    const stubborn = spawnTarget(t, "sh -c 'trap \"\" TERM; while :; do sleep 1; done'");
    f.env.VISUALIZER_TEST_HEALTH = healthBody(stubborn);
    f.env.VISUALIZER_TEST_LISTENER_PID = String(stubborn);
    const result = runShell(f, f.stop);
    Assert.equal(result.status, 1);
    Assert.equal(result.stdout, '');
    Assert.equal(result.stderr.trim(), '프로세스 ' + stubborn + '가 종료 신호(SIGTERM) 후 제때 종료되지 않았습니다. 강제로 끝내려면: kill -9 ' + stubborn);
    Assert.equal(isAlive(stubborn), true);
});

Test('stop.sh prints its usage and rejects options before contacting the server', function(t)
{
    const f = stopFixture(t);
    const usage = runShell(f, f.stop, ['--help']);
    Assert.equal(usage.status, 0, usage.stderr);
    Assert.equal(usage.stdout.split('\n')[0], '사용법: ' + Path.join(f.root, 'bin') + '/stop.sh');
    const english = runShell(f, f.stop, ['-h'], { WAS_LANG: 'en' });
    Assert.equal(english.status, 0, english.stderr);
    Assert.equal(english.stdout.split('\n')[0], 'Usage: ' + Path.join(f.root, 'bin') + '/stop.sh');
    Assert.doesNotMatch(english.stdout, /[ᄀ-ᇿ㄰-㆏가-힯]/);
    const rejected = runShell(f, f.stop, ['--now']);
    Assert.equal(rejected.status, 1);
    Assert.equal(rejected.stderr.trim(), 'stop.sh는 옵션 없이 실행해주세요.');
    Assert.equal(runShell(f, f.stop, ['--now'], { WAS_LANG: 'en' }).stderr.trim(), 'Run stop.sh without options.');
    Assert.equal(Fs.existsSync(f.env.VISUALIZER_TEST_CURL_ARGS_PATH), false);
});
