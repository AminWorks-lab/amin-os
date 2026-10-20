import { KEY, anchor, activeEffects, readStore } from './model.js';
import { LIBRARY_KEY } from './library.js';
import { KEY as SCENE_KEY, readCurrentScene, validateClock } from '../scene/model.js';
import { KEY as CHARACTERS_KEY, STATUS_PATH, resolveStat, readCharacters } from '../characters/model.js';
import { KEY as INVENTORY_KEY, readInventory } from '../inventory/model.js';
import { HISTORY_KEY } from '../status/history.js';
import { adapter as statusAdapter } from '../linkage/adapters/status.js';
import { adapter as inventoryAdapter } from '../linkage/adapters/inventory.js';
import { periodicStatus, validatePeriodicConfig } from './rules.js';
import { toLegacyContext } from '../story-state/access.js';

export const SETTLEMENT_PATHS = [[KEY], [SCENE_KEY], [CHARACTERS_KEY], [INVENTORY_KEY], [...STATUS_PATH], [HISTORY_KEY]];
export const MANUAL_SETTLEMENT_PATHS = [...SETTLEMENT_PATHS, ['variables'], ['LWB_RULES_V2'], ['extensions', 'LittleWhiteBox']];
export function metadataEffects(store, ctx) {
    const next = structuredClone(store);
    if (ctx.extensionSettings?.[LIBRARY_KEY]) next.skills = structuredClone(ctx.chatMetadata[KEY]?.skills ?? []);
    delete next.trash; delete next.groups;
    return next;
}
const rounded = value => {
    const result = Math.round(value * 1000000) / 1000000;
    if (!Number.isFinite(result) || Math.abs(result) > 1000000000) throw Error('累计周期增减超出数值上限，请拆分效果或修正游戏时间。');
    return result;
};

export function operationReference(ctx, operation) {
    if (operation.kind === 'stat') {
        const resolved = resolveStat(ctx, operation.characterId, operation.statId);
        return { label: `${resolved.character.name} · ${resolved.label}`, value: resolved.value, binding: resolved.stat.binding, component: resolved.stat.component };
    }
    const inventory = readInventory(ctx);
    const record = operation.kind === 'item' ? inventory.items.find(item => item.id === operation.itemId) : inventory.balances.find(balance => balance.id === operation.balanceId);
    if (!record) throw Error(operation.kind === 'item' ? '周期绑定的物品已不存在，请重新绑定。' : '周期绑定的资源账户已不存在，请重新绑定。');
    const owner = readCharacters(ctx).characters.find(character => character.id === record.ownerId);
    return { label: `${owner?.name ?? record.ownerId} · ${record.name}`, ownerId: record.ownerId, value: operation.kind === 'item' ? record.quantity : record.amount };
}
export function validatePeriodicReferences(ctx, config) {
    for (const operation of validatePeriodicConfig(config).operations) operationReference(ctx, operation);
}

// Lightweight forecast for time/scene previews. It does not apply adapters or
// mutate metadata, and it reports broken clocks rather than guessing elapsed time.
export function periodicPreview(ctx, clock = readCurrentScene(ctx).clock) {
    const records = activeEffects(readStore(ctx), ctx?.chat).filter(effect => effect.periodic).map(effect => ({
        id: effect.id, name: effect.skill.name, target: effect.target || effect.holder,
        ...periodicStatus(effect, clock), lastSettledAt: structuredClone(effect.periodic.lastSettledAt),
    }));
    return { clock: structuredClone(clock), pending: records.filter(record => record.pendingTicks > 0), unknown: records.filter(record => record.state === 'unknown'), records };
}

function applyPatches(ctx, patches, output) {
    for (const patch of patches) {
        let parent = ctx.chatMetadata;
        for (const key of patch.path.slice(0, -1)) parent = parent[key] ??= {};
        const key = patch.path.at(-1);
        if (patch.remove) delete parent[key]; else parent[key] = structuredClone(patch.value);
        output.set(JSON.stringify(patch.path), structuredClone(patch));
    }
}

// All resource and settlement-watermark patches are prepared on a cloned
// metadata snapshot. Any missing binding, insufficient stock or numeric boundary
// rejects the whole plan. Only the shared operation service commits this plan.
export function buildSettlement(ctx, { effectIds, operationId, now = new Date().toISOString() } = {}) {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9:_-]{1,80}$/.test(operationId)) throw Error('周期结算操作编号无效。');
    const clock = validateClock(readCurrentScene(ctx).clock), store = readStore(ctx), effects = activeEffects(store, ctx.chat);
    if (effectIds !== undefined && (!Array.isArray(effectIds) || !effectIds.length || new Set(effectIds).size !== effectIds.length)) throw Error('请选择需要结算的效果。');
    if (effectIds?.some(id => !effects.some(effect => effect.id === id))) throw Error('所选效果已不在当前剧情分支。');
    if (store.events.some(event => event.operationId === operationId && event.op === 'settle')) throw Error('此周期结算已提交，不能重复执行。');
    const selected = effects.filter(effect => effect.periodic && (!effectIds || effectIds.includes(effect.id)));
    const working = toLegacyContext(ctx), patches = new Map(), rows = [];
    let sequence = 0;
    for (const effect of selected) {
        const status = periodicStatus(effect, clock);
        if (status.state === 'unknown') throw Error(`${effect.skill.name}：${status.label}`);
        if (!status.pendingTicks) continue;
        const stacks = effect.periodic.scaleWithStacks ? effect.stacking?.stacks ?? 1 : 1;
        const multiplier = status.pendingTicks * stacks, changes = [];
        for (const operation of effect.periodic.operations) {
            const before = operationReference(working, operation);
            const reason = `持续效果「${effect.skill.name}」结算 ${status.pendingTicks} 个周期${stacks > 1 ? ` × ${stacks} 层` : ''}`;
            let adapter, request;
            if (operation.kind === 'stat') {
                adapter = statusAdapter;
                request = { module: 'status', action: 'adjust', target: before.binding, data: { delta: rounded(operation.delta * multiplier), component: before.component }, reason };
            } else if (operation.kind === 'item') {
                adapter = inventoryAdapter;
                request = { module: 'inventory', action: 'consume-item', target: operation.itemId, data: { quantity: rounded(operation.quantity * multiplier) }, reason };
            } else {
                adapter = inventoryAdapter;
                request = { module: 'inventory', action: 'adjust-balance', target: operation.balanceId, data: { delta: rounded(operation.delta * multiplier) }, reason };
            }
            const result = adapter.apply(working, request, { operationId: `${operationId}:${sequence++}`, now });
            applyPatches(working, result.patches, patches);
            const after = operationReference(working, operation);
            changes.push({ kind: operation.kind, label: before.label, before: before.value, after: after.value, delta: rounded(after.value - before.value), summary: result.summary });
        }
        store.events.push({ op: 'settle', operationId, id: effect.id, anchor: anchor(ctx.chat), at: now, floor: ctx.chat?.length ?? 0,
            patch: { periodic: { ...structuredClone(effect.periodic), settledTicks: status.totalTicks, lastSettledAt: structuredClone(clock) } },
            ticks: status.pendingTicks, stacks, changes });
        rows.push({ effectId: effect.id, name: effect.skill.name, target: effect.target || effect.holder, ticks: status.pendingTicks, stacks, changes });
    }
    if (!rows.length) throw Error('当前没有到期且尚未结算的周期。');
    const next = metadataEffects(store, ctx);
    patches.set(JSON.stringify([KEY]), { path: [KEY], value: next });
    return { patches: [...patches.values()], summary: `结算 ${rows.length} 项持续效果，共 ${rows.reduce((sum, row) => sum + row.ticks, 0)} 个周期`, rows, clock };
}
