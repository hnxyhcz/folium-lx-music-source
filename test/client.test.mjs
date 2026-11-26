// test/client.test.mjs
// Exercises the Folium 1.6+ client entry against a minimal in-memory host.
// The main-process logic is faked through folium.rpc; real execution lives in
// index.cjs (covered by runtime.test.mjs / proxy.test.mjs).
// Run with `node test/client.test.mjs`.

import assert from 'node:assert/strict';
import test from 'node:test';

import activate from '../lx-music-source/client.mjs';

const FIXTURE = `/**
 * @name Fixture Source
 * @version 1.2.3
 * @description Fixture source
 */
globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => {});
`;

const createHost = () => {
    const logs = [];
    const store = new Map();
    const sections = [];
    const commands = new Map();
    const handlers = new Map();
    const hooks = new Map();
    const intervals = [];
    const rpcCalls = [];
    const toasts = [];
    let currentSong = null;
    let queueSnapshot = { items: [], length: 0, currentIndex: -1, kind: 'queue', version: 'v1' };
    let cacheCount = 0;
    let options = {};

    const makeSettings = (def) => {
        const values = Object.fromEntries(def.settings.map((field) => [field.key, field.defaultValue]));
        const listeners = new Set();
        return {
            schema: def.settings,
            get: () => ({ ...values }),
            set: (patch) => {
                Object.assign(values, patch);
                listeners.forEach((listener) => listener());
            },
            reset: () => {
                for (const field of def.settings) values[field.key] = field.defaultValue;
                listeners.forEach((listener) => listener());
            },
            onChange: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
    };

    const netFetch = async (url) => {
        if (url === 'https://example.test/source.js') {
            return { ok: true, status: 200, statusText: 'OK', headers: {}, text: () => FIXTURE };
        }
        return { ok: false, status: 404, statusText: 'Not Found', headers: {}, text: () => '' };
    };

    const statusFromStore = () => {
        const entries = Array.isArray(store.get('scripts')) ? store.get('scripts') : [];
        return {
            loaded: entries.some((entry) => entry.enabled !== false),
            proxyPort: 12345,
            cacheCount,
            options: { ...options },
            scripts: entries.map((entry) => ({
                id: entry.id,
                name: entry.name,
                meta: { version: entry.version || '', description: entry.description || '' },
                enabled: entry.enabled !== false,
                error: null,
                runtime: entry.enabled !== false
                    ? { sources: { wy: { qualitys: ['128k', '320k', 'flac'] }, tx: { qualitys: ['128k', '320k'] } } }
                    : null,
            })),
        };
    };

    const rpcHandlers = {
        'lx.setOptions': (payload) => { options = { ...options, ...(payload || {}) }; return statusFromStore(); },
        'lx.status': () => statusFromStore(),
        'lx.reload': () => statusFromStore(),
        'lx.resolve': (payload = {}) => {
            if (!statusFromStore().loaded) throw new Error('没有已启用的脚本');
            cacheCount += 1;
            return { url: `https://cdn.test/resolved/${payload.source}/${payload.id}/${payload.quality}`, quality: payload.quality };
        },
        'lx.prefetch': () => true,
        'lx.invalidate': () => true,
        'lx.clearCache': () => { cacheCount = 0; return true; },
    };

    const folium = {
        modId: 'lx-music-source',
        env: { context: 'main' },
        host: { folium: { major: 2, minor: 1 }, folia: '0.8.0' },
        log: {
            info: (...args) => logs.push(['info', ...args]),
            warn: (...args) => logs.push(['warn', ...args]),
            error: (...args) => logs.push(['error', ...args]),
        },
        registries: {
            settingsSections: {
                register: (def) => {
                    const settings = makeSettings(def);
                    sections.push({ def, settings });
                    return { id: def.id, unregister: () => {}, settings };
                },
            },
            commands: {
                register: (def) => {
                    commands.set(def.id, def);
                    return { id: def.id, unregister: () => commands.delete(def.id) };
                },
            },
        },
        events: {
            on: (type, handler) => {
                handlers.set(type, handler);
                return () => handlers.delete(type);
            },
        },
        playback: {
            getState: () => ({ song: currentSong }),
            getQueue: () => queueSnapshot,
        },
        ui: {
            pickFile: async () => null,
            toast: (message) => { toasts.push(String(message)); },
        },
        net: { fetch: netFetch },
        storage: {
            get: async (key) => store.get(key),
            set: async (key, value) => { store.set(key, value); },
            has: async (key) => store.has(key),
            delete: async (key) => { store.delete(key); },
            keys: async () => [...store.keys()],
        },
        every: (ms, listener) => {
            intervals.push({ ms, listener });
            return () => {};
        },
        rpc: {
            call: (name, payload) => {
                rpcCalls.push({ name, payload });
                const handler = rpcHandlers[name];
                if (!handler) return Promise.reject(new Error(`unknown rpc ${name}`));
                try {
                    return Promise.resolve(handler(payload));
                } catch (error) {
                    return Promise.reject(error);
                }
            },
        },
        experimental: {
            'omni.hooks': {
                on: (type, handler) => {
                    hooks.set(type, handler);
                    return () => hooks.delete(type);
                },
            },
        },
    };

    return {
        folium,
        logs,
        store,
        sections,
        commands,
        handlers,
        hooks,
        intervals,
        rpcCalls,
        toasts,
        setCurrentSong: (song) => { currentSong = song; },
        setQueue: (snapshot) => { queueSnapshot = snapshot; },
    };
};

const seedFixture = (host) => {
    host.store.set('scripts', [{
        id: 'fixture',
        name: 'Fixture Source',
        code: FIXTURE,
        version: '1.2.3',
        description: 'Fixture source',
        homepage: 'https://example.test/fixture',
        importedAt: Date.now(),
        enabled: true,
    }]);
};

const readPayload = (url) => JSON.parse(Buffer.from(new URL(url).pathname.slice(3), 'base64url').toString('utf8'));

// A tiny DOM shim is enough for the source-list panel.
class FakeNode {
    constructor(tag, doc) {
        this.ownerDocument = doc;
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.attributes = {};
        this.style = { setProperty(key, value) { this[key] = value; } };
        this.dataset = {};
        this.listeners = new Map();
        this.className = '';
        const classOwner = this;
        this.classList = {
            contains: (name) => String(classOwner.className).split(/\s+/).includes(name),
            add: (name) => {
                const set = new Set(String(classOwner.className).split(/\s+/).filter(Boolean));
                set.add(name);
                classOwner.className = [...set].join(' ');
            },
            remove: (name) => {
                const set = new Set(String(classOwner.className).split(/\s+/).filter(Boolean));
                set.delete(name);
                classOwner.className = [...set].join(' ');
            },
        };
        this.parentNode = null;
        this._rect = { top: 0, height: 0, left: 0, width: 0 };
        this.textContent = '';
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.title = '';
        this.type = '';
        this.isConnected = true;
        this.parent = null;
    }

    setAttribute(key, value) {
        this.attributes[key] = String(value);
        if (key === 'class') this.className = String(value);
        if (key === 'type') this.type = String(value);
        if (key === 'value') this.value = String(value);
    }

    append(...nodes) {
        for (const node of nodes) {
            if (node === null || node === undefined || node === false) continue;
            if (typeof node === 'string') { this.textContent += node; continue; }
            if (node.parentNode && Array.isArray(node.parentNode.children)) {
                const at = node.parentNode.children.indexOf(node);
                if (at >= 0) node.parentNode.children.splice(at, 1);
            }
            node.parent = this;
            node.parentNode = this;
            this.children.push(node);
        }
    }

    insertBefore(node, ref) {
        if (node.parentNode && Array.isArray(node.parentNode.children)) {
            const at = node.parentNode.children.indexOf(node);
            if (at >= 0) node.parentNode.children.splice(at, 1);
        }
        const index = ref ? this.children.indexOf(ref) : -1;
        if (index >= 0) this.children.splice(index, 0, node);
        else this.children.push(node);
        node.parent = this;
        node.parentNode = this;
        return node;
    }

    getBoundingClientRect() {
        return this._rect;
    }

    setPointerCapture() {}

    releasePointerCapture() {}

    replaceChildren(...nodes) {
        this.children = [];
        this.textContent = '';
        this.append(...nodes);
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    removeEventListener(type, listener) {
        const list = this.listeners.get(type);
        if (!list) return;
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
    }

    dispatch(type, extra = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener({ key: '', preventDefault() {}, ...extra });
    }
}

const createFakeDocument = () => {
    const doc = {
        createElement: (tag) => new FakeNode(tag, doc),
        listeners: new Map(),
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        },
        removeEventListener(type, listener) {
            const list = this.listeners.get(type);
            if (!list) return;
            const index = list.indexOf(listener);
            if (index >= 0) list.splice(index, 1);
        },
        dispatch(type, extra = {}) {
            for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {}, ...extra });
        },
    };
    return doc;
};

const collectText = (node) => {
    let text = node.textContent || '';
    for (const child of node.children ?? []) text += ` ${collectText(child)}`;
    return text;
};

const findNode = (node, predicate) => {
    if (predicate(node)) return node;
    for (const child of node.children ?? []) {
        const found = findNode(child, predicate);
        if (found) return found;
    }
    return null;
};

const settle = async () => {
    for (let index = 0; index < 8; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

test('activate registers the settings section, commands and the audio hook', async () => {
    const host = createHost();
    const dispose = await activate(host.folium);

    assert.equal(host.sections.length, 2);
    assert.equal(host.sections[0].def.id, 'lx-source');
    assert.deepEqual(
        host.sections[0].def.settings.map((field) => field.key),
        ['mode', 'enabledNetease', 'enabledQq', 'enabledKugou', 'quality', 'requestTimeoutMs'],
    );
    assert.equal(typeof host.sections[0].def.settingsPanel, 'function');
    assert.equal(host.sections[1].def.id, 'lx-source-list');
    assert.equal(host.sections[1].def.label['zh-CN'], '音源脚本');
    assert.equal(typeof host.sections[1].def.settingsPanel, 'function');
    assert.deepEqual([...host.commands.keys()].sort(), ['test']);
    assert.equal(typeof host.handlers.get('omni.audioSourceResolved'), 'function');
    assert.equal(typeof host.handlers.get('playback.songChanged'), 'function');
    assert.equal(typeof host.handlers.get('playback.beforePlay'), 'function');
    assert.equal(typeof host.handlers.get('playback.failed'), 'function');
    assert.equal(host.intervals[0].ms, 5000);
    assert.ok(host.rpcCalls.some((call) => call.name === 'lx.reload'));

    dispose();
});

test('the test command resolves a URL through the main process', async () => {
    const host = createHost();
    seedFixture(host);
    const dispose = await activate(host.folium);

    const url = await host.commands.get('test').run({
        values: { source: 'wy', id: '186016', quality: '320k' },
    });
    assert.equal(url, null);
    assert.ok(host.rpcCalls.some((call) => call.name === 'lx.resolve' && call.payload.id === '186016'));
    assert.match(host.toasts.at(-1), /^https:\/\/cdn\.test\//);

    const txUrl = await host.commands.get('test').run({
        values: { source: 'tx', id: '', quality: '320k' },
    });
    assert.equal(txUrl, null);
    assert.match(host.toasts.at(-1), /\/tx\/0039MnYb0qxYhV\/320k$/);

    dispose();
});

test('the audio hook writes a synchronous placeholder and honours off / fallback / always', async () => {
    const host = createHost();
    seedFixture(host);
    const dispose = await activate(host.folium);
    // 平台默认全熄，先点亮网易云再验证钩子行为。
    host.sections[0].settings.set({ enabledNetease: true });

    // 仅兜底：内置没有地址 → 写占位地址，payload 里 fallback 为 null。
    const missing = { song: { id: '2', source: 'netease', title: 't', artist: 'a', album: null }, url: null };
    host.handlers.get('omni.audioSourceResolved')(missing);
    assert.match(missing.url, /^http:\/\/127\.0\.0\.1:12345\/p\//);
    const missingPayload = readPayload(missing.url);
    assert.equal(missingPayload.source, 'wy');
    assert.equal(missingPayload.id, '2');
    assert.equal(missingPayload.fallback, null);

    // 仅兜底：内置已有地址 → 不动。
    const kept = { song: { id: '3', source: 'netease' }, url: 'https://builtin.test/a.mp3' };
    host.handlers.get('omni.audioSourceResolved')(kept);
    assert.equal(kept.url, 'https://builtin.test/a.mp3');

    // 不替换：关闭适配层，内置没有地址也不劫持。
    host.sections[0].settings.set({ mode: 'off' });
    const off = { song: { id: '9', source: 'netease' }, url: null };
    host.handlers.get('omni.audioSourceResolved')(off);
    assert.equal(off.url, null);
    const offWithUrl = { song: { id: '10', source: 'netease' }, url: 'https://builtin.test/c.mp3' };
    host.handlers.get('omni.audioSourceResolved')(offWithUrl);
    assert.equal(offWithUrl.url, 'https://builtin.test/c.mp3');

    // 总是替换：即使内置有地址也写占位，且 fallback 带上内置地址。
    host.sections[0].settings.set({ mode: 'always' });
    const replaced = { song: { id: '4', source: 'netease' }, url: 'https://builtin.test/b.mp3' };
    host.handlers.get('omni.audioSourceResolved')(replaced);
    assert.match(replaced.url, /^http:\/\/127\.0\.0\.1:12345\/p\//);
    const replacedPayload = readPayload(replaced.url);
    assert.equal(replacedPayload.fallback, 'https://builtin.test/b.mp3');

    // 脚本没声明 kg：不要劫持这个音源。
    const unsupported = { song: { id: '5', source: 'kugou' }, url: null };
    host.handlers.get('omni.audioSourceResolved')(unsupported);
    assert.equal(unsupported.url, null);

    dispose();
});

test('per-platform chips: only lit platforms route to LX', async () => {
    const host = createHost();
    seedFixture(host);
    const dispose = await activate(host.folium);
    host.sections[0].settings.set({ mode: 'always' });

    // 默认全部熄灭：即使「总是替换」，未点亮的平台也保留内置原版。
    const wy = { song: { id: '11', source: 'netease' }, url: 'https://builtin.test/wy.mp3' };
    host.handlers.get('omni.audioSourceResolved')(wy);
    assert.equal(wy.url, 'https://builtin.test/wy.mp3');

    // 点亮 QQ 后：QQ 走替换，其它平台仍保留内置。
    host.sections[0].settings.set({ enabledQq: true });
    const qq = { song: { id: '12', source: 'qq' }, url: 'https://builtin.test/qq.mp3' };
    host.handlers.get('omni.audioSourceResolved')(qq);
    assert.match(qq.url, /^http:\/\/127\.0\.0\.1:12345\/p\//);

    dispose();
});

test('songChanged prefetches the next queue items (always mode)', async () => {
    const host = createHost();
    seedFixture(host);
    const current = { id: '1', source: 'netease', title: 'one', artist: 'a', album: null };
    const next = { id: '2', source: 'netease', title: 'two', artist: 'a', album: null };
    const after = { id: '3', source: 'netease', title: 'three', artist: 'a', album: null };
    host.setQueue({
        items: [{ index: 0, song: current }, { index: 1, song: next }, { index: 2, song: after }],
        length: 3,
        currentIndex: 0,
        kind: 'queue',
        version: 'v1',
    });
    const dispose = await activate(host.folium);
    try {
        host.sections[0].settings.set({ mode: 'always', enabledNetease: true });
        host.setCurrentSong(current);
        host.handlers.get('playback.songChanged')({ song: current });
        await settle();
        const ids = host.rpcCalls
            .filter((call) => call.name === 'lx.prefetch')
            .map((call) => call.payload.id);
        assert.ok(ids.includes('1'));
        assert.ok(ids.includes('2'));
        assert.ok(ids.includes('3'));
    } finally {
        dispose();
    }
});

test('fallback and off modes do not prefetch on song change', async () => {
    const host = createHost();
    seedFixture(host);
    const current = { id: '1', source: 'netease', title: 'one', artist: 'a', album: null };
    host.setQueue({
        items: [{ index: 0, song: current }],
        length: 1,
        currentIndex: 0,
        kind: 'queue',
        version: 'v1',
    });
    const dispose = await activate(host.folium);
    try {
        host.setCurrentSong(current);
        host.handlers.get('playback.songChanged')({ song: current });
        await settle();
        const prefetches = host.rpcCalls.filter((call) => call.name === 'lx.prefetch');
        assert.equal(prefetches.length, 0);

        host.sections[0].settings.set({ mode: 'off' });
        host.handlers.get('playback.songChanged')({ song: current });
        await settle();
        assert.equal(host.rpcCalls.filter((call) => call.name === 'lx.prefetch').length, 0);
    } finally {
        dispose();
    }
});

test('the custom source list imports, toggles and deletes scripts', async () => {
    const host = createHost();
    const dispose = await activate(host.folium);

    const listSection = host.sections.find((section) => section.def.id === 'lx-source-list');
    const doc = createFakeDocument();
    const container = new FakeNode('div', doc);
    const panelDispose = listSection.def.settingsPanel(container, {
        locale: 'zh-CN',
        settings: listSection.settings,
        getTheme: () => ({ primaryColor: '#fff', secondaryColor: '#aaa', accentColor: '#0af', isDaylight: false }),
        onChange: () => () => {},
        every: () => () => {},
        onDispose: () => {},
    });
    await settle();

    let text = collectText(container);
    assert.match(text, /还没有音源脚本/);

    const urlInput = findNode(container, (node) => String(node.className).split(' ').includes('lx-list-url-input'));
    assert.ok(urlInput);
    urlInput.value = 'https://example.test/source.js';
    const urlButton = findNode(container, (node) => String(node.className).split(' ').includes('lx-list-btn') && node.textContent === '导入');
    assert.ok(urlButton);
    urlButton.dispatch('click');
    await settle();

    text = collectText(container);
    assert.match(text, /Fixture Source v1\.2\.3/);
    assert.doesNotMatch(text, /wy 128k\/320k\/flac/);

    const disable = findNode(container, (node) => String(node.className).split(' ').includes('lx-source-switch'));
    assert.ok(disable);
    disable.dispatch('click');
    await settle();
    assert.equal(host.store.get('scripts')[0].enabled, false);

    let statusButton = findNode(container, (node) => String(node.className).split(' ').includes('lx-icon-status'));
    assert.ok(statusButton);
    statusButton.dispatch('click');
    await settle();
    text = collectText(container);
    assert.match(text, /脚本 0 个/);
    assert.match(text, /已停用/);

    const disabledUrl = await host.commands.get('test').run({
        values: { source: 'wy', id: '186016', quality: '320k' },
    });
    assert.equal(disabledUrl, null);

    const enable = findNode(container, (node) => String(node.className).split(' ').includes('lx-source-switch'));
    assert.ok(enable);
    enable.dispatch('click');
    await settle();
    assert.equal(host.store.get('scripts')[0].enabled, true);
    text = collectText(container);
    assert.doesNotMatch(text, /wy 128k\/320k\/flac/);

    const resolved = await host.commands.get('test').run({
        values: { source: 'wy', id: '186016', quality: '320k' },
    });
    assert.equal(resolved, null);
    assert.match(host.toasts.at(-1), /^https:\/\/cdn\.test\//);
    statusButton = findNode(container, (node) => String(node.className).split(' ').includes('lx-icon-status'));
    assert.ok(statusButton);
    statusButton.dispatch('click');
    await settle();
    const clearCache = findNode(container, (node) => String(node.className).split(' ').includes('lx-list-notice-clear'));
    assert.ok(clearCache);
    clearCache.dispatch('click');
    await settle();
    assert.match(collectText(container), /缓存已清除/);
    statusButton = findNode(container, (node) => String(node.className).split(' ').includes('lx-icon-status'));
    assert.ok(statusButton);
    statusButton.dispatch('click');
    await settle();
    assert.match(collectText(container), /URL 缓存 0 条/);

    const remove = findNode(container, (node) => node.className === 'lx-list-btn lx-list-btn-danger');
    assert.ok(remove);
    remove.dispatch('click');
    assert.equal(remove.textContent, '确认');
    remove.dispatch('click');
    await settle();
    assert.deepEqual(host.store.get('scripts'), []);
    assert.match(collectText(container), /还没有音源脚本/);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => FIXTURE });
    try {
        host.folium.ui.pickFile = async () => ({ name: 'fixture.js', url: 'https://example.test/source.js' });
        const choose = findNode(container, (node) => String(node.className).split(' ').includes('lx-icon-file'));
        assert.ok(choose);
        choose.dispatch('click');
        await settle();
        assert.equal(host.store.get('scripts').length, 1);
        assert.match(collectText(container), /Fixture Source/);
    } finally {
        globalThis.fetch = originalFetch;
    }

    panelDispose();
    dispose();
});

test('the source list reorders scripts (resolve priority follows the list)', async () => {
    const host = createHost();
    host.store.set('scripts', [
        { id: 'a', name: 'Source A', code: FIXTURE, version: '1.0.0', description: 'A', importedAt: 1, enabled: true },
        { id: 'b', name: 'Source B', code: FIXTURE, version: '1.0.0', description: 'B', importedAt: 2, enabled: true },
    ]);
    const dispose = await activate(host.folium);
    const listSection = host.sections.find((section) => section.def.id === 'lx-source-list');
    const doc = createFakeDocument();
    const container = new FakeNode('div', doc);
    const panelDispose = listSection.def.settingsPanel(container, {
        locale: 'zh-CN',
        settings: listSection.settings,
        getTheme: () => ({ primaryColor: '#fff', secondaryColor: '#aaa', accentColor: '#0af', isDaylight: false }),
        onChange: () => () => {},
        every: () => () => {},
        onDispose: () => {},
    });
    await settle();

    assert.deepEqual(host.store.get('scripts').map((entry) => entry.id), ['a', 'b']);
    const cards = [];
    const collect = (node) => {
        if (String(node.className).split(' ').includes('lx-source-card')) cards.push(node);
        for (const child of node.children ?? []) collect(child);
    };
    collect(container);
    assert.equal(cards.length, 2);
    cards[0]._rect = { top: 0, height: 40, left: 0, width: 200 };
    cards[1]._rect = { top: 40, height: 40, left: 0, width: 200 };

    const handle = findNode(container, (node) => String(node.className).split(' ').includes('lx-drag-handle'));
    assert.ok(handle);
    handle.dispatch('pointerdown', { pointerId: 1, clientY: 10 });
    doc.dispatch('pointermove', { pointerId: 1, clientY: 100 });
    doc.dispatch('pointerup', { pointerId: 1, clientY: 100 });
    await settle();

    assert.deepEqual(host.store.get('scripts').map((entry) => entry.id), ['b', 'a']);
    assert.ok(host.rpcCalls.some((call) => call.name === 'lx.clearCache'));

    panelDispose();
    dispose();
});

test('Folium 2.x is accepted (Folia 0.8.0)', async () => {
    const host = createHost();
    host.folium.host.folium = { major: 2, minor: 1 };
    const dispose = await activate(host.folium);
    assert.equal(host.sections.length, 2);
    assert.equal(typeof host.handlers.get('omni.audioSourceResolved'), 'function');
    dispose();
});

test('activation survives a playback source that is not ready yet', async () => {
    const host = createHost();
    host.folium.playback = { getState: () => { throw new Error('playback-unavailable-in-main-context'); } };
    const dispose = await activate(host.folium);
    assert.equal(host.sections.length, 2);
    assert.equal(typeof host.handlers.get('omni.audioSourceResolved'), 'function');
    assert.equal(host.logs.filter(([level]) => level === 'error').length, 0);
    dispose();
});

test('a host older than Folium 2.0 is refused without throwing', async () => {
    const host = createHost();
    host.folium.host.folium = { major: 1, minor: 10 };
    const dispose = await activate(host.folium);
    assert.equal(dispose, undefined);
    assert.equal(host.sections.length, 0);
    assert.ok(host.logs.some(([level, message]) => level === 'error' && /needs Folium 2/.test(message)));
});
