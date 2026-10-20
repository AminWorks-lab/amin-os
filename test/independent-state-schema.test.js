import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, emptyModules, normalizeModules, validateState, stateHash, MODULE_NAMES } from '../apps/story-state/schema.js';
import { emptyState as emptyScene } from '../apps/scene/model.js';
import { emptyState as emptyInventory, transition } from '../apps/inventory/model.js';

const character = { id: 'person', name: '人物', kind: 'pc', notes: '', stats: [] };
test('independent state is complete, detached, and hashes JSON key order consistently', () => {
    const state = emptyState({ updatedAt: '2026-10-10T00:00:00.000Z' });
    assert.deepEqual(Object.keys(state.modules), MODULE_NAMES);
    assert.ok(Object.values(state.modules).every(value => value === null));
    const modules = normalizeModules({ characters: { version: 1, characters: [character] } });
    modules.characters.characters[0].name = 'changed';
    assert.equal(character.name, '人物');
    assert.equal(stateHash({ a: 1, nested: { b: 2, a: 1 } }), stateHash({ nested: { a: 1, b: 2 }, a: 1 }));
    assert.throws(() => validateState({ ...state, revision: -1 }), /编号/);
    const missing = structuredClone(state); delete missing.modules.characters;
    assert.throws(() => validateState(missing), /状态格式/);
});
test('duplicate entities and unresolved references refuse without removing source entries', () => {
    const input = { ...emptyModules(), characters: { version: 1, characters: [character, character] } };
    const before = structuredClone(input);
    assert.throws(() => normalizeModules(input), /人物编号重复/);
    assert.deepEqual(input, before);
    const inventory = { version: 1, items: [{ id: 'item', ownerId: 'missing-person', name: '物品', notes: '', quantity: 1, equipped: false }], balances: [], ledger: [] };
    assert.throws(() => normalizeModules({ inventory }), error => error.code === 'AMIN_STATE_REFERENCE_INVALID');
    inventory.items[0].ownerId = character.id;
    assert.equal(normalizeModules({ inventory, characters: { version: 1, characters: [character] } }).inventory.items.length, 1);
});
test('settings-only modules and malformed JSON are refused rather than silently discarded', () => {
    assert.throws(() => normalizeModules({ informationLibrary: [] }), error => error.code === 'AMIN_STATE_SETTINGS_SEPARATE');
    assert.throws(() => normalizeModules({ linkage: {} }), /既有配置/);
    assert.throws(() => normalizeModules({ characters: undefined }), /有效 JSON/);
    const sparse = []; sparse.length = 1;
    assert.throws(() => stateHash(sparse), /空位/);
});
test('normalization supplies model defaults once and preserves actual business records', () => {
    const scene = emptyScene(); delete scene.timeRules; delete scene.absenceRules;
    const modules = normalizeModules({ scene, effects: { version: 1, enabled: true, limit: 30000, effects: [] },
        journal: { version: 1, limit: 40000, entries: [], drafts: [] },
        information: { version: 1, enabled: true, limit: 40000, records: [], modificationHistory: [] } });
    assert.ok(modules.scene.timeRules);
    assert.deepEqual(modules.scene.absenceRules, []);
    assert.deepEqual(modules.effects.consumedActionIds, []);
    assert.deepEqual(modules.journal.drafts, []);
    assert.deepEqual(modules.information.modificationHistory, []);
    assert.deepEqual(normalizeModules(modules), modules, 'the canonical snapshot must already be stable');
});
test('normalization preserves real inventory audit, information edits and journal drafts', () => {
    let serial = 0;
    const inventory = transition(emptyInventory(), 'save-item', { name: '物品', ownerId: character.id, quantity: 1,
        equipped: false, notes: '', reason: '登记' }, { ownerIds: [character.id], createId: () => 'audit_' + ++serial,
        at: '2026-10-10T00:00:00.000Z' }).state;
    const before = { id: 'record', name: '面板', kind: 'thing', mode: 'forward', fields: [
        { id: 'field', category: '资料', label: '名称', value: '之前', status: 'edited' }] };
    const after = structuredClone(before); after.fields[0].value = '之后';
    const history = [{ id: 'edit', recordId: 'record', at: '2026-10-10T00:00:00.000Z', reason: '更新', before, snapshot: after, changes: [] }];
    const draft = { id: 'draft', title: '草稿', body: '保留草稿', status: 'ready', at: '2026-10-10T00:00:00.000Z',
        sources: { start: 0, end: 0, messages: [{ index: 0, revision: 'revision', name: '人物', isUser: false, swipeId: 0, text: '来源' }] } };
    const modules = normalizeModules({ characters: { version: 1, characters: [character] }, inventory,
        information: { version: 1, enabled: true, limit: 40000, records: [after], modificationHistory: history },
        journal: { version: 1, limit: 40000, entries: [], drafts: [draft] } });
    assert.deepEqual(modules.inventory.ledger, inventory.ledger);
    assert.deepEqual(modules.information.modificationHistory, history);
    assert.deepEqual(modules.journal.drafts, [draft]);
    assert.deepEqual(normalizeModules(modules), modules);
});
