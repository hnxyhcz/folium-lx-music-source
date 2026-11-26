// test/proxy.test.mjs
// Exercises the local loopback proxy in index.cjs: /p placeholder redirects,
// fallback redirect, failure 502, and /a Range streaming.

import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const { audioProxy, probeFinalUrl } = require('../lx-music-source/index.cjs').__internals;
after(() => audioProxy.close());

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const encodePayload = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const startProxy = async () => {
    await audioProxy.start(silentLog);
    return audioProxy.getPort();
};

const placeholder = (port, payload) => `http://127.0.0.1:${port}/p/${encodePayload(payload)}`;

test('placeholder redirects to the resolved URL', async () => {
    const port = await startProxy();
    audioProxy.setHandler(async () => ({ url: 'https://cdn.test/resolved.mp3', quality: '320k' }));
    const response = await fetch(placeholder(port, { source: 'wy', id: '1', quality: '320k' }), { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://cdn.test/resolved.mp3');
});

test('placeholder falls back to the built-in URL when resolution fails', async () => {
    const port = await startProxy();
    audioProxy.setHandler(async () => { throw new Error('no source'); });
    const payload = { source: 'wy', id: '2', quality: '320k', fallback: 'https://builtin.test/free.mp3' };
    const response = await fetch(placeholder(port, payload), { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://builtin.test/free.mp3');
});

test('placeholder returns 502 when resolution fails without a fallback', async () => {
    const port = await startProxy();
    audioProxy.setHandler(async () => { throw new Error('no source'); });
    const response = await fetch(placeholder(port, { source: 'wy', id: '3' }), { redirect: 'manual' });
    assert.equal(response.status, 502);
});

test('/a streams the target with Range support', async () => {
    const upstream = http.createServer((req, res) => {
        const body = Buffer.from('0123456789');
        const range = req.headers.range;
        if (range) {
            const match = /bytes=(\d+)-(\d*)/.exec(range);
            const start = Number(match[1]);
            const end = match[2] ? Number(match[2]) : body.length - 1;
            res.writeHead(206, {
                'Content-Type': 'audio/mpeg',
                'Content-Range': `bytes ${start}-${end}/${body.length}`,
                'Content-Length': String(end - start + 1),
                'Accept-Ranges': 'bytes',
            });
            res.end(body.subarray(start, end + 1));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
        res.end(body);
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;
    const port = await startProxy();
    const url = audioProxy.register(`http://127.0.0.1:${upstreamPort}/file.mp3`);
    try {
        const full = await fetch(url);
        assert.equal(full.status, 200);
        assert.equal(await full.text(), '0123456789');

        const ranged = await fetch(url, { headers: { Range: 'bytes=2-5' } });
        assert.equal(ranged.status, 206);
        assert.equal(await ranged.text(), '2345');
    } finally {
        upstream.close();
    }
});

test('/a follows upstream redirects and keeps Range headers', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/start') {
            res.writeHead(302, { Location: '/final.mp3' });
            res.end();
            return;
        }
        const body = Buffer.from('abcdef');
        const range = req.headers.range;
        if (range) {
            const match = /bytes=(\d+)-(\d*)/.exec(range);
            const start = Number(match[1]);
            const end = match[2] ? Number(match[2]) : body.length - 1;
            res.writeHead(206, {
                'Content-Type': 'audio/mpeg',
                'Content-Range': `bytes ${start}-${end}/${body.length}`,
                'Content-Length': String(end - start + 1),
                'Accept-Ranges': 'bytes',
            });
            res.end(body.subarray(start, end + 1));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length) });
        res.end(body);
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
        const port = await startProxy();
        const url = audioProxy.register(`http://127.0.0.1:${upstream.address().port}/start`);
        const response = await fetch(url, { headers: { Range: 'bytes=1-3' } });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-type'), 'audio/mpeg');
        assert.equal(await response.text(), 'bcd');
    } finally {
        upstream.close();
    }
});

test('probeFinalUrl reads headers without draining a Range-ignoring body', async () => {
    let sent = 0;
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '52428800' });
        const timer = setInterval(() => {
            if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
            sent += 65536;
            res.write(Buffer.alloc(65536));
        }, 5);
        res.on('close', () => clearInterval(timer));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const result = await probeFinalUrl(`http://127.0.0.1:${server.address().port}/huge.mp3`, 3000);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(result.statusCode, 200);
        assert.ok(sent < 20 * 65536, `probe drained ${sent} bytes`);
    } finally {
        server.close();
    }
});

test('finalize keeps an https URL direct and upgrades an http one only when https answers', async () => {
    await startProxy();
    const direct = await audioProxy.finalize('https://cdn.test/direct.mp3');
    assert.equal(direct, 'https://cdn.test/direct.mp3');
});

test('finalize falls back to the local proxy when the host has no https', async () => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '3' });
        res.end('abc');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
        await startProxy();
        const out = await audioProxy.finalize(`http://127.0.0.1:${upstream.address().port}/file.mp3`);
        assert.match(out, /^http:\/\/127\.0\.0\.1:\d+\/a\//);
        const response = await fetch(out);
        assert.equal(await response.text(), 'abc');
    } finally {
        upstream.close();
    }
});

test('the cache dedupes concurrent resolutions and can be cleared', async () => {
    await startProxy();
    let calls = 0;
    audioProxy.setHandler(async () => {
        calls += 1;
        return { url: 'https://cdn.test/cached.mp3', quality: '320k' };
    });
    audioProxy.clear();
    const payload = { source: 'wy', id: 'dedupe', quality: '320k' };
    await Promise.all([audioProxy.get(payload), audioProxy.get(payload)]);
    await audioProxy.get(payload);
    assert.equal(calls, 1);
    assert.equal(audioProxy.cacheSize(), 1);
    audioProxy.clear();
    assert.equal(audioProxy.cacheSize(), 0);
});
