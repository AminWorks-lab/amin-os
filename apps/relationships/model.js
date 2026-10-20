import { uuid } from '../../uuid.js';
import { legacyModule, registerModuleCodec } from '../story-state/access.js';
import { readCharacters } from '../characters/model.js';
import { chatRevisions, pathBelongs, sameMessageRevision, validMessageRevision } from '../shared/message-revision.js';

export const KEY = 'amin_os_relationships_v1';
export const LIMITS = Object.freeze({ relationships: 500, events: 1000, rules: 200, alerts: 1000, sources: 30, text: 4000, prompt: 12000, storeChars: 20000000 });
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !unsafe.has(value);
function keys(value, allowed, label) {
    if (!object(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || unsafe.has(key) || !allowed.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)))) throw Error(`${label}格式不兼容，原记录未改写。`);
}
function array(value, limit, label) {
    if (!Array.isArray(value) || value.length > limit || Object.keys(value).length !== value.length) throw Error(`${label}格式或数量不兼容。`);
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index) || !('value' in Object.getOwnPropertyDescriptor(value, String(index)))) throw Error(`${label}不能包含空项或访问器。`);
}
function text(value, label, max, required = false) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw Error(`${label}需为${required ? '非空的 ' : ' '} ${max} 字以内文本。`);
    return value.trim();
}
const checkedId = (value, label) => { if (!validId(value)) throw Error(`${label}无效。`); return value; };
export const emptyState = () => ({ version: 1, relationships: [], settings: { includeInContext: false } });
export const emptyStore = () => ({ version: 1, events: [] });

// Exact content/candidate evidence: copied metadata cannot expose another branch's facts.
export const chatPath = chat => {
    if (!Array.isArray(chat ?? [])) throw Error('聊天消息格式不兼容。');
    return chatRevisions((chat ?? []).map(message => {
        if (!object(message)) throw Error('聊天消息格式不兼容。');
        return message;
    }));
};
export const belongs = (event, path) => pathBelongs(event?.path, path);

export function sourceReferences(chat, indices) {
    array(indices, LIMITS.sources, '关系来源');
    const path = chatPath(chat);
    if (new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= path.length)) throw Error('关系来源楼层无效或重复。');
    return indices.map(index => ({ index, revision: path[index] }));
}
export function validateEvidence(input) {
    keys(input, ['origin', 'reason', 'sources'], '关系更新依据');
    if (!['manual', 'ai', 'linkage'].includes(input.origin)) throw Error('关系更新来源无效。');
    const reason = text(input.reason, '关系更新原因', LIMITS.text, true);
    array(input.sources, LIMITS.sources, '关系来源');
    const sources = input.sources.map(source => {
        keys(source, ['index', 'revision'], '关系来源楼层');
        if (!Number.isInteger(source.index) || source.index < 0 || source.index > 99999) throw Error('关系来源楼层无效。');
        const revision = text(source.revision, '关系来源楼层记录', 200000, true);
        if (!validMessageRevision(revision)) throw Error('关系来源楼层记录格式无效。');
        return { index: source.index, revision };
    });
    if (new Set(sources.map(source => source.index)).size !== sources.length) throw Error('关系来源楼层重复。');
    return { origin: input.origin, reason, sources };
}
export function evidenceMatches(evidence, chat) {
    if (!evidence) return true;
    const path = chatPath(chat);
    return evidence.sources.every(source => sameMessageRevision(path[source.index], source.revision));
}
const strengthValue = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000000) throw Error('关系强度需为 -1000000000 至 1000000000 的有限数字；未填写时不记录强度。');
    return value;
};
export function validateThresholdRule(input) {
    keys(input, ['id', 'relationshipId', 'operator', 'value', 'message', 'enabled', 'repeat'], '关系阈值规则');
    if (!['gte', 'lte'].includes(input.operator) || typeof input.enabled !== 'boolean' || !['once', 'crossing'].includes(input.repeat ?? 'once')) throw Error('关系阈值条件、启用状态或提醒方式无效。');
    return { id: checkedId(input.id, '阈值规则编号'), relationshipId: checkedId(input.relationshipId, '关系编号'), operator: input.operator,
        value: strengthValue(input.value), message: text(input.message, '阈值提醒', 1000, true), enabled: input.enabled, repeat: input.repeat ?? 'once' };
}
const ruleSignature = rule => JSON.stringify([rule.id, rule.relationshipId, rule.operator, rule.value, rule.message, rule.repeat]);
function validateAlert(input) {
    keys(input, ['id', 'ruleId', 'relationshipId', 'signature', 'at', 'operator', 'value', 'strength', 'previousStrength', 'message', 'acknowledged'], '关系阈值提醒');
    if (!['gte', 'lte'].includes(input.operator) || typeof input.acknowledged !== 'boolean' || typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at))) throw Error('关系阈值提醒格式无效。');
    return { id: checkedId(input.id, '阈值提醒编号'), ruleId: checkedId(input.ruleId, '阈值规则编号'), relationshipId: checkedId(input.relationshipId, '关系编号'),
        signature: text(input.signature, '阈值规则签名', 3000, true), at: text(input.at, '提醒时间', 100, true), operator: input.operator, value: strengthValue(input.value),
        strength: strengthValue(input.strength), ...(Object.hasOwn(input, 'previousStrength') ? { previousStrength: strengthValue(input.previousStrength) } : {}),
        message: text(input.message, '阈值提醒', 1000, true), acknowledged: input.acknowledged };
}
const matches = (rule, relationship) => typeof relationship?.strength === 'number' && (rule.operator === 'gte' ? relationship.strength >= rule.value : relationship.strength <= rule.value);
// A threshold is only a reminder. It never creates story events or changes another module.
export function evaluateThresholds(before, after, { operationId, at } = {}) {
    const state = validateState(after), alerts = state.thresholdAlerts ?? [];
    for (const rule of state.thresholdRules ?? []) {
        const old = before.relationships.find(value => value.id === rule.relationshipId), current = state.relationships.find(value => value.id === rule.relationshipId);
        if (!rule.enabled || typeof old?.strength !== 'number' || matches(rule, old) || !matches(rule, current)) continue;
        const signature = ruleSignature(rule);
        if (rule.repeat === 'once' && alerts.some(alert => alert.signature === signature)) continue;
        const id = `${operationId}_alert_${alerts.length}`;
        alerts.push(validateAlert({ id, ruleId: rule.id, relationshipId: rule.relationshipId, signature, at,
            operator: rule.operator, value: rule.value, strength: current.strength, ...(typeof old?.strength === 'number' ? { previousStrength: old.strength } : {}), message: rule.message, acknowledged: false }));
    }
    if (alerts.length || Object.hasOwn(state, 'thresholdAlerts')) state.thresholdAlerts = alerts;
    return validateState(state);
}

export function validateRelationship(input) {
    keys(input, ['id', 'fromId', 'toId', 'type', 'label', 'notes', 'strength', 'evidence'], '人物关系');
    const value = {
        id: checkedId(input.id, '关系编号'), fromId: checkedId(input.fromId, '起点人物编号'), toId: checkedId(input.toId, '终点人物编号'),
        type: text(input.type, '关系类型', 60, true), label: text(input.label ?? '', '关系名称', 120), notes: text(input.notes ?? '', '关系说明', LIMITS.text),
    };
    if (value.fromId === value.toId) throw Error('关系的起点和终点需为不同人物。');
    if (Object.hasOwn(input, 'strength')) {
        value.strength = strengthValue(input.strength);
    }
    if (Object.hasOwn(input, 'evidence')) value.evidence = validateEvidence(input.evidence);
    return value;
}
export function validateState(input) {
    keys(input, ['version', 'relationships', 'settings', 'thresholdRules', 'thresholdAlerts'], '人物关系快照');
    if (input.version !== 1) throw Error('人物关系快照版本不兼容，原记录未改写。');
    array(input.relationships, LIMITS.relationships, `人物关系（最多 ${LIMITS.relationships} 条）`);
    keys(input.settings, ['includeInContext'], '人物关系设置');
    if (typeof input.settings.includeInContext !== 'boolean') throw Error('人物关系读取设置无效。');
    const relationships = input.relationships.map(validateRelationship);
    if (new Set(relationships.map(value => value.id)).size !== relationships.length) throw Error('人物关系编号重复。');
    const signatures = relationships.map(value => JSON.stringify([value.fromId, value.toId, value.type, value.label]));
    if (new Set(signatures).size !== signatures.length) throw Error('同方向、类型和名称的人物关系已存在，请编辑原关系。');
    const result = { version: 1, relationships, settings: { includeInContext: input.settings.includeInContext } };
    for (const [key, limit, validate] of [['thresholdRules', LIMITS.rules, validateThresholdRule], ['thresholdAlerts', LIMITS.alerts, validateAlert]]) {
        if (!Object.hasOwn(input, key)) continue;
        array(input[key], limit, key === 'thresholdRules' ? '关系阈值规则' : '关系阈值提醒');
        result[key] = input[key].map(validate);
        if (new Set(result[key].map(value => value.id)).size !== result[key].length) throw Error('关系阈值编号重复。');
    }
    return result;
}
export function validateStore(input) {
    keys(input, ['version', 'events'], '人物关系记录');
    if (input.version !== 1) throw Error('人物关系记录版本不兼容，原记录未改写。');
    array(input.events, LIMITS.events, '人物关系事件');
    const ids = new Set();
    const events = input.events.map(event => {
        keys(event, ['id', 'at', 'path', 'op', 'snapshot', 'evidence'], '人物关系事件');
        checkedId(event.id, '关系事件编号');
        if (ids.has(event.id)) throw Error('人物关系事件编号重复。');
        ids.add(event.id);
        if (typeof event.at !== 'string' || event.at.length > 100 || !Number.isFinite(Date.parse(event.at))) throw Error('人物关系记录时间无效。');
        if (!['save', 'delete', 'settings', 'restore', 'rules', 'alerts', 'ai', 'linkage'].includes(event.op)) throw Error('人物关系事件操作不兼容。');
        array(event.path, 100000, '人物关系分支记录');
        if (event.path.some(value => typeof value !== 'string')) throw Error('人物关系分支记录格式不兼容。');
        return { id: event.id, at: event.at, path: [...event.path], op: event.op, snapshot: validateState(event.snapshot), ...(Object.hasOwn(event, 'evidence') ? { evidence: validateEvidence(event.evidence) } : {}) };
    });
    const result = { version: 1, events };
    if (JSON.stringify(result).length > LIMITS.storeChars) throw Error('人物关系记录已超过容量限制，请先导出存档保留记录。');
    return result;
}
export function readStore(ctx) { const raw = legacyModule(ctx, 'relationships', KEY); return raw === undefined ? emptyStore() : validateStore(raw); }
export function currentState(store, chat) {
    const value = validateStore(store), path = chatPath(chat);
    for (let index = value.events.length - 1; index >= 0; index--) if (belongs(value.events[index], path)) return clone(value.events[index].snapshot);
    return emptyState();
}
export const readRelationships = ctx => currentState(readStore(ctx), ctx?.chat);
export function visibleEvents(ctx) { const path = chatPath(ctx?.chat); return readStore(ctx).events.filter(event => belongs(event, path)); }
// Keep the exact source text in local history without repeating every cited floor in a model prompt.
export function relationshipContext(ctx) {
    const state = readRelationships(ctx), path = chatPath(ctx?.chat);
    return { ...state, relationships: state.relationships.map(relationship => relationship.evidence ? { ...relationship, evidence: {
        origin: relationship.evidence.origin, reason: relationship.evidence.reason,
        sources: relationship.evidence.sources.map(source => ({ index: source.index, current: sameMessageRevision(source.revision, path[source.index]) })),
    } } : relationship) };
}

export function transition(input, op, data, { relationshipId } = {}) {
    const state = validateState(input);
    if (op === 'save') {
        keys(data?.relationship, ['id', 'fromId', 'toId', 'type', 'label', 'notes', 'strength', 'evidence'], '人物关系');
        const relationship = validateRelationship({ ...data.relationship, id: data.relationship.id ?? relationshipId ?? uuid() });
        const index = state.relationships.findIndex(value => value.id === relationship.id);
        if (index < 0) state.relationships.push(relationship); else state.relationships[index] = relationship;
    } else if (op === 'delete') {
        checkedId(data?.id, '关系编号');
        if (!state.relationships.some(value => value.id === data.id)) throw Error('该人物关系已不存在，请刷新列表。');
        state.relationships = state.relationships.filter(value => value.id !== data.id);
    } else if (op === 'settings') {
        if (typeof data?.includeInContext !== 'boolean') throw Error('请选择是否读取人物关系。');
        state.settings.includeInContext = data.includeInContext;
    } else if (op === 'save-rule') {
        const rule = validateThresholdRule(data?.rule);
        const rules = state.thresholdRules ??= [], previous = rules.find(value => value.id === rule.id);
        if (previous?.relationshipId !== rule.relationshipId && !state.relationships.some(value => value.id === rule.relationshipId)) throw Error('阈值规则需选择当前已有的关系。');
        const index = rules.findIndex(value => value.id === rule.id);
        if (index < 0) rules.push(rule); else rules[index] = rule;
    } else if (op === 'delete-rule') {
        checkedId(data?.id, '阈值规则编号');
        if (!(state.thresholdRules ?? []).some(value => value.id === data.id)) throw Error('阈值规则已不存在。');
        state.thresholdRules = state.thresholdRules.filter(value => value.id !== data.id);
    } else if (op === 'acknowledge-alert') {
        const alert = (state.thresholdAlerts ?? []).find(value => value.id === data?.id);
        if (!alert) throw Error('阈值提醒已不存在。');
        alert.acknowledged = true;
    } else throw Error('不支持的人物关系操作。');
    return validateState(state);
}
// Save restoration materializes a snapshot at the current tail; it does not replace messages.
export function appendSnapshot(store, chat, state, { id = uuid(), at = new Date().toISOString(), op = 'restore', evidence } = {}) {
    const value = validateStore(store);
    value.events.push({ id, at, op, path: chatPath(chat), snapshot: validateState(state), ...(evidence ? { evidence: validateEvidence(evidence) } : {}) });
    return validateStore(value);
}
export const buildRestore = (ctx, state, options = {}) => appendSnapshot(readStore(ctx), ctx?.chat, state, { ...options, op: 'restore' });
export function resolveRelationships(ctx) {
    const state = readRelationships(ctx), characters = readCharacters(ctx).characters;
    const lookup = new Map(characters.map(character => [character.id, character]));
    const resolve = id => ({ id, name: lookup.get(id)?.name ?? `未解析人物（${id}）`, missing: !lookup.has(id) });
    return state.relationships.map(relationship => ({ ...relationship, from: resolve(relationship.fromId), to: resolve(relationship.toId) }));
}
export function currentPrompt(ctx) {
    if (!readRelationships(ctx).settings.includeInContext) return '';
    const resolved = resolveRelationships(ctx).filter(relationship => !relationship.from.missing && !relationship.to.missing && evidenceMatches(relationship.evidence, ctx.chat));
    if (!resolved.length) return '';
    // JSON strings keep free-form user text visibly separate from structural labels.
    const lines = resolved.map(value => JSON.stringify({ from: value.from.name, fromId: value.fromId, to: value.to.name, toId: value.toId, type: value.type,
        ...(value.label ? { label: value.label } : {}), ...(Object.hasOwn(value, 'strength') ? { strength: value.strength } : {}), ...(value.notes ? { notes: value.notes } : {}) }));
    const prompt = `[已确认的人物关系，仅适用于当前剧情分支]\n关系具有方向性；未记录的反向关系和强度均未知。数字强度沿用用户记录，不推导统一量表。\n${lines.join('\n')}\n[/已确认的人物关系]`;
    if (prompt.length > LIMITS.prompt) throw Error(`人物关系提示超过 ${LIMITS.prompt} 字符，本轮未附加；请缩短关系说明或关闭读取。`);
    return prompt;
}

registerModuleCodec('relationships', {
    toLegacy(ctx, snapshot) {
        return { [KEY]: { version: 1, events: [{ id: 'independent_relationships', at: '1970-01-01T00:00:00.000Z', path: [], op: 'restore', snapshot: validateState(snapshot ?? emptyState()) }] } };
    },
    fromLegacy(ctx) { return readRelationships(ctx); },
});
