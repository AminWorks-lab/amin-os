import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareUpdateEntry, installUpdateEntry, ENTRY_MARKER } from '../apps/status/lorebook.js';

// The shared owned-entry writer (used by the unified linkage entry) must never
// overwrite user entries or entries owned by another app.
const create = (name, book) => { const uid = Math.max(-1, ...Object.keys(book.entries).map(Number)) + 1; return book.entries[uid] = { uid }; };
const opts = { ownerField: 'amin_test_owner', marker: 'amin-os/test-v1', title: '测试 · 更新规则', prompt: '规则', enabled: true };
const context = () => ({ characters: [{ data: { extensions: { world: 'book' } } }], characterId: 0, chatMetadata: {}, getRequestHeaders: () => ({}) });

test('new worldbook entry never overwrites user same-name entry or another owned rule', () => {
    const original = { entries: { 0: { uid: 0, comment: opts.title, content: 'user' }, 1: { uid: 1, world_status_hud_owner: ENTRY_MARKER, content: 'status' } } };
    const result = prepareUpdateEntry(original, 'book', create, '', opts);
    assert.equal(Object.keys(result.book.entries).length, 3);
    assert.deepEqual(result.book.entries[0], original.entries[0]); assert.deepEqual(result.book.entries[1], original.entries[1]);
    assert.equal(result.entry.amin_test_owner, opts.marker); assert.equal(Object.keys(original.entries).length, 2);
});

test('resync only modifies the owned entry; disabling turns it off; title and content are required', () => {
    const first = prepareUpdateEntry({ entries: {} }, 'book', create, '', opts);
    const second = prepareUpdateEntry(first.book, 'book', create, '', { ...opts, enabled: false });
    assert.equal(Object.keys(second.book.entries).length, 1); assert.equal(second.entry.disable, true); assert.ok(second.previous);
    assert.throws(() => prepareUpdateEntry({ entries: {} }, 'book', create, '', { ...opts, prompt: undefined }), /缺少标题或内容/);
});

test('worldbook cache conflicts stop before the edit request', async () => {
    const ctx = context(); let edits = 0;
    await assert.rejects(installUpdateEntry({ context: () => ctx, check() {}, entryOptions: opts,
        loadModule: async () => ({ createWorldInfoEntry: create, worldInfoCache: new Map([['book', { entries: { 0: { content: 'unsaved' } } }]]) }),
        fetcher: async route => { if (route.endsWith('/edit')) edits++; return { ok: true, json: async () => ({ entries: {} }) }; } }), /未同步/);
    assert.equal(edits, 0);
});

test('worldbook changes between first read and save are rejected', async () => {
    const ctx = context(); let gets = 0, edits = 0;
    await assert.rejects(installUpdateEntry({ context: () => ctx, check() {}, entryOptions: opts, loadModule: async () => ({ createWorldInfoEntry: create }),
        fetcher: async route => { if (route.endsWith('/edit')) edits++; return { ok: true, json: async () => ++gets === 1 ? { entries: {} } : { entries: { 0: { uid: 0, content: 'concurrent' } } } }; } }), /其他操作/);
    assert.equal(edits, 0);
});
