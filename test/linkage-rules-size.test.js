import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateRules } from '../apps/linkage/prompt.js';
import { estimateTokens } from '../apps/linkage/budget.js';
import { adapters } from '../apps/linkage/registry.js';
import { actionNames } from '../apps/linkage/contract.js';
import { KEY, MODULES, emptyLinkageState, validateLinkageState } from '../apps/linkage/policy.js';
import { STATE_KEY } from '../apps/story-state/access.js';
import { parseUpdate } from '../apps/linkage/protocol.js';
import { KEY as CHARACTERS_KEY, emptyStore as emptyCharacters, appendSnapshot as appendCharacters } from '../apps/characters/model.js';
import { KEY as RELATIONSHIPS_KEY, emptyStore, emptyState, appendSnapshot } from '../apps/relationships/model.js';
import { adapter as relationships } from '../apps/linkage/adapters/relationships.js';
import { adapter as journal } from '../apps/linkage/adapters/journal.js';

// Measured 0.19.0 baseline with every module writable: 4438 chars, ~2019 estimated
// tokens (0.18.1 was 7768 chars, ~3902 tokens). Caps allow ~10% growth.
const MAX_CHARS = 4880, MAX_TOKENS = 2220;

function fullContext(extra = {}) {
    const modules = Object.fromEntries(Object.keys(MODULES).map(id => [id, { enabled: true, read: true, write: id !== 'dice' }]));
    return { chat: [{ is_user: true, mes: '继续', name: '玩家' }], characters: [{ avatar: 'a.png', name: 'A' }], characterId: 0, extensionSettings: {},
        chatMetadata: { [STATE_KEY]: { version: 1, modules: {} }, [KEY]: { ...emptyLinkageState(), enabled: true, modules, ...extra } } };
}
const has = (rules, name) => rules.includes(`\n${name}(`);

test('full-module update rules stay within the compact budget', () => {
    const rules = buildUpdateRules(fullContext());
    assert.ok(rules.length <= MAX_CHARS, `rules are ${rules.length} chars`);
    assert.ok(estimateTokens(rules) <= MAX_TOKENS, `rules are ~${estimateTokens(rules)} tokens`);
    assert.match(rules, /<amin_update>/); assert.match(rules, /@new:/);
    assert.doesNotMatch(rules, /显式|唯一安全ID|sourceStart|sourceNote|sources\?/);
    assert.equal((rules.match(/@new:/g) ?? []).length, 1, 'alias rule is stated once in the header');
});

test('every common action is advertised; advanced actions only with the opt-in switch', () => {
    const plain = buildUpdateRules(fullContext()), advanced = buildUpdateRules(fullContext({ advancedActions: true }));
    let advancedCount = 0;
    for (const adapter of adapters.filter(adapter => adapter.id !== 'dice')) {
        for (const name of actionNames(adapter.spec, { advanced: false })) {
            assert.ok(has(plain, name), `${adapter.id}.${name} missing from default rules`);
            assert.ok(has(advanced, name), `${adapter.id}.${name} missing from advanced rules`);
        }
        for (const name of actionNames(adapter.spec, { advanced: true })) {
            advancedCount++;
            assert.ok(!has(plain, name), `${adapter.id}.${name} should be advanced-only`);
            assert.ok(has(advanced, name), `${adapter.id}.${name} missing when advanced descriptions are on`);
        }
    }
    assert.ok(advancedCount >= 6);
    assert.ok(advanced.length > plain.length);
    for (const name of ['save-rule', 'delete-rule', 'acknowledge-alert', 'settle-absence', 'draft_chronicle']) assert.ok(has(advanced, name), name);
    assert.match(advanced, /monthLengths/); assert.doesNotMatch(plain, /monthLengths/);
});

test('advanced switch is an optional boolean in saved linkage settings', () => {
    assert.equal(validateLinkageState({ ...emptyLinkageState(), advancedActions: true }).advancedActions, true);
    assert.throws(() => validateLinkageState({ ...emptyLinkageState(), advancedActions: 'yes' }), /高级动作/);
});

test('advanced actions stay valid when not advertised, and omitted source floors bind to the reply', () => {
    const at = '2026-10-20T00:00:00.000Z', person = id => ({ id, name: id, kind: 'npc', notes: '', stats: [] });
    const ctx = { chat: [{ name: '玩家', is_user: true, mes: '说好了' }, { name: '鲍勃', mes: '鲍勃答应以后提醒', swipe_id: 0 }], chatMetadata: {} };
    ctx.chatMetadata[CHARACTERS_KEY] = appendCharacters(emptyCharacters(), ctx.chat.slice(0, 1), { version: 1, characters: [person('alice'), person('bob')] }, { id: 'people', at });
    ctx.chatMetadata[RELATIONSHIPS_KEY] = appendSnapshot(emptyStore(), ctx.chat.slice(0, 1), { ...emptyState(),
        relationships: [{ id: 'r1', fromId: 'alice', toId: 'bob', type: '信任', label: '', notes: '', strength: 1 }] }, { id: 'initial', at });
    const update = parseUpdate({ version: 1, changes: [{ module: 'relationships', action: 'save-rule', target: 'trust',
        data: { relationshipId: 'r1', operator: 'gte', value: 5, message: '提醒', enabled: true, repeat: 'once' }, reason: '用户要求设置提醒' }] });
    const result = relationships.apply(ctx, update.changes[0], { operationId: 'op_rule', now: at });
    assert.match(result.summary, /阈值规则/); assert.match(result.summary, /第 2 楼/);
    const fact = journal.apply(ctx, { module: 'journal', action: 'set_fact', target: 'f1', data: { title: '约定', body: '鲍勃会提醒' }, reason: '正文' },
        { operationId: 'op_fact', now: at });
    const sources = fact.patches[0].value.events.at(-1).record?.sources ?? fact.patches[0].value.events.at(-1).sources;
    assert.equal(sources?.start ?? sources?.end, 1);
});
