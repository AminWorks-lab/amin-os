import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavesService } from '../apps/saves/service.js';
import { createOperationService, subscribeStateChanges } from '../apps/shared/operations.js';
import { memoryBackups } from './fixtures/memory-backups.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
    let writes = 0, slow = null;
    const callbacks = new Map(), eventSource = {
        on(key, fn) { if (!callbacks.has(key)) callbacks.set(key, new Set()); callbacks.get(key).add(fn); },
        removeListener(key, fn) { callbacks.get(key)?.delete(fn); },
        emit(key, ...args) { for (const fn of callbacks.get(key) ?? []) fn(...args); },
    };
    const ctx = { chatId: 'story', getCurrentChatId() { return this.chatId; }, characterId: 0, characters: [{ avatar: 'hero.png' }],
        chat: [{ name: '角色', is_user: false, mes: '开场', swipe_id: 0 }],
        // The user already keeps saves in this chat, so automatic checkpoints are allowed here.
        chatMetadata: { variables: { 状态栏: JSON.stringify({ 版本: 1, 项目: { 主角: { 生命: 8 } } }) }, amin_os_saves_v1: { version: 2, saves: [], ring: [], checkpointSettings: { enabled: true, limit: 10 } } },
        async saveMetadata() { writes++; if (slow) await slow(); },
        eventSource, eventTypes: { CHAT_CHANGED: 'chat', MESSAGE_RECEIVED: 'received', USER_MESSAGE_RENDERED: 'user', GENERATION_STARTED: 'started', GENERATION_ENDED: 'ended', GENERATION_STOPPED: 'stopped' } };
    const { backups } = memoryBackups(() => ctx);
    const api = createSavesService(() => ctx, { createId: (() => { let n = 0; return () => 'id-' + (++n); })(), autoCheckpoints: true, backups });
    return { api, ctx, eventSource, writes: () => writes, slow: fn => { slow = fn; } };
}
// A follow-up writer such as the linkage auto update.
async function followUp(ctx) {
    const operations = createOperationService(() => ctx);
    try {
        operations.stage({ label: '联动更新', patches: [{ path: ['variables', '状态栏'], value: JSON.stringify({ 版本: 1, 项目: { 主角: { 生命: 5 } } }) }] });
        return await operations.confirm();
    } finally { operations.dispose(); }
}

test('a background checkpoint whose save goes stale does not leave the chat dirty', async () => {
    const h = fixture(), phases = [];
    const off = subscribeStateChanges(detail => phases.push(detail.phase));
    try {
        await delay(450); assert.equal(h.api.read().checkpoints.length, 0, 'opening a chat records nothing');
        h.eventSource.emit('received'); await delay(450); assert.equal(h.api.read().checkpoints.length, 1);
        // The host appends its reply while the checkpoint is being saved.
        h.ctx.chat.push({ name: '玩家', is_user: true, mes: '继续', swipe_id: 0 });
        h.slow(async () => { h.ctx.chat.push({ name: '角色', is_user: false, mes: '回复', swipe_id: 0 }); await delay(5); });
        h.eventSource.emit('received'); await delay(450); h.slow(null);
        assert.ok(phases.includes('stale'), 'the checkpoint save observed a changed chat');
        assert.equal(h.api.dirty(), false, 'a disposable checkpoint must not hold the chat dirty');
        assert.equal(h.api.checkpointStatus(), '');
        const result = await followUp(h.ctx);
        assert.equal(result.saved, true, 'the linkage update is not blocked');
    } finally { off(); h.api.dispose(); }
});

test('automatic checkpoints wait for an active generation and are rebuilt after it ends', async () => {
    const h = fixture();
    try {
        h.eventSource.emit('received'); await delay(450); const before = h.writes();
        h.eventSource.emit('started', 'normal', {}, false);
        h.ctx.chat.push({ name: '玩家', is_user: true, mes: '继续', swipe_id: 0 }); h.eventSource.emit('received');
        await delay(450); assert.equal(h.writes(), before, 'no checkpoint while generating');
        h.ctx.chat.push({ name: '角色', is_user: false, mes: '回复', swipe_id: 0 });
        h.eventSource.emit('ended'); await delay(450);
        assert.deepEqual(h.api.read().checkpoints.map(saved => saved.source.floor), [1, 3]);
        assert.equal(h.api.dirty(), false);
        h.eventSource.emit('started', 'quiet', {}, false); h.ctx.chat.at(-1).mes = '改写'; h.eventSource.emit('received');
        await delay(450); assert.equal(h.api.read().checkpoints.at(-1).source.floor, 3);
        assert.equal(h.api.read().checkpoints.length, 3, 'quiet generations do not pause checkpoints');
        h.eventSource.emit('started', 'normal', {}, true); h.ctx.chat.at(-1).mes = '再改'; h.eventSource.emit('received');
        await delay(450); assert.equal(h.api.read().checkpoints.length, 4, 'dry runs do not pause checkpoints');
        h.eventSource.emit('started', 'regenerate', {}, false); h.eventSource.emit('stopped');
        h.ctx.chat.at(-1).mes = '停止后'; h.eventSource.emit('received'); await delay(450);
        assert.equal(h.api.read().checkpoints.length, 5, 'a stopped generation resumes checkpoints');
    } finally { h.api.dispose(); }
});

test('a manual checkpoint keeps the explicit stale-save contract', async () => {
    const h = fixture();
    try {
        await delay(450);
        h.ctx.chat.push({ name: '玩家', is_user: true, mes: '手动', swipe_id: 0 });
        h.slow(async () => { h.ctx.chat.push({ name: '角色', mes: '回复', swipe_id: 0 }); });
        await assert.rejects(h.api.captureCheckpoint(), error => error.code === 'STALE_COMPLETION');
        h.slow(null); assert.equal(h.api.dirty(), true);
        await h.api.retrySave(); assert.equal(h.api.dirty(), false);
    } finally { h.api.dispose(); }
});
