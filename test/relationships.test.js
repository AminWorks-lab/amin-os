import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY as CHARACTERS_KEY, appendSnapshot as appendCharacters, emptyStore as emptyCharactersStore } from '../apps/characters/model.js';
import { KEY, LIMITS, emptyState, emptyStore, validateRelationship, validateState, validateStore, readStore, readRelationships, resolveRelationships, transition, appendSnapshot, buildRestore, currentPrompt } from '../apps/relationships/model.js';
import { createRelationshipsService, PROMPT_KEY } from '../apps/relationships/service.js';

const at = '2026-09-23T00:00:00.000Z';
const relationship = (extra = {}) => ({ id: 'r1', fromId: 'alice', toId: 'bob', type: '信任', label: '', notes: '', ...extra });
const person = (id, name = id) => ({ id, name, kind: 'npc', notes: '', stats: [] });
function characters(ctx, list, id = 'characters_1') {
    ctx.chatMetadata[CHARACTERS_KEY] = appendCharacters(ctx.chatMetadata[CHARACTERS_KEY] ?? emptyCharactersStore(), ctx.chat, { version: 1, characters: list }, { id, at });
}
function setup() {
    let count = 0, saves = 0;
    let ctx = { chat: [], chatMetadata: {}, characterId: 1, getCurrentChatId: () => 'chat-a', saveMetadata: async () => { saves++; } };
    characters(ctx, [person('alice', '爱丽丝'), person('bob', '鲍勃'), person('carol', '卡萝')]);
    const service = createRelationshipsService(() => ctx, { createId: () => `relation_${++count}`, now: () => at });
    return { service, get ctx() { return ctx; }, set ctx(value) { ctx = value; }, get saves() { return saves; } };
}

test('empty relationship read is side-effect-free; direction and missing strength remain explicit', () => {
    const ctx = { chat: [], chatMetadata: {} };
    assert.deepEqual(readRelationships(ctx), emptyState()); assert.deepEqual(ctx.chatMetadata, {});
    let state = transition(emptyState(), 'save', { relationship: relationship() });
    assert.equal(Object.hasOwn(state.relationships[0], 'strength'), false);
    state = transition(state, 'save', { relationship: relationship({ id: 'r2', fromId: 'bob', toId: 'alice', strength: 0 }) });
    assert.equal(state.relationships.length, 2); assert.equal(state.relationships[1].strength, 0);
    assert.throws(() => transition(state, 'save', { relationship: relationship({ id: 'r3' }) }), /已存在/);
    assert.throws(() => validateRelationship(relationship({ toId: 'alice' })), /不同人物/);
});

test('schema rejects future, malformed, duplicate and prototype-key data without rewriting original', () => {
    for (const bad of [NaN, Infinity, -Infinity, 1000000001, '3', null]) assert.throws(() => validateRelationship(relationship({ strength: bad })), /有限数字/);
    for (const bad of ['__proto__', 'prototype', 'constructor']) assert.throws(() => validateRelationship(relationship({ fromId: bad })), /编号无效/);
    assert.throws(() => validateRelationship(JSON.parse('{"id":"r1","fromId":"alice","toId":"bob","type":"朋友","__proto__":{}}')), /不兼容/);
    assert.throws(() => validateState({ ...emptyState(), relationships: new Array(2) }), /格式|空项/);
    const valid = appendSnapshot(emptyStore(), [], { ...emptyState(), relationships: [relationship()] }, { id: 'e1', at });
    for (const value of [{ version: 99, events: [], future: true }, { ...valid, future: true }, { ...valid, events: [...valid.events, ...valid.events] }, { ...valid, events: [{ ...valid.events[0], snapshot: { ...emptyState(), version: 2 } }] }]) {
        const before = structuredClone(value), ctx = { chatMetadata: { [KEY]: value }, chat: [] };
        assert.throws(() => readStore(ctx), /不兼容|重复/); assert.deepEqual(ctx.chatMetadata[KEY], before);
    }
    const corruptOtherBranch = structuredClone(valid); corruptOtherBranch.events[0].path = ['not-this-branch']; corruptOtherBranch.events[0].snapshot.relationships[0].strength = 'bad';
    assert.throws(() => readRelationships({ chat: [], chatMetadata: { [KEY]: corruptOtherBranch } }), /有限数字/);
    assert.equal({}.polluted, undefined);
});

test('branch snapshots reject changed messages/candidates and restore at current tail preserves earlier paths', () => {
    const base = { ...emptyState(), relationships: [relationship()] }, first = [{ name: '玩家', is_user: true, mes: '开始', swipe_id: 0 }];
    let store = appendSnapshot(emptyStore(), first, base, { id: 'e1', at, op: 'save' });
    const second = [...first, { name: '人物', mes: '友好路线', swipe_id: 0 }];
    const changed = transition(base, 'save', { relationship: relationship({ type: '盟友' }) });
    store = appendSnapshot(store, second, changed, { id: 'e2', at, op: 'save' });
    const ctx = { chat: second, chatMetadata: { [KEY]: store } };
    assert.equal(readRelationships(ctx).relationships[0].type, '盟友');
    ctx.chat = [...first, { name: '人物', mes: '敌对路线', swipe_id: 1 }];
    assert.equal(readRelationships(ctx).relationships[0].type, '信任');
    ctx.chatMetadata[KEY] = buildRestore(ctx, changed, { id: 'e3', at });
    assert.equal(readRelationships(ctx).relationships[0].type, '盟友'); assert.equal(ctx.chatMetadata[KEY].events.length, 3);
    assert.equal(ctx.chatMetadata[KEY].events[2].op, 'restore');
    ctx.chat = first; assert.equal(readRelationships(ctx).relationships[0].type, '信任');
    ctx.chat = [{ ...first[0], mes: '完全改写的起点' }]; assert.deepEqual(readRelationships(ctx), emptyState());
});

test('relationship CRUD previews first, confirms once and preserves unrelated metadata', async () => {
    const t = setup(); t.ctx.chatMetadata.unrelated = { keep: true };
    const input = relationship(), preview = t.service.saveRelationship(input);
    assert.equal(t.ctx.chatMetadata[KEY], undefined); assert.match(preview.summary, /爱丽丝 → 鲍勃/);
    input.type = '未确认改写'; preview.relationship.type = '修改预览副本';
    await t.service.confirm(); assert.equal(t.saves, 1); assert.equal(t.service.read().relationships[0].type, '信任');
    await assert.rejects(t.service.confirm(), /没有待确认/);
    t.service.saveRelationship(relationship({ type: '师徒', strength: -12.5 })); await t.service.confirm();
    assert.equal(t.service.read().relationships[0].strength, -12.5);
    t.service.deleteRelationship('r1'); assert.equal(t.service.read().relationships.length, 1); await t.service.confirm();
    assert.equal(t.service.read().relationships.length, 0); assert.equal(t.ctx.chatMetadata[KEY].events.length, 3); assert.deepEqual(t.ctx.chatMetadata.unrelated, { keep: true });
    t.service.dispose();
});

test('new endpoints require stable current persons; deleted references stay visible and can be annotated', async () => {
    const t = setup();
    assert.throws(() => t.service.saveRelationship(relationship({ toId: 'unknown' })), /当前人物/);
    t.service.saveRelationship(relationship()); await t.service.confirm();
    characters(t.ctx, [person('alice', '改名后的爱丽丝')], 'characters_2'); t.service.sync();
    const resolved = t.service.resolved()[0]; assert.equal(resolved.from.name, '改名后的爱丽丝'); assert.equal(resolved.to.missing, true); assert.match(resolved.to.name, /未解析人物.*bob/);
    t.service.saveRelationship(relationship({ notes: '人物移除后保留依据' })); await t.service.confirm();
    assert.equal(t.service.read().relationships[0].toId, 'bob');
    assert.throws(() => t.service.saveRelationship(relationship({ toId: 'new_missing' })), /当前人物/);
    t.service.dispose();
});

test('character dependency or message/chat changes invalidate relationship edits before mutation', async () => {
    const t = setup(), token = t.service.capture();
    t.service.saveRelationship(relationship()); characters(t.ctx, [person('alice')], 'characters_2');
    await assert.rejects(t.service.confirm(), /相关资料已变化/); assert.equal(t.ctx.chatMetadata[KEY], undefined);
    assert.throws(() => t.service.saveRelationship(relationship(), token), /相关资料已变化/);
    characters(t.ctx, [person('alice'), person('bob')], 'characters_3'); t.service.sync(); t.service.saveRelationship(relationship());
    t.ctx.chat.push({ name: '玩家', mes: '已发出的新行动', is_user: true });
    await assert.rejects(t.service.confirm(), /聊天或消息候选已变化/); assert.equal(t.ctx.chatMetadata[KEY], undefined);
    t.service.sync(); assert.equal(t.service.preview(), null);
    t.service.saveRelationship(relationship()); const previous = t.ctx;
    t.ctx = { ...previous, chatMetadata: {}, getCurrentChatId: () => 'chat-b' };
    await assert.rejects(t.service.confirm(), /聊天或消息候选已变化/); assert.equal(previous.chatMetadata[KEY], undefined); assert.deepEqual(t.ctx.chatMetadata, {});
    t.service.dispose();
});

test('failed persistence keeps one confirmed relationship event and retry never repeats creation', async () => {
    const t = setup(); t.ctx.saveMetadata = async () => { throw Error('断网'); };
    t.service.saveRelationship(relationship()); await assert.rejects(t.service.confirm(), /保存失败/);
    assert.equal(t.service.dirty(), true); assert.equal(t.service.preview(), null); assert.equal(t.ctx.chatMetadata[KEY].events.length, 1);
    assert.throws(() => t.service.saveRelationship(relationship({ id: 'other', type: '竞争' })), /重试保存/);
    const value = structuredClone(t.ctx.chatMetadata[KEY]); t.ctx.saveMetadata = async () => {};
    await t.service.retrySave(); await t.service.retrySave(); assert.equal(t.service.dirty(), false); assert.deepEqual(t.ctx.chatMetadata[KEY], value);
    t.service.dispose();
});

test('a save completing after a chat switch is reported as stale and leaves the new chat untouched', async () => {
    const t = setup(); let done; const original = t.ctx; original.saveMetadata = () => new Promise(resolve => { done = resolve; });
    t.service.saveRelationship(relationship()); const saving = t.service.confirm();
    t.ctx = { ...original, chatMetadata: {}, getCurrentChatId: () => 'chat-b' }; t.service.sync(); done();
    await assert.rejects(saving, error => error.code === 'STALE_COMPLETION' && error.committed);
    assert.deepEqual(t.ctx.chatMetadata, {}); assert.equal(readRelationships(original).relationships.length, 1);
    t.ctx = original; t.ctx.saveMetadata = async () => {}; await t.service.retrySave(); assert.equal(t.service.dirty(), false); t.service.dispose();
});

test('optional prompt has only confirmed directed relations, no inferred strength and no unresolved identities', async () => {
    const t = setup(); t.service.saveRelationship(relationship()); await t.service.confirm(); assert.equal(currentPrompt(t.ctx), '');
    t.service.stage('settings', { includeInContext: true }); await t.service.confirm();
    const prompt = currentPrompt(t.ctx); assert.match(prompt, /"from":"爱丽丝".*"to":"鲍勃"/); assert.doesNotMatch(prompt, /"strength"/);
    assert.equal(prompt.split('"from":').length - 1, 1);
    t.service.saveRelationship(relationship({ type: '未确认关系' })); assert.doesNotMatch(currentPrompt(t.ctx), /未确认关系/); t.service.discard();
    characters(t.ctx, [person('alice')], 'characters_2'); assert.equal(currentPrompt(t.ctx), ''); assert.equal(resolveRelationships(t.ctx).length, 1);
    t.service.dispose();
});

test('prompt refuses overflow rather than silently truncating confirmed relationship rules', () => {
    const ctx = { chat: [], chatMetadata: {} };
    const list = [person('alice'), ...Array.from({ length: 4 }, (_, index) => person(`p${index}`))]; characters(ctx, list);
    const relationships = list.slice(1).map((value, index) => relationship({ id: `r${index}`, toId: value.id, notes: '说'.repeat(LIMITS.text) }));
    ctx.chatMetadata[KEY] = appendSnapshot(emptyStore(), [], { ...emptyState(), relationships, settings: { includeInContext: true } }, { id: 'e1', at });
    assert.throws(() => currentPrompt(ctx), /超过.*未附加/);
});

test('host hooks use pre-candidate facts for retries and clean up all injected relationship prompts', async () => {
    const callbacks = new Map(), prompts = new Map(); let count = 0;
    const names = ['GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED'];
    const ctx = { chat: [{ name: '玩家', is_user: true, mes: '交谈' }], chatMetadata: {}, characterId: 1, getCurrentChatId: () => 'host', saveMetadata: async () => {},
        eventTypes: Object.fromEntries(names.map(value => [value, value])), eventSource: { on(name, callback) { if (!callbacks.has(name)) callbacks.set(name, new Set()); callbacks.get(name).add(callback); }, removeListener(name, callback) { callbacks.get(name)?.delete(callback); if (!callbacks.get(name)?.size) callbacks.delete(name); } },
        setExtensionPrompt(name, value) { prompts.set(name, value); },
    };
    const emit = (name, ...args) => { let result; for (const callback of [...(callbacks.get(name) ?? [])]) result = callback(...args); return result; };
    characters(ctx, [person('alice'), person('bob')]);
    const service = createRelationshipsService(() => ctx, { createId: () => `host_${++count}`, now: () => at });
    assert.equal(service.supported, true); service.saveRelationship(relationship()); await service.confirm(); service.stage('settings', { includeInContext: true }); await service.confirm();
    ctx.chat.push({ name: '人物', mes: '关系发生变化', swipe_id: 0 }); service.sync(); service.saveRelationship(relationship({ type: '怀疑' })); await service.confirm();
    for (const type of ['regenerate', 'swipe']) { emit('GENERATION_AFTER_COMMANDS', type); assert.match(prompts.get(PROMPT_KEY), /"type":"信任"/); assert.doesNotMatch(prompts.get(PROMPT_KEY), /"type":"怀疑"/); }
    emit('GENERATION_AFTER_COMMANDS', 'continue'); assert.match(prompts.get(PROMPT_KEY), /"type":"怀疑"/);
    for (const args of [['quiet'], ['normal', {}, true], ['normal', { signal: { aborted: true } }]]) { emit('GENERATION_AFTER_COMMANDS', ...args); assert.equal(prompts.get(PROMPT_KEY), ''); }
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
        emit('GENERATION_AFTER_COMMANDS', 'normal'); assert.ok(prompts.get(PROMPT_KEY)); emit(name); assert.equal(prompts.get(PROMPT_KEY), '');
    }
    service.dispose(); service.dispose(); assert.equal(callbacks.size, 0); assert.equal(prompts.get(PROMPT_KEY), '');
});
