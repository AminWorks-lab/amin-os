import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex, searchIndex, normalizeQuery } from '../apps/home/search.js';
import { openSearchResult } from '../apps/home/navigate.js';

const data = {
    characters: [{ id: 'c1', name: '艾琳', kind: 'npc', notes: '星港的向导' }, { id: 'c2', name: '旅人', kind: 'pc', notes: '' }],
    inventory: { items: [{ id: 'i1', name: '星图', notes: '标出观测站' }], balances: [{ id: 'b1', name: '金币', unit: '枚' }] },
    journal: [
        { id: 'j1', kind: 'task', title: '修复观测站', body: '找到星图碎片', current: true },
        { id: 'j2', kind: 'fact', title: '艾琳曾是学徒', body: '', current: true },
        { id: 'j3', kind: 'clue', title: '旧分支线索', current: false },
    ],
    map: { maps: { world: { id: 'world', name: '星港', nodes: { n1: { id: 'n1', name: '观测站', description: '山顶', discovered: true }, n2: { id: 'n2', name: '密室', discovered: false } } } } },
    organizations: { organizations: { o1: { name: '星港议会', type: '议会', summary: '管理观测站' } }, alliances: {}, regions: { r1: { name: '北岭' } } },
    information: [{ id: 'r1', name: '艾琳', kind: 'person', fields: [{ id: 'f1', label: '身份', value: '星港的向导' }] }],
    effects: { skills: [{ id: 's1', name: '星语', book: '演示技能', original: '理解星辰低语' }, { id: 's2', name: '隐藏能力', ui: { hidden: true } }], active: [{ id: 'e1', name: '星语共鸣' }] },
};

test('the index flattens every searchable app with the request each app takes on open', () => {
    const index = buildSearchIndex(data), byId = Object.fromEntries(index.map(entry => [`${entry.app}:${entry.id}`, entry]));
    assert.deepEqual(byId['inventory:b1'].request, { focus: 'b1', tab: 'balances', query: '金币' });
    assert.deepEqual(byId['journal:j2'].request, { focus: 'j2', tab: 'memory', query: '艾琳曾是学徒' });
    assert.deepEqual(byId['map:world/n1'].request, { focus: { mapId: 'world', nodeId: 'n1' } });
    assert.deepEqual(byId['organizations:r1'].request, { focus: 'r1', group: 'regions' });
    assert.deepEqual(byId['effects:s1'].request, { focus: 's1', tab: '能力管理' });
    assert.deepEqual(byId['effects:e1'].request, { focus: 'e1', tab: '生效中' });
    assert.equal(byId['journal:j3'], undefined, 'records from other branches are left out');
    assert.equal(byId['map:world/n2'], undefined, 'undiscovered places stay hidden');
    assert.equal(byId['effects:s2'], undefined, 'hidden abilities stay hidden');
});

test('results are grouped by app in a fixed order and ranked by name match', () => {
    const groups = searchIndex(buildSearchIndex(data), '观测站');
    assert.deepEqual(groups.map(group => group.app), ['inventory', 'journal', 'map', 'organizations']);
    const map = groups.find(group => group.app === 'map');
    assert.equal(map.results[0].label, '观测站');
    const people = searchIndex(buildSearchIndex(data), '艾琳');
    assert.deepEqual(people.map(group => group.app), ['characters', 'journal', 'information']);
    assert.equal(people[1].results[0].label, '艾琳曾是学徒');
});

test('every term must match; case, width and spacing are normalized', () => {
    const index = buildSearchIndex({ characters: [{ id: 'a', name: 'Alice Ｗong', notes: 'pilot' }, { id: 'b', name: 'Bob', notes: 'alice fan' }] });
    assert.equal(normalizeQuery('  ALICE   ｗong '), 'alice wong');
    const groups = searchIndex(index, 'alice  WONG');
    assert.equal(groups[0].total, 1);
    assert.equal(groups[0].results[0].id, 'a');
    assert.equal(searchIndex(index, 'alice')[0].results[0].id, 'a', 'name matches rank above note matches');
    assert.deepEqual(searchIndex(index, '   '), []);
    assert.deepEqual(searchIndex(index, '不存在'), []);
});

test('each group is capped while keeping the total', () => {
    const characters = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, name: '守卫' + i }));
    const [group] = searchIndex(buildSearchIndex({ characters }), '守卫', { limit: 3 });
    assert.equal(group.total, 9);
    assert.equal(group.results.length, 3);
});

test('malformed app data is skipped instead of breaking the index', () => {
    const index = buildSearchIndex({ characters: [null, { id: '', name: 'x' }, { id: 'ok', name: ' ' }], inventory: { items: 'bad' }, map: { maps: { m: null } }, organizations: null, effects: {} });
    assert.deepEqual(index, []);
});

test('opening a result routes to the app with its focus request', async () => {
    const opened = [], events = [];
    const openApp = async (id, request) => { opened.push([id, request]); };
    const document = { dispatchEvent: event => events.push(event), defaultView: { CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } } } };
    const index = buildSearchIndex(data), find = id => index.find(entry => entry.id === id);
    await openSearchResult(find('i1'), { openApp, document, map: null });
    assert.deepEqual(opened.at(-1), ['inventory', { focus: 'i1', tab: 'items', query: '星图' }]);
    await openSearchResult(find('c1'), { openApp, document, map: null });
    assert.deepEqual(opened.at(-1), ['characters', undefined]);
    assert.equal(events[0].type, 'amin:select-character');
    assert.deepEqual(events[0].detail, { app: 'characters', characterId: 'c1' });
    const mapCalls = [];
    await openSearchResult(find('world/n1'), { openApp, document, map: { open: options => mapCalls.push(options) } });
    assert.deepEqual(mapCalls, [{ focus: { mapId: 'world', nodeId: 'n1' } }]);
    assert.equal(opened.length, 2, 'the map opens through its own API');
});
