import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndependentMigration } from '../apps/story-state/migration.js';
import { KEY, STATE_FORMAT, emptyState } from '../apps/story-state/schema.js';
import { buildRestore, KEY as CHARACTERS_KEY } from '../apps/characters/model.js';
import { chatIdentity } from '../apps/shared/operations.js';
import { canonicalJSON } from '../apps/story-state/schema.js';
import { sha256HexSync } from '../apps/tts/source-hash.js';

// A 0.17.4 current-story export, sealed exactly as that release wrote it.
function currentStoryExport(ctx) {
    const digest = value => 'sha256:' + sha256HexSync(canonicalJSON(value));
    const state = { version: 2, variables: { AminOS人物: JSON.parse(ctx.chatMetadata.variables.AminOS人物) }, rules: {}, jsonStringRoots: ['AminOS人物'] };
    const data = { version: 1, owner: 'amin-os/current-story-v1', chat: chatIdentity(ctx), revision: 1, backups: [],
        current: { state, hash: digest(state), at: 1, label: '当前状态' } };
    return { format: 'amin-os-current-story', version: 1, record: { ...data, hash: digest(data) } };
}
const person = { id: 'person', name: '人物', kind: 'pc', notes: '', stats: [] };
function fixture() {
    let ctx = { chatId: 'migration', characterId: 0, characters: [{ avatar: 'one.png' }], chat: [{ mes: 'original', swipe_id: 0 }],
        chatMetadata: { integrity: 'ready', variables: {}, extensions: { LittleWhiteBox: { keep: 'native-history' } } },
        extensionSettings: { protected: 'global-settings' } };
    const service = createIndependentMigration(() => ctx);
    return { get ctx() { return ctx; }, set ctx(value) { ctx = value; }, service };
}
test('app and native migration remain explicit previews and preserve all source stores', () => {
    const f = fixture();
    f.ctx.chatMetadata[CHARACTERS_KEY] = buildRestore(f.ctx, { version: 1, characters: [person] }, { id: 'event', at: '2026-10-10T00:00:00.000Z' });
    f.ctx.chatMetadata.variables.AminOS人物 = JSON.stringify({ version: 1, characters: [{ ...person, name: '原生当前' }] });
    const before = structuredClone(f.ctx);
    const app = f.service.previewLegacy({ source: 'app' }), native = f.service.previewLegacy({ source: 'native' });
    assert.equal(app.valid, true); assert.equal(native.valid, true);
    assert.equal(f.service.validatePreview(app.plan).modules.characters.characters[0].name, '人物');
    assert.equal(f.service.validatePreview(native.plan).modules.characters.characters[0].name, '原生当前');
    assert.deepEqual(f.ctx, before);
    assert.equal(Object.hasOwn(f.ctx.chatMetadata, KEY), false);
});
test('duplicated current native persons are shown as blocked and never deduplicated', () => {
    const f = fixture();
    f.ctx.chatMetadata.variables.AminOS人物 = JSON.stringify({ version: 1, characters: [person, person] });
    const before = structuredClone(f.ctx), preview = f.service.previewLegacy('native');
    assert.equal(preview.valid, false);
    assert.ok(preview.modules.find(row => row.key === 'characters').error.includes('人物编号重复'));
    assert.throws(() => f.service.validatePreview(preview.plan), /未通过校验/);
    assert.deepEqual(f.ctx, before);
});
test('valid native current data does not materialize broken derived history or replay native floors', () => {
    const f = fixture();
    f.ctx.chatMetadata[CHARACTERS_KEY] = { version: 1, events: [{ id: 'bad', snapshot: { version: 1, characters: [person, person] } }] };
    f.ctx.chatMetadata.variables.AminOS人物 = JSON.stringify({ version: 1, characters: [person] });
    const preview = f.service.previewLegacy('native');
    assert.equal(preview.valid, true);
    assert.equal(f.service.validatePreview(preview.plan).modules.characters.characters.length, 1);
    assert.equal(f.service.previewLegacy('app').valid, false);
});
test('migration plans reject source edits, chat switches, clones and invalid JSON imports', () => {
    const f = fixture(), preview = f.service.previewLegacy('native');
    assert.match(preview.summary, /没有已建立/);
    assert.throws(() => f.service.validatePreview(structuredClone(preview.plan)), /预览无效/);
    f.ctx.chatMetadata.variables.AminOS人物 = JSON.stringify({ version: 1, characters: [person] });
    assert.throws(() => f.service.validatePreview(preview.plan), /来源已变化/);
    const fresh = f.service.previewLegacy('native');
    f.ctx = { ...f.ctx, chatId: 'other', chatMetadata: structuredClone(f.ctx.chatMetadata) };
    assert.throws(() => f.service.validatePreview(fresh.plan), /来源已变化/);
    const invalid = f.service.previewImport('{'); assert.equal(invalid.valid, false);
    assert.match(invalid.errors[0].message, /不是有效 JSON/);
});
test('independent import validates a detached current state without changing legacy/native metadata', () => {
    const f = fixture(), state = emptyState({ updatedAt: '2026-10-10T00:00:00.000Z' });
    state.modules.characters = { version: 1, characters: [structuredClone(person)] };
    const bundle = { format: STATE_FORMAT, version: 1, state }, before = structuredClone(f.ctx);
    const preview = f.service.previewImport(bundle);
    assert.equal(preview.valid, true);
    bundle.state.modules.characters.characters[0].name = 'mutated file';
    assert.equal(f.service.validatePreview(preview.plan).modules.characters.characters[0].name, '人物');
    assert.deepEqual(f.ctx, before);
    assert.equal(f.service.previewImport({ version: 2, graph: {} }).valid, false);
});
test('a real legacy current-only export is validated and previewed without applying native state', async () => {
    const f = fixture();
    f.ctx.chatMetadata.variables.AminOS人物 = JSON.stringify({ version: 1, characters: [person] });
    const overlayCalls = 0;
    const bundle = currentStoryExport(f.ctx), before = structuredClone(f.ctx);
    const preview = f.service.previewImport(bundle);
    assert.equal(preview.valid, true);
    assert.equal(f.service.validatePreview(preview.plan).modules.characters.characters[0].name, '人物');
    assert.equal(overlayCalls, 0);
    assert.deepEqual(f.ctx, before);
    const broken = structuredClone(bundle); broken.record.current.hash = 'sha256:' + '0'.repeat(64);
    const invalid = f.service.previewImport(broken);
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors[0].message, /校验不一致/);
    assert.deepEqual(f.ctx, before);
});
