import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationService } from '../apps/generation/service.js';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';
import { STATE_KEY, emptyState, validateState } from '../apps/story-state/schema.js';
import { KEY } from '../apps/linkage/policy.js';

const copy = value => structuredClone(value);
const change = (module, action, target, data) => ({ module, action, target, data, reason: '所选资料已明确说明' });
const changes = [
    change('characters', 'create-character', '@new:alice', { name: '艾琳', kind: 'npc', notes: '名字写作 @new:alice', stats: [] }),
    change('characters', 'create-character', '@new:bob', { name: '鲍勃', kind: 'npc', stats: [] }),
    change('inventory', 'create-item', '@new:potion', { name: '药水', ownerId: '@new:alice', quantity: 2, notes: '' }),
    change('relationships', 'save-relationship', '@new:relation', { fromId: '@new:alice', toId: '@new:bob', type: '朋友', notes: '', sources: [0] }),
    change('scene', 'save-scene', '@new:room', { name: '小屋', participantIds: ['@new:alice', '@new:bob'], activate: true }),
];
const options = { modules: ['characters','inventory','relationships','scene'], mode: 'create', sources: { includeChat: true, start: 0, end: 0 } };

function fixture(initial = changes) {
    let selected = copy(initial), saves = 0, fail = false, sourceText = '艾琳和鲍勃是朋友，在小屋中，艾琳持有两瓶药水。', callback = null;
    const ctx = { characterId: 7, getCurrentChatId: () => 'independent-generation', extensionSettings: {},
        chat: [{ name: '玩家', is_user: true, mes: sourceText }],
        chatMetadata: { [STATE_KEY]: emptyState({ updatedAt: '2026-10-10T00:00:00.000Z' }), variables: { Foreign: 'keep' }, apiSettings: { provider: 'unrelated' }, world_info: 'keep' },
        async saveMetadata() { saves++; if (fail) throw Error('offline'); },
    };
    const calls = [], captures = [], sourceCalls = [];
    const runtime = createStoryStateRuntime(() => ctx, { backups: { available: () => false, status: () => ({ available: false }), savePrevious: async () => {} } });
    const ai = { capture(route) { const snapshot = { route, channelId: 'per-app-channel', model: 'chosen-model', requestBody: { temperature: 0.3 } }; captures.push(snapshot); return snapshot; },
        async generate(...args) { calls.push(args); await callback?.(); return JSON.stringify({ version: 1, changes: selected }); } };
    const api = createGenerationService(() => ctx, { ai, collectSources: async (context, settings, controls) => {
        sourceCalls.push({ context, settings, controls });
        return { text: sourceText, provenance: { chat: { start: 0, end: 0, indices: [0] } } };
    } });
    const protectedData = copy({ variables: ctx.chatMetadata.variables, apiSettings: ctx.chatMetadata.apiSettings, world_info: ctx.chatMetadata.world_info });
    return { ctx, api, runtime, calls, captures, sourceCalls, get saves() { return saves; }, set fail(value) { fail = value; }, set source(value) { sourceText = value; }, set changes(value) { selected = copy(value); }, set callback(value) { callback = value; },
        assertProtected() { assert.deepEqual({ variables: ctx.chatMetadata.variables, apiSettings: ctx.chatMetadata.apiSettings, world_info: ctx.chatMetadata.world_info }, protectedData);
            for (const key of ['amin_os_characters_v1','amin_os_inventory_v1','amin_os_relationships_v1','amin_os_scene_v1','LWB_RULES_V2','extensions','world_status_hud_history_v1']) assert.equal(ctx.chatMetadata[key], undefined); },
        dispose() { api.dispose(); runtime.destroy(); },
    };
}

test('independent generation preserves provider route, captured channel snapshot, signal and context flags', async () => {
    const f = fixture();
    try {
        const draft = await f.api.generate(options);
        assert.equal(f.captures.length, 1); assert.equal(f.captures[0].route, 'linkage');
        const [label, context, payload, request] = f.calls[0];
        assert.match(label, /资料生成/); assert.notEqual(context.chat, f.ctx.chat); assert.deepEqual(context.chat, f.ctx.chat);
        assert.notEqual(context.chatMetadata, f.ctx.chatMetadata); assert.ok(context.chatMetadata[STATE_KEY]);
        assert.equal(request.snapshot, f.captures[0]); assert.equal(request.snapshot.channelId, 'per-app-channel');
        assert.equal(request.signal instanceof AbortSignal, true); assert.equal(request.signal.aborted, false);
        for (const flag of ['includeEffects','includeJournal','includeScene','includeLinkage']) assert.equal(request[flag], false);
        assert.match(payload.systemPrompt, /@new:/); assert.equal(request.data.request, payload.prompt);
        const prompt = JSON.parse(payload.prompt); assert.equal(prompt.sources, f.sourceCalls[0].context.chat[0].mes);
        assert.deepEqual(prompt.provenance.chat.indices, [0]); assert.deepEqual(prompt.existing.characters.characters, []);
        assert.deepEqual(draft.changes, changes); assert.equal(f.saves, 0); f.assertProtected();
    } finally { f.dispose(); }
});

test('independent generate stage confirm persists linked typed entities once, retaining aliases only in the draft', async () => {
    const f = fixture();
    try {
        const before = copy(f.ctx.chatMetadata), draft = await f.api.generate(options);
        assert.deepEqual(f.ctx.chatMetadata, before);
        const preview = f.api.stage(draft.changes);
        assert.ok(preview); assert.deepEqual(f.ctx.chatMetadata, before); assert.equal(f.saves, 0);
        await f.api.confirm();
        const state = validateState(f.ctx.chatMetadata[STATE_KEY]), modules = state.modules;
        const alice = modules.characters.characters.find(person => person.name === '艾琳'), bob = modules.characters.characters.find(person => person.name === '鲍勃');
        for (const id of [alice.id, bob.id, modules.inventory.items[0].id, modules.relationships.relationships[0].id, Object.keys(modules.scene.scenes)[0]]) assert.match(id, /^e_[0-9a-f-]{36}$/);
        assert.equal(modules.inventory.items[0].ownerId, alice.id); assert.equal(modules.inventory.items[0].quantity, 2);
        assert.equal(modules.relationships.relationships[0].fromId, alice.id); assert.equal(modules.relationships.relationships[0].toId, bob.id);
        assert.deepEqual(Object.values(modules.scene.scenes)[0].participantIds, [alice.id, bob.id]);
        assert.equal(alice.notes, changes[0].data.notes); assert.equal(state.revision, 1); assert.equal(f.saves, 1);
        assert.equal(f.ctx.chatMetadata[KEY].enabled, false); assert.equal(f.ctx.chatMetadata[KEY].applied[0].changes.length, 0);
        assert.deepEqual(draft.changes, changes); assert.equal(f.api.draft(), null); f.assertProtected();
    } finally { f.dispose(); }
});

test('independent generation rejects AI-picked persisted IDs and invalid alias dependencies without writing', async () => {
    const f = fixture([{ ...changes[0], target: 'ai-chosen' }]);
    try {
        const before = copy(f.ctx.chatMetadata);
        await assert.rejects(f.api.generate({ ...options, modules: ['characters'] }), /临时|别名|插件/);
        assert.equal(f.api.draft(), null); assert.equal(f.saves, 0); assert.deepEqual(f.ctx.chatMetadata, before);
        f.changes = [changes[2]];
        await assert.rejects(f.api.generate({ ...options, modules: ['inventory'] }), /未声明|人物|持有/);
        assert.deepEqual(f.ctx.chatMetadata, before); f.assertProtected();
    } finally { f.dispose(); }
});

test('independent single-app updates reuse canonical stable IDs and send current typed records to the provider', async () => {
    const f = fixture([changes[0]]);
    try {
        let draft = await f.api.generate({ ...options, modules: ['characters'] });
        f.api.stage(draft.changes); await f.api.confirm();
        const alice = f.ctx.chatMetadata[STATE_KEY].modules.characters.characters[0];
        f.changes = [change('characters', 'save-character', alice.id, { notes: '剧情中的新记录' })];
        draft = await f.api.generate({ ...options, modules: ['characters'], mode: 'update' });
        const prompt = JSON.parse(f.calls.at(-1)[2].prompt);
        assert.equal(f.captures.at(-1).route, 'characters');
        assert.deepEqual(prompt.references.characters, [{ id: alice.id, name: '艾琳' }]);
        assert.equal(prompt.existing.characters.characters[0].notes, changes[0].data.notes);
        assert.equal(draft.changes[0].target, alice.id);
        f.api.stage(draft.changes); await f.api.confirm();
        const people = f.ctx.chatMetadata[STATE_KEY].modules.characters.characters;
        assert.equal(people.length, 1); assert.equal(people[0].id, alice.id); assert.equal(people[0].notes, '剧情中的新记录');
        assert.equal(f.saves, 2); assert.equal(f.ctx.chatMetadata[STATE_KEY].revision, 2); f.assertProtected();
    } finally { f.dispose(); }
});

test('independent generation failed persistence retries the same canonical state without reexecuting or reallocating', async () => {
    const f = fixture();
    try {
        const draft = await f.api.generate(options); f.api.stage(draft.changes); f.fail = true;
        await assert.rejects(f.api.confirm(), /保存失败|offline/);
        assert.equal(f.api.dirty(), true); const committed = copy(f.ctx.chatMetadata[STATE_KEY]);
        f.fail = false; await f.api.retrySave();
        assert.deepEqual(f.ctx.chatMetadata[STATE_KEY], committed); assert.equal(f.saves, 2); assert.equal(f.calls.length, 1);
        assert.equal(committed.modules.inventory.items[0].quantity, 2); assert.equal(f.ctx.chatMetadata[KEY].applied.length, 1);
        assert.equal(f.api.dirty(), false); f.assertProtected();
    } finally { f.dispose(); }
});

test('independent generation source or typed state drift blocks pending work without a save', async () => {
    const f = fixture();
    try {
        f.callback = () => { f.ctx.chat[0].mes = '新的正文'; };
        await assert.rejects(f.api.generate(options), /已变化/); assert.equal(f.api.draft(), null); assert.equal(f.saves, 0);
        f.callback = null;
        const draft = await f.api.generate(options); f.api.stage(draft.changes); f.source = '已修改世界书来源';
        await assert.rejects(f.api.confirm(), /来源已变化/); assert.equal(f.saves, 0); assert.equal(f.ctx.chatMetadata[STATE_KEY].revision, 0); f.assertProtected();
        f.api.discard();
        f.callback = () => { f.ctx.chatMetadata[STATE_KEY].modules.status = { 版本: 1, 项目: { 玩家: { 生命: 1 } } }; };
        await assert.rejects(f.api.generate(options), /已变化/); assert.equal(f.api.draft(), null); assert.equal(f.saves, 0);
    } finally { f.dispose(); }
});

test('independent single-app routing and cancellation remain provider-compatible without a native engine', async () => {
    const f = fixture([changes[0]]);
    try {
        const controller = new AbortController();
        f.callback = () => controller.abort(Error('test cancelled'));
        await assert.rejects(f.api.generate({ ...options, modules: ['characters'] }, { signal: controller.signal }), /cancelled/);
        assert.equal(f.captures[0].route, 'characters'); assert.equal(f.calls[0][3].signal.aborted, true);
        assert.equal(f.api.draft(), null); assert.equal(f.saves, 0); assert.equal(f.ctx.chatMetadata[STATE_KEY].revision, 0); f.assertProtected();
    } finally { f.dispose(); }
});
