import { isIndependent } from '../story-state/access.js';
import { sha256HexSync } from '../tts/source-hash.js';

export const KEY = 'amin_os_linkage_v1';
export const ROOT = KEY;
export const SCOPE_TEMPLATE_KEY = 'amin_os_linkage_scope_template_v1';
export const MODULES = Object.freeze({
    characters: ['人物卡与外观', 'amin_os_characters_v1'], inventory: ['背包与账本', 'amin_os_inventory_v1'],
    relationships: ['人物关系', 'amin_os_relationships_v1'], scene: ['场景、时间与日程', 'amin_os_scene_v1'],
    journal: ['剧情档案与记忆', 'amin_os_journal_v1'], effects: ['能力与持续效果', 'amin_os_effects_v1'],
    map: ['地图', 'dynamicMapV1'], status: ['世界状态', '状态栏'], organizations: ['势力概览', '势力资料'],
    information: ['信息面板', 'amin_os_information_v1'], dice: ['固定骰点（只读）', 'amin_os_dice_v1'],
});
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const blocked = new Set(['__proto__', 'prototype', 'constructor']);
export function validateJSON(value, depth = 0) {
    if (depth > 48) throw Error('联动资料嵌套过深。');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (Array.isArray(value)) { for (const item of value) validateJSON(item, depth + 1); return; }
    if (!plain(value)) throw Error('联动资料必须是有效 JSON。');
    for (const [key, item] of Object.entries(value)) { if (blocked.has(key)) throw Error('联动资料包含受保护的字段名。'); validateJSON(item, depth + 1); }
}
export const emptyLinkageState = () => ({ version: 1, enabled: false, mode: 'review', modules: {}, extraRules: '', links: [], applied: [] });
export function validateLinkageState(raw) {
    validateJSON(raw);
    if (!plain(raw) || raw.version !== 1 || Object.keys(raw).some(k => !['version','enabled','mode','modules','extraRules','links','applied','dataSource','contextBudget','advancedActions'].includes(k))) throw Error('联动资料版本或字段不兼容。');
    if (typeof raw.enabled !== 'boolean' || !['review', 'auto'].includes(raw.mode) || !plain(raw.modules) || typeof raw.extraRules !== 'string' || raw.extraRules.length > 40000) throw Error('联动设置格式无效。');
    if (raw.contextBudget !== undefined) {
        const budget = raw.contextBudget;
        if (!plain(budget) || Object.keys(budget).some(key => !['enabled', 'maxChars', 'requiredModules', 'entrySelection'].includes(key))
            || typeof budget.enabled !== 'boolean' || !Number.isInteger(budget.maxChars) || budget.maxChars < 1000 || budget.maxChars > 2000000
            || !Array.isArray(budget.requiredModules) || budget.requiredModules.some(id => !own(MODULES, id))
            || new Set(budget.requiredModules).size !== budget.requiredModules.length) throw Error('资料预算需为 1000–2000000 字符，固定模块必须有效且不能重复。');
    }
    if (raw.contextBudget?.entrySelection !== undefined) {
        const selection = raw.contextBudget.entrySelection;
        if (!plain(selection) || Object.keys(selection).some(key => !['enabled', 'pinned'].includes(key))
            || typeof selection.enabled !== 'boolean' || !Array.isArray(selection.pinned) || selection.pinned.length > 2000
            || selection.pinned.some(id => typeof id !== 'string' || id.length > 300 || !own(MODULES, id.split(':')[0]) || !id.split(':').slice(1).join(':') || /[\x00-\x1f]/.test(id))
            || new Set(selection.pinned).size !== selection.pinned.length) throw Error('条目筛选需要有效且不重复的固定条目 ID，最多 2000 项。');
    }
    if (raw.dataSource !== undefined && !['amin','external'].includes(raw.dataSource)) throw Error('请选择有效的资料发送来源。');
    if (raw.advancedActions !== undefined && typeof raw.advancedActions !== 'boolean') throw Error('高级动作说明开关无效。');
    for (const [id, flags] of Object.entries(raw.modules)) {
        if (!own(MODULES, id) || !plain(flags) || Object.keys(flags).some(k => !['enabled', 'read', 'write'].includes(k)) || ['enabled','read','write'].some(k => typeof flags[k] !== 'boolean') || (id === 'dice' && flags.write)) throw Error('联动模块开关无效。');
        if (flags.write && !flags.read) throw Error('允许模型更新的模块必须同时提供当前资料。');
    }
    if (raw.links !== undefined) {
        if (!Array.isArray(raw.links) || raw.links.length > 2000) throw Error('手动关联必须是列表，最多 2000 条。');
        for (const link of raw.links) {
            if (!plain(link) || Object.keys(link).some(k=>!['id','from','to','label'].includes(k)) || typeof link.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(link.id) || typeof link.label !== 'string' || !link.label.trim() || link.label.length > 200) throw Error('手动关联标识或说明无效。');
            for (const key of ['from','to']) if (typeof link[key] !== 'string' || link[key].length > 300 || !Object.hasOwn(MODULES,link[key].split(':')[0]) || !link[key].split(':').slice(1).join(':')) throw Error('手动关联需要完整的模块与条目标识。');
            if (link.from === link.to) throw Error('请选择两个不同的关联条目。');
        }
        if (new Set(raw.links.map(link=>link.id)).size !== raw.links.length || new Set(raw.links.map(link=>JSON.stringify([link.from,link.to,link.label]))).size !== raw.links.length) throw Error('手动关联重复。');
    }
    if (!Array.isArray(raw.applied) || raw.applied.length > 2000) throw Error('联动更新记录格式无效或已达 2000 条上限。');
    for (const record of raw.applied) {
        if (record.archived !== undefined && typeof record.archived !== 'boolean') throw Error('联动历史归档标记无效。');
        if (!plain(record) || typeof record.id !== 'string' || !record.id || typeof record.at !== 'string' || !plain(record.source) || !Array.isArray(record.changes)) throw Error('联动更新来源记录无效。');
        const compact = record.source.textHash !== undefined || record.source.pathHash !== undefined;
        const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
        if (typeof record.source.identity !== 'string' || !Number.isInteger(record.source.index)
            || (compact ? !hash(record.source.textHash) || !hash(record.source.pathHash)
                || !Number.isInteger(record.source.swipe) || record.source.swipe < 0
                || Object.keys(record.source).some(key => !['identity', 'index', 'swipe', 'textHash', 'pathHash'].includes(key))
                : !Array.isArray(record.source.path) || record.source.path.some(v => typeof v !== 'string') || typeof record.source.text !== 'string')) throw Error('联动更新来源不完整。');
        if (record.changesHash !== undefined && !hash(record.changesHash)) throw Error('联动更新变更收据无效。');
    }
    if (new Set(raw.applied.map(r => r.id)).size !== raw.applied.length) throw Error('联动操作编号重复。');
    return { ...structuredClone(raw), links: structuredClone(raw.links ?? []) };
}
export function readLinkageState(ctx) {
    const raw = ctx?.chatMetadata?.[KEY];
    return raw === undefined ? { ...emptyLinkageState(), ...readScopeTemplate(ctx) } : validateLinkageState(raw);
}
/** Compact idempotency receipts only; business data and permissions are kept. */
export function compactLinkageReceipts(input) {
    const state = validateLinkageState(input);
    const hash = value => 'sha256:' + sha256HexSync(typeof value === 'string' ? value : JSON.stringify(value));
    state.applied = state.applied.slice(-64).map(record => ({ id: record.id, at: record.at,
        ...(record.archived !== undefined ? {archived:record.archived} : {}),
        source: {identity:record.source.identity,index:record.source.index,swipe:record.source.swipe ?? 0,
            textHash:record.source.textHash ?? hash(record.source.text),pathHash:record.source.pathHash ?? hash(record.source.path)},
        changes:[],changesHash:record.changesHash ?? hash(record.changes) }));
    return validateLinkageState(state);
}
// A template carries permissions only, never chat data, rules, IDs or history.
export function scopeTemplate(input) {
    const state = validateLinkageState({ ...emptyLinkageState(), enabled: input?.enabled, modules: input?.modules });
    return { version: 1, enabled: state.enabled, modules: Object.fromEntries(Object.keys(MODULES).map(id => [id,
        state.modules[id] ?? { enabled: false, read: false, write: false }])) };
}
export function readScopeTemplate(ctx) {
    const raw = ctx?.extensionSettings?.[SCOPE_TEMPLATE_KEY];
    if (raw === undefined) return null;
    if (raw?.version !== 1) throw Error('通用联动范围模板版本不兼容。');
    return scopeTemplate(raw);
}
export function moduleAvailable(ctx, id) {
    if (!own(MODULES, id)) return false;
    // Application availability is independent of whether its current document
    // has records. A cleared/new story must be able to create its first entity.
    if (isIndependent(ctx)) return true;
    const key = MODULES[id][1], meta = ctx?.chatMetadata ?? {};
    return id === 'status' || id === 'organizations' ? own(meta.variables ?? {}, key) : own(meta, key);
}
// Batch callers may reuse a validated state/settings snapshot for this synchronous read.
export function modulePolicy(ctx, id, state) {
    if (!own(MODULES, id)) throw Error('未知联动模块。');
    state ??= readLinkageState(ctx);
    const saved = state.modules[id];
    if (saved) return saved;
    const enabled = moduleAvailable(ctx, id);
    return { enabled, read: enabled, write: enabled && id !== 'dice' };
}
export function readLinkageSettings(ctx) {
    const state = readLinkageState(ctx);
    const { applied, ...settings } = state;
    settings.modules = Object.fromEntries(Object.keys(MODULES).map(id => [id, modulePolicy(ctx, id, state)]));
    return settings;
}
function managedPolicy(ctx, id, state) {
    try {
        state ??= readLinkageState(ctx);
        if (!state.enabled) return null;
        const policy = modulePolicy(ctx, id, state);
        return policy.enabled ? policy : null;
    } catch { return null; }
}
export function managesModule(ctx, id) { return Boolean(managedPolicy(ctx, id)); }
export function mayRead(ctx, id, state) { return managedPolicy(ctx, id, state)?.read ?? false; }
export function mayWrite(ctx, id, state) {
    const policy = managedPolicy(ctx, id, state);
    return Boolean(policy?.read && policy.write && id !== 'dice');
}

/** Explicit manual status requests work with the master off, but never override
 * a disabled module or its saved read/write permissions. */
export function mayManuallyUpdateStatus(ctx) {
    const policy = modulePolicy(ctx, 'status');
    return policy.enabled && policy.read && policy.write;
}
