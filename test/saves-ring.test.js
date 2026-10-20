import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavesService } from '../apps/saves/service.js';
import { KEY } from '../apps/saves/model.js';
import { createIndependentBackups, backupKey, namedKey } from '../apps/story-state/backups.js';
import { STATE_KEY, emptyState } from '../apps/story-state/schema.js';
import { chatIdentity } from '../apps/shared/operations.js';
import { memoryFiles } from './fixtures/memory-backups.mjs';

const clone = value => structuredClone(value), at = '2026-10-20T00:00:00.000Z';
const REF_KEYS = 'at,hash,id,kind,label,revision';
const status = ctx => JSON.parse(ctx.chatMetadata.variables.状态栏).项目.主角.生命;
function fixture({ external = true, independent = false, metadata = {}, prefix = 'id' } = {}) {
    let writes = 0, seq = 0;
    const ctx = { chatId: 'ring', getCurrentChatId() { return this.chatId; }, characterId: 0, characters: [{ avatar: 'hero.png' }],
        chat: [{ name: '角色', is_user: false, mes: '开场', swipe_id: 0 }],
        chatMetadata: { variables: { 状态栏: JSON.stringify({ 版本: 1, 项目: { 主角: { 生命: 8 } } }) },
            ...(independent ? { [STATE_KEY]: emptyState({ updatedAt: at }) } : {}), ...clone(metadata) },
        async saveMetadata() { writes++; } };
    const files = memoryFiles({ available: external }), backups = createIndependentBackups(() => ctx, { files, now: () => at });
    const service = () => createSavesService(() => ctx, { createId: () => prefix + '-' + (++seq), now: () => at, autoCheckpoints: false, backups });
    const api = service();
    return { ctx, files, backups, api, service, writes: () => writes,
        hp(value) { ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 版本: 1, 项目: { 主角: { 生命: value } } }); },
        ring: () => files.records.get(backupKey(chatIdentity(ctx)))?.entries ?? [],
        named: () => files.records.get(namedKey(chatIdentity(ctx)))?.entries ?? [] };
}
/** A 0.18 (version 1) store: every save, backup and checkpoint as a full snapshot in metadata. */
async function versionOneStore() {
    const h = fixture({ external: false, prefix: 'old' });
    h.api.stageSave({ name: '旧命名存档' }); await h.api.confirm();
    h.hp(6); const checkpoint = await h.api.captureCheckpoint();
    h.api.stageRestore(h.api.read().saves[0].id); await h.api.confirm();
    const store = { version: 1, saves: h.api.read().saves, backups: h.api.read().backups, checkpoints: [checkpoint], checkpointSettings: { enabled: true, limit: 12 } };
    h.api.dispose();
    return store;
}

test('with the external store, named saves and the ring live outside the chat and metadata keeps references only', async () => {
    const h = fixture();
    h.api.stageSave({ name: '旅店' }); await h.api.confirm();
    const store = h.ctx.chatMetadata[KEY];
    assert.equal(store.version, 2);
    assert.equal(Object.keys(store.saves[0]).sort().join(), REF_KEYS);
    assert.equal(store.saves[0].kind, 'named');
    assert.equal(h.named().length, 1);
    assert.equal(h.api.read().saves[0].modules.status.项目.主角.生命, 8);
    h.hp(3); h.api.stageRestore(store.saves[0].id); await h.api.confirm();
    assert.equal(status(h.ctx), 8);
    const [ref] = h.ctx.chatMetadata[KEY].ring;
    assert.equal(Object.keys(ref).sort().join(), REF_KEYS);
    assert.equal(ref.kind, 'before-restore');
    assert.equal(h.ring().length, 1);
    assert.equal(h.ring()[0].kind, 'before-restore');
    assert.deepEqual(h.ring()[0].snapshot.source.path.length, 1, 'each entry carries its source message path');
    assert.equal(h.ring()[0].snapshot.modules.status.项目.主角.生命, 3);
    assert.ok(!JSON.stringify(h.ctx.chatMetadata[KEY]).includes('"modules"'), 'no full snapshot stays in metadata');
    // A reopened page reads the external lists before the records become usable.
    const again = h.service();
    await again.load();
    assert.equal(again.read().backups[0].modules.status.项目.主角.生命, 3);
    assert.equal(again.read().saves[0].name, '旅店');
    h.api.dispose(); again.dispose();
});

test('without the external store, named saves stay inline and at most two ring snapshots are kept', async () => {
    const h = fixture({ external: false });
    h.api.stageSave({ name: '内联' }); await h.api.confirm();
    assert.equal(h.ctx.chatMetadata[KEY].saves[0].snapshot.name, '内联');
    for (let floor = 0; floor < 4; floor++) { h.ctx.chat.push({ name: '角色', mes: '剧情' + floor }); await h.api.captureCheckpoint(); }
    assert.equal(h.api.read().checkpoints.length, 2);
    assert.ok(h.ctx.chatMetadata[KEY].ring.filter(item => item.snapshot).length <= 2);
    assert.deepEqual(h.api.read().checkpoints.map(saved => saved.source.floor), [4, 5]);
    assert.equal(h.files.writes.length, 0);
    assert.equal(h.api.read().storage.external, false);
    h.api.dispose();
});

test('version 1 metadata stays listable and restorable without writes, then moves out on the next write', async () => {
    const v1 = await versionOneStore(), h = fixture({ metadata: { [KEY]: v1 } }), before = clone(h.ctx.chatMetadata);
    await h.api.load();
    const listed = h.api.read();
    assert.deepEqual([listed.saves.length, listed.backups.length, listed.checkpoints.length], [1, 1, 1]);
    assert.equal(listed.storage.legacy, true);
    assert.deepEqual(h.ctx.chatMetadata, before, 'listing never rewrites old metadata');
    assert.equal(h.writes(), 0); assert.equal(h.files.writes.length, 0);
    h.hp(1); h.api.stageRestore(v1.checkpoints[0].id);
    assert.deepEqual(h.ctx.chatMetadata[KEY], v1, 'a preview writes nothing');
    await h.api.confirm();
    assert.equal(status(h.ctx), 6, 'the old checkpoint restored');
    const store = h.ctx.chatMetadata[KEY];
    assert.equal(store.version, 2); assert.equal(store.legacy, undefined);
    assert.ok(!JSON.stringify(store).includes('"modules"'), 'migrated copies are cleared from metadata');
    assert.deepEqual(h.named().map(saved => saved.id), [v1.saves[0].id]);
    const ids = h.ring().map(entry => entry.snapshot.id);
    for (const id of [v1.backups[0].id, v1.checkpoints[0].id]) assert.ok(ids.includes(id), 'old entry moved to the ring: ' + id);
    assert.equal(h.ring().find(entry => entry.snapshot.id === v1.checkpoints[0].id).kind, 'auto');
    assert.equal(h.ring().find(entry => entry.snapshot.id === v1.backups[0].id).kind, 'before-restore');
    assert.equal(store.checkpointSettings.limit, 12, 'existing settings are kept');
    h.api.dispose();
});

test('a failed migration keeps the original metadata copies and the next write retries', async () => {
    const v1 = await versionOneStore();
    // Nothing reaches the external store: the chat keeps its version 1 data.
    const whole = fixture({ metadata: { [KEY]: v1 } });
    whole.files.failNext(Error('disk offline'));
    whole.api.stageSave({ name: '新存档' }); await assert.rejects(whole.api.confirm(), /disk offline/);
    assert.deepEqual(whole.ctx.chatMetadata[KEY], v1);
    whole.api.dispose();
    // Named saves moved but the ring append failed: old checkpoints stay in metadata.
    const h = fixture({ metadata: { [KEY]: v1 } });
    h.files.failNext(Error('ring offline'), 'backups-');
    h.api.stageSave({ name: '新存档' }); await h.api.confirm();
    const store = h.ctx.chatMetadata[KEY];
    assert.deepEqual(store.legacy.checkpoints.map(saved => saved.id), [v1.checkpoints[0].id]);
    assert.deepEqual(store.legacy.backups.map(saved => saved.id), [v1.backups[0].id]);
    assert.match(h.api.checkpointStatus(), /原资料保留/);
    assert.equal(h.api.read().checkpoints.length, 1);
    assert.equal(h.api.read().saves.length, 2);
    h.hp(2); h.api.stageRestore(v1.checkpoints[0].id); await h.api.confirm();
    assert.equal(status(h.ctx), 6, 'old checkpoints stay restorable');
    assert.equal(h.ctx.chatMetadata[KEY].legacy, undefined, 'the next write migrates them');
    assert.ok(h.ring().some(entry => entry.snapshot.id === v1.checkpoints[0].id));
    h.api.dispose();
});

test('a revision is stored once, the default ring keeps ten and that limit bounds every kind', async () => {
    const h = fixture({ independent: true });
    assert.equal(h.api.read().checkpointSettings.limit, 10);
    const first = await h.api.captureCheckpoint(), writes = h.files.writes.length;
    assert.equal((await h.api.captureCheckpoint()).id, first.id);
    h.ctx.chat.push({ name: '角色', mes: '未改变剧情' });
    await h.api.captureCheckpoint({ automatic: true });
    assert.equal(h.files.writes.length, writes, 'the same revision is never stored twice');
    // The runtime's pre-change backup of that revision is the same ring entry.
    assert.equal((await h.backups.savePrevious(h.ctx, h.ctx.chatMetadata[STATE_KEY])).duplicate, true);
    for (let revision = 1; revision <= 12; revision++) {
        h.ctx.chatMetadata[STATE_KEY] = { ...h.ctx.chatMetadata[STATE_KEY], revision };
        h.ctx.chat.push({ name: '角色', mes: '第 ' + revision + ' 次' });
        await h.api.captureCheckpoint({ automatic: true });
    }
    const revisions = h.ring().map(entry => entry.revision);
    assert.equal(revisions.length, 10); assert.equal(new Set(revisions).size, 10);
    assert.deepEqual(revisions, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    assert.equal(h.ctx.chatMetadata[KEY].ring.length, 10);
    h.api.stageCheckpointSettings({ enabled: true, limit: 3 }); await h.api.confirm();
    assert.equal(h.ring().length, 3);
    await h.backups.savePrevious(h.ctx, { ...h.ctx.chatMetadata[STATE_KEY], revision: 13 });
    assert.equal(h.ring().length, 3, 'pre-change backups share the same limit');
    h.api.dispose();
});
