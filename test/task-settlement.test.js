import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActionSettlement, actionResources } from '../apps/shared/action-settlement.js';
import { KEY, empty, changeWithContext, currentEntries, readStore, restoreJournal, validateJournalSnapshot } from '../apps/journal/model.js';
import { KEY as INVENTORY, change, emptyStore, readInventory } from '../apps/inventory/model.js';
import { KEY as CHARACTERS, appendSnapshot, emptyStore as emptyCharacters } from '../apps/characters/model.js';
import { createEffects } from '../apps/effects/service.js';
import { adapter as journal } from '../apps/linkage/adapters/journal.js';

function fixture() {
    const ctx = { chat: [{ mes: '接受委托', is_user: true }], chatMetadata: {}, getCurrentChatId: () => 'test-chat', saveMetadata: async () => {} };
    ctx.chatMetadata[CHARACTERS] = appendSnapshot(emptyCharacters(), ctx.chat, { version: 1, characters: [{ id: 'hero', name: '甲', kind: 'pc', notes: '', stats: [] }] });
    ctx.chatMetadata[INVENTORY] = change(emptyStore(), ctx.chat, 'save-item', { name: '药', ownerId: 'hero', quantity: 2, equipped: false, notes: '', reason: '库存' }, { id: 'seed', ownerIds: ['hero'], createId: () => 'potion' }).store;
    ctx.chatMetadata[KEY] = changeWithContext(empty(), ctx, 'create', { id: 'quest', kind: 'task', title: '调查', body: '找到线索', reward: '百万金币与神器', enabled: false }, 'task-seed');
    return ctx;
}
const input = () => ({ name: '交付任务', task: { taskId: 'quest', status: 'completed', progress: 100, claimRewards: true, rewards: [{ kind: 'item', itemId: 'potion', amount: 3 }] } });
function apply(ctx, plan) { for (const patch of plan.patches) { let parent = ctx.chatMetadata; for (const key of patch.path.slice(0, -1)) parent = parent[key] ??= {}; parent[patch.path.at(-1)] = structuredClone(patch.value); } }

test('task rewards preview exact configuration only and repeated same item rewards accumulate', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata), spec = input();
    spec.task.rewards.push({ kind: 'item', itemId: 'potion', amount: 1 });
    const plan = buildActionSettlement(ctx, spec, { operationId: 'award' });
    assert.deepEqual(ctx.chatMetadata, before); assert.doesNotMatch(plan.text, /百万金币|神器/);
    apply(ctx, plan); assert.equal(readInventory(ctx).items[0].quantity, 6);
    assert.equal(currentEntries(readStore(ctx), ctx.chat)[0].rewardClaim.operationId, 'award');
    assert.throws(() => buildActionSettlement(ctx, input(), { operationId: 'again' }), /不能重复领取/);
});

test('task progress alone never grants free-text rewards and invalid reward is atomic', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata);
    const plan = buildActionSettlement(ctx, { name: '推进', task: { taskId: 'quest', status: 'active', progress: 50 } }, { operationId: 'progress' });
    apply(ctx, plan); assert.equal(readInventory(ctx).items[0].quantity, 2); assert.equal(actionResources(ctx).tasks[0].progress, 50);
    const valid = structuredClone(ctx.chatMetadata), spec = input(); spec.task.rewards.push({ kind: 'item', itemId: 'missing', amount: 1 });
    assert.throws(() => buildActionSettlement(ctx, spec, { operationId: 'bad' }), /不存在/); assert.deepEqual(ctx.chatMetadata, valid);
    assert.notDeepEqual(ctx.chatMetadata, before);
});

test('receipt survives normal edits, adapter updates and snapshot restore; earlier branch may claim', () => {
    const ctx = fixture(), earlier = structuredClone(ctx.chatMetadata); ctx.chat.push({ mes: '调查完毕', is_user: false });
    apply(ctx, buildActionSettlement(ctx, input(), { operationId: 'award' }));
    let record = currentEntries(readStore(ctx), ctx.chat)[0]; const { rewardClaim, ...edited } = record;
    ctx.chatMetadata[KEY] = changeWithContext(readStore(ctx), ctx, 'update', { ...edited, title: '调查已交付' }, 'edit');
    apply(ctx, journal.apply(ctx, { target: 'quest', action: 'set_task', reason: '说明', data: { progress: 100 } }, { operationId: 'ai', now: new Date().toISOString() }));
    record = currentEntries(readStore(ctx), ctx.chat)[0]; assert.deepEqual(record.rewardClaim, rewardClaim);
    const { savedAt, savedFloor, eventId, ...entry } = record;
    const snapshot = validateJournalSnapshot({ version: 1, limit: 40000, entries: [entry] });
    ctx.chatMetadata[KEY] = restoreJournal(ctx, snapshot); assert.throws(() => buildActionSettlement(ctx, input(), { operationId: 'again' }), /不能重复/);
    ctx.chat.pop(); ctx.chatMetadata = earlier; assert.doesNotThrow(() => buildActionSettlement(ctx, input(), { operationId: 'branch' }));
});

test('task receipt and reward stay single when a failed save is retried', async () => {
    const ctx = fixture(), api = createEffects(() => ctx); let fail = true;
    ctx.saveMetadata = async () => { if (fail) throw Error('disk'); };
    try {
        api.stageAction(input()); await assert.rejects(api.confirmAction(), /disk/);
        assert.equal(readInventory(ctx).items[0].quantity, 5);
        fail = false; await api.retrySave(); assert.equal(readInventory(ctx).items[0].quantity, 5);
        assert.throws(() => api.stageAction(input()), /不能重复/);
    } finally { api.dispose(); }
});



test('existing balance and bound stat rewards use their native bounds atomically', () => {
    const ctx = fixture();
    ctx.chatMetadata[CHARACTERS] = appendSnapshot(emptyCharacters(), ctx.chat, { version: 1, characters: [{ id: 'hero', name: '甲', kind: 'pc', notes: '', stats: [{ id: 'hp', label: '体力', binding: '甲.hp', component: 'current', check: 'none' }] }] });
    ctx.chatMetadata.variables = { 状态栏: JSON.stringify({ 版本: 1, 项目: { 甲: { hp: { 当前: 5, 最大: 10 } } } }) };
    ctx.chatMetadata[INVENTORY] = change(ctx.chatMetadata[INVENTORY], ctx.chat, 'save-balance', { name: '金币', ownerId: 'hero', amount: 2, unit: '枚', notes: '', reason: '初始' }, { id: 'seed-coins', ownerIds: ['hero'], createId: () => 'coins' }).store;
    const spec = input(); spec.task.rewards = [{ kind: 'balance', balanceId: 'coins', amount: 10 }, { kind: 'stat', characterId: 'hero', statId: 'hp', amount: 3 }];
    const before = structuredClone(ctx.chatMetadata); const invalid = structuredClone(spec); invalid.task.rewards[1].amount = 100;
    assert.throws(() => buildActionSettlement(ctx, invalid, { operationId: 'bad' }), /越界/); assert.deepEqual(ctx.chatMetadata, before);
    apply(ctx, buildActionSettlement(ctx, spec, { operationId: 'reward' }));
    assert.equal(readInventory(ctx).balances[0].amount, 12);
    const raw = ctx.chatMetadata.variables.状态栏, state = typeof raw === 'string' ? JSON.parse(raw) : raw;
    assert.equal(state.项目.甲.hp.当前, 8);
});
