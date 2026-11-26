// test/probe.mjs
// Runs one LX source script exactly like the mod's main process does and prints
// the resolved URL, plus every request the script fired.
//
//   node test/probe.mjs <script.js> <source> <id> [quality]
//   node test/probe.mjs ./my-source.js wy 186016 320k
//
// `source` is an LX source id: wy / tx / kg / kw / mg. Pass the platform id the
// script expects (wy/tx/kw: songmid, kg: FileHash, mg: copyrightId).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const {
    buildMusicInfo,
    createLxRuntime,
    decodeLxScript,
    httpRequest,
    parseScriptMeta,
    qualityLadder,
} = require('../lx-music-source/index.cjs').__internals;

const [file, source, id, preferred = '320k'] = process.argv.slice(2);
if (!file || !source || !id) {
    console.error('usage: node test/probe.mjs <script.js> <source> <id> [quality]');
    process.exit(2);
}

const raw = readFileSync(file, 'utf8');
const code = decodeLxScript(raw);
const meta = parseScriptMeta(code, file);

const requests = [];
const runtime = createLxRuntime({
    request: (url, options, callback) => {
        requests.push({ url, options });
        return httpRequest(url, options, callback);
    },
    log: {
        info: (...parts) => console.log('[info]', ...parts),
        warn: (...parts) => console.warn('[warn]', ...parts),
        error: (...parts) => console.error('[error]', ...parts),
    },
    options: () => ({ requestTimeoutMs: 15000 }),
    info: { ...meta, rawScript: code },
});

runtime.run(code);

await Promise.race([
    runtime.whenInited(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
]);

console.log('script:', meta.name, meta.version ? `v${meta.version}` : '');
console.log('declared sources:', JSON.stringify(runtime.sources, null, 2));
const quality = qualityLadder(runtime.sources, source, preferred)[0];
console.log(`requesting ${source}:${id} quality=${quality} (preferred ${preferred})`);

try {
    const url = await runtime.resolveMusicUrl(source, buildMusicInfo(source, id), quality);
    console.log('RESOLVED URL:', url);
    console.log('requests:', requests.length);
    for (const request of requests) console.log(' ', request.options.method || 'GET', request.url);
} catch (error) {
    console.error('FAILED:', error.message);
    console.error('requests:', requests.length);
    for (const request of requests) console.error(' ', request.options.method || 'GET', request.url);
    process.exitCode = 1;
} finally {
    runtime.dispose();
}
