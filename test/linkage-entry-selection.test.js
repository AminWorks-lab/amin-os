import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContextEntries } from '../apps/linkage/entry-selection.js';
import { buildDataPromptReport, STATE2_ROOTS } from '../apps/linkage/prompt.js';
import { KEY, MODULES, emptyLinkageState, validateLinkageState } from '../apps/linkage/policy.js';
import * as Characters from '../apps/characters/model.js';
import * as Scene from '../apps/scene/model.js';
import * as Journal from '../apps/journal/model.js';

const person = (id, name = id) => ({ id, name, kind: 'npc', notes: '', stats: [] });
const data = () => ({ characters: { characters: [person('a'), person('b'), person('c'), person('d')] },
    scene: { activeSceneId: 'here', scenes: { here: { id: 'here', name: '当前', participantIds: ['a'] }, far: { id: 'far', name: '远处', participantIds: ['d'] } }, schedules: [] },
    relationships: { relationships: [{ id: 'ab', fromId: 'a', toId: 'b', label: '朋友' }, { id: 'bc', fromId: 'b', toId: 'c', label: '同事' }] },
    inventory: { items: [{ id: 'ia', ownerId: 'a', name: '包' }, { id: 'id', ownerId: 'd', name: '无关' }], balances: [], ledger: [] } });

test('entry selection uses exact scene references and bounded relationships without mutating input', () => {
    const source = data(), before = structuredClone(source);
    const result = selectContextEntries(source, { enabled: true, pinned: [] });
    assert.deepEqual(result.data.characters.characters.map(row => row.id), ['a', 'b']);
    assert.deepEqual(result.data.relationships.relationships.map(row => row.id), ['ab']);
    assert.deepEqual(result.data.inventory.items.map(row => row.id), ['ia']);
    assert.deepEqual(Object.keys(result.data.scene.scenes), ['here']);
    assert.match(result.entries.find(row => row.id === 'characters:d').reason, /略过/);
    assert.deepEqual(source, before);
});

test('missing scene, name-only attendance and schedules alone preserve complete context', () => {
    const source = data(); source.scene.scenes.here.participantIds = []; source.scene.scenes.here.participants = 'a';
    source.scene.schedules = [{ id: 's', characterId: 'a' }];
    const result = selectContextEntries(source, { enabled: true, pinned: [] });
    assert.deepEqual(result.data, source);
    assert.match(result.entries.find(row => row.id === 'characters:d').reason, /没有可用/);
});

test('pins preserve direct dependencies and complete nested records without unbounded graph expansion', () => {
    const source = data(); delete source.scene;
    source.characters.characters[0].stats = [{ id: 'hp', binding: '甲.生命', label: '生命' }];
    source.status = { 项目: { 甲: { 生命: 10 } } };
    const result = selectContextEntries(source, { enabled: true, pinned: ['relationships:ab'] });
    assert.deepEqual(result.data.characters.characters.map(row => row.id), ['a', 'b']);
    assert.equal(result.data.characters.characters[0].stats[0].id, 'hp');
    assert.ok(result.pinnedModules.has('status'));
    assert.equal(result.entries.find(row => row.id === 'status:甲.生命').required, true);
    assert.equal(result.entries.find(row => row.id === 'characters:d').included, false);
});

function fixture() {
    const ctx = { chat: [{ is_user: true, mes: '继续', name: '玩家' }], extensionSettings: {}, chatMetadata: { variables: {} } };
    ctx.chatMetadata[KEY] = { ...emptyLinkageState(), enabled: true, modules: Object.fromEntries(Object.keys(MODULES).map(id => [id, { enabled: false, read: false, write: false }])), contextBudget: { enabled: false, maxChars: 24000, requiredModules: [], entrySelection: { enabled: true, pinned: [] } } };
    for (const id of ['characters', 'scene']) ctx.chatMetadata[KEY].modules[id] = { enabled: true, read: true, write: false };
    const chars = { version: 1, characters: [person('hiddenByRelevance'), person('a')] };
    ctx.chatMetadata[Characters.KEY] = Characters.appendSnapshot(Characters.emptyStore(), ctx.chat, chars, { id: 'seed', at: '2026-09-24T00:00:00Z' });
    ctx.chatMetadata.variables[STATE2_ROOTS.characters] = chars;
    const scene = { ...Scene.emptyState(), ...data().scene };
    ctx.chatMetadata[Scene.KEY] = Scene.appendEvent(Scene.emptyStore(), ctx.chat, { state: scene, op: 'save-scene', reason: '确认', details: {} }, { eventId: 'scene-seed', at: '2026-09-24T00:00:00Z' });
    return ctx;
}
const payload = report => JSON.parse(report.prompt.slice(report.prompt.indexOf('{')));

test('filtered records retain native indexes and writable modules never lose current records', () => {
    const ctx = fixture(); let report = buildDataPromptReport(ctx);
    assert.deepEqual(payload(report).modules.characters.characters.map(row => row.id), ['a']);
    assert.deepEqual(payload(report).nativeVariables.characters.recordPaths, [{ id: 'characters:a', path: 'AminOS人物.characters[1]' }]);
    ctx.chatMetadata[KEY].modules.characters.write = true;
    report = buildDataPromptReport(ctx);
    assert.equal(payload(report).modules.characters.characters.length, 2);
    assert.match(report.entrySelection.entries.find(row => row.id === 'characters:hiddenByRelevance').reason, /允许变量更新/);
});

test('pins cannot bypass read permission or journal privacy and enabled journal stays complete', () => {
    const ctx = fixture(), settings = ctx.chatMetadata[KEY];
    settings.contextBudget.entrySelection.pinned = ['characters:a', 'journal:hidden'];
    settings.modules.characters = { enabled: true, read: false, write: false };
    settings.modules.journal = { enabled: true, read: true, write: false };
    const sources = Journal.sourceFromRange(ctx.chat, 0, 0);
    let store = Journal.empty();
    store = Journal.change(store, ctx.chat, 'create', { id: 'hidden', kind: 'fact', title: 'SECRET_TITLE', body: 'SECRET_BODY', enabled: false, sources }, 'hide');
    store = Journal.change(store, ctx.chat, 'create', { id: 'public', kind: 'fact', title: '事实', body: '已知内容', enabled: true, sources }, 'show');
    ctx.chatMetadata[Journal.KEY] = store;
    const report = buildDataPromptReport(ctx);
    assert.doesNotMatch(JSON.stringify(report), /SECRET_TITLE|SECRET_BODY/);
    assert.ok(!report.entrySelection.entries.some(row => row.id === 'characters:a' || row.id === 'journal:hidden'));
    assert.match(report.prompt, /已知内容/);
    assert.equal(report.entrySelection.entries.find(row => row.id === 'journal:public').required, true);
});

test('entry settings are opt-in, validate pins, and fixed items cause budget failure rather than omission', () => {
    const ctx = fixture(), settings = ctx.chatMetadata[KEY];
    delete settings.contextBudget.entrySelection;
    assert.equal(payload(buildDataPromptReport(ctx)).modules.characters.characters.length, 2);
    for (const invalid of [{ enabled: 'yes', pinned: [] }, { enabled: true, pinned: ['unknown:a'] }, { enabled: true, pinned: ['characters:a', 'characters:a'] }]) {
        settings.contextBudget.entrySelection = invalid; assert.throws(() => validateLinkageState(settings), /条目筛选/);
    }
    // Compact JSON keeps the small fixture under the 1000-char minimum; give the pinned record real weight.
    const chars = { version: 1, characters: [person('hiddenByRelevance'), { ...person('a'), notes: '固定条目备注'.repeat(150) }] };
    ctx.chatMetadata[Characters.KEY] = Characters.appendSnapshot(Characters.emptyStore(), ctx.chat, chars, { id: 'seed', at: '2026-09-24T00:00:00Z' });
    settings.contextBudget = { enabled: true, maxChars: 1000, requiredModules: [], entrySelection: { enabled: true, pinned: ['characters:a'] } };
    const report = buildDataPromptReport(ctx);
    assert.match(report.error, /必需资料/); assert.equal(report.prompt, '');
});

test('required projections remain complete and scene/schedule ID collisions fail conservatively', () => {
    const source = data(); source.scene.schedules = [{ id: 'far', characterId: 'd', title: '计划' }];
    source.effects = { enabled: true, skills: [{ id: 'skill', reminder: '持续约束' }], effects: [{ id: 'eff', command: '必须维持' }] };
    source.journal = { entries: [{ id: 'fact', title: '固定事实', body: '需要记住' }] };
    const required = new Map([['effects', '保留生效能力'], ['journal', '保留启用档案']]);
    const result = selectContextEntries(source, { enabled: true, pinned: [] }, required);
    assert.deepEqual(result.data.effects, source.effects); assert.deepEqual(result.data.journal, source.journal);
    assert.deepEqual(result.data.scene, source.scene);
    assert.match(result.entries.find(row => row.id === 'scene:far').reason, /ID 重复/);
});
