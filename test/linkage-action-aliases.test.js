import test from 'node:test';
import assert from 'node:assert/strict';
import { adapters, getAdapter } from '../apps/linkage/registry.js';
import { canonicalAction, canonicalChange, actionSpec } from '../apps/linkage/contract.js';
import { parseUpdate } from '../apps/linkage/protocol.js';
import { allocateUpdateEntityIds } from '../apps/linkage/entity-ids.js';
import { buildUpdateRules } from '../apps/linkage/prompt.js';
import { KEY, MODULES, emptyLinkageState } from '../apps/linkage/policy.js';
import { STATE_KEY } from '../apps/story-state/access.js';
import { parseSuggestions } from '../apps/relationships/draft.js';

// Every legacy name a model or an old chat may still emit, and its current name.
const LEGACY = {
    characters: { 'save-character': 'update-character', 'set-appearance': 'update-appearance' },
    inventory: { 'save-item': 'update-item', 'save-balance': 'update-balance' },
    relationships: { save: 'save-relationship', delete: 'delete-relationship' },
    scene: { activity: 'log-activity' },
    journal: { set_fact: 'save-fact', set_knowledge: 'save-knowledge', set_hook: 'save-hook', set_task: 'save-task', set_clue: 'save-clue',
        forget: 'forget-knowledge', delete: 'delete-entry', draft_chronicle: 'draft-chronicle' },
    effects: { create: 'create-effect', update: 'update-effect', pause: 'pause-effect', end: 'end-effect', settle: 'settle-effect' },
    map: { add_node: 'create-node', update_node: 'update-node', add_edge: 'create-edge', update_edge: 'update-edge', move: 'move-to' },
    status: { set: 'set-field', adjust: 'adjust-field' },
    organizations: { create: 'create-entity', update: 'update-entity' },
    information: { create: 'create-panel', add_field: 'create-field', set_field: 'update-field', remove_field: 'delete-field' },
};
const change = (module, action, target, data = {}) => ({ module, action, ...(target === undefined ? {} : { target }), data, reason: '剧情已发生' });

test('every advertised action is kebab-case and every alias resolves to exactly one action', () => {
    for (const adapter of adapters) {
        const names = adapter.spec.actions.map(action => action.name), aliases = adapter.spec.actions.flatMap(action => action.aliases ?? []);
        for (const name of names) assert.match(name, /^[a-z]+(?:-[a-z]+)+$/, `${adapter.id}.${name}`);
        assert.equal(new Set([...names, ...aliases]).size, names.length + aliases.length, `${adapter.id} has a colliding alias`);
        for (const alias of aliases) assert.ok(names.includes(canonicalAction(adapter.spec, alias)));
    }
});

test('the legacy alias table maps to current names, and current names map to themselves', () => {
    for (const [module, table] of Object.entries(LEGACY)) {
        const spec = getAdapter(module).spec;
        for (const [legacy, current] of Object.entries(table)) {
            assert.equal(canonicalAction(spec, legacy), current, `${module}.${legacy}`);
            assert.equal(canonicalAction(spec, current), current);
            assert.equal(actionSpec(spec, legacy).name, current);
        }
        const declared = Object.fromEntries(spec.actions.flatMap(action => (action.aliases ?? []).map(alias => [alias, action.name])));
        assert.deepEqual(declared, table, `${module} aliases differ from the documented legacy table`);
    }
    assert.equal(canonicalAction(getAdapter('status').spec, 'unknown'), 'unknown');
    const input = change('status', 'set', '人物.生命', { value: 1 });
    assert.equal(canonicalChange(getAdapter('status').spec, input).action, 'set-field');
    assert.equal(input.action, 'set', 'the caller object is not mutated');
});

test('parseUpdate accepts legacy names and returns current names; canonical:false keeps the literal payload', () => {
    const changes = Object.entries(LEGACY).flatMap(([module, table]) => Object.keys(table).map(action => change(module, action, 'x')));
    const raw = `<amin_update>${JSON.stringify({ version: 1, changes })}</amin_update>`;
    const parsed = parseUpdate(raw), literal = parseUpdate(raw, { canonical: false });
    assert.deepEqual(parsed.changes.map(item => item.action), changes.map(item => LEGACY[item.module][item.action]));
    assert.deepEqual(literal.changes.map(item => item.action), changes.map(item => item.action));
});

test('rules advertise only current names', () => {
    const modules = Object.fromEntries(Object.keys(MODULES).map(id => [id, { enabled: true, read: true, write: id !== 'dice' }]));
    const rules = buildUpdateRules({ chat: [], characters: [], extensionSettings: {},
        chatMetadata: { [STATE_KEY]: { version: 1, modules: {} }, [KEY]: { ...emptyLinkageState(), enabled: true, modules, advancedActions: true } } });
    for (const [module, table] of Object.entries(LEGACY)) for (const [legacy, current] of Object.entries(table)) {
        assert.ok(rules.includes(`\n${current}(`), `${module}.${current} missing`);
        assert.ok(!rules.includes(`\n${legacy}(`), `${module}.${legacy} still advertised`);
    }
});

test('entity creation metadata comes from adapter specs and legacy names still require @new aliases', () => {
    const rawId = i => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const ids = () => { let i = 0; return () => rawId(++i); };
    const creates = Object.fromEntries(adapters.map(adapter => [adapter.id, Object.fromEntries(adapter.spec.actions.filter(action => action.creates).map(action => [action.name, action.creates]))]));
    assert.deepEqual(creates, {
        characters: { 'create-character': 'person' }, inventory: { 'create-item': 'item', 'create-balance': 'balance' }, relationships: {}, scene: {},
        journal: { 'draft-chronicle': 'entry' }, effects: { 'create-effect': 'effect' }, map: { 'create-node': 'node', 'create-edge': 'edge' },
        status: {}, organizations: { 'create-entity': 'entity' }, information: { 'create-panel': 'record' }, dice: {},
    });
    for (const [module, action] of [['map', 'add_node'], ['effects', 'create'], ['information', 'create'], ['journal', 'draft_chronicle'], ['organizations', 'create']]) {
        assert.throws(() => allocateUpdateEntityIds({ version: 1, changes: [change(module, action, rawId(9))] }, { createId: ids() }), /临时别名/);
        const { update } = allocateUpdateEntityIds({ version: 1, changes: [change(module, action, '@new:thing')] }, { createId: ids() });
        assert.equal(update.changes[0].target, `e_${rawId(1)}`);
    }
    const { update } = allocateUpdateEntityIds({ version: 1, changes: [change('journal', 'set_fact', '@new:fact', { title: 't', body: 'b' }),
        change('journal', 'set_knowledge', '@new:memory', { factId: '@new:fact', characterId: 'alice' })] }, { createId: ids() });
    assert.deepEqual(update.changes.map(item => item.action), ['save-fact', 'save-knowledge']);
    assert.equal(update.changes[1].data.factId, update.changes[0].target);
});

test('adapters and relationship suggestions accept legacy names from direct callers and old drafts', () => {
    const suggestions = parseSuggestions(JSON.stringify({ version: 1, changes: [change('relationships', 'save', 'r1', { fromId: 'a', toId: 'b', type: '朋友', sources: [0] }), change('relationships', 'delete', 'r2', { sources: [0] })] }));
    assert.deepEqual(suggestions.map(item => item.action), ['save-relationship', 'delete-relationship']);
    const status = getAdapter('status'), ctx = { chat: [], chatMetadata: { [STATE_KEY]: { version: 1, modules: { status: { 版本: 1, 项目: { 人物: { 生命: 5 } } } } } } };
    const legacy = status.apply(ctx, change('status', 'adjust', '人物.生命', { delta: -2 }), { now: '2026-10-20T00:00:00.000Z' });
    const current = status.apply(ctx, change('status', 'adjust-field', '人物.生命', { delta: -2 }), { now: '2026-10-20T00:00:00.000Z' });
    assert.deepEqual(legacy, current);
    assert.match(current.summary, /5 → 3/);
});
