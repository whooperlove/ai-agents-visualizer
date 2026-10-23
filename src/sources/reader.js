/* Read-only, bounded JSONL sampling and incremental tailing. */
'use strict';

const Fs = require('node:fs');
const StringDecoder = require('node:string_decoder').StringDecoder;

const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_HEAD_BYTES = 256 * 1024;
const DEFAULT_TAIL_BYTES = 128 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

function createJsonlReader(filePath, options)
{
    options = options || {};
    var identity = null;
    var offset = 0;
    var initialized = false;
    var pending = '';
    var pendingBytes = 0;
    var dropping = false;
    var closed = false;
    var activeStream = null;
    var decoder = new StringDecoder('utf8');
    var previousMtime = null;
    var anchor = Buffer.alloc(0);
    const maxLineBytes = options.maxLineBytes || DEFAULT_MAX_LINE_BYTES;
    const stats = { bytesRead: 0, skippedBytes: 0, records: 0, malformedLines: 0, oversizedLines: 0, resets: 0 };

    function diagnostic(code)
    {
        if (options.onDiagnostic)
        {
            options.onDiagnostic({ code: code, path: filePath });
        }
    }

    function clearPending()
    {
        pending = '';
        pendingBytes = 0;
        dropping = false;
        decoder = new StringDecoder('utf8');
    }

    function reset()
    {
        offset = 0;
        initialized = false;
        anchor = Buffer.alloc(0);
        clearPending();
        stats.resets += 1;
        if (options.onReset)
        {
            options.onReset();
        }
    }

    function acceptLine(line)
    {
        if (!line.trim())
        {
            return;
        }
        var record = null;
        try
        {
            record = JSON.parse(line);
        }
        catch (error)
        {
            stats.malformedLines += 1;
            diagnostic('malformed-jsonl');
            return;
        }
        stats.records += 1;
        if (record && typeof record === 'object' && options.onRecord)
        {
            options.onRecord(record);
        }
    }

    function consume(text)
    {
        var start = 0;
        var newline = text.indexOf('\n');
        while (newline !== -1)
        {
            const fragment = text.slice(start, newline);
            const fragmentBytes = Buffer.byteLength(fragment);
            if (!dropping && pendingBytes + fragmentBytes <= maxLineBytes)
            {
                acceptLine(pending + fragment);
            }
            else if (!dropping)
            {
                stats.oversizedLines += 1;
                diagnostic('oversized-jsonl-line');
            }
            pending = '';
            pendingBytes = 0;
            dropping = false;
            start = newline + 1;
            newline = text.indexOf('\n', start);
        }
        const remainder = text.slice(start);
        if (!dropping)
        {
            pendingBytes += Buffer.byteLength(remainder);
            if (pendingBytes > maxLineBytes)
            {
                pending = '';
                pendingBytes = 0;
                dropping = true;
                stats.oversizedLines += 1;
                diagnostic('oversized-jsonl-line');
            }
            else
            {
                pending += remainder;
            }
        }
    }

    function readRange(start, end, discardFirstLine, callback, stopAfterFirstLine)
    {
        if (closed || end < start)
        {
            callback(null);
            return;
        }
        var completed = false;
        var skipping = discardFirstLine;
        const stream = Fs.createReadStream(filePath, { start: start, end: end, highWaterMark: READ_CHUNK_BYTES });
        activeStream = stream;
        function finish(error)
        {
            if (completed)
            {
                return;
            }
            completed = true;
            activeStream = null;
            callback(error || null);
        }
        stream.on('data', function(chunk)
        {
            stats.bytesRead += chunk.length;
            var stopAtNewline = false;
            if (stopAfterFirstLine)
            {
                const newlineByte = chunk.indexOf(10);
                if (newlineByte !== -1)
                {
                    chunk = chunk.subarray(0, newlineByte + 1);
                    stopAtNewline = true;
                    stream.pause();
                }
            }
            offset += chunk.length;
            anchor = chunk.length >= 128 ? Buffer.from(chunk.subarray(chunk.length - 128)) : Buffer.concat([anchor, chunk]).subarray(-128);
            var text = decoder.write(chunk);
            if (skipping)
            {
                const newline = text.indexOf('\n');
                if (newline === -1)
                {
                    return;
                }
                text = text.slice(newline + 1);
                skipping = false;
            }
            consume(text);
            if (stopAtNewline)
            {
                stream.destroy();
                finish(null);
            }
        });
        stream.on('error', finish);
        stream.on('end', function()
        {
            finish(null);
        });
        stream.on('close', function()
        {
            finish(null);
        });
    }

    function initialRead(size, callback)
    {
        const headBytes = options.headBytes || DEFAULT_HEAD_BYTES;
        const tailBytes = options.tailBytes || DEFAULT_TAIL_BYTES;
        if (options.fullInitialRead || size <= headBytes + tailBytes)
        {
            readRange(0, size - 1, false, callback);
            return;
        }
        const initialRecordCount = stats.records;
        function finishPrefix(error)
        {
            if (error || closed)
            {
                callback(error);
                return;
            }
            if (offset >= size - tailBytes)
            {
                readRange(offset, size - 1, false, callback);
                return;
            }
            clearPending();
            anchor = Buffer.alloc(0);
            stats.skippedBytes += size - tailBytes - offset;
            diagnostic('history-sampled');
            offset = size - tailBytes;
            readRange(offset, size - 1, true, callback);
        }
        readRange(0, headBytes - 1, false, function(error)
        {
            if (!error && !closed && stats.records === initialRecordCount && pendingBytes > 0 && !dropping)
            {
                // Native session_meta can include long base instructions. Finish
                // its first line within the same explicit per-line memory bound.
                readRange(offset, Math.min(size - 1, offset + maxLineBytes - pendingBytes), false, finishPrefix, true);
                return;
            }
            finishPrefix(error);
        });
    }

    function poll(callback)
    {
        callback = callback || function() {};
        if (closed)
        {
            callback(null);
            return;
        }
        Fs.stat(filePath, function(error, stat)
        {
            if (error)
            {
                callback(error);
                return;
            }
            const nextIdentity = String(stat.dev) + ':' + String(stat.ino);
            const changed = previousMtime !== null && stat.mtimeMs !== previousMtime;
            if (identity !== null && (identity !== nextIdentity || stat.size < offset))
            {
                reset();
            }
            identity = nextIdentity;
            previousMtime = stat.mtimeMs;
            function continueRead(error)
            {
                if (error)
                {
                    callback(error);
                    return;
                }
                if (!initialized)
                {
                    initialized = true;
                    initialRead(stat.size, callback);
                    return;
                }
                readRange(offset, stat.size - 1, false, callback);
            }
            if (!changed || !initialized || anchor.length === 0)
            {
                continueRead(null);
                return;
            }
            // A file can be truncated and regrown between polls. Verify the last
            // observed bytes before treating its new suffix as an append.
            Fs.open(filePath, 'r', function(openError, fd)
            {
                if (openError)
                {
                    continueRead(openError);
                    return;
                }
                const expected = anchor;
                const buffer = Buffer.alloc(expected.length);
                Fs.read(fd, buffer, 0, buffer.length, offset - expected.length, function(readError, bytesRead)
                {
                    Fs.close(fd, function(closeError)
                    {
                        if (!readError && (bytesRead !== expected.length || !buffer.equals(expected)))
                        {
                            reset();
                        }
                        continueRead(readError || closeError || null);
                    });
                });
            });
        });
    }

    function stop()
    {
        closed = true;
        if (activeStream)
        {
            activeStream.destroy();
        }
    }

    function snapshot()
    {
        return Object.assign({ offset: offset, pendingBytes: pendingBytes }, stats);
    }

    return { poll: poll, stop: stop, snapshot: snapshot };
}

module.exports = { createJsonlReader: createJsonlReader };
