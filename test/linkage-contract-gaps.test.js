import test from 'node:test';
import assert from 'node:assert/strict';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
import { adapter as inventory } from '../apps/linkage/adapters/inventory.js';
import { adapter as status } from '../apps/linkage/adapters/status.js';
import { adapter as relationships } from '../apps/linkage/adapters/relationships.js';
import { repairChange } from '../apps/linkage/repair.js';

// Each case is a payload the contract text allows but an adapter used to reject.
const change = (module,action,target,data) => ({module,action,target,data,reason:'剧情明确发生'});
let n = 0;
function run(ctx, input) {
    const { change: fixed } = repairChange(input);
    const adapter = { characters, inventory, status, relationships }[fixed.module];
    const result = adapter.apply(ctx, fixed, { operationId: `op_${++n}`, now: '2026-10-21T00:00:00.000Z' });
    for (const patch of result.patches) {
        let parent = ctx.chatMetadata;
        for (const key of patch.path.slice(0, -1)) parent = parent[key] ??= {};
        parent[patch.path.at(-1)] = structuredClone(patch.value);
    }
    return result;
}
function world() {
    const ctx = { chat: [{ name: '玩家', is_user: true, mes: '开场' }], chatMetadata: { variables: { 状态栏: JSON.stringify({ 版本: 1, 项目: { 主角: { 生命: { 当前: 8, 最大: 10 } } } }) } }, getCurrentChatId: () => 'c' };
    run(ctx, change('characters', 'create-character', 'alice', { name: '艾琳', kind: 'pc', appearance: { description: '旅人', hairstyle: '长发', features: '雀斑' } }));
    run(ctx, change('characters', 'create-character', 'bob', { name: '鲍勃', kind: 'npc' }));
    return ctx;
}

test('inventory accepts partial condition and wear, and unequips at zero', () => {
    const ctx = world();
    run(ctx, change('inventory', 'create-item', 'coat', { name: '外套', ownerId: 'alice', quantity: 1, equipped: true, wear: { slot: 'torso', layer: 'outer' }, condition: { wetness: 10 } }));
    run(ctx, change('inventory', 'update-item', 'coat', { condition: { dirt: 30 }, wear: { description: '湿透的外套' } }));
    let coat = inventory.read(ctx).items[0];
    assert.deepEqual(coat.condition, { wetness: 10, dirt: 30, damage: 0, notes: '' });
    assert.deepEqual(coat.wear, { slot: 'torso', layer: 'outer', description: '湿透的外套' });
    run(ctx, change('inventory', 'update-item', 'coat', { quantity: 0 }));
    coat = inventory.read(ctx).items[0]; assert.equal(coat.equipped, false);
});
test('status progress without component addresses the current value', () => {
    const ctx = world();
    run(ctx, change('status', 'adjust-field', '主角.生命', { delta: -3 }));
    assert.deepEqual(status.read(ctx).项目.主角.生命, { 当前: 5, 最大: 10 });
    run(ctx, change('status', 'set-field', '主角.生命', { value: 9 }));
    assert.deepEqual(status.read(ctx).项目.主角.生命, { 当前: 9, 最大: 10 });
});
test('partial appearance in update-character keeps the other appearance fields', () => {
    const ctx = world();
    run(ctx, change('characters', 'update-character', 'alice', { appearance: { hairstyle: '短发' } }));
    assert.deepEqual(characters.read(ctx).characters[0].appearance, { description: '旅人', hairstyle: '短发', features: '雀斑' });
});
test('an existing relationship can change only its strength', () => {
    const ctx = world();
    run(ctx, change('relationships', 'save-relationship', 'r1', { fromId: 'alice', toId: 'bob', type: '朋友', strength: 1 }));
    run(ctx, change('relationships', 'save-relationship', 'r1', { strength: 4 }));
    const [relation] = relationships.read(ctx).relationships;
    assert.equal(relation.type, '朋友'); assert.equal(relation.strength, 4); assert.equal(relation.fromId, 'alice');
});
test('repair normalizes scene lists, effect stacking, knowledge titles and organization keys', () => {
    assert.equal(repairChange(change('scene', 'save-scene', 's1', { name: '酒馆', participants: ['艾琳', '鲍勃'] })).change.data.participants, '艾琳、鲍勃');
    assert.deepEqual(repairChange(change('effects', 'create-effect', 'e1', { stacking: { mode: 'refresh', key: 'shield', maxStacks: 3, stacks: 2 } })).change.data.stacking, { mode: 'refresh', key: 'shield', maxStacks: 1, stacks: 1 });
    assert.deepEqual(repairChange(change('journal', 'save-knowledge', 'k1', { factId: 'f1', characterId: 'alice', title: '知道', body: 'x' })).change.data, { factId: 'f1', characterId: 'alice' });
    const org = repairChange(change('organizations', 'create-entity', 'mages', { group: 'organizations', fields: { name: '法师塔', description: '研究魔法', leader: '大法师', motto: '求知' } }));
    assert.deepEqual(org.change.data.fields, { name: '法师塔', summary: '研究魔法', leadership: '大法师' });
    assert.ok(org.notes.some(note => /fields\.motto/.test(note)));
});
test('map accepts Chinese or hyphenated directions and type display names', async () => {
    const { createDemoDocument } = await import('../apps/map/src/core/demo.js');
    const { adapter: map, direction } = await import('../apps/linkage/adapters/map.js');
    const ctx = { chat: [{ name: '玩家', is_user: true, mes: '出发' }], chatMetadata: { dynamicMapV1: { updatedAt: 1, document: createDemoDocument() } }, getCurrentChatId: () => 'c' };
    const apply = input => { const result = map.apply(ctx, input, { operationId: `op_${++n}`, now: '2026-10-21T00:00:00.000Z' }); ctx.chatMetadata.dynamicMapV1 = result.patches[0].value; };
    apply(change('map', 'create-node', 'inn', { mapId: 'world', name: '旅店', type: '地标' }));
    apply(change('map', 'create-edge', 'inn_road', { mapId: 'world', from: 'qingyun_sect', to: 'inn', type: '小径', direction: '东' }));
    const world = ctx.chatMetadata.dynamicMapV1.document.maps.world, road = world.edges.find(edge => edge.id === 'inn_road');
    assert.equal(world.nodes.inn.type, 'landmark'); assert.deepEqual([road.type, road.direction], ['trail', 'east']);
    for (const [input, id] of [['North-East', 'northeast'], ['north east', 'northeast'], ['东北方', 'northeast'], ['西南', 'southwest'], ['north-northwest', 'north-northwest'], ['上', 'up'], ['sideways', 'sideways']]) assert.equal(direction(input), id, input);
});
test('organization links may omit role and note', async () => {
    const { adapter: organizations } = await import('../apps/linkage/adapters/organizations.js');
    const { empty, entity } = await import('../apps/organizations/model.js');
    const doc = empty(); doc.organizations.guild = entity('organizations', '商会');
    const ctx = { chat: [{ name: '玩家', is_user: true, mes: '开场' }], chatMetadata: { variables: { 势力资料: JSON.stringify(doc) } }, getCurrentChatId: () => 'c' };
    const result = organizations.apply(ctx, change('organizations', 'create-entity', 'mages', { group: 'organizations', fields: { name: '法师塔', relations: [{ organization: 'guild', role: '盟友' }] } }), { now: '2026-10-21T00:00:00.000Z' });
    const saved = JSON.parse(result.patches.find(patch => patch.path.at(-1) === '势力资料').value);
    assert.deepEqual(saved.organizations.mages.relations, [{ organization: 'guild', role: '盟友', note: '' }]);
});
