// test/main.test.mjs
// End-to-end test of the main entry (index.cjs): storage -> vm runtime -> rpc ->
// placeholder proxy -> resolved URL / fallback.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const activate = require('../lx-music-source/index.cjs');

const SCRIPT = `/**
 * @name Const Source
 * @version 1.0.0
 * @description Returns a fixed URL, no network.
 */
const { EVENT_NAMES, on, send } = globalThis.lx
send(EVENT_NAMES.inited, {
    status: true,
    sources: { wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] } },
})
on(EVENT_NAMES.request, ({ source, action, info }) => {
    if (action !== 'musicUrl') throw new Error('unsupported action')
    return 'https://cdn.test/' + source + '/' + info.musicInfo.songmid + '/' + info.type
})
`;

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const makeApi = (entries) => {
    const store = new Map();
    store.set('scripts', entries);
    const handlers = new Map();
    return {
        api: {
            log: silentLog,
            host: { folium: { major: 1, minor: 7 } },
            storage: { get: async (key) => store.get(key) },
            rpc: {
                handle: (name, fn) => handlers.set(name, fn),
                send: () => {},
            },
        },
        store,
        handlers,
    };
};

const entry = { id: 'const', name: 'Const Source', code: SCRIPT, version: '1.0.0', enabled: true };

test('main entry loads a script, answers status/resolve, and serves placeholders', async () => {
    const { api, handlers } = makeApi([entry]);
    const dispose = await activate(api);
    try {
        const status = await handlers.get('lx.status')();
        assert.equal(status.loaded, true);
        assert.ok(status.proxyPort > 0);
        assert.deepEqual(JSON.parse(JSON.stringify(status.scripts[0].runtime.sources.wy.qualitys)), ['128k', '320k', 'flac']);

        await handlers.get('lx.setOptions')({ quality: 'flac' });
        const resolved = await handlers.get('lx.resolve')({ source: 'wy', id: '123', quality: 'flac', song: { id: '123' } });
        assert.equal(resolved.url, 'https://cdn.test/wy/123/flac');
        assert.equal(resolved.quality, 'flac');

        // Placeholder (default quality 320k) redirects to the real URL.
        const payload = Buffer.from(JSON.stringify({ source: 'wy', id: '123', quality: '320k' }), 'utf8').toString('base64url');
        const response = await fetch(`http://127.0.0.1:${status.proxyPort}/p/${payload}`, { redirect: 'manual' });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), 'https://cdn.test/wy/123/320k');
    } finally {
        dispose();
    }
});

test('main entry falls back to the built-in URL when the script cannot resolve', async () => {
    const { api, handlers } = makeApi([entry]);
    const dispose = await activate(api);
    try {
        const status = await handlers.get('lx.status')();
        // The script only declares wy; asking for tx fails and hits the fallback.
        const payload = Buffer.from(JSON.stringify({
            source: 'tx',
            id: '9',
            quality: '320k',
            fallback: 'https://builtin.test/free.mp3',
        }), 'utf8').toString('base64url');
        const response = await fetch(`http://127.0.0.1:${status.proxyPort}/p/${payload}`, { redirect: 'manual' });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), 'https://builtin.test/free.mp3');
    } finally {
        dispose();
    }
});

test('main entry reports a disabled/all-disabled script set', async () => {
    const { api, handlers } = makeApi([{ ...entry, enabled: false }]);
    const dispose = await activate(api);
    try {
        const status = await handlers.get('lx.status')();
        assert.equal(status.loaded, false);
        assert.equal(status.scripts[0].enabled, false);
        assert.equal(status.scripts[0].runtime, null);
        await assert.rejects(handlers.get('lx.resolve')({ source: 'wy', id: '1', quality: '320k' }), /没有已启用的脚本/);
    } finally {
        dispose();
    }
});

test('lx.reload reuses an unchanged script runtime instead of resetting it', async () => {
    const counter = `/**
 * @name Counter Source
 * @version 1.0.0
 */
let hits = 0
globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, {
    status: true,
    sources: { wy: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] } },
})
globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => 'https://cdn.test/hit/' + (++hits))
`;
    const { api, handlers } = makeApi([{ id: 'counter', name: 'Counter Source', code: counter, enabled: true }]);
    const dispose = await activate(api);
    try {
        const first = await handlers.get('lx.resolve')({ source: 'wy', id: 'a', quality: '320k' });
        assert.equal(first.url, 'https://cdn.test/hit/1');
        await handlers.get('lx.reload')();
        const second = await handlers.get('lx.resolve')({ source: 'wy', id: 'b', quality: '320k' });
        assert.equal(second.url, 'https://cdn.test/hit/2');
    } finally {
        dispose();
    }
});
