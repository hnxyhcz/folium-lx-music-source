// test/runtime.test.mjs
// Unit tests for the main-process LX runtime (lx-music-source/index.cjs).
// Run directly with `node test/runtime.test.mjs` (Node's built-in runner).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
    buildMusicInfo,
    createLxRuntime,
    decodeLxScript,
    httpRequest,
    normalizePlayableUrl,
    parseScriptMeta,
    qualityLadder,
    QUALITY_MAP,
    QUALITY_ORDER,
} = require('../lx-music-source/index.cjs').__internals;

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/source-fixture.js', import.meta.url)), 'utf8');

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** A request() that answers like a working LX source API and records what it saw. */
const mockRequest = (calls) => (url, options, callback) => {
    calls.push({ url, options });
    const body = { code: 0, url: `https://cdn.test/${encodeURIComponent(url)}` };
    callback(null, { statusCode: 200, headers: {}, body, raw: Buffer.from(JSON.stringify(body)) }, body);
    return () => {};
};

const makeRuntime = (code = FIXTURE, extra = {}) => {
    const calls = [];
    const runtime = createLxRuntime({
        log: silentLog,
        request: mockRequest(calls),
        options: () => ({ requestTimeoutMs: 5000 }),
        info: { name: 'fixture', version: '1.2.3', description: '', homepage: '', rawScript: code },
        ...extra,
    });
    runtime.run(code);
    return { runtime, calls };
};

test('parseScriptMeta reads the LX header', () => {
    const meta = parseScriptMeta(FIXTURE, 'fallback');
    assert.equal(meta.name, 'Fixture Source');
    assert.equal(meta.version, '1.2.3');
    assert.equal(meta.description, 'A plaintext LX source used by the runtime tests.');
    assert.equal(meta.homepage, 'https://example.test/fixture');
    assert.equal(parseScriptMeta('const x = 1', 'fallback').name, 'fallback');
});

test('buildMusicInfo uses the id field each source expects and carries song fields', () => {
    const song = { title: 'T', artist: 'A', album: 'B' };
    assert.deepEqual(buildMusicInfo('wy', '186016', song), { name: 'T', singer: 'A', albumName: 'B', songmid: '186016', songId: 186016 });
    assert.deepEqual(buildMusicInfo('tx', '003abc', song), { name: 'T', singer: 'A', albumName: 'B', songmid: '003abc', mediaMid: '003abc', songId: '003abc' });
    assert.deepEqual(buildMusicInfo('tx', '003abc', { ...song, id: '186016' }), { name: 'T', singer: 'A', albumName: 'B', songmid: '003abc', mediaMid: '003abc', songId: 186016 });
    assert.deepEqual(buildMusicInfo('kg', 'HASH', {}), { name: '', singer: '', albumName: '', hash: 'HASH', hash128: 'HASH', albumId: '' });
    assert.deepEqual(buildMusicInfo('mg', '600000', {}), { name: '', singer: '', albumName: '', songmid: '600000', copyrightId: '600000', songId: '600000' });
});

test('QUALITY_MAP maps Folia audio qualities to LX ids', () => {
    assert.deepEqual(QUALITY_MAP, { standard: '128k', high: '320k', lossless: 'flac', hires: 'flac24bit' });
    assert.deepEqual(QUALITY_ORDER, ['128k', '192k', '256k', '320k', 'flac', 'flac24bit', 'hires']);
});

test('normalizePlayableUrl accepts http(s), fixes protocol-relative, rejects the rest', () => {
    assert.equal(normalizePlayableUrl('https://cdn.test/a.mp3'), 'https://cdn.test/a.mp3');
    assert.equal(normalizePlayableUrl(' http://cdn.test/a.mp3 '), 'http://cdn.test/a.mp3');
    assert.equal(normalizePlayableUrl('//cdn.test/a.mp3'), 'https://cdn.test/a.mp3');
    assert.equal(normalizePlayableUrl('https://cdn.test/a.mp3, https://cdn.test/b.mp3'), 'https://cdn.test/a.mp3');
    assert.equal(normalizePlayableUrl('HTTPS://CDN.TEST/a.mp3'), 'https://CDN.TEST/a.mp3');
    assert.equal(normalizePlayableUrl('file:///etc/passwd'), null);
    assert.equal(normalizePlayableUrl(''), null);
    assert.equal(normalizePlayableUrl(null), null);
});

test('httpRequest follows redirects and decodes gzip bodies like LX needle', async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/start') {
            res.writeHead(302, { Location: '/final' });
            res.end();
            return;
        }
        const body = gzipSync(Buffer.from(JSON.stringify({ ok: true })));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': String(body.length) });
        res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const { response, body } = await new Promise((resolve, reject) => {
            httpRequest(`${base}/start`, {}, (error, res, value) => (error ? reject(error) : resolve({ response: res, body: value })));
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(body, { ok: true });
        assert.equal(response.headers['content-encoding'], undefined);
    } finally {
        server.close();
    }
});

test('qualityLadder picks the best declared quality at or below the preference', () => {
    const picked = (available, preferred) => qualityLadder({ x: { qualitys: available } }, 'x', preferred)[0];
    assert.equal(picked(null, '320k'), '320k');
    assert.equal(picked(['128k', '320k', 'flac'], '320k'), '320k');
    assert.equal(picked(['128k', '320k', 'flac'], 'flac24bit'), 'flac');
    assert.equal(picked(['128k', '320k', 'flac'], '128k'), '128k');
    assert.equal(picked(['320k', 'flac'], '128k'), '320k');
    assert.equal(picked(['256k', 'flac'], '320k'), '256k');
    assert.equal(picked(['flac24bit'], '320k'), 'flac24bit');
    assert.equal(picked(['128k', '320k'], 'flac'), '320k');
    assert.equal(picked([], '320k'), '320k');
});

test('runtime.run aborts a runaway script after the vm timeout', () => {
    const runtime = createLxRuntime({
        log: silentLog,
        request: () => () => {},
        options: () => ({ requestTimeoutMs: 5000 }),
        info: { name: 'runaway' },
    });
    try {
        assert.throws(() => runtime.run('while (true) {}'), /timed out|timeout/i);
    } finally {
        runtime.dispose();
    }
});

test('resolveMusicUrl cancels pending lx.request when the handler times out', async () => {
    let cancelled = false;
    const runtime = createLxRuntime({
        log: silentLog,
        request: () => () => { cancelled = true; },
        options: () => ({ requestTimeoutMs: 500 }),
        info: { name: 'hang' },
    });
    runtime.run(`
        globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => new Promise(() => {
            globalThis.lx.request('https://api.test/hang', {}, () => {})
        }))
    `);
    try {
        await assert.rejects(runtime.resolveMusicUrl('wy', { songmid: '1' }, '320k'), /musicUrl/);
        assert.equal(cancelled, true);
    } finally {
        runtime.dispose();
    }
});

test('decodeLxScript passes plain scripts through and unwraps gz_ payloads', () => {
    assert.equal(decodeLxScript(FIXTURE), FIXTURE);

    const wrapped = `gz_${deflateSync(Buffer.from(FIXTURE, 'utf8')).toString('base64')}`;
    assert.equal(decodeLxScript(wrapped), FIXTURE);

    const raw = `gz_${deflateRawSync(Buffer.from(FIXTURE, 'utf8')).toString('base64')}`;
    assert.equal(decodeLxScript(raw), FIXTURE);

    assert.throws(() => decodeLxScript('gz_not-base64!!'), /incorrect header check|invalid|buffer/i);
});

test('the runtime exposes the declared sources and the utils surface', async () => {
    const { runtime } = makeRuntime();
    await runtime.whenInited();

    assert.equal(runtime.inited, true);
    assert.deepEqual(Object.keys(runtime.sources).sort(), ['tx', 'wy']);
    // Values come from the vm realm; normalise before deep-comparing.
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.sources.wy.qualitys)), ['128k', '320k', 'flac']);
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.sources.wy.probe)), {
        md5Empty: 'd41d8cd98f00b204e9800998ecf8427e',
        md5Abc: '900150983cd24fb0d6963f7d28e17f72',
        md5Parts: '900150983cd24fb0d6963f7d28e17f72',
        hexRoundTrip: '00ff10',
        base64RoundTrip: 'aGVsbG8=',
        utf8RoundTrip: '你好',
        latin1RoundTrip: '\xff\x00',
    });
    runtime.dispose();
});

test('resolveMusicUrl runs the script handler and lx.request with the signature', async () => {
    const { runtime, calls } = makeRuntime();
    await runtime.whenInited();

    const url = await runtime.resolveMusicUrl('wy', { songmid: '186016' }, '320k');
    assert.match(url, /^https:\/\/cdn\.test\//);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method || 'GET', 'GET');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options.headers)), { 'x-source': 'fixture' });
    assert.match(calls[0].url, /sign=58adbc1755ff9ec5cc1e65f6895acc8f/);
    assert.match(decodeURIComponent(calls[0].url), /source\.test\/url\/wy\/186016\/320k/);
    runtime.dispose();
});

test('resolveMusicUrl rejects when the script never registers a handler', async () => {
    const { runtime } = makeRuntime('globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, { status: true, sources: {} })');
    await assert.rejects(runtime.resolveMusicUrl('wy', { songmid: '1' }, '320k'), /request handler/);
    runtime.dispose();
});

test('a disposed runtime refuses further work', async () => {
    const { runtime } = makeRuntime();
    await runtime.whenInited();
    runtime.dispose();
    await assert.rejects(runtime.resolveMusicUrl('wy', { songmid: '1' }, '320k'), /stopped/);
});

test('a failing source surfaces its error', async () => {
    const { runtime } = makeRuntime(FIXTURE, {
        request: (url, options, callback) => {
            const body = { code: 4, message: 'internal' };
            callback(null, { statusCode: 200, headers: {}, body, raw: Buffer.from(JSON.stringify(body)) }, body);
            return () => {};
        },
    });
    await runtime.whenInited();
    await assert.rejects(runtime.resolveMusicUrl('wy', { songmid: '1' }, '320k'), /source error: 4/);
    runtime.dispose();
});
