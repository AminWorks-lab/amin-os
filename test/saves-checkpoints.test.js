import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavesService } from '../apps/saves/service.js';
import { KEY, validateSnapshot, validateStore } from '../apps/saves/model.js';
import { chatIdentity, publishExternalMetadataChange } from '../apps/shared/operations.js';
import { memoryFiles } from './fixtures/memory-backups.mjs';
import { createIndependentBackups } from '../apps/story-state/backups.js';

const clone = value => structuredClone(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture({ automatic = false, loadBranchHost } = {}) {
    let writes = 0, branches = 0, seq = 0, fail = false, original;
    const callbacks = new Map(), eventSource = {
        on(key, fn) { if (!callbacks.has(key)) callbacks.set(key, new Set()); callbacks.get(key).add(fn); },
        removeListener(key, fn) { callbacks.get(key)?.delete(fn); },
        emit(key) { for (const fn of callbacks.get(key) ?? []) fn(); },
    };
    let ctx = { chatId: 'original', getCurrentChatId() { return this.chatId; }, characterId: 0, characters: [{ avatar: 'hero.png' }],
        chat: [{ name: '角色', is_user: false, mes: '来到客房', swipe_id: 0 }], chatMetadata: { variables: { 状态栏: JSON.stringify({ 版本: 1, 项目: { 主角: { 生命: 8 } } }), unrelated: 'KEEP' }, other: 'KEEP' },
        async saveMetadata() { writes++; if (fail) throw Error('disk offline'); },
        ...(automatic ? { eventSource, eventTypes: { CHAT_CHANGED: 'chat', MESSAGE_RECEIVED: 'message', MESSAGE_SWIPED: 'swipe' } } : {}) };
    const host = { async branchChat(index) {
        branches++; original = ctx;
        const next = { ...ctx, chatId: 'original - Branch #' + branches, chat: clone(ctx.chat.slice(0, index + 1)), chatMetadata: clone(ctx.chatMetadata) };
        ctx = next; eventSource.emit('chat'); return next.chatId;
    } };
    const files = memoryFiles(), backups = createIndependentBackups(() => ctx, { files });
    const api = createSavesService(() => ctx, { createId: () => 'save-' + (++seq), now: () => '2026-09-23T00:00:00.000Z', loadBranchHost: loadBranchHost ?? (async () => host), autoCheckpoints: automatic, backups });
    return { api, files, get ctx() { return ctx; }, get original() { return original; }, host, eventSource, writes: () => writes, branches: () => branches, fail: value => { fail = value; },
        replace: value => { ctx = value; }, listenerCount: () => [...callbacks.values()].reduce((sum, set) => sum + set.size, 0),
        hp(value) { ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 版本: 1, 项目: { 主角: { 生命: value } } }); },
    };
}

test('checkpoints capture only the actual tail and keep candidate and content revisions separate', async () => {
    const h = fixture();
    const first = await h.api.captureCheckpoint(); assert.equal(first.source.floor, 1); assert.equal(first.source.path.length, 1);
    assert.equal(h.api.read().checkpoints.length, 1);
    assert.equal((await h.api.captureCheckpoint()).id, first.id); assert.equal(h.writes(), 1, 'no duplicate persistence');
    h.hp(7); await h.api.captureCheckpoint(); assert.equal(h.api.read().checkpoints.length, 2); assert.equal(h.api.read().checkpoints.at(-1).modules.status.项目.主角.生命, 7);
    h.ctx.chat[0].swipe_id = 1; h.ctx.chat[0].mes = '来到市场'; await h.api.captureCheckpoint();
    assert.equal(h.api.read().checkpoints.length, 3); assert.equal(h.api.branchAvailability(first.id).available, false);
    h.ctx.chat[0].swipe_id = 0; h.ctx.chat[0].mes = '来到客房'; assert.equal(h.api.branchAvailability(first.id).available, true);
    h.ctx.chat.push({ name: '玩家', is_user: true, mes: '休息' }); await h.api.captureCheckpoint();
    assert.equal(h.api.read().checkpoints.length, 4); assert.equal(h.api.branchAvailability(first.id).available, true);
    h.ctx.chat[0].mes = '已修改'; assert.match(h.api.branchAvailability(first.id).reason, /编辑/); h.api.dispose();
});

test('old stores and snapshots remain usable without pretending to have historical source proof', async () => {
    const h = fixture(); h.api.stageSave({ name: '旧存档' }); await h.api.confirm();
    const saved = clone(h.api.read().saves[0]); delete saved.source.path; delete saved.source.candidateBinding;
    // A 0.18 chat on a host without the external store: every record is inline in metadata.
    h.files.enabled = false; h.ctx.chatMetadata[KEY] = { version: 1, saves: [saved], backups: [] };
    assert.equal(h.api.read().checkpointSettings.enabled, true); assert.deepEqual(h.api.read().checkpoints, []);
    assert.match(h.api.branchAvailability(saved.id).reason, /旧版/); assert.throws(() => h.api.stageBranch(saved.id), /旧版/);
    h.api.stageRestore(saved.id); await h.api.confirm();
    assert.equal(h.api.read().backups.length, 1); h.api.dispose();
});

test('checkpoint source paths reject incomplete and mismatched candidate data', async () => {
    const h = fixture(), saved = await h.api.captureCheckpoint();
    for (const alter of [s => s.source.path.pop(), s => s.source.candidate++, s => s.source.path[0] = '{}',
        s => s.source.path[0] = 'sha256:' + 'a'.repeat(64), s => delete s.source.candidateBinding]) {
        const bad = clone(saved); alter(bad); assert.throws(() => validateSnapshot(bad), /来源|修订|候选/);
    }
    const old = clone(saved); delete old.source.path; delete old.source.candidateBinding;
    assert.throws(() => validateStore({ version: 1, saves: [], backups: [], checkpoints: [old] }), /完整来源/); h.api.dispose();
});

test('checkpoint retention and settings are per chat and never erase named saves', async () => {
    const h = fixture(); h.api.stageSave({ name: '永久' }); await h.api.confirm();
    h.api.stageCheckpointSettings({ enabled: true, limit: 2 }); await h.api.confirm();
    for (let index = 0; index < 4; index++) { h.ctx.chat.push({ name: '角色', mes: '剧情' + index }); await h.api.captureCheckpoint(); }
    assert.deepEqual(h.api.read().checkpoints.map(saved => saved.source.floor), [4, 5]); assert.equal(h.api.read().saves.length, 1);
    h.api.stageCheckpointSettings({ enabled: false, limit: 2 }); await h.api.confirm();
    h.ctx.chat.push({ name: '角色', mes: '暂停期间' }); assert.equal(await h.api.captureCheckpoint({ automatic: true }), null);
    const next = { ...h.ctx, chatId: 'another', chatMetadata: {} }; h.replace(next);
    assert.equal(h.api.read().checkpointSettings.enabled, true); assert.equal(h.api.read().checkpoints.length, 0); h.api.dispose();
});

test('branch confirmation creates one native branch then restores exact saved state without changing source metadata', async () => {
    const h = fixture(), saved = await h.api.captureCheckpoint();
    h.ctx.chat.push({ name: '角色', mes: '走出旅店' }); h.hp(2);
    const source = clone(h.ctx.chatMetadata), preview = h.api.stageBranch(saved.id);
    assert.equal(preview.summary.kind, 'branch'); assert.equal(h.branches(), 0);
    await h.api.confirm(); assert.equal(h.branches(), 1); assert.equal(h.ctx.chat.length, 1);
    assert.equal(JSON.parse(h.ctx.chatMetadata.variables.状态栏).项目.主角.生命, 8);
    assert.deepEqual(h.original.chatMetadata, source); assert.equal(h.ctx.chatMetadata.other, 'KEEP');
    assert.equal(h.api.read().checkpoints.at(-1).source.identity, chatIdentity(h.ctx));
    assert.equal(h.api.read().backups.length, 0, 'never label inherited future state as the old floor backup');
    await assert.rejects(async () => h.api.confirm(), /没有待确认/); h.api.dispose();
});

test('branch save failure retries persistence without creating another branch', async () => {
    const h = fixture(), saved = await h.api.captureCheckpoint(); h.ctx.chat.push({ name: '角色', mes: '未来' }); h.hp(1);
    h.api.stageBranch(saved.id); h.fail(true); await assert.rejects(h.api.confirm(), /已创建.*保存/);
    assert.equal(h.api.dirty(), true); assert.equal(h.branches(), 1);
    const data = clone(h.ctx.chatMetadata); h.fail(false); await h.api.retrySave();
    assert.equal(h.branches(), 1); assert.deepEqual(h.ctx.chatMetadata, data); h.api.dispose();
});

test('branch import, unsupported hosts, stale candidates and wrong destination fail before data restoration', async () => {
    const h = fixture({ loadBranchHost: async () => ({}) }), saved = await h.api.captureCheckpoint();
    h.api.stageBranch(saved.id); const before = clone(h.ctx.chatMetadata);
    await assert.rejects(h.api.confirm(), /未提供兼容/); assert.deepEqual(h.ctx.chatMetadata, before); assert.equal(h.api.busy(), false);
    h.api.discard(); h.ctx.chatId = 'other'; assert.throws(() => h.api.stageBranch(saved.id), /原聊天|外置存储/); h.api.dispose();
    const other = fixture(), record = await other.api.captureCheckpoint(); other.api.stageBranch(record.id); other.ctx.chat[0].swipe_id = 2;
    await assert.rejects(other.api.confirm(), /变化/); assert.equal(other.branches(), 0); other.api.dispose();
    const wrong = fixture({ loadBranchHost: async () => ({ branchChat: async () => 'wrong' }) }), checkpoint = await wrong.api.captureCheckpoint();
    wrong.api.stageBranch(checkpoint.id); const wrongBefore = clone(wrong.ctx.chatMetadata);
    await assert.rejects(wrong.api.confirm(), /预期的新分支/); assert.deepEqual(wrong.ctx.chatMetadata, wrongBefore); wrong.api.dispose();
});

test('loading the native branch adapter cannot cause duplicate concurrent confirmation', async () => {
    let release; const ready = new Promise(resolve => { release = resolve; });
    const h = fixture({ loadBranchHost: async () => { await ready; return h.host; } }), saved = await h.api.captureCheckpoint();
    h.api.stageBranch(saved.id); const confirmation = h.api.confirm();
    await assert.rejects(h.api.confirm(), /重复确认/); release(); await confirmation; assert.equal(h.branches(), 1); h.api.dispose();
});

test('background checkpoint listeners follow actual messages and committed state and dispose cleanly', async () => {
    const h = fixture({ automatic: true });
    await delay(450); assert.equal(h.api.read().checkpoints.length, 0, 'opening a chat records nothing');
    assert.equal(h.writes(), 0); assert.equal(h.ctx.chatMetadata[KEY], undefined);
    h.eventSource.emit('message'); await delay(450);
    assert.equal(h.api.read().checkpoints.length, 0, 'a chat without Amin data or saves is left untouched');
    await h.api.captureCheckpoint(); assert.equal(h.api.read().checkpoints.length, 1);
    h.ctx.chat.push({ name: '角色', mes: '新一楼' }); h.eventSource.emit('message'); await delay(450);
    assert.deepEqual(h.api.read().checkpoints.map(saved => saved.source.floor), [1, 2]);
    h.hp(4); publishExternalMetadataChange(() => h.ctx, [['variables', '状态栏']], { phase: 'saved' }); await delay(450);
    assert.equal(h.api.read().checkpoints.at(-1).modules.status.项目.主角.生命, 4);
    const writes = h.writes(); h.api.dispose(); assert.equal(h.listenerCount(), 0); h.eventSource.emit('message'); await delay(450); assert.equal(h.writes(), writes);
});
