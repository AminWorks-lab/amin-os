import { KEY, validId, readRelationships, readStore, transition, appendSnapshot, evaluateThresholds, sourceReferences, validateEvidence } from './model.js';
import { readCharacters } from '../characters/model.js';
import { renderContract } from '../linkage/contract.js';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, allowed, label) {
    if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)))) throw Error(`${label}包含不支持的字段。`);
}
export function validateEndpoints(ctx, before, relationship) {
    const previous = before.relationships.find(value => value.id === relationship.id), ids = new Set(readCharacters(ctx).characters.map(value => value.id));
    for (const key of ['fromId', 'toId']) if (previous?.[key] !== relationship[key] && !ids.has(relationship[key])) throw Error('新增或更换的关系端点必须选择当前人物；请先在角色卡中建立人物。');
}
export const UPDATE_SPEC = Object.freeze({
    notes: 'target=关系ID。关系有方向，反向关系单独保存。',
    actions: [
        { name: 'save', args: 'fromId,toId:不同人物ID,type,label?,notes?,strength?:num', note: '保存完整关系；无明确量表不填 strength' },
        { name: 'delete', note: '删除当前关系，保留历史' },
        { name: 'save-rule', args: 'relationshipId,operator:gte|lte,value:num,message,enabled:bool,repeat:once|crossing', note: '阈值规则仅在用户要求时调整；只产生提示，不代表剧情已发生', advanced: true },
        { name: 'delete-rule', note: 'target=阈值规则ID', advanced: true },
        { name: 'acknowledge-alert', note: 'target=提醒ID', advanced: true },
    ],
    sources: '各动作 data 另可含 sources?:[int]（从0起的当前聊天楼层索引，须确实支持该变更）。',
});
export const UPDATE_CONTRACT = renderContract(UPDATE_SPEC);

// Shared by the unified transaction adapter and the explicit relationship AI preview.
// All mutations are applied to validated clones and returned as one metadata patch.
export function applyRelationshipChange(ctx, change, { operationId, now, origin = 'linkage', allowedSources } = {}) {
    fields(change, ['module', 'action', 'target', 'data', 'reason'], '关系更新');
    if (change.module !== 'relationships' || !validId(change.target) || !validId(operationId)) throw Error('关系更新模块、目标或操作编号无效。');
    const allowed = {
        save: ['fromId', 'toId', 'type', 'label', 'notes', 'strength', 'sources'],
        delete: ['sources'], 'save-rule': ['relationshipId', 'operator', 'value', 'message', 'enabled', 'repeat', 'sources'],
        'delete-rule': ['sources'], 'acknowledge-alert': ['sources'],
    }[change.action];
    if (!allowed) throw Error('不支持的人物关系更新操作。');
    fields(change.data, allowed, '关系更新数据');
    if (origin === 'ai' && (!Object.hasOwn(change.data, 'sources') || !Array.isArray(change.data.sources) || !change.data.sources.length)) throw Error('AI 关系建议必须明确提供来源楼层。');
    const indices = change.data.sources ?? (ctx.chat?.length ? [ctx.chat.length - 1] : []);
    if (allowedSources && (!Array.isArray(indices) || !indices.length || indices.some(index => !allowedSources.includes(index)))) throw Error('AI 建议的来源超出了所选剧情范围。');
    const evidence = validateEvidence({ origin, reason: change.reason, sources: sourceReferences(ctx.chat, indices) });
    const before = readRelationships(ctx), { sources: unused, ...payload } = change.data;
    let state, description;
    if (change.action === 'save') {
        state = transition(before, 'save', { relationship: { ...payload, id: change.target, evidence } });
        const relationship = state.relationships.find(value => value.id === change.target);
        validateEndpoints(ctx, before, relationship);
        const old = before.relationships.find(value => value.id === change.target);
        description = `${old ? '修改' : '新增'}关系 ${relationship.fromId} → ${relationship.toId}：${relationship.type}`;
        if (old?.strength !== relationship.strength) description += `，强度 ${old?.strength ?? '未设'} → ${relationship.strength ?? '未设'}`;
        state = evaluateThresholds(before, state, { operationId, at: now });
    } else if (change.action === 'save-rule') {
        state = transition(before, change.action, { rule: { ...payload, id: change.target } });
        description = `保存阈值规则 ${change.target}（仅提醒）`;
    } else {
        state = transition(before, change.action, { id: change.target });
        description = `${change.action === 'delete' ? '删除关系' : change.action === 'delete-rule' ? '删除阈值规则' : '标记提醒已读'} ${change.target}`;
    }
    const newAlerts = (state.thresholdAlerts ?? []).filter(alert => !(before.thresholdAlerts ?? []).some(previous => previous.id === alert.id));
    const summary = `${description}\n依据：${evidence.reason}${evidence.sources.length ? `\n来源：第 ${evidence.sources.map(source => source.index + 1).join('、')} 楼` : '\n来源：未绑定聊天楼层'}${newAlerts.length ? `\n阈值提醒：${newAlerts.map(alert => alert.message).join('；')}（提示，不代表剧情已发生）` : ''}`;
    const value = appendSnapshot(readStore(ctx), ctx.chat, state, { id: operationId, at: now, op: origin === 'ai' ? 'ai' : 'linkage', evidence });
    return { patches: [{ path: [KEY], value }], summary, state, newAlerts };
}
