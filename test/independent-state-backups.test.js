import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { emptyState, stateHash, canonicalJSON } from '../apps/story-state/schema.js';
import { sha256HexSync } from '../apps/tts/source-hash.js';
import { createIndependentBackups, createIndependentBackupFileStore, BACKUP_TABLE, LEGACY_TABLE, backupKey, legacySourceKey } from '../apps/story-state/backups.js';
import { chatIdentity } from '../apps/shared/operations.js';

const clone = value => structuredClone(value);
function fixture() {
    let ctx = { chatId: 'one', characterId: 0, characters: [{ avatar: 'person.png' }], chat: [{ mes: 'unchanged' }], chatMetadata: { integrity: 'ready' } };
    const records = new Map(), writes = [];
    const files = { available: () => true, async get(key) { return clone(records.get(key) ?? null); },
        async put(key, value, { expected }) {
            if (!isDeepStrictEqual(records.get(key) ?? null, expected)) throw Object.assign(Error('conflict'), { code: 'AMIN_BACKUP_CONFLICT' });
            records.set(key, clone(value)); writes.push(key);
        } };
    files.getLegacy = files.get;
    files.putLegacy = files.put;
    const service = createIndependentBackups(() => ctx, { files, now: () => '2026-10-10T00:00:00.000Z' });
    return { get ctx() { return ctx; }, set ctx(value) { ctx = value; }, records, writes, files, service };
}
const state = revision => ({ ...emptyState({ updatedAt: '2026-10-10T00:00:00.000Z' }), revision });
test('backup storage is separate, idempotent and bounded by the ring limit (default 10)', async () => {
    const f = fixture(), before = clone(f.ctx);
    for (let revision = 0; revision < 12; revision++) await f.service.savePrevious(f.ctx, state(revision));
    const list = await f.service.list();
    assert.deepEqual(list.map(entry => entry.revision), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    assert.ok(list.every(entry => entry.kind === 'before-change' && Object.keys(entry).sort().join() === 'at,hash,id,kind,label,revision'));
    assert.equal(f.records.size, 1);
    assert.equal(f.service.status().count, 10);
    assert.equal(f.service.status().limit, 10);
    const saved = await f.service.savePrevious(f.ctx, state(11));
    assert.equal(saved.duplicate, true); assert.equal(f.writes.length, 12, 'the same revision is never stored twice');
    const loaded = await f.service.load(f.ctx, list[0].id);
    assert.equal(loaded.revision, 11); assert.deepEqual(loaded.snapshot.modules, state(11).modules);
    assert.deepEqual(f.ctx, before, 'backup writes never mirror or mutate canonical/chat metadata');
    const exported = await f.service.export();
    assert.equal(exported.entries.length, 10); exported.entries[0].revision = 99;
    assert.equal((await f.service.load(list[0].id)).revision, 11);
});
test('a ring limit stored in the chat bounds every kind of backup', async () => {
    const f = fixture(); f.ctx.chatMetadata.amin_os_saves_v1 = { version: 2, saves: [], ring: [], checkpointSettings: { enabled: true, limit: 3 } };
    for (let revision = 0; revision < 5; revision++) await f.service.savePrevious(f.ctx, state(revision), { kind: revision % 2 ? 'auto' : 'before-change' });
    assert.deepEqual((await f.service.list()).map(entry => entry.revision), [4, 3, 2]);
});
test('version 1 backup records stay readable as before-change entries', async () => {
    const f = fixture(), key = backupKey(chatIdentity(f.ctx));
    const hash = stateHash(state(4));
    const old = { version: 1, owner: 'amin-os/independent-backups-v1', chat: chatIdentity(f.ctx), entries: [{ id: 'r4-' + hash.slice(7), hash, at: '2026-10-01T00:00:00.000Z', label: '旧备份', state: state(4) }] };
    f.records.set(key, { ...old, hash: 'sha256:' + sha256HexSync(canonicalJSON(old)) });
    const [entry] = await f.service.list();
    assert.equal(entry.kind, 'before-change'); assert.equal(entry.revision, 4); assert.equal(entry.label, '旧备份');
});
test('two chat identities stay isolated and corrupt checksums refuse without rewriting', async () => {
    const f = fixture(); await f.service.savePrevious(f.ctx, state(1));
    const firstKey = backupKey(chatIdentity(f.ctx)), first = clone(f.records.get(firstKey));
    f.ctx = { ...f.ctx, chatId: 'two', chatMetadata: clone(f.ctx.chatMetadata) };
    assert.deepEqual(await f.service.list(), []);
    await f.service.savePrevious(f.ctx, state(2));
    assert.deepEqual(f.records.get(firstKey), first);
    const ownKey = backupKey(chatIdentity(f.ctx)); f.records.get(ownKey).entries[0].hash = 'sha256:' + '0'.repeat(64);
    const count = f.writes.length;
    await assert.rejects(f.service.list(), /校验不一致/);
    await assert.rejects(f.service.savePrevious(f.ctx, state(3)), /校验不一致/);
    assert.equal(f.writes.length, count);
});
test('unavailable external API disables only backups and performs no writes', async () => {
    const f = fixture(); f.files.available = () => false;
    assert.equal(f.service.available(), false);
    assert.equal((await f.service.savePrevious(f.ctx, state(1))).disabled, true);
    assert.deepEqual(await f.service.list(), []);
    assert.deepEqual(f.ctx.chatMetadata, { integrity: 'ready' });
    assert.equal(f.writes.length, 0);
});
test('chat switch during a pending read rejects without writing a different chat', async () => {
    const f = fixture(); let release;
    f.files.get = () => new Promise(resolve => { release = resolve; });
    const pending = f.service.savePrevious(f.ctx, state(1));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    f.ctx = { ...f.ctx, chatId: 'other', chatMetadata: {} }; release(null);
    await assert.rejects(pending, error => error.code === 'AMIN_BACKUP_CONTEXT_CHANGED');
    assert.equal(f.writes.length, 0);
});
test('host adapter awaits writes, checks expected old record, and verifies the new table', async () => {
    const data = new Map(), calls = [];
    const host = { __TAURITAVERN__: { api: { extension: { store: {
        async tryGetJson({ table, key }) { calls.push(table); return data.has(key) ? { found: true, value: clone(data.get(key)) } : { found: false }; },
        async setJson({ table, key, value }) { calls.push(table); data.set(key, clone(value)); },
    } } } } };
    const files = createIndependentBackupFileStore({ getHostWindow: () => host }), key = backupKey('chat');
    await files.put(key, { value: 1 }, { expected: null });
    await assert.rejects(files.put(key, { value: 2 }, { expected: null }), error => error.code === 'AMIN_BACKUP_CONFLICT');
    await files.put(key, { value: 2 }, { expected: { value: 1 } });
    assert.deepEqual(await files.get(key), { value: 2 });
    assert.ok(calls.every(table => table === BACKUP_TABLE));
    host.__TAURITAVERN__.api.extension.store.setJson = async () => {};
    await assert.rejects(files.put(key, { value: 3 }, { expected: { value: 2 } }), error => error.code === 'AMIN_BACKUP_WRITE_VERIFY_FAILED');
});
test('legacy archive preserves duplicate raw records once, remains immutable and does not touch chat or variables', async () => {
    const f = fixture();
    const sources = { amin_os_characters_v1: { version: 1, events: [{ id: 'duplicate' }, { id: 'duplicate' }] },
        malformedDerived: { original: true } };
    Object.assign(f.ctx.chatMetadata, clone(sources));
    f.ctx.chatMetadata.variables = { 状态栏: 'raw original string', unrelated: 'keep' };
    const before = clone(f.ctx);
    const result = await f.service.archiveLegacy(f.ctx, sources);
    assert.equal(result.archived, true);
    const exported = await f.service.exportLegacy();
    assert.deepEqual(exported.record.sources, sources);
    assert.equal((await f.service.archiveLegacy(f.ctx, sources)).duplicate, true);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.ctx, before);
    sources.malformedDerived.original = false;
    await assert.rejects(f.service.archiveLegacy(f.ctx, sources), error => error.code === 'AMIN_LEGACY_SOURCE_EXISTS');
    assert.equal(f.writes.length, 1);
    assert.equal((await f.service.exportLegacy()).record.sources.malformedDerived.original, true);
});
test('corrupt legacy archives, source changes and changed chat contexts refuse without overwrite', async () => {
    const f = fixture(), sources = { oldStore: { original: true } };
    await f.service.archiveLegacy(f.ctx, sources);
    const key = legacySourceKey(chatIdentity(f.ctx));
    f.records.get(key).hash = 'sha256:' + '0'.repeat(64);
    await assert.rejects(f.service.exportLegacy(), /校验不一致/);
    await assert.rejects(f.service.archiveLegacy(f.ctx, sources), /校验不一致/);
    assert.equal(f.writes.length, 1);
    const g = fixture(); let release;
    g.files.getLegacy = () => new Promise(resolve => { release = resolve; });
    g.ctx.chatMetadata.oldStore = { original: true };
    const changed = g.service.archiveLegacy(g.ctx, sources);
    g.ctx.chatMetadata.oldStore.original = false; release(null);
    await assert.rejects(changed, error => error.code === 'AMIN_LEGACY_SOURCE_CHANGED');
    assert.equal(g.writes.length, 0);
    const switched = g.service.archiveLegacy(g.ctx, sources);
    g.ctx = { ...g.ctx, chatId: 'new-chat', chatMetadata: {} }; release(null);
    await assert.rejects(switched, error => error.code === 'AMIN_BACKUP_CONTEXT_CHANGED');
    assert.equal(g.writes.length, 0);
});
test('legacy archive uses its own host table, forbids overwrite, and disables cleanly without external API', async () => {
    const records = new Map(), tables = [];
    const host = { __TAURITAVERN__: { api: { extension: { store: {
        async tryGetJson({ table, key }) { tables.push(table); return records.has(key) ? { found: true, value: clone(records.get(key)) } : { found: false }; },
        async setJson({ table, key, value }) { tables.push(table); records.set(key, clone(value)); },
    } } } } };
    const f = fixture(), service = createIndependentBackups(() => f.ctx, { getHostWindow: () => host });
    await service.archiveLegacy(f.ctx, { untouched: [1, 2] });
    assert.ok(tables.every(table => table === LEGACY_TABLE));
    const files = createIndependentBackupFileStore({ getHostWindow: () => host }), key = legacySourceKey(chatIdentity(f.ctx));
    await assert.rejects(files.putLegacy(key, { changed: true }, { expected: clone(records.get(key)) }), error => error.code === 'AMIN_LEGACY_IMMUTABLE');
    delete host.__TAURITAVERN__.api.extension.store;
    assert.equal((await service.archiveLegacy(f.ctx, { untouched: [1, 2] })).disabled, true);
    assert.deepEqual(f.ctx.chatMetadata, { integrity: 'ready' });
});
