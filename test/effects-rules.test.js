import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, empty, change, activeEffects, snapshotEffects, validateEffectsSnapshot, restoreEffects, consumedActionIds, currentPrompt, compile } from '../apps/effects/model.js';
import { createEffects, PROMPT_KEY } from '../apps/effects/service.js';
import { periodicStatus, validatePeriodicConfig } from '../apps/effects/rules.js';
import { buildSettlement, periodicPreview } from '../apps/effects/settlement.js';
import { adapter } from '../apps/linkage/adapters/effects.js';
import { emptyLinkageState, KEY as LINKAGE_KEY } from '../apps/linkage/policy.js';
import { KEY as CHARACTERS_KEY, emptyStore as emptyCharacters, appendSnapshot, resolveStat } from '../apps/characters/model.js';
import { KEY as INVENTORY_KEY, emptyStore as emptyInventory, change as inventoryChange, readInventory } from '../apps/inventory/model.js';
import { KEY as SCENE_KEY, emptyState as emptyScene, advanceClock, chatPath } from '../apps/scene/model.js';
import { LIBRARY_KEY } from '../apps/effects/library.js';

const now = '2026-09-23T10:00:00Z';
const clock = { year: 2026, month: 9, day: 23, hour: 10, minute: 0, calendarLabel: '' };
const chat = () => [{ name: '旅人', is_user: true, mes: '效果开始', extra: { wsh_message_id: 'floor-one' } }];
const seed = () => ({ ...empty(), skills: [{ id: 'poison', name: '毒性状态', book: '自定义', entryId: 'one', original: '原文', reminder: '按记录保持毒性' }] });
const data = { skillId: 'poison', holder: '施法者', target: '调查员', scope: '毒性', command: '', condition: '解毒或到期', durationMinutes: 60 };
const stacking = (mode = 'stack', stacks = 1) => ({ mode, key: 'poison', maxStacks: mode === 'stack' ? 3 : 1, stacks });
const periodic = (operations = [{ kind: 'stat', characterId: 'hero', statId: 'hp', delta: -2 }]) => ({ intervalMinutes: 10, scaleWithStacks: true, operations });
const effectOf = ctx => activeEffects(ctx.chatMetadata[KEY], ctx.chat)[0];
function setClock(ctx, value) { ctx.chatMetadata[SCENE_KEY] = { version: 1, events: [{ path: chatPath(ctx.chat), snapshot: { ...emptyScene(), clock: value } }] }; }
function fixture({ rules = periodic(), stack = stacking('independent'), duration = 60 } = {}) {
    const ctx = { getCurrentChatId: () => 'effects-rules', chat: chat(), chatMetadata: {}, saveMetadata: async () => {} };
    ctx.chatMetadata[CHARACTERS_KEY] = appendSnapshot(emptyCharacters(), ctx.chat, { version: 1, characters: [{ id: 'hero', name: '调查员', kind: 'pc', notes: '', stats: [{ id: 'hp', label: '生命', binding: '调查员.生命', component: 'current', check: 'none' }] }] }, { id: 'characters-one', at: now });
    ctx.chatMetadata.variables = { 状态栏: JSON.stringify({ 版本: 1, 项目: { 调查员: { 生命: { 当前: 30, 最大: 30 } } } }), unrelated: { keep: true } };
    let inventory = inventoryChange(emptyInventory(), ctx.chat, 'save-item', { name: '药剂', ownerId: 'hero', quantity: 10, equipped: false, notes: '', reason: '起始库存' }, { id: 'item-start', at: now, ownerIds: ['hero'], createId: () => 'medicine' }).store;
    inventory = inventoryChange(inventory, ctx.chat, 'save-balance', { name: '魔力', ownerId: 'hero', amount: 20, unit: '点', notes: '', reason: '起始资源' }, { id: 'balance-start', at: now, ownerIds: ['hero'], createId: () => 'mana' }).store;
    ctx.chatMetadata[INVENTORY_KEY] = inventory;
    ctx.chatMetadata[KEY] = change(seed(), ctx.chat, 'create', { ...data, durationMinutes: duration, stacking: stack, periodic: rules }, { clock, createId: () => 'effect-one', at: now });
    setClock(ctx, clock); return ctx;
}
function apply(ctx, plan) { for (const patch of plan.patches) { let target = ctx.chatMetadata; for (const key of patch.path.slice(0, -1)) target = target[key] ??= {}; if (patch.remove) delete target[patch.path.at(-1)]; else target[patch.path.at(-1)] = structuredClone(patch.value); } }

test('legacy duplicate protection remains, while independent, refresh and stack have explicit behavior', () => {
    const c = chat(), legacy = change(seed(), c, 'create', data, { clock });
    assert.throws(() => change(legacy, c, 'create', data, { clock }), /已有记录/);
    let independent = change(seed(), c, 'create', { ...data, stacking: stacking('independent') }, { clock });
    independent = change(independent, c, 'create', { ...data, stacking: stacking('independent') }, { clock });
    assert.equal(activeEffects(independent, c).length, 2);
    for (const mode of ['refresh', 'stack']) {
        let state = change(seed(), c, 'create', { ...data, stacking: stacking(mode) }, { clock });
        const id = activeEffects(state, c)[0].id;
        state = change(state, c, 'create', { ...data, stacking: stacking(mode), actionId: `confirmed-${mode}` }, { clock: advanceClock(clock, 5) });
        const current = activeEffects(state, c);
        assert.equal(current.length, 1); assert.equal(current[0].id, id);
        assert.equal(current[0].stacking.stacks, mode === 'stack' ? 2 : 1);
        assert.equal(current[0].timing.startedAt.minute, 5);
        assert.ok(consumedActionIds(state, c).includes(`confirmed-${mode}`));
        assert.throws(() => change(state, c, 'create', { ...data, stacking: stacking(mode), actionId: `confirmed-${mode}` }, { clock }), /已经确认/);
    }
});

test('stack refresh requires settled ticks first and caps layers without silently dropping pending cost', () => {
    const ctx = fixture({ stack: stacking() }), effect = effectOf(ctx), later = advanceClock(clock, 20);
    assert.throws(() => change(ctx.chatMetadata[KEY], ctx.chat, 'create', { ...data, stacking: stacking() }, { clock: later }), /先预览并确认结算/);
    setClock(ctx, later); apply(ctx, buildSettlement(ctx, { operationId: 'settle-before-stack', now }));
    ctx.chatMetadata[KEY] = change(ctx.chatMetadata[KEY], ctx.chat, 'create', { ...data, stacking: stacking() }, { clock: later });
    assert.equal(effectOf(ctx).id, effect.id); assert.equal(effectOf(ctx).stacking.stacks, 2); assert.equal(effectOf(ctx).periodic.settledTicks, 0);
    ctx.chatMetadata[KEY] = change(ctx.chatMetadata[KEY], ctx.chat, 'create', { ...data, stacking: stacking() }, { clock: later });
    assert.throws(() => change(ctx.chatMetadata[KEY], ctx.chat, 'create', { ...data, stacking: stacking() }, { clock: later }), /最大层数/);
});

test('periodic forecasts and prompts are pure, final settlement is capped at expiry', () => {
    const ctx = fixture({ duration: 25 }); setClock(ctx, advanceClock(clock, 100));
    const before = JSON.stringify(ctx.chatMetadata), status = periodicStatus(effectOf(ctx), advanceClock(clock, 100));
    assert.equal(status.pendingTicks, 2); assert.equal(periodicPreview(ctx).pending[0].pendingTicks, 2);
    assert.equal(currentPrompt(ctx), ''); compile(ctx.chatMetadata[KEY], ctx.chat, advanceClock(clock, 10));
    assert.equal(JSON.stringify(ctx.chatMetadata), before);
    const plan = buildSettlement(ctx, { operationId: 'expiry-settle', now }); assert.equal(plan.rows[0].changes[0].after, 26); assert.equal(JSON.stringify(ctx.chatMetadata), before);
    apply(ctx, plan); assert.equal(periodicPreview(ctx).pending.length, 0); assert.throws(() => buildSettlement(ctx, { operationId: 'next-settle', now }), /没有到期/);
});

test('stat, item and balance deltas plus the watermark are prepared atomically with proper histories', () => {
    const ctx = fixture({ rules: periodic([{ kind: 'stat', characterId: 'hero', statId: 'hp', delta: -2 }, { kind: 'item', itemId: 'medicine', quantity: 1 }, { kind: 'balance', balanceId: 'mana', delta: -3 }]), stack: stacking('stack', 2) });
    setClock(ctx, advanceClock(clock, 20)); const before = JSON.stringify(ctx), plan = buildSettlement(ctx, { operationId: 'atomic-settle', now });
    assert.deepEqual(plan.rows[0].changes.map(change => [change.before, change.after]), [[30, 22], [10, 6], [20, 8]]);
    assert.equal(JSON.stringify(ctx), before);
    apply(ctx, plan); assert.equal(resolveStat(ctx, 'hero', 'hp').value, 22);
    assert.equal(readInventory(ctx).items[0].quantity, 6); assert.equal(readInventory(ctx).balances[0].amount, 8);
    assert.equal(ctx.chatMetadata.world_status_hud_history_v1.records['floor-one:0'].state.项目.调查员.生命.当前, 22);
    assert.equal(readInventory(ctx).ledger.length, 4); assert.equal(effectOf(ctx).periodic.settledTicks, 2); assert.deepEqual(effectOf(ctx).periodic.lastSettledAt, advanceClock(clock, 20));
    assert.deepEqual(ctx.chatMetadata.variables.unrelated, { keep: true });
    assert.throws(() => buildSettlement(ctx, { operationId: 'atomic-settle', now }), /已提交/);
});

test('insufficient stock or numeric boundary rejects all prepared changes', () => {
    for (const operations of [
        [{ kind: 'stat', characterId: 'hero', statId: 'hp', delta: -2 }, { kind: 'item', itemId: 'medicine', quantity: 100 }],
        [{ kind: 'balance', balanceId: 'mana', delta: -1 }, { kind: 'stat', characterId: 'hero', statId: 'hp', delta: -100 }],
    ]) {
        const ctx = fixture({ rules: periodic(operations) }); setClock(ctx, advanceClock(clock, 10)); const before = JSON.stringify(ctx.chatMetadata);
        assert.throws(() => buildSettlement(ctx, { operationId: 'reject-whole-batch', now }), /数量不足|越界/);
        assert.equal(JSON.stringify(ctx.chatMetadata), before);
    }
});

test('pause preserves prior due cycles and excludes paused game time from later settlements', () => {
    const ctx = fixture({ duration: 60 }), id = effectOf(ctx).id;
    ctx.chatMetadata[KEY] = change(ctx.chatMetadata[KEY], ctx.chat, 'pause', { id, paused: true }, { clock: advanceClock(clock, 15) });
    setClock(ctx, advanceClock(clock, 120)); assert.equal(periodicPreview(ctx).pending[0].pendingTicks, 1);
    apply(ctx, buildSettlement(ctx, { operationId: 'settle-paused', now }));
    ctx.chatMetadata[KEY] = change(ctx.chatMetadata[KEY], ctx.chat, 'pause', { id, paused: false }, { clock: advanceClock(clock, 120) });
    setClock(ctx, advanceClock(clock, 124)); assert.equal(periodicPreview(ctx).pending.length, 0);
    setClock(ctx, advanceClock(clock, 125)); assert.equal(periodicPreview(ctx).pending[0].pendingTicks, 1);
    assert.equal(resolveStat(ctx, 'hero', 'hp').value, 28);
});

test('branch replay, restore and backwards clocks preserve their own settlement watermark', () => {
    const ctx = fixture(), initial = snapshotEffects(ctx.chatMetadata[KEY], ctx.chat), oldChat = structuredClone(ctx.chat);
    ctx.chat.push({ mes: '十分钟后' }); setClock(ctx, advanceClock(clock, 10));
    apply(ctx, buildSettlement(ctx, { operationId: 'branch-settle', now }));
    assert.equal(effectOf(ctx).periodic.settledTicks, 1);
    assert.equal(activeEffects(ctx.chatMetadata[KEY], oldChat)[0].periodic.settledTicks, 0);
    assert.equal(periodicStatus(effectOf(ctx), advanceClock(clock, 5)).state, 'unknown');
    const restored = restoreEffects(ctx.chatMetadata[KEY], ctx.chat, initial, { operationId: 'restore-before-settle', at: now });
    assert.equal(activeEffects(restored, ctx.chat)[0].periodic.settledTicks, 0);
    assert.deepEqual(validateEffectsSnapshot(initial).effects[0].periodic, initial.effects[0].periodic);
    const old = snapshotEffects(seed(), oldChat); assert.doesNotThrow(() => validateEffectsSnapshot(old));
});

test('periodic clocks support custom calendars and reject cross-calendar comparisons', () => {
    const special = { ...clock, year: 5, month: 1, day: 40, hour: 23, minute: 55, calendar: { monthLengths: [40, 40], weekDays: ['一', '二'], epochWeekday: 0 } };
    const state = change(seed(), chat(), 'create', { ...data, periodic: periodic(), stacking: stacking('independent') }, { clock: special });
    const effect = activeEffects(state, chat())[0]; assert.equal(periodicStatus(effect, advanceClock(special, 10)).pendingTicks, 1);
    assert.equal(periodicStatus(effect, clock).state, 'unknown');
});

test('save failure keeps exactly one atomic settlement and retry only persists it', async () => {
    const ctx = fixture(); setClock(ctx, advanceClock(clock, 10)); let writes = 0;
    ctx.saveMetadata = async () => { if (++writes === 1) throw Error('disk'); };
    const api = createEffects(() => ctx);
    try {
        api.stageSettlement(); await assert.rejects(api.confirmSettlement(), /保存失败/);
        assert.equal(api.dirty(), true); assert.equal(resolveStat(ctx, 'hero', 'hp').value, 28); assert.equal(effectOf(ctx).periodic.settledTicks, 1);
        const once = JSON.stringify(ctx.chatMetadata); assert.throws(() => api.stageSettlement(), /尚未保存/);
        await api.retrySave(); assert.equal(writes, 2); assert.equal(JSON.stringify(ctx.chatMetadata), once); assert.equal(api.dirty(), false);
        assert.throws(() => api.stageSettlement(), /没有到期/);
    } finally { api.dispose(); }
});

test('stale resource values and candidate switches invalidate a settlement before commit', async () => {
    for (const mutate of [ctx => { ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 版本: 1, 项目: { 调查员: { 生命: { 当前: 29, 最大: 30 } } } }); }, ctx => { ctx.chat[0].mes = '另一条候选'; }]) {
        const ctx = fixture(); setClock(ctx, advanceClock(clock, 10)); const api = createEffects(() => ctx);
        try { api.stageSettlement(); mutate(ctx); const before = JSON.stringify(ctx.chatMetadata); await assert.rejects(api.confirmSettlement(), /资料已变化|候选已变化/); assert.equal(JSON.stringify(ctx.chatMetadata), before); }
        finally { api.dispose(); }
    }
});

test('manual settlement never writes LittleWhiteBox checkpoints or unrelated variable roots', async () => {
    const ctx = fixture(); ctx.extensionSettings = { LittleWhiteBox: { variablesMode: '2.0' } }; ctx.chatMetadata.LWB_RULES_V2 = { keep: true };
    setClock(ctx, advanceClock(clock, 10)); const api = createEffects(() => ctx);
    try {
        api.stageSettlement(); await api.confirmSettlement();
        assert.equal(ctx.chatMetadata.extensions, undefined); assert.deepEqual(ctx.chatMetadata.LWB_RULES_V2, { keep: true });
        assert.equal(JSON.parse(ctx.chatMetadata.variables.状态栏).项目.调查员.生命.当前, 28); assert.deepEqual(ctx.chatMetadata.variables.unrelated, { keep: true });
    } finally { api.dispose(); }
});

test('adapter is pure, cannot modify the shared ability library and enforces existing references', () => {
    const ctx = fixture(); ctx.extensionSettings = { [LIBRARY_KEY]: { version: 1, skills: seed().skills, trash: [], groups: [], imported: [] } }; const before = JSON.stringify(ctx);
    const result = adapter.apply(ctx, { module: 'effects', action: 'update', target: 'effect-one', data: { command: '调整指令' }, reason: '剧情明确' }, { operationId: 'adapter-update', now });
    assert.equal(JSON.stringify(ctx), before); assert.equal(result.patches.length, 1); assert.deepEqual(result.patches[0].value.skills, ctx.chatMetadata[KEY].skills);
    assert.throws(() => adapter.apply(ctx, { module: 'effects', action: 'update', target: 'effect-one', data: { skills: [] }, reason: '错误' }, { operationId: 'bad-update', now }), /不支持/);
    assert.throws(() => adapter.apply(ctx, { module: 'effects', action: 'create', target: 'new-effect', data: { ...data, periodic: periodic([{ kind: 'stat', characterId: 'gone', statId: 'hp', delta: -1 }]) }, reason: '错误引用' }, { operationId: 'new-effect-op', now }), /人物已不存在/);
});

test('unified ownership suppresses the legacy prompt and never settles cycles while generating', () => {
    const ctx = fixture(), handlers = {}, prompts = new Map(); setClock(ctx, advanceClock(clock, 10));
    ctx.chatMetadata[LINKAGE_KEY] = { ...emptyLinkageState(), enabled: true, modules: { effects: { enabled: true, read: false, write: false } } };
    ctx.eventTypes = { GENERATION_AFTER_COMMANDS: 'start', CHAT_CHANGED: 'chat' }; ctx.eventSource = { on: (event, fn) => handlers[event] = fn, removeListener() {} }; ctx.setExtensionPrompt = (key, value) => prompts.set(key, value);
    const api = createEffects(() => ctx), before = JSON.stringify(ctx.chatMetadata);
    try { assert.equal(currentPrompt(ctx), ''); handlers.start('normal'); assert.equal(prompts.get(PROMPT_KEY), ''); assert.equal(JSON.stringify(ctx.chatMetadata), before); }
    finally { api.dispose(); }
});

test('effects model facts remain complete while the prompt respects the scene read switch', () => {
    const ctx = fixture(); setClock(ctx, advanceClock(clock, 20));
    ctx.chatMetadata[LINKAGE_KEY] = { ...emptyLinkageState(), enabled: true, modules: { scene: { enabled: true, read: false, write: false } } };
    assert.equal(adapter.read(ctx).clock.minute, 20); assert.equal(adapter.read(ctx).effects[0].periodicStatus.pendingTicks, 2);
    const prompt = adapter.readForPrompt(ctx); assert.equal(Object.hasOwn(prompt, 'clock'), false); assert.equal(Object.hasOwn(prompt.effects[0], 'periodicStatus'), false);
    assert.equal(prompt.effects[0].periodic.operations[0].characterId, 'hero'); assert.equal(Object.hasOwn(prompt.effects[0].periodic.operations[0], 'name'), false);
});

test('invalid or surprising periodic payloads reject rather than execute arbitrary metadata writes', () => {
    assert.throws(() => validatePeriodicConfig({ ...periodic(), arbitraryPatch: {} }), /不支持/);
    assert.throws(() => validatePeriodicConfig(periodic([{ kind: 'stat', characterId: 'hero', statId: 'hp', delta: -1, path: ['variables'] }])), /不支持/);
    assert.throws(() => validatePeriodicConfig(periodic([{ kind: 'item', itemId: 'medicine', quantity: 0 }])), /消耗/);
});
