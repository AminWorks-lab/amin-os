import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavesService } from '../apps/saves/service.js';

// The saves view re-reads on every notify; a failing external read used to
// notify, which re-read, which failed again: an endless read/render loop that
// froze 存档与历史 on its loading state.
function fixture(readRing) {
    let reads = 0;
    const ctx = { chatId: 'loop', getCurrentChatId() { return this.chatId; }, characterId: 0, characters: [{ avatar: 'hero.png' }],
        chat: [{ name: '角色', is_user: false, mes: '开场', swipe_id: 0 }], chatMetadata: {}, async saveMetadata() {} };
    const backups = { available: () => true, readRing: async () => { reads++; return readRing(); }, readNamed: async () => ({ entries: [] }) };
    const api = createSavesService(() => ctx, { autoCheckpoints: false, backups });
    let renders = 0;
    api.subscribe(() => { renders++; api.read(); });
    return { ctx, api, reads: () => reads, renders: () => renders };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test('a failing external read is not retried by its own refresh', async () => {
    const f = fixture(() => { throw Error('磁盘忙'); });
    try {
        const first = f.api.read(); assert.equal(first.storage.loaded, false);
        await settle();
        assert.equal(f.reads(), 1); assert.ok(f.renders() <= 2, `renders ${f.renders()}`);
        assert.match(f.api.read().storage.error, /外置存档读取失败：磁盘忙/);
        f.api.reloadExternal(); await settle();
        assert.equal(f.reads(), 2, 'an explicit retry reads again');
    } finally { f.api.dispose(); }
});
test('a successful external read is done once and cached', async () => {
    const f = fixture(() => ({ entries: [] }));
    try {
        f.api.read(); await settle(); f.api.read(); f.api.read(); await settle();
        assert.equal(f.reads(), 1); assert.equal(f.api.read().storage.loaded, true);
    } finally { f.api.dispose(); }
});
