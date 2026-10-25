import { chatRevision } from '../shared/chat-revision.js';
import { KEY, readStore, readInventory, change } from './model.js';
import { KEY as CHARACTERS_KEY, readCharacters } from '../characters/model.js';
import { createOperationService, subscribeStateChanges, chatIdentity } from '../shared/operations.js';

const dependencies = [[KEY], [CHARACTERS_KEY]];
const clone = value => structuredClone(value);
const labels = {
    'save-item': '登记或调整物品', 'delete-item': '删除零数量物品', 'consume-item': '消耗物品',
    'use-item': '使用道具', 'transfer-item': '转移物品', 'equip-item': '修改装备状态', 'save-balance': '登记或校正资源账户',
    'set-condition': '更新物品状态',
    'delete-balance': '删除零余额账户', 'adjust-balance': '记录资源收支', 'transfer-balance': '转移资源',
};

/** Inventory changes share the same commit lock and retry semantics as other apps. */
export function createInventoryService(getContext = () => globalThis.SillyTavern?.getContext?.(), { poll = false, createId, now = () => new Date().toISOString() } = {}) {
    const operations = createOperationService(getContext), listeners = new Set(), removers = [];
    let disposed = false, lastScope = null;
    const notify = () => { for (const callback of [...listeners]) { try { callback(); } catch { /* Views do not interrupt committed state. */ } } };
    const ensureOpen = () => { if (disposed) throw Error('背包服务已关闭。'); };
    const capture = (paths = []) => { ensureOpen(); return operations.capture([...dependencies, ...paths]); };
    const owners = () => readCharacters(getContext()).characters;
    function preview() {
        const result = operations.preview();
        if (!result) return null;
        const store = result.patches.find(patch => patch.path.length === 1 && patch.path[0] === KEY)?.value;
        const event = store?.events.at(-1);
        return { ...result, op: event?.op, state: clone(event?.state), entries: clone(event?.state?.ledger.at(-1)?.entries ?? []) };
    }
    function stage(op, data, token = capture()) {
        ensureOpen();
        if (!Object.hasOwn(labels, op)) throw Error('背包操作类型无效。');
        const ctx = operations.check(token);
        const result = change(readStore(ctx), ctx.chat, op, clone(data), { ownerIds: readCharacters(ctx).characters.map(character => character.id), createId, at: now() });
        operations.stage({ label: labels[op], summary: result.summary, patches: [{ path: [KEY], value: result.store }] }, token);
        return preview();
    }
    function scope() {
        const ctx = getContext();
        return { metadata: ctx?.chatMetadata, identity: chatIdentity(ctx), path: chatRevision(ctx?.chat), basis: JSON.stringify([ctx?.chatMetadata?.[KEY], ctx?.chatMetadata?.[CHARACTERS_KEY]]) };
    }
    function sync() {
        if (disposed) return;
        const next = scope();
        if (lastScope && next.metadata === lastScope.metadata && next.identity === lastScope.identity && next.path === lastScope.path && next.basis === lastScope.basis) return;
        if (lastScope && operations.preview()) operations.discard();
        lastScope = next; notify();
    }
    removers.push(operations.subscribe(notify));
    removers.push(subscribeStateChanges(detail => { if (detail.paths.some(path => [KEY, CHARACTERS_KEY].includes(path[0]))) sync(); }));
    const initial = getContext(), source = initial?.eventSource, types = initial?.eventTypes ?? initial?.event_types ?? {};
    for (const name of ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
        if (source?.on && types[name]) {
            source.on(types[name], sync);
            removers.push(() => source.removeListener ? source.removeListener(types[name], sync) : source.off?.(types[name], sync));
        }
    }
    const timer = poll ? setInterval(sync, 800) : null;
    sync();
    return {
        context: getContext, capture, check: operations.check, owners, stage, preview, sync,
        read: () => readInventory(getContext()),
        async confirm() { await operations.confirm(); return readInventory(getContext()); },
        async retrySave() { await operations.retrySave(); return readInventory(getContext()); },
        discard: operations.discard, status: operations.status, busy: operations.busy, dirty: operations.dirty,
        saveItem: (data, token) => stage('save-item', data, token),
        deleteItem: (data, token) => stage('delete-item', data, token),
        consumeItem: (data, token) => stage('consume-item', data, token),
        useItem: (data, token) => stage('use-item', data, token),
        transferItem: (data, token) => stage('transfer-item', data, token),
        equipItem: (data, token) => stage('equip-item', data, token),
        setCondition: (data, token) => stage('set-condition', data, token),
        saveBalance: (data, token) => stage('save-balance', data, token),
        adjustBalance: (data, token) => stage('adjust-balance', data, token),
        transferBalance: (data, token) => stage('transfer-balance', data, token),
        subscribe(callback) { ensureOpen(); listeners.add(callback); return () => listeners.delete(callback); },
        dispose() { if (disposed) return; disposed = true; clearInterval(timer); for (const remove of removers) remove(); operations.dispose(); listeners.clear(); },
    };
}
let shared;
export function getSharedInventoryService(getContext) { return shared ??= createInventoryService(getContext, { poll: true }); }
