import { uuid } from '../../uuid.js';
import { legacyModule, registerModuleCodec } from '../story-state/access.js';
import { chatRevisions, pathBelongs } from '../shared/message-revision.js';

export const KEY = 'amin_os_inventory_v1';
export const LIMITS = Object.freeze({ items: 1000, balances: 300, ledger: 2000, events: 2000, amount: 1000000000 });
const OPS = new Set(['save-item', 'delete-item', 'consume-item', 'use-item', 'transfer-item', 'equip-item', 'set-condition', 'save-balance', 'delete-balance', 'adjust-balance', 'transfer-balance', 'restore']);
export const WEAR_SLOTS = Object.freeze({ head: '头部', face: '面部', neck: '颈部', torso: '上身', hands: '双手', waist: '腰部', legs: '腿部', feet: '足部', back: '背部', accessory: '饰品' });
export const WEAR_LAYERS = Object.freeze({ base: '贴身层', middle: '中间层', outer: '外层' });
/** How one use is paid for. The effect itself is prose the story model plays out. */
export const USE_MODES = Object.freeze({ consume: '每次消耗一件', charges: '按剩余次数', reusable: '可反复使用' });
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, max, required = false) => {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw Error(`${label}${required ? '不能为空，且' : ''}不能超过 ${max} 字符。`);
    return value.trim();
};
const id = (value, label = '编号') => {
    const result = text(value, label, 100, true);
    if (['__proto__', 'prototype', 'constructor'].includes(result) || /[\u0000-\u001f]/u.test(result)) throw Error(`${label}无效。`);
    return result;
};
export function amount(value, label = '资源数量') {
    const normalized = typeof value === 'number' ? Math.round(value * 1000000) / 1000000 : NaN;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > LIMITS.amount || value !== normalized) throw Error(`${label}需为 0–${LIMITS.amount} 的数字，最多六位小数。`);
    return normalized;
}
const quantity = value => {
    if (!Number.isSafeInteger(value) || value < 0 || value > LIMITS.amount) throw Error(`物品数量需为 0–${LIMITS.amount} 的整数。`);
    return value;
};
const positiveQuantity = value => { quantity(value); if (!value) throw Error('操作数量必须大于零。'); return value; };
const positiveAmount = value => { const normalized = amount(value); if (!normalized) throw Error('操作金额必须大于零。'); return normalized; };
const addAmount = (a, b) => amount((Math.round(a * 1000000) + Math.round(b * 1000000)) / 1000000);
const timestamp = value => { if (typeof value !== 'string' || value.length > 60 || !Number.isFinite(Date.parse(value))) throw Error('账本保存时间无效。'); return value; };
export const emptyState = () => ({ version: 1, items: [], balances: [], ledger: [] });
export const emptyStore = () => ({ version: 1, events: [] });
export const chatPath = chat => chatRevisions(chat ?? []);
const belongs = (event, path) => pathBelongs(event?.path, path);

export function validateWear(value) {
    if (!object(value) || Object.keys(value).some(key => !['slot', 'layer', 'description'].includes(key))) throw Error('穿戴资料格式无效。');
    if (value.slot !== '' && !Object.hasOwn(WEAR_SLOTS, value.slot)) throw Error('穿戴部位无效。');
    if (!Object.hasOwn(WEAR_LAYERS, value.layer)) throw Error('穿戴层次无效。');
    return { slot: value.slot, layer: value.layer, description: text(value.description ?? '', '衣物外观', 2000) };
}
export function validateCondition(value) {
    if (!object(value) || Object.keys(value).some(key => !['wetness', 'dirt', 'damage', 'notes'].includes(key))) throw Error('物品状态格式无效。');
    for (const key of ['wetness', 'dirt', 'damage']) if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100) throw Error('湿润、污渍和破损程度必须是 0–100 的整数。');
    return { wetness: value.wetness, dirt: value.dirt, damage: value.damage, notes: text(value.notes ?? '', '状态说明', 1000) };
}
export function validateUse(value) {
    if (!object(value) || Object.keys(value).some(key => !['mode', 'effect', 'charges'].includes(key))) throw Error('道具用法格式无效。');
    if (!Object.hasOwn(USE_MODES, value.mode)) throw Error('道具消耗方式无效。');
    const use = { mode: value.mode, effect: text(value.effect ?? '', '道具效果', 2000) };
    if (value.mode === 'charges') {
        if (!Number.isSafeInteger(value.charges) || value.charges < 0 || value.charges > LIMITS.amount) throw Error(`道具剩余次数需为 0–${LIMITS.amount} 的整数。`);
        use.charges = value.charges;
    } else if (value.charges !== undefined) throw Error('只有“按剩余次数”的道具才记录剩余次数。');
    return use;
}
/** The draft line handed to the story: who uses what, how, and what it cost. */
export function useDescription(item, { user = '', target = '', intent = '', count = 1 } = {}) {
    const use = item.use ?? { mode: 'consume', effect: '' };
    const cost = use.mode === 'charges' ? `消耗 ${count} 次使用次数，剩余 ${use.charges} 次` : use.mode === 'reusable' ? '道具可反复使用，未消耗' : `消耗 ${count} 件，剩余 ${item.quantity} 件`;
    return [`【使用道具】${user || '持有人'}${target ? `对${target}` : ''}使用了「${item.name}」${intent ? `：${intent}` : '。'}`,
        use.effect ? `道具效果：${use.effect}` : '', `（${cost}。请按道具效果和当前情境演绎使用结果。）`].filter(Boolean).join('\n');
}
export function validateItem(value) {
    if (!object(value)) throw Error('物品记录损坏。');
    id(value.id); id(value.ownerId, '持有人编号'); text(value.name, '物品名称', 120, true); text(value.notes, '物品备注', 4000);
    quantity(value.quantity);
    if (typeof value.equipped !== 'boolean' || (value.equipped && !value.quantity)) throw Error('装备状态无效：零数量物品不能装备。');
    if (value.wear !== undefined) {
        const wear = validateWear(value.wear);
        if (wear.slot && value.quantity > 1) throw Error('指定穿戴部位的衣物需逐件登记，数量只能为 0 或 1。');
    }
    if (value.condition !== undefined) validateCondition(value.condition);
    if (value.use !== undefined) validateUse(value.use);
}
function validateBalance(value) {
    if (!object(value)) throw Error('资源记录损坏。');
    id(value.id); id(value.ownerId, '持有人编号'); text(value.name, '资源名称', 120, true); text(value.unit, '资源单位', 40); text(value.notes, '资源备注', 4000); amount(value.amount);
}
function validateLedger(value) {
    if (!object(value) || !OPS.has(value.op) || !Array.isArray(value.entries) || value.entries.length > 2) throw Error('账本记录损坏。');
    id(value.id); timestamp(value.at); text(value.reason, '操作原因', 1000, true); text(value.summary, '操作摘要', 2000, true);
    for (const entry of value.entries) {
        if (!object(entry) || !['item', 'balance'].includes(entry.kind)) throw Error('账本明细损坏。');
        id(entry.id); id(entry.ownerId, '持有人编号'); text(entry.name, '账本名称', 120, true);
        const validate = entry.kind === 'item' ? quantity : amount;
        validate(entry.before); validate(entry.after);
        if (typeof entry.delta !== 'number' || !Number.isFinite(entry.delta) || Math.round(entry.delta * 1000000) !== Math.round(entry.after * 1000000) - Math.round(entry.before * 1000000)) throw Error('账本增减与余额不一致。');
    }
}
function unique(values, label) {
    const ids = new Set();
    for (const value of values) { if (ids.has(value.id)) throw Error(`${label}编号重复。`); ids.add(value.id); }
}
/** Validate without filtering, rewriting, or silently resetting imported/current data. */
export function validateState(state) {
    if (!object(state) || state.version !== 1 || !Array.isArray(state.items) || !Array.isArray(state.balances) || !Array.isArray(state.ledger)) throw Error('背包与账本数据版本不兼容或数据损坏。');
    for (const key of ['items', 'balances', 'ledger']) if (state[key].length > LIMITS[key]) throw Error(`背包与账本的 ${key} 已超过容量上限。`);
    state.items.forEach(validateItem); state.balances.forEach(validateBalance); state.ledger.forEach(validateLedger);
    unique(state.items, '物品'); unique(state.balances, '资源'); unique(state.ledger, '账本');
    const occupied = new Set();
    for (const item of state.items) if (item.equipped && item.wear?.slot) {
        const key = JSON.stringify([item.ownerId, item.wear.slot, item.wear.layer]);
        if (occupied.has(key)) throw Error('同一人物的同一部位和层次已有穿戴物品，请先卸下再更换。');
        occupied.add(key);
    }
    const accounts = new Set();
    for (const balance of state.balances) {
        const key = JSON.stringify([balance.ownerId, balance.name, balance.unit]);
        if (accounts.has(key)) throw Error('同一持有人的同名同单位资源账户重复。');
        accounts.add(key);
    }
    return clone(state);
}
export function validateStore(store) {
    if (!object(store) || store.version !== 1 || !Array.isArray(store.events)) throw Error('背包与账本数据版本不兼容或数据损坏。');
    if (store.events.length > LIMITS.events) throw Error('背包操作记录已超过容量上限。');
    unique(store.events, '操作');
    for (const event of store.events) {
        if (!object(event) || !Array.isArray(event.path) || event.path.some(part => typeof part !== 'string') || !OPS.has(event.op)) throw Error('背包分支记录损坏。');
        id(event.id); timestamp(event.at); text(event.summary, '操作摘要', 2000, true); validateState(event.state);
    }
    return clone(store);
}
export function readStore(ctx) { const raw = legacyModule(ctx, 'inventory', KEY); return raw === undefined ? emptyStore() : validateStore(raw); }
export function currentState(store, chat) {
    const validated = validateStore(store), path = chatPath(chat);
    for (let index = validated.events.length - 1; index >= 0; index--) if (belongs(validated.events[index], path)) return clone(validated.events[index].state);
    return emptyState();
}
export function readInventory(ctx) { return currentState(readStore(ctx), ctx?.chat); }

const entry = (kind, record, before, after) => ({ kind, id: record.id, name: record.name, ownerId: record.ownerId, before, after, delta: (Math.round(after * 1000000) - Math.round(before * 1000000)) / 1000000 });
const find = (records, recordId, label) => { const value = records.find(record => record.id === recordId); if (!value) throw Error(`${label}已不存在，请重新选择。`); return value; };
function requireOwner(ownerId, context) {
    id(ownerId, '持有人编号');
    const owners = context.ownerIds instanceof Set ? context.ownerIds : new Set(context.ownerIds ?? []);
    if (!owners.has(ownerId)) throw Error('持有人已不存在，请从当前人物中重新选择。');
}
/** One logical change, including both sides of transfers and their immutable ledger entry. */
export function transition(source, op, data, context = {}) {
    const state = validateState(source), makeId = context.createId ?? uuid, eventId = context.id ?? makeId(), at = context.at ?? new Date().toISOString();
    if (!OPS.has(op) || op === 'restore') throw Error('背包操作类型无效。');
    if (!object(data)) throw Error('背包操作参数无效。');
    const reason = text(data.reason, '操作原因', 1000, true), entries = [];
    let summary = '';
    if (op === 'save-item') {
        const existing = data.id ? find(state.items, data.id, '物品') : null;
        if (!existing || existing.ownerId !== data.ownerId) requireOwner(data.ownerId, context);
        if (existing && existing.ownerId !== data.ownerId) throw Error('请通过转移物品改变持有人，以便保留双方账目。');
        const item = { ...(existing ?? {}), id: existing?.id ?? (data.newId ? id(data.newId) : makeId()), name: text(data.name, '物品名称', 120, true), ownerId: data.ownerId,
            quantity: quantity(data.quantity), equipped: data.equipped ?? false, notes: text(data.notes ?? '', '物品备注', 4000) };
        if (data.wear !== undefined) item.wear = validateWear(data.wear);
        if (data.condition !== undefined) item.condition = validateCondition(data.condition);
        if (data.use === null) delete item.use; else if (data.use !== undefined) item.use = validateUse(data.use);
        validateItem(item); entries.push(entry('item', item, existing?.quantity ?? 0, item.quantity));
        if (existing) state.items[state.items.indexOf(existing)] = item; else state.items.push(item);
        summary = `${existing ? '更新' : '登记'}物品「${item.name}」：${existing?.quantity ?? 0} → ${item.quantity}`;
    } else if (['consume-item', 'use-item', 'transfer-item', 'equip-item', 'delete-item', 'set-condition'].includes(op)) {
        const item = find(state.items, data.id, '物品'), before = item.quantity;
        if (op === 'use-item') {
            // Unconfigured items are used up like consumables.
            const use = item.use ?? { mode: 'consume', effect: '' }, count = positiveQuantity(data.quantity ?? 1);
            if (!item.quantity) throw Error('物品数量为 0，无法使用。');
            if (use.mode === 'consume') {
                if (count > item.quantity) throw Error('物品数量不足，无法完成操作。');
                item.quantity -= count; if (!item.quantity) item.equipped = false;
            } else if (use.mode === 'charges') {
                if (count > use.charges) throw Error(use.charges ? `「${item.name}」只剩 ${use.charges} 次使用次数。` : `「${item.name}」的使用次数已用完。`);
                item.use = { ...use, charges: use.charges - count };
            }
            summary = `使用「${item.name}」${count > 1 ? ` × ${count}` : ''}：${use.mode === 'charges' ? `剩余次数 ${use.charges} → ${item.use.charges}` : use.mode === 'reusable' ? '可反复使用，未消耗' : `${before} → ${item.quantity}`}`;
        } else if (op === 'equip-item') {
            if (typeof data.equipped !== 'boolean') throw Error('请选择装备或卸下。');
            if (data.equipped && !item.quantity) throw Error('零数量物品不能装备。');
            item.equipped = data.equipped; summary = `${item.equipped ? '装备' : '卸下'}「${item.name}」`;
        } else if (op === 'set-condition') {
            if (!object(data.condition)) throw Error('物品状态参数无效。');
            item.condition = validateCondition({ wetness: 0, dirt: 0, damage: 0, notes: '', ...item.condition, ...data.condition });
            summary = `更新「${item.name}」状态：湿润 ${item.condition.wetness} / 污渍 ${item.condition.dirt} / 破损 ${item.condition.damage}`;
        } else if (op === 'delete-item') {
            if (item.quantity) throw Error('请先消耗或转移剩余物品，再删除零数量条目。');
            state.items.splice(state.items.indexOf(item), 1); summary = `删除零数量物品「${item.name}」`;
        } else {
            const count = positiveQuantity(data.quantity);
            if (count > item.quantity) throw Error('物品数量不足，无法完成操作。');
            if (op === 'transfer-item') {
                requireOwner(data.toOwnerId, context);
                if (data.toOwnerId === item.ownerId) throw Error('转移目标必须是其他人物。');
                summary = `转移「${item.name}」× ${count}：${item.ownerId} → ${data.toOwnerId}`;
                if (item.wear?.slot) {
                    // An individually registered garment keeps its identity when handed over.
                    entries.push(entry('item', item, before, 0));
                    item.ownerId = data.toOwnerId; item.equipped = false;
                    entries.push(entry('item', item, 0, count));
                } else {
                    const target = { ...clone(item), id: data.newId ? id(data.newId) : makeId(), ownerId: data.toOwnerId, quantity: count, equipped: false };
                    state.items.push(target); entries.push(entry('item', target, 0, count));
                }
            } else summary = `消耗「${item.name}」× ${count}`;
            if (!(op === 'transfer-item' && item.wear?.slot)) item.quantity -= count;
            if (!item.quantity) item.equipped = false;
        }
        if (!(op === 'transfer-item' && item.wear?.slot)) entries.unshift(entry('item', item, before, item.quantity));
    } else if (op === 'save-balance') {
        const existing = data.id ? find(state.balances, data.id, '资源账户') : null;
        if (!existing || existing.ownerId !== data.ownerId) requireOwner(data.ownerId, context);
        if (existing && existing.ownerId !== data.ownerId) throw Error('请通过转账改变资源归属，以便保留双方账目。');
        const balance = { ...(existing ?? {}), id: existing?.id ?? (data.newId ? id(data.newId) : makeId()), name: text(data.name, '资源名称', 120, true), ownerId: data.ownerId,
            amount: amount(data.amount), unit: text(data.unit ?? '', '资源单位', 40), notes: text(data.notes ?? '', '资源备注', 4000) };
        validateBalance(balance); entries.push(entry('balance', balance, existing?.amount ?? 0, balance.amount));
        if (existing) state.balances[state.balances.indexOf(existing)] = balance; else state.balances.push(balance);
        summary = `${existing ? '校正' : '登记'}「${balance.name}」：${existing?.amount ?? 0} → ${balance.amount}${balance.unit}`;
    } else {
        const balance = find(state.balances, data.id, '资源账户'), before = balance.amount;
        if (op === 'delete-balance') {
            if (balance.amount) throw Error('请先支出或转移剩余资源，再删除零余额账户。');
            state.balances.splice(state.balances.indexOf(balance), 1); summary = `删除零余额账户「${balance.name}」`;
        } else if (op === 'adjust-balance') {
            if (typeof data.delta !== 'number' || !data.delta) throw Error('收支数量必须是非零数字。');
            const delta = (data.delta < 0 ? -1 : 1) * positiveAmount(Math.abs(data.delta));
            balance.amount = addAmount(balance.amount, delta);
            summary = `${delta > 0 ? '收入' : '支出'}「${balance.name}」${Math.abs(delta)}${balance.unit}：${before} → ${balance.amount}`;
        } else {
            const count = positiveAmount(data.amount); requireOwner(data.toOwnerId, context);
            if (data.toOwnerId === balance.ownerId) throw Error('转账目标必须是其他人物。');
            if (count > balance.amount) throw Error('资源余额不足，无法完成转账。');
            let target = state.balances.find(value => value.ownerId === data.toOwnerId && value.name === balance.name && value.unit === balance.unit);
            if (!target) { target = { ...clone(balance), id: data.newId ? id(data.newId) : makeId(), ownerId: data.toOwnerId, amount: 0 }; state.balances.push(target); }
            const targetBefore = target.amount; target.amount = addAmount(target.amount, count);
            balance.amount = addAmount(balance.amount, -count); entries.push(entry('balance', target, targetBefore, target.amount));
            summary = `转账「${balance.name}」${count}${balance.unit}：${balance.ownerId} → ${data.toOwnerId}`;
        }
        entries.unshift(entry('balance', balance, before, balance.amount));
    }
    state.ledger.push({ id: eventId, at, op, reason, entries, summary });
    return { state: validateState(state), summary, id: eventId, at, op };
}

export function appendEvent(store, chat, change) {
    const next = validateStore(store);
    if (next.events.some(event => event.id === change.id)) throw Error('背包操作编号已使用，不能重复提交。');
    next.events.push({ id: change.id, at: change.at, path: chatPath(chat), op: change.op, summary: change.summary, state: validateState(change.state) });
    return validateStore(next);
}
export function change(store, chat, op, data, context = {}) {
    const result = transition(currentState(store, chat), op, data, context);
    return { ...result, store: appendEvent(store, chat, result) };
}
/** Restore saved materialized facts at the current tail without replacing any chat messages. */
export function buildRestoreStore(ctx, snapshot, options = {}) {
    const state = validateState(snapshot), eventId = options.id ?? uuid(), at = options.at ?? new Date().toISOString();
    const reason = text(options.reason ?? '恢复跨应用存档', '恢复原因', 1000, true), summary = `恢复背包与资源账本存档到当前剧情位置：${reason}`;
    // The outer branch event records this restore. Keep the saved ledger exact,
    // including a valid ledger already at capacity; restoration is not a trade.
    return appendEvent(readStore(ctx), ctx?.chat, { id: eventId, at, op: 'restore', summary, state });
}

registerModuleCodec('inventory', {
    toLegacy(ctx, snapshot) {
        return { [KEY]: { version: 1, events: [{ id: 'independent_inventory', at: '1970-01-01T00:00:00.000Z', path: [], op: 'restore', summary: '当前背包与账本', state: validateState(snapshot ?? emptyState()) }] } };
    },
    fromLegacy(ctx) { return readInventory(ctx); },
});
