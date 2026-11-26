// test/scriptIdResolver.test.mjs
// Song-id translation helpers live in index.cjs now.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { isQqSongId, resolveSongId } = require('../lx-music-source/index.cjs').__internals;

test('isQqSongId only accepts positive int32 values', () => {
    assert.equal(isQqSongId('340236384'), 340236384);
    assert.equal(isQqSongId(438910555), 438910555);
    assert.equal(isQqSongId('001OAxbu2X5Sop'), null);
    assert.equal(isQqSongId('0'), null);
    assert.equal(isQqSongId('3000000000'), null); // > int32 max → treated as a songmid
});

test('resolveSongId passes non-tx sources through untouched', async () => {
    assert.equal(await resolveSongId('wy', '2652820720'), '2652820720');
    assert.equal(await resolveSongId('kg', 'HASH123'), 'HASH123');
});

test('resolveSongId passes a songmid-shaped tx id through without a request', async () => {
    assert.equal(await resolveSongId('tx', '001OAxbu2X5Sop'), '001OAxbu2X5Sop');
});
