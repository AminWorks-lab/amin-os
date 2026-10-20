import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLinkedContext as collectCurrent, DEFAULT_LINKED_SOURCES, LINKED_SOURCES } from '../apps/reply/linked-context.js';
import { ROOTS } from '../apps/story-state/legacy-roots.js';
import { STATE_KEY } from '../apps/story-state/access.js';
import { emptyState } from '../apps/story-state/schema.js';

const json = value => JSON.stringify(value);
// The fixture keeps readable root-shaped records; reads go through the canonical
// independent snapshot built from them (malformed roots become absent modules).
function collectLinkedContext(ctx, settings) {
    if (ctx.chatMetadata[STATE_KEY]) return collectCurrent(ctx, settings);
    const state = emptyState({ updatedAt: '2026-09-24T00:00:00.000Z' });
    for (const [module, root] of [...Object.entries(ROOTS), ['status', '状态栏']]) {
        try { if (ctx.chatMetadata.variables?.[root] !== undefined) state.modules[module] = JSON.parse(ctx.chatMetadata.variables[root]); } catch { /* absent */ }
    }
    return collectCurrent({ ...ctx, chatMetadata: { ...ctx.chatMetadata, [STATE_KEY]: state } }, settings);
}
function fixture() {
    const chat = [{ name: 'Alice', is_user: true, mes: 'Alice asks Bob about the door.', swipe_id: 0 }];
    const source = { start: 0, end: 0, messages: [{ index: 0, text: chat[0].mes,
        revision: json([chat[0].name, true, chat[0].mes, 0]) }] };
    const ctx = {
        chatId: 'branch-a', name1: 'Alice', chat, replyState2Ready: true,
        getCurrentChatId() { return this.chatId; },
        extensionSettings: {},
        chatMetadata: {
            variables: {
                [ROOTS.characters]: json({ version: 1, characters: [
                    { id: 'alice', name: 'Alice', kind: 'pc', notes: 'Keep a promise.', stats: [] },
                    { id: 'bob', name: 'Bob', kind: 'npc', notes: 'SECRET_BOB_PLAN', stats: [] },
                    { id: 'eve', name: 'Eve', kind: 'npc', notes: 'SECRET_EVE_PLAN', stats: [] },
                ] }),
                [ROOTS.relationships]: json({ version: 1, relationships: [
                    { id: 'a-b', fromId: 'alice', toId: 'bob', type: 'friend', notes: 'Mutual trust.' },
                    { id: 'b-e', fromId: 'bob', toId: 'eve', type: 'enemy', notes: 'SECRET_OTHER_RELATION' },
                ] }),
                [ROOTS.inventory]: json({ version: 1, items: [
                    { id: 'key', ownerId: 'alice', name: 'Key', notes: '', quantity: 1, equipped: false },
                    { id: 'evebook', ownerId: 'eve', name: 'SECRET_EVE_ITEM', notes: '', quantity: 1, equipped: false },
                ], balances: [], ledger: [] }),
                [ROOTS.scene]: json({ version: 1, clock: { year: 1, month: 2, day: 3, hour: 4, minute: 5 }, activeSceneId: 'door', scenes: {
                    door: { id: 'door', name: 'Door', participantIds: ['alice', 'bob'], weather: 'Rain', objects: 'Locked door' },
                }, schedules: [{ id: 'meet', characterId: 'alice', title: 'Meet Bob', startMinute: 360, enabled: true }] }),
                [ROOTS.journal]: json({ version: 1, entries: [
                    { id: 'fact', kind: 'fact', title: 'Secret', body: 'SECRET_GLOBAL_FACT', enabled: true, confirmed: true, sources: source },
                    { id: 'known', kind: 'knowledge', title: 'Door clue', belief: 'The door has a mark.', characterId: 'alice', factId: 'fact', state: 'known', enabled: true, confirmed: true, sources: source },
                    { id: 'unknown', kind: 'knowledge', title: 'Eve clue', belief: 'SECRET_EVE_KNOWLEDGE', characterId: 'eve', factId: 'fact', state: 'known', enabled: true, confirmed: true, sources: source },
                ] }),
                [ROOTS.effects]: json({ version: 1, effects: [{ id: 'bless', holder: 'alice', target: 'Alice', skill: { name: 'Bless', reminder: 'Bonus' }, scope: 'mind', condition: '', paused: false }] }),
                状态栏: json({ 版本: 1, 项目: { Alice: { 生命: 8 }, Eve: { 私密: 'SECRET_EVE_STATUS' } } }),
            },
        },
    };
    return ctx;
}

test('independent linked context reads canonical records, respects exclusions, and ignores inert native roots', () => {
    const ctx = fixture(), state = emptyState();
    state.modules.characters = { version: 1, characters: [{ id: 'alice', name: 'Alice', kind: 'pc', notes: 'CURRENT_CANONICAL_NOTE', stats: [] }] };
    ctx.chatMetadata[STATE_KEY] = state;
    const before = structuredClone(ctx.chatMetadata);
    const result = collectLinkedContext(ctx, { linkedSources: ['characters'] });
    assert.match(result.selected.map(record => record.text).join('\n'), /CURRENT_CANONICAL_NOTE/);
    assert.doesNotMatch(result.records.map(record => record.text).join('\n'), /SECRET_BOB_PLAN|Keep a promise/);
    const omitted = collectLinkedContext(ctx, { linkedSources: ['characters'], excludedLinkedRecords: ['characters:alice'] });
    assert.equal(omitted.records.length, 1);
    assert.equal(omitted.selected.length, 0);
    ctx.chatMetadata.variables[ROOTS.characters] = 'old native data changed';
    assert.equal(collectLinkedContext(ctx, { linkedSources: ['characters'] }).stamp, result.stamp);
    ctx.chatMetadata.variables = before.variables;
    assert.deepEqual(ctx.chatMetadata, before);
});

test('linked context reads selected current records without modifying metadata', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata);
    const result = collectLinkedContext(ctx, { linkedSources: [...DEFAULT_LINKED_SOURCES, 'effects', 'status'] });
    const selected = result.selected.map(record => record.text).join('\n');
    assert.ok(result.records.some(record => record.id === 'characters:alice' && record.selected));
    assert.ok(result.records.some(record => record.id === 'relationships:a-b' && record.selected));
    assert.ok(result.records.some(record => record.id === 'inventory:key' && record.selected));
    assert.ok(result.records.some(record => record.id === 'scene:door' && record.selected));
    assert.ok(result.records.some(record => record.id === 'journal:known' && record.selected));
    assert.ok(result.records.some(record => record.id === 'effects:bless' && record.selected));
    assert.ok(result.records.some(record => record.id === 'status:Alice' && record.selected));
    for (const forbidden of ['SECRET_EVE_PLAN', 'SECRET_BOB_PLAN', 'SECRET_OTHER_RELATION', 'SECRET_EVE_ITEM', 'SECRET_GLOBAL_FACT', 'SECRET_EVE_KNOWLEDGE', 'SECRET_EVE_STATUS']) {
        assert.equal(selected.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(ctx.chatMetadata, before);
});

test('source and record exclusions control generation input while leaving preview available', () => {
    const ctx = fixture();
    const result = collectLinkedContext(ctx, { linkedSources: ['characters', 'inventory'], excludedLinkedRecords: ['inventory:key'] });
    assert.ok(result.records.some(record => record.id === 'inventory:key' && !record.selected));
    assert.ok(!result.selected.some(record => record.id === 'inventory:key'));
    assert.ok(result.selected.every(record => ['characters', 'inventory'].includes(record.module)));
    assert.deepEqual(LINKED_SOURCES.map(source => source.id).filter(id => DEFAULT_LINKED_SOURCES.includes(id)), [...DEFAULT_LINKED_SOURCES]);
});

test('old floor, unready state and chats without Amin state cannot leak current facts', () => {
    const ctx = fixture();
    ctx.replyFloorIndex = 0; ctx.replyLiveChatLength = 3;
    assert.deepEqual(collectLinkedContext(ctx, {}).selected, []);
    delete ctx.replyFloorIndex; delete ctx.replyLiveChatLength;
    ctx.replyState2Ready = false;
    assert.deepEqual(collectLinkedContext(ctx, {}).selected, []);
    ctx.replyState2Ready = true;
    const plainChat = collectCurrent(ctx, {});
    assert.deepEqual(plainChat.selected, []);
    assert.ok(plainChat.warnings.some(message => message.includes('尚未导入')));
});

test('unusable roots and very large inventories stay bounded', () => {
    const ctx = fixture();
    ctx.chatMetadata.variables[ROOTS.characters] = '{bad';
    const malformed = collectLinkedContext(ctx, { linkedSources: ['characters', 'inventory'] });
    assert.equal(malformed.selected.some(record => record.module === 'characters'), false);
    ctx.chatMetadata.variables[ROOTS.characters] = fixture().chatMetadata.variables[ROOTS.characters];
    ctx.chatMetadata.variables[ROOTS.inventory] = json({ version: 1, items: Array.from({ length: 100 }, (_, index) => ({
        id: `item-${index}`, ownerId: 'alice', name: `Item ${index}`, notes: 'x'.repeat(200), quantity: 1, equipped: false,
    })), balances: [], ledger: [] });
    const bounded = collectLinkedContext(ctx, { linkedSources: ['inventory'] });
    assert.ok(bounded.records.length <= 32);
    assert.ok(bounded.selected.reduce((length, record) => length + record.text.length, 0) <= 7000);
    assert.ok(bounded.warnings.some(message => message.includes('32')));
});

test('ambiguous subject and unverified memory evidence are excluded', () => {
    const ctx = fixture();
    const characters = JSON.parse(ctx.chatMetadata.variables[ROOTS.characters]);
    characters.characters.push({ id: 'alice-duplicate', name: 'Alice', kind: 'pc', notes: '', stats: [] });
    ctx.chatMetadata.variables[ROOTS.characters] = json(characters);
    const ambiguous = collectLinkedContext(ctx, {});
    assert.ok(ambiguous.warnings.some(message => message.includes('重名')));
    assert.equal(ambiguous.selected.some(record => ['inventory', 'journal'].includes(record.module)), false);

    ctx.chatMetadata.variables[ROOTS.characters] = fixture().chatMetadata.variables[ROOTS.characters];
    const journal = JSON.parse(ctx.chatMetadata.variables[ROOTS.journal]);
    journal.entries.find(record => record.id === 'known').sources.messages[0].text = 'changed';
    ctx.chatMetadata.variables[ROOTS.journal] = json(journal);
    assert.equal(collectLinkedContext(ctx, {}).selected.some(record => record.id === 'journal:known'), false);
});

test('outdated relationship evidence and expired effects do not enter candidates', () => {
    const ctx = fixture();
    const relationships = JSON.parse(ctx.chatMetadata.variables[ROOTS.relationships]);
    relationships.relationships[0].evidence = { sources: [{ index: 0, revision: 'stale' }] };
    ctx.chatMetadata.variables[ROOTS.relationships] = json(relationships);
    const effects = JSON.parse(ctx.chatMetadata.variables[ROOTS.effects]);
    effects.effects[0].timing = {
        version: 1, durationMinutes: 5, elapsedMinutes: 5,
        startedAt: JSON.parse(ctx.chatMetadata.variables[ROOTS.scene]).clock,
        segmentStartedAt: JSON.parse(ctx.chatMetadata.variables[ROOTS.scene]).clock,
        pausedAt: null,
    };
    ctx.chatMetadata.variables[ROOTS.effects] = json(effects);
    const result = collectLinkedContext(ctx, { linkedSources: ['relationships', 'effects'] });
    assert.deepEqual(result.selected, []);
});
