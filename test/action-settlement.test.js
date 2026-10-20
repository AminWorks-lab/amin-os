import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActionSettlement, actionResources } from '../apps/shared/action-settlement.js';
import { createEffects } from '../apps/effects/service.js';
import { KEY, appendSnapshot, emptyStore, resolveStat } from '../apps/characters/model.js';
import { KEY as INVENTORY, change, emptyStore as emptyInventory, readInventory } from '../apps/inventory/model.js';
import { KEY as SCENE, emptyState, chatPath, readCurrentScene } from '../apps/scene/model.js';
function fixture() {
    const ctx = { chat: [{ name: '甲', mes: '开始', is_user: true }], chatMetadata: {}, getCurrentChatId: () => 'a', saveMetadata: async () => {} };
    const stats = ['hp', 'mp'].map(id => ({ id, label: id, binding: `甲.${id}`, component: 'current', check: 'none' }));
    ctx.chatMetadata[KEY] = appendSnapshot(emptyStore(), ctx.chat, { version: 1, characters: [{ id: 'hero', name: '甲', kind: 'pc', notes: '', stats }] });
    ctx.chatMetadata.variables = { 状态栏: JSON.stringify({ 版本: 1, 项目: { 甲: { hp: { 当前: 5, 最大: 10 }, mp: { 当前: 4, 最大: 10 } } } }) };
    ctx.chatMetadata[INVENTORY] = change(emptyInventory(), ctx.chat, 'save-item', { name: '药', ownerId: 'hero', quantity: 2, equipped: false, notes: '', reason: '库存' }, { id: 'seed', ownerIds: ['hero'], createId: () => 'potion' }).store;
    return ctx;
}
const input = () => ({ name: '治疗', cost: { kind: 'stat', characterId: 'hero', statId: 'mp' }, costAmount: 2, target: { kind: 'stat', characterId: 'hero', statId: 'hp' }, delta: 3 });
test('action preview is read only and reports exact resource and target deltas', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata), plan = buildActionSettlement(ctx, input(), { operationId: 'action' });
    assert.deepEqual(ctx.chatMetadata, before); assert.match(plan.text, /4 → 2/); assert.match(plan.text, /5 → 8/);
    assert.equal(actionResources(ctx).costs.length, 3);
});
test('insufficient resources or invalid target rejects the whole action without spending', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata);
    assert.throws(() => buildActionSettlement(ctx, { ...input(), costAmount: 6 }), /资源不足/);
    assert.throws(() => buildActionSettlement(ctx, { ...input(), delta: 99 }), /越界/);
    assert.deepEqual(ctx.chatMetadata, before);
});
test('item consumption and healing save once; failed save retries do not charge again', async () => {
    const ctx = fixture(), api = createEffects(() => ctx); let fail = true;
    ctx.saveMetadata = async () => { if (fail) throw Error('disk'); };
    api.stageAction({ ...input(), cost: { kind: 'item', itemId: 'potion' }, costAmount: 1 });
    await assert.rejects(api.confirmAction(), /disk/);
    assert.equal(readInventory(ctx).items[0].quantity, 1); assert.equal(resolveStat(ctx, 'hero', 'hp').value, 8);
    assert.throws(() => api.stageAction(input()), /尚未保存/);
    fail = false; await api.retrySave();
    assert.equal(readInventory(ctx).items[0].quantity, 1); assert.equal(resolveStat(ctx, 'hero', 'hp').value, 8);
    assert.match(api.actionResult().text, /5 → 8/); await assert.rejects(api.confirmAction()); api.dispose();
});
test('action confirmation rejects changed chat or data after preview', async () => {
    const ctx = fixture(), api = createEffects(() => ctx); api.stageAction(input()); ctx.chat.push({ is_user: true, mes: '另一个楼层' });
    await assert.rejects(api.confirmAction(), /变化/); assert.equal(resolveStat(ctx, 'hero', 'hp').value, 5); api.dispose();
});
test('existing fixed dice text and elapsed time remain fixed across a save retry', async () => {
    const ctx = fixture(); ctx.chatMetadata[SCENE] = { version: 1, events: [{ path: chatPath(ctx.chat), snapshot: { ...emptyState(), clock: { year: 2026, month: 9, day: 23, hour: 10, minute: 0, calendarLabel: '' } } }] };
    ctx.chatMetadata.amin_os_dice_v1 = { version: 1, rolls: [{ id: 'roll-one', text: '1d6 = 3', results: [{ total: 3 }], settings: {}, createdAt: 1 }] };
    const api = createEffects(() => ctx), plan = api.stageAction({ ...input(), rollId: 'roll-one', minutes: 10 });
    assert.match(plan.text, /1d6 = 3/); assert.equal(readCurrentScene(ctx).clock.minute, 0);
    ctx.saveMetadata = async () => { throw Error('offline'); }; await assert.rejects(api.confirmAction());
    assert.equal(readCurrentScene(ctx).clock.minute, 10);
    ctx.saveMetadata = async () => {}; await api.retrySave(); assert.equal(readCurrentScene(ctx).clock.minute, 10);
    assert.equal(api.actionResult().text, plan.text); api.dispose();
});
test('result isolation works without host events and pending actions reject chat or Swipe changes', async () => {
    let ctx = fixture(); const api = createEffects(() => ctx);
    api.stageAction(input()); await api.confirmAction(); assert.ok(api.actionResult());
    const original = ctx; ctx = fixture(); assert.equal(api.actionResult(), null);
    ctx = original; assert.ok(api.actionResult()); ctx.chat[0].swipe_id = 1; assert.equal(api.actionResult(), null);
    ctx.chat[0].swipe_id = 0; api.stageAction({ ...input(), delta: -1 }); ctx.chat[0].swipe_id = 1;
    await assert.rejects(api.confirmAction(), /聊天或回复版本已变化/);
    ctx = fixture(); await assert.rejects(api.confirmAction(), /聊天或回复版本已变化/); api.dispose();
});
