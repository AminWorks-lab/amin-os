import { getAdapter } from './registry.js';
import { canonicalAction } from './contract.js';
import { LIMITS } from '../characters/model.js';
import { FIELDS as ORGANIZATION_FIELDS, LINKS as ORGANIZATION_LINKS } from '../organizations/model.js';

// Models routinely send a usable update in a slightly wrong shape: a change
// without data, the record id repeated inside data, a synonym such as count
// for quantity, or extra attributes the app does not store. Adapters stay
// strict; this pass rewrites only those predictable slips before validation
// and reports each one, so a single stray key no longer voids the whole batch.
// A payload that is already valid passes through unchanged (receipts and
// idempotency hashes depend on that).
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const blank = value => value == null || value === '' || (Array.isArray(value) && !value.length) || (object(value) && !Object.keys(value).length);
const show = value => typeof value === 'string' ? value.trim() : Array.isArray(value) && value.every(item => !object(item) && !Array.isArray(item)) ? value.join('、') : JSON.stringify(value);
const CHANGE_KEYS = ['module', 'action', 'target', 'data', 'reason'];
const MODULE_ALIASES = { character: 'characters', person: 'characters', people: 'characters', item: 'inventory', items: 'inventory', backpack: 'inventory', relationship: 'relationships', relation: 'relationships', effect: 'effects', fact: 'journal', facts: 'journal', world_status: 'status', worldStatus: 'status' };
// The record's own id repeated inside data.
const ECHO_KEYS = ['id', 'target', 'characterId', 'itemId', 'balanceId', 'sceneId', 'scheduleId', 'effectId', 'entryId', 'relationshipId', 'panelId', 'nodeId', 'edgeId', 'entityId'];
const REASON_KEYS = ['evidence', 'because', 'note', 'summary', 'description'];

// Synonyms rename only when the canonical key is accepted and absent.
const SYNONYMS = {
    '*': { notes: ['note', 'remark', 'remarks', 'comment'], body: ['content', 'text'] },
    characters: { notes: ['background', 'bio'], kind: ['type', 'role'] },
    inventory: {
        quantity: ['count', 'qty', 'number', 'amount'], ownerId: ['owner', 'ownerID', 'owner_id', 'characterId', 'holderId', 'holder'],
        toOwnerId: ['to', 'toId', 'recipientId', 'receiverId', 'toCharacterId', 'targetOwnerId'], notes: ['description', 'desc'],
        unit: ['currency'], amount: ['value', 'balance'], delta: ['change', 'amount', 'diff'],
    },
    relationships: { fromId: ['from', 'fromCharacterId', 'sourceId'], toId: ['to', 'toCharacterId', 'targetId'], type: ['relation', 'relationship', 'kind'], notes: ['description'], strength: ['score', 'affinity', 'value'] },
    journal: { body: ['description', 'detail', 'details'], title: ['name'] },
    scene: { minutes: ['duration', 'durationMinutes'], notes: ['description'] },
    status: { delta: ['change', 'amount', 'diff'] },
};
// Values these keys may hold; a synonym carrying something else is not renamed.
const ACCEPTS = {
    kind: { characters: value => ['pc', 'npc'].includes(value) },
    strength: { relationships: value => typeof value === 'number' },
};

function synonyms(module, allowed, data, renamed) {
    const table = { ...SYNONYMS['*'], ...SYNONYMS[module] };
    for (const [key, list] of Object.entries(table)) {
        if (!allowed.includes(key) || Object.hasOwn(data, key)) continue;
        const alias = list.find(name => Object.hasOwn(data, name) && !allowed.includes(name) && (ACCEPTS[key]?.[module]?.(data[name]) ?? true));
        if (!alias) continue;
        data[key] = data[alias]; delete data[alias]; renamed.push(`${alias}→${key}`);
    }
}

function append(text, entries, limit) {
    let next = typeof text === 'string' ? text.trim() : '', count = 0;
    for (const [key, value] of entries) {
        const line = `${key}：${show(value)}`, joined = next ? `${next}\n${line}` : line;
        if (joined.length > limit) break;
        next = joined; count++;
    }
    return { text: next, count };
}

// Nested shapes the adapters also check key by key.
function nested(change, action, data, dropped) {
    if (change.module === 'characters') {
        if (action === 'update-appearance' && object(data.appearance)) {
            const inner = data.appearance; delete data.appearance;
            for (const [key, value] of Object.entries(inner)) data[key] ??= value;
        }
        if (['create-character', 'update-character'].includes(action)) {
            for (const key of ['description', 'hairstyle', 'features']) if (Object.hasOwn(data, key)) {
                data.appearance = object(data.appearance) ? { ...data.appearance } : {}; data.appearance[key] ??= data[key]; delete data[key];
            }
            if (object(data.appearance)) for (const key of Object.keys(data.appearance)) if (!['description', 'hairstyle', 'features'].includes(key)) {
                data[`外观·${key}`] = data.appearance[key]; delete data.appearance[key];
            }
        }
        const stats = action === 'save-stat' ? null : data.stats;
        if (Array.isArray(stats)) data.stats = stats.map(stat => {
            if (!object(stat)) return stat;
            // Numbers belong to World Status; a stat only names its binding.
            const keep = ['id', 'label', 'binding', 'component', 'check'], clean = Object.fromEntries(Object.entries(stat).filter(([key]) => keep.includes(key)));
            dropped.push(...Object.keys(stat).filter(key => !keep.includes(key)).map(key => `stats.${key}`));
            clean.check ??= 'none';
            return clean;
        });
    }
    if (change.module === 'scene' && action === 'save-scene') for (const key of ['participants', 'objects', 'weather', 'notes']) {
        if (Array.isArray(data[key]) && data[key].every(item => typeof item === 'string')) data[key] = data[key].join('、');
    }
    // Only stack mode has layers; independent/refresh are always one.
    if (change.module === 'effects' && object(data.stacking) && data.stacking.mode !== 'stack') data.stacking = { ...data.stacking, maxStacks: 1, stacks: 1 };
    // Knowledge takes its title from the fact; a model-written one is redundant.
    if (change.module === 'journal' && action === 'save-knowledge') for (const key of ['title', 'body']) delete data[key];
    if (change.module === 'organizations' && object(data.fields) && Object.hasOwn(ORGANIZATION_FIELDS, data.group)) {
        const fields = { ...data.fields }, keep = [...Object.keys(ORGANIZATION_FIELDS[data.group]), ...Object.keys(ORGANIZATION_LINKS[data.group]), 'metrics'];
        for (const [key, list] of Object.entries({ summary: ['description', 'desc'], leadership: ['leader', 'leaders'], goals: ['goal'] })) {
            const alias = list.find(name => Object.hasOwn(fields, name));
            if (keep.includes(key) && !Object.hasOwn(fields, key) && alias) { fields[key] = fields[alias]; delete fields[alias]; }
        }
        const extra = Object.keys(fields).filter(key => !keep.includes(key));
        for (const key of extra) delete fields[key];
        dropped.push(...extra.map(key => `fields.${key}`));
        data.fields = fields;
    }
    if (change.module === 'inventory') {
        for (const [key, keep] of [['wear', ['slot', 'layer', 'description']], ['condition', ['wetness', 'dirt', 'damage', 'notes']]]) {
            if (!object(data[key])) continue;
            const extra = Object.keys(data[key]).filter(name => !keep.includes(name));
            if (!extra.length) continue;
            data[key] = Object.fromEntries(Object.entries(data[key]).filter(([name]) => keep.includes(name)));
            dropped.push(...extra.map(name => `${key}.${name}`));
        }
    }
}

/**
 * Repair one change in place of a copy. `fold` (draft generation) keeps extra
 * attributes as "字段：值" lines in notes/body; otherwise they are dropped.
 * `previous` returns the record the change edits, so supplement mode never
 * rewrites a populated notes/body.
 */
export function repairChange(input, { fold = false, mode, previous } = {}) {
    if (!object(input)) return { change: input, notes: [] };
    const change = { ...input }, notes = [], label = () => `${change.module ?? '更新'} ${change.action ?? ''}${change.target ? `（${change.target}）` : ''}`.trim();
    if (typeof change.module === 'string' && !getAdapter(change.module) && MODULE_ALIASES[change.module]) { notes.push(`模块 ${change.module} 按 ${MODULE_ALIASES[change.module]} 处理。`); change.module = MODULE_ALIASES[change.module]; }
    const adapter = getAdapter(change.module), action = canonicalAction(adapter?.spec, change.action), allowed = adapter?.dataFields?.(action);
    if (change.data === undefined || change.data === null) change.data = {};
    if (object(change.data)) change.data = { ...change.data };
    if (change.target === undefined && Array.isArray(allowed) && !allowed.includes('id') && object(change.data) && typeof change.data.id === 'string' && change.data.id) { change.target = change.data.id; delete change.data.id; }
    if (change.target === undefined && typeof change.id === 'string' && change.id) change.target = change.id;
    if ((typeof change.reason !== 'string' || !change.reason.trim())) {
        const key = REASON_KEYS.find(name => typeof change[name] === 'string' && change[name].trim());
        if (key) change.reason = change[key];
    }
    const extraKeys = Object.keys(change).filter(key => !CHANGE_KEYS.includes(key));
    for (const key of extraKeys) delete change[key];
    if (extraKeys.length) notes.push(`${label()} 忽略了外层多余字段 ${extraKeys.join('、')}。`);
    if (!Array.isArray(allowed) || !object(change.data)) return { change, notes };
    const data = change.data, renamed = [], dropped = [], folded = [];
    for (const key of Object.keys(data)) if (!allowed.includes(key) && ECHO_KEYS.includes(key) && data[key] === change.target) delete data[key];
    nested(change, action, data, dropped);
    synonyms(change.module, allowed, data, renamed);
    const extra = Object.keys(data).filter(key => !allowed.includes(key)), pending = extra.map(key => [key, data[key]]).filter(([, value]) => !blank(value));
    for (const key of extra) delete data[key];
    const sink = change.module === 'characters' && action === 'update-appearance' ? 'features' : allowed.includes('notes') ? 'notes' : allowed.includes('body') ? 'body' : null;
    if (pending.length) {
        const prior = previous?.(change), existing = sink === 'features' ? prior?.appearance?.features : prior?.[sink];
        // Supplement mode only fills blanks, so a populated notes/body stays as is.
        if (fold && sink && !(mode === 'supplement' && typeof existing === 'string' && existing.trim())) {
            const result = append(data[sink] ?? existing ?? '', pending, sink === 'features' ? 2000 : LIMITS.text);
            if (result.count) data[sink] = result.text;
            folded.push(...pending.slice(0, result.count).map(([key]) => key)); dropped.push(...pending.slice(result.count).map(([key]) => key));
        } else dropped.push(...pending.map(([key]) => key));
    }
    const sinkName = { notes: '备注', body: '正文', features: '外貌特征' }[sink];
    if (renamed.length) notes.push(`${label()} 的字段 ${renamed.join('、')} 已按协议改名。`);
    if (folded.length) notes.push(`${label()} 的 ${folded.join('、')} 不是该应用的字段，已并入${sinkName}。`);
    if (dropped.length) notes.push(`${label()} 的 ${[...new Set(dropped)].join('、')} 不是该应用的字段，已忽略。`);
    return { change, notes };
}
/** Repair every change of a raw (already JSON-parsed) update object. */
export function repairUpdate(raw, options = {}) {
    if (!object(raw) || !Array.isArray(raw.changes)) return { update: raw, notes: [] };
    const notes = [], changes = raw.changes.map(change => { const result = repairChange(change, options); notes.push(...result.notes); return result.change; });
    return { update: { ...raw, changes }, notes };
}
