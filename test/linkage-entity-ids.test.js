import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateUpdateEntityIds } from '../apps/linkage/entity-ids.js';

const rawId = i => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const issued = i => `e_${rawId(i)}`;
const ids = () => { let i = 0; return () => rawId(++i); };
const change = (module, action, target, data = {}) => ({ module, action, ...(target === undefined ? {} : { target }), data, reason: '剧情已发生' });
const batch = (...changes) => ({ version: 1, changes });
const resolve = (input, options = {}) => allocateUpdateEntityIds(input, { createId: ids(), ...options });

test('NPC ID is issued by plugin, temporary model alias and source object stay unchanged', () => {
    const source = batch(change('characters', 'create-character', '@new:alice', { name: 'Alice', kind: 'npc' }));
    const { update, mapping } = resolve(source);
    assert.equal(update.changes[0].target, issued(1));
    assert.deepEqual(mapping, { '@new:alice': issued(1) });
    assert.equal(source.changes[0].target, '@new:alice');
});

test('same-batch typed cross references resolve without rewriting prose', () => {
    const text = '@new:alice';
    const source = batch(
        change('characters', 'create-character', text, { name: text, notes: text, kind: 'npc', appearance: { description: text } }),
        change('inventory', 'create-item', '@new:hat', { name: 'Hat', ownerId: text, notes: text, quantity: 1 }),
        change('relationships', 'save', '@new:friendship', { fromId: text, toId: 'bob', type: text, notes: text }),
        change('scene', 'save-scene', '@new:room', { name: text, participantIds: [text, 'bob'], participants: [text], objects: [text] }),
        change('journal', 'set_task', '@new:task', { title: text, body: text, characterIds: [text], itemIds: ['@new:hat'], locationIds: ['@new:room'] }),
    );
    source.changes[0].reason = text;
    const { update, mapping } = resolve(source);
    assert.equal(update.changes[1].data.ownerId, mapping[text]);
    assert.equal(update.changes[2].data.fromId, mapping[text]);
    assert.deepEqual(update.changes[3].data.participantIds, [mapping[text], 'bob']);
    assert.deepEqual(update.changes[4].data.itemIds, [mapping['@new:hat']]);
    assert.deepEqual(update.changes[4].data.locationIds, [mapping['@new:room']]);
    assert.equal(update.changes[0].data.name, text);
    assert.equal(update.changes[0].data.appearance.description, text);
    assert.equal(update.changes[0].reason, text);
    assert.deepEqual(update.changes[3].data.participants, [text]);
    assert.equal(update.changes[4].data.body, text);
});

test('fresh persisted IDs are forbidden across all explicit creation contracts', () => {
    const contracts = [['characters', 'create-character'], ['inventory', 'create-item'], ['inventory', 'create-balance'], ['effects', 'create'], ['map', 'add_node'], ['map', 'add_edge'], ['organizations', 'create'], ['information', 'create'], ['journal', 'draft_chronicle']];
    for (const [module, action] of contracts) {
        assert.throws(() => resolve(batch(change(module, action, rawId(9)))), /临时别名/);
        const { update } = resolve(batch(change(module, action, '@new:entity')));
        assert.match(update.changes[0].target, /^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
    }
});

test('upsert creates need aliases; stable targets must belong to the same module', () => {
    const contracts = [['relationships', 'save'], ['relationships', 'save-rule'], ['scene', 'save-scene'], ['scene', 'save-schedule'], ...['set_fact', 'set_hook', 'set_task', 'set_clue', 'set_knowledge'].map(action => ['journal', action])];
    for (const [module, action] of contracts) {
        const input = batch(change(module, action, 'existing'));
        assert.throws(() => resolve(input), /不能指定持久编号/);
        assert.throws(() => resolve(input, { existingIds: ['existing', 'characters:existing'] }), /不能指定持久编号/);
        assert.equal(resolve(input, { existingIds: [`${module}:existing`] }).update.changes[0].target, 'existing');
        assert.equal(resolve(batch(change(module, action, '@new:entity'))).update.changes[0].target, issued(1));
    }
});

test('existing ordinary updates remain unchanged, including strings inside arbitrary status values', () => {
    const source = batch(change('characters', 'update-character', 'alice', { name: '@new:alice' }), change('status', 'set-field', '人物.档案', { value: { ownerId: '@new:alice', nested: ['@new:alice'] } }), change('scene', 'advance-time', undefined, { minutes: 1 }));
    const { update, mapping } = resolve(source);
    assert.deepEqual(update, source);
    assert.deepEqual(mapping, {});
    assert.equal(Object.hasOwn(update.changes[2], 'target'), false);
});

test('new stats and information fields receive IDs while existing local IDs remain stable', () => {
    const source = batch(
        change('characters', 'create-character', '@new:alice', { name: 'Alice', stats: [{ id: '@new:health', label: 'Health', binding: '角色.生命' }] }),
        change('characters', 'save-character', 'bob', { stats: [{ id: 'health', label: 'Health', binding: '角色.生命' }] }),
        change('characters', 'save-stat', 'bob', { id: '@new:luck', label: 'Luck', binding: '角色.幸运' }),
        change('information', 'create', '@new:panel', { name: 'Info', fields: [{ id: '@new:age', label: 'Age', category: 'Basic', value: '18' }] }),
        change('information', 'add_field', 'existing-panel', { field: { id: '@new:height', label: 'Height', category: 'Basic', value: '170' } }),
        change('information', 'set_field', '@new:panel', { fieldId: '@new:age', value: '@new:height' }),
    );
    const { update, mapping } = resolve(source, { existingIds: ['characters:bob/stats/health'] });
    assert.equal(update.changes[0].data.stats[0].id, mapping['@new:health']);
    assert.equal(update.changes[1].data.stats[0].id, 'health');
    assert.equal(update.changes[2].data.id, mapping['@new:luck']);
    assert.equal(update.changes[3].data.fields[0].id, mapping['@new:age']);
    assert.equal(update.changes[5].data.fieldId, mapping['@new:age']);
    assert.equal(update.changes[5].data.value, '@new:height');
    assert.throws(() => resolve(batch(change('characters', 'save-stat', 'bob', { id: 'custom' }))), /临时别名/);
    assert.throws(() => resolve(batch(change('information', 'create', '@new:panel', { fields: [{ id: 'custom' }] }))), /临时别名/);
});

test('inventory transfer newId is allocated and recipient character is resolved', () => {
    const { update, mapping } = resolve(batch(change('characters', 'create-character', '@new:bob'), change('inventory', 'transfer-item', 'hat', { quantity: 1, newId: '@new:newhat', toOwnerId: '@new:bob' })));
    assert.equal(update.changes[1].data.newId, mapping['@new:newhat']);
    assert.equal(update.changes[1].data.toOwnerId, mapping['@new:bob']);
    assert.throws(() => resolve(batch(change('inventory', 'transfer-balance', 'wallet', { newId: 'chosen' }))), /临时别名/);
});

test('map node and edge aliases resolve narrowly on an existing map', () => {
    const { update, mapping } = resolve(batch(change('map', 'add_node', '@new:a', { mapId: 'map1', name: '@new:b' }), change('map', 'add_node', '@new:b', { mapId: 'map1' }), change('map', 'add_edge', '@new:road', { mapId: 'map1', from: '@new:a', to: '@new:b' })));
    assert.equal(update.changes[2].data.from, mapping['@new:a']);
    assert.equal(update.changes[2].data.to, mapping['@new:b']);
    assert.equal(update.changes[0].data.name, '@new:b');
    assert.throws(() => resolve(batch(change('map', 'add_node', '@new:a', { mapId: '@new:a' }))), /类型不匹配/);
});

test('organizations explicit parent and organization references resolve, notes do not', () => {
    const { update, mapping } = resolve(batch(change('organizations', 'create', '@new:group', { group: 'organizations', fields: { name: 'Group' } }), change('organizations', 'create', '@new:region', { group: 'regions', fields: { name: 'Region', parent: '@new:group', controllers: [{ organization: '@new:group', note: '@new:group' }] } })));
    assert.equal(update.changes[1].data.fields.parent, mapping['@new:group']);
    assert.equal(update.changes[1].data.fields.controllers[0].organization, mapping['@new:group']);
    assert.equal(update.changes[1].data.fields.controllers[0].note, '@new:group');
});

test('effects periodic typed references resolve; textual holder and target are not IDs', () => {
    const { update, mapping } = resolve(batch(change('characters', 'create-character', '@new:alice', { stats: [{ id: '@new:health' }] }), change('inventory', 'create-item', '@new:potion', { ownerId: '@new:alice' }), change('inventory', 'create-balance', '@new:wallet', { ownerId: '@new:alice' }), change('effects', 'create', '@new:buff', { skillId: 'heal', holder: '@new:alice', target: '@new:alice', periodic: { operations: [{ kind: 'stat', characterId: '@new:alice', statId: '@new:health' }, { kind: 'item', itemId: '@new:potion' }, { kind: 'balance', balanceId: '@new:wallet' }] } })));
    const data = update.changes[3].data;
    assert.equal(data.periodic.operations[0].characterId, mapping['@new:alice']);
    assert.equal(data.periodic.operations[0].statId, mapping['@new:health']);
    assert.equal(data.periodic.operations[1].itemId, mapping['@new:potion']);
    assert.equal(data.periodic.operations[2].balanceId, mapping['@new:wallet']);
    assert.equal(data.holder, '@new:alice'); assert.equal(data.target, '@new:alice');
});

test('journal fact and knowledge aliases maintain the same-batch relationship', () => {
    const { update, mapping } = resolve(batch(change('characters', 'create-character', '@new:alice'), change('journal', 'set_fact', '@new:fact', { title: 'Fact', body: 'Fact' }), change('journal', 'set_knowledge', '@new:memory', { factId: '@new:fact', characterId: '@new:alice', learnedFromId: null })));
    assert.equal(update.changes[2].data.factId, mapping['@new:fact']);
    assert.equal(update.changes[2].data.characterId, mapping['@new:alice']);
    assert.equal(update.changes[2].data.learnedFromId, null);
});

test('duplicate declarations and unresolved typed aliases reject the whole update', () => {
    assert.throws(() => resolve(batch(change('characters', 'create-character', '@new:a'), change('inventory', 'create-item', '@new:a'))), /别名重复/);
    assert.throws(() => resolve(batch(change('inventory', 'create-item', '@new:hat', { ownerId: '@new:missing' }))), /未声明/);
    assert.throws(() => resolve(batch(change('characters', 'save-character', '@new:missing'))), /未声明/);
});

test('aliases have a bounded ASCII format and wrong entity types cannot be referenced', () => {
    for (const alias of ['@new:', '@new:中文', '@new:1foo', '@new:a/b', '@new:a.b', '@new:a b', `@new:${'a'.repeat(61)}`]) assert.throws(() => resolve(batch(change('characters', 'create-character', alias))), /临时别名/);
    assert.throws(() => resolve(batch(change('inventory', 'create-item', '@new:hat', { ownerId: '@new:hat' }))), /类型不匹配/);
    assert.throws(() => resolve(batch(change('map', 'add_edge', '@new:road', { mapId: 'm', from: '@new:road', to: 'existing' }))), /类型不匹配/);
});

test('generated UUID collisions with current IDs or another batch allocation fail', () => {
    const source = batch(change('characters', 'create-character', '@new:a'));
    for (const existingIds of [[issued(1)], [`characters:${issued(1)}`], [`information:panel/fields/${issued(1)}`], [rawId(1)]]) assert.throws(() => resolve(source, { existingIds }), /已存在/);
    assert.throws(() => resolve(batch(change('characters', 'create-character', '@new:a'), change('characters', 'create-character', '@new:b')), { createId: () => rawId(1) }), /已存在/);
});

test('UUID generator must supply secure-form UUID values, not arbitrary persisted IDs', () => {
    for (const invalid of [null, '', 'chosen', 'e_custom', '00000000-0000-0000-0000-000000000000']) assert.throws(() => resolve(batch(change('characters', 'create-character', '@new:a')), { createId: () => invalid }), /UUID/);
    const { update } = resolve(batch(change('characters', 'create-character', '@new:a')), { createId: () => rawId(15).toUpperCase() });
    assert.equal(update.changes[0].target, issued(15));
});
