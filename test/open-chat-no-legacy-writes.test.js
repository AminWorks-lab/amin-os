import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavesService } from '../apps/saves/service.js';
import { createHistory } from '../apps/status/history.js';
import { STATE_KEY, emptyState } from '../apps/story-state/schema.js';
import { harness } from '../apps/organizations/test/fixtures.js';
import { memoryBackups } from './fixtures/memory-backups.mjs';

const clone = value => structuredClone(value), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const OLD_FIELDS = ['amin_os_organizations_history_v1', 'world_status_hud_history_v1', 'amin_os_saves_v1'];
const OLD_MESSAGE_IDS = ['amin_org_message_id', 'wsh_message_id'];
function chat({ independent = false } = {}) {
    const callbacks = new Map(); let writes = 0;
    const eventSource = {
        on(key, fn) { if (!callbacks.has(key)) callbacks.set(key, new Set()); callbacks.get(key).add(fn); },
        removeListener(key, fn) { callbacks.get(key)?.delete(fn); },
        emit(key, ...args) { for (const fn of callbacks.get(key) ?? []) fn(...args); },
    };
    const ctx = { chatId: 'fresh', getCurrentChatId() { return this.chatId; }, characterId: 0, characters: [{ avatar: 'hero.png' }],
        chat: [{ name: '角色', is_user: false, mes: '开场白', swipe_id: 0, extra: {} }],
        chatMetadata: { variables: { 状态栏: JSON.stringify({ 版本: 1, 项目: { 主角: { 生命: 8 } } }) }, ...(independent ? { [STATE_KEY]: emptyState() } : {}) },
        async saveMetadata() { writes++; }, eventSource,
        eventTypes: { CHAT_CHANGED: 'chat', MESSAGE_RECEIVED: 'received', USER_MESSAGE_RENDERED: 'user', CHARACTER_MESSAGE_RENDERED: 'character',
            MESSAGE_UPDATED: 'updated', MESSAGE_SWIPED: 'swiped', GENERATION_STARTED: 'started', GENERATION_ENDED: 'ended' } };
    return { ctx, eventSource, writes: () => writes };
}
function assertUntouched(ctx, before) {
    assert.deepEqual(ctx.chatMetadata, before.chatMetadata);
    assert.deepEqual(ctx.chat, before.chat);
    for (const key of OLD_FIELDS) assert.equal(ctx.chatMetadata[key], undefined, key);
    for (const message of ctx.chat) for (const key of OLD_MESSAGE_IDS) assert.equal(message.extra?.[key], undefined, key);
}

for (const independent of [false, true]) test(`opening a ${independent ? 'story' : 'plain'} chat records no checkpoint and writes nothing`, async () => {
    const h = chat({ independent }), before = clone({ chatMetadata: h.ctx.chatMetadata, chat: h.ctx.chat });
    const { files, backups } = memoryBackups(() => h.ctx);
    const api = createSavesService(() => h.ctx, { autoCheckpoints: true, backups });
    try {
        h.eventSource.emit('chat');
        h.eventSource.emit('character', 0); h.eventSource.emit('user', 0);
        h.eventSource.emit('received', 0, 'first_message');
        api.read(); await delay(450);
        assert.equal(h.writes(), 0); assert.equal(files.writes.length, 0);
        assertUntouched(h.ctx, before);
    } finally { api.dispose(); }
});

test('status floor history observes a new chat without assigning IDs or writing history', () => {
    const h = chat(), before = clone({ chatMetadata: h.ctx.chatMetadata, chat: h.ctx.chat });
    const history = createHistory({ context: () => h.ctx, read: () => ({}) });
    history.sync(); h.ctx.chat.push({ name: '玩家', is_user: true, mes: '你好', swipe_id: 0, extra: {} }); history.sync();
    before.chat.push(clone(h.ctx.chat.at(-1)));
    assert.deepEqual(history.list().map(row => row.available), [false, false]);
    assertUntouched(h.ctx, before);
});

test('old floor history and message IDs remain readable without being rewritten', async () => {
    const h = chat();
    h.ctx.chat[0].extra.wsh_message_id = 'old-message';
    h.ctx.chatMetadata.world_status_hud_history_v1 = { version: 1, records: { 'old-message:0': { state: { 项目: { 主角: { 生命: 5 } } }, savedAt: 1 } } };
    const before = clone(h.ctx.chatMetadata), history = createHistory({ context: () => h.ctx, read: () => ({}) });
    history.sync();
    const [row] = history.list();
    assert.equal(row.available, true); assert.equal(row.state.项目.主角.生命, 5);
    assert.equal((await history.readFloor(0)).state.项目.主角.生命, 5);
    assert.deepEqual(h.ctx.chatMetadata, before);
});

test('the organizations store syncs a newly opened chat without creating history, settings or message IDs', () => {
    const { api, ctx } = harness(), before = clone({ chatMetadata: ctx.chatMetadata, chat: ctx.chat });
    api.sync(); api.history(); api.sync();
    assertUntouched(ctx, before);
    assert.equal(ctx.chatMetadata.amin_os_organizations_v1, undefined);
});
