/* Start or reuse this project's read-only server. This module never stops a process. */
'use strict';

const ChildProcess = require('node:child_process');
const Fs = require('node:fs');
const Http = require('node:http');
const Path = require('node:path');
const I18n = require('../src/i18n');

const APPLICATION_ID = 'ai-agents-visualizer';
const DEFAULT_PORT = 4317;
const STARTUP_DEADLINE_MS = 15 * 1000;
const PROBE_TIMEOUT_MS = 1200;
const MAX_HEALTH_BYTES = 16 * 1024;

function probeServer(port, callback, timeoutMs)
{
    var finished = false;
    var bytes = 0;
    var text = '';
    var deadlineTimer = null;
    function finish(error, result)
    {
        if (finished) return;
        finished = true;
        clearTimeout(deadlineTimer);
        callback(error, result);
    }
    const request = Http.get({ hostname: '127.0.0.1', port: port, path: '/api/health', agent: false }, function(response)
    {
        response.setEncoding('utf8');
        response.on('data', function(chunk)
        {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_HEALTH_BYTES)
            {
                finish(null, { state: 'occupied' });
                response.destroy();
                return;
            }
            text += chunk;
        });
        response.on('end', function()
        {
            var health = null;
            try { health = JSON.parse(text); }
            catch (error) { finish(null, { state: 'occupied' }); return; }
            if (response.statusCode !== 200 || !health || health.app !== APPLICATION_ID || health.ok !== true ||
                health.readOnly !== true || health.host !== '127.0.0.1' || !Number.isInteger(health.processId) || health.processId <= 0)
            {
                finish(null, { state: 'occupied' });
                return;
            }
            finish(null, { state: 'ready', processId: health.processId });
        });
        response.on('error', function(error) { finish(error); });
        response.on('aborted', function() { finish(new Error(I18n.t('cli.launcher.responseAborted'))); });
    });
    deadlineTimer = setTimeout(function()
    {
        const error = new Error(I18n.t('cli.launcher.probeTimeout'));
        finish(error);
        request.destroy(error);
    }, Math.max(1, Math.min(PROBE_TIMEOUT_MS, timeoutMs || PROBE_TIMEOUT_MS)));
    request.on('error', function(error)
    {
        if (error.code === 'ECONNREFUSED') finish(null, { state: 'closed' });
        else finish(error);
    });
}

function ensureServer(options, callback)
{
    const settings = options || {};
    const port = settings.port === undefined ? DEFAULT_PORT : settings.port;
    const projectRoot = Path.resolve(settings.projectRoot || Path.join(__dirname, '..'));
    const serverPath = Path.join(projectRoot, 'server.js');
    const logPath = Path.join(projectRoot, '.runtime', 'server.log');
    const url = 'http://127.0.0.1:' + port;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
    {
        callback(new Error(I18n.t('cli.launcher.portInvalid')));
        return;
    }
    probeServer(port, function(error, result)
    {
        if (error) { callback(error); return; }
        if (result.state === 'ready')
        {
            callback(null, { url: url, processId: result.processId, started: false, logPath: logPath });
            return;
        }
        if (result.state === 'occupied') { callback(portConflict(port)); return; }
        Fs.stat(serverPath, function(statError, stat)
        {
            if (statError || !stat.isFile()) { callback(new Error(I18n.t('cli.launcher.serverMissing', { path: serverPath }))); return; }
            startServer();
        });
    });

    function startServer()
    {
        var logFd = null;
        var child = null;
        var completed = false;
        var exitStatus = null;
        const deadline = Date.now() + STARTUP_DEADLINE_MS;
        try
        {
            Fs.mkdirSync(Path.dirname(logPath), { recursive: true, mode: 0o700 });
            logFd = Fs.openSync(logPath, 'a', 0o600);
            child = ChildProcess.spawn(process.execPath, [serverPath, '--port', String(port)], {
                cwd: projectRoot, detached: true, stdio: ['ignore', logFd, logFd]
            });
        }
        catch (error)
        {
            if (logFd !== null) Fs.closeSync(logFd);
            callback(error);
            return;
        }
        Fs.closeSync(logFd);
        child.unref();
        child.once('error', function(error) { finish(error); });
        child.once('exit', function(code, signal) { exitStatus = signal || String(code); });

        function finish(error, result)
        {
            if (completed) return;
            completed = true;
            callback(error, result);
        }

        function check()
        {
            if (completed) return;
            if (Date.now() >= deadline)
            {
                finish(new Error(I18n.t('cli.launcher.startTimeout', { count: STARTUP_DEADLINE_MS / 1000, path: logPath })));
                return;
            }
            probeServer(port, function(error, result)
            {
                if (completed) return;
                if (!error && result.state === 'ready')
                {
                    finish(null, { url: url, processId: result.processId, started: result.processId === child.pid, logPath: logPath });
                    return;
                }
                if (!error && result.state === 'occupied') { finish(portConflict(port)); return; }
                if (exitStatus !== null)
                {
                    finish(new Error(I18n.t('cli.launcher.exitedEarly', { status: exitStatus, path: logPath })));
                    return;
                }
                if (Date.now() >= deadline)
                {
                    finish(new Error(I18n.t('cli.launcher.startTimeout', { count: STARTUP_DEADLINE_MS / 1000, path: logPath })));
                    return;
                }
                setTimeout(check, Math.min(150, deadline - Date.now()));
            }, deadline - Date.now());
        }
        check();
    }
}

function portConflict(port)
{
    return new Error(I18n.t('cli.launcher.portBusy', { port: port }));
}

if (require.main === module)
{
    if (Number(process.versions.node.split('.')[0]) < 22)
    {
        console.error(I18n.t('cli.launcher.nodeRequired'));
        process.exitCode = 1;
    }
    else
    {
        ensureServer({}, function(error, result)
        {
            if (error) { console.error(error.message); process.exitCode = 1; return; }
            console.error(result.started ? I18n.t('cli.launcher.started') : I18n.t('cli.launcher.reused'));
            console.log(result.url);
        });
    }
}

module.exports = { ensureServer: ensureServer, probeServer: probeServer };
