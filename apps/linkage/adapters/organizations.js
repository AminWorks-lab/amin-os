import { ROOT, GROUPS, FIELDS, LINKS, entity, read, validate, enforceLocks, diff } from '../../organizations/model.js';
import '../../organizations/story-state.js';
import { isIndependent, readStoryRoot, storyRootPath, legacyModule } from '../../story-state/access.js';
import { renderContract } from '../contract.js';

const META = 'amin_os_organizations_v1', HISTORY = 'amin_os_organizations_history_v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
function source(ctx) {
    const doc = read(readStoryRoot(ctx, ROOT));
    const raw = legacyModule(ctx, 'organizations', META);
    if (raw !== undefined && (!object(raw) || raw.locks !== undefined && (!Array.isArray(raw.locks) || raw.locks.some(path => typeof path !== 'string')) || raw.backups !== undefined && !Array.isArray(raw.backups))) throw Error('势力元数据格式无效，原始资料未改写。');
    const extra = clone(raw ?? {}), locks = extra.locks ?? [];
    enforceLocks(doc, doc, locks);
    return { doc, extra, locks };
}
function historyPatch(ctx, doc, assessment, timestamp) {
    if (isIndependent(ctx) || ctx.aminIndependentDraft) return [];
    const raw = ctx?.chatMetadata?.[HISTORY];
    if (raw !== undefined && (!object(raw) || !object(raw.records))) throw Error('势力楼层历史格式无效，未写入。');
    const tail = ctx?.chat?.at(-1), id = tail?.extra?.amin_org_message_id;
    if (!id) return [];
    if (typeof id !== 'string') throw Error('势力楼层标识无效。');
    const next = clone(raw ?? { records: {} }), key = id + ':' + String(tail.swipe_id ?? 0);
    next.records[key] = { ...next.records[key], state: { doc: clone(doc), assessment: clone(assessment ?? null) }, savedAt: timestamp };
    return [{ path: [HISTORY], value: next }];
}

const spec = {
    notes: 'target=主体ID；group:organizations|alliances|regions；metrics=[{key,label,unit,source,kind:number|range|text|unknown,value}]；relations/members/controllers=[{organization:组织ID,role,note}]；地区 parent=地区ID|null。locked 路径不可改，不删除或整体替换。',
    actions: [
        { name: 'create', args: 'group,fields:{name,...}' },
        { name: 'update', args: 'group,fields:{待改字段}', note: '仅既有主体，不换ID或group' },
    ],
};

export const adapter = {
    id: 'organizations', label: '势力资料',
    paths: [['variables', ROOT], [META], [HISTORY]],
    spec, contract: renderContract(spec),
    read(ctx) { const { doc, locks } = source(ctx); return { version: 1, doc, locks }; },
    apply(ctx, change, { now } = {}) {
        if (change?.module !== 'organizations' || !['create', 'update'].includes(change.action)) throw Error('不支持的势力联动操作。');
        if (typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 4000) throw Error('势力更新需要明确依据。');
        const data = change.data;
        if (!object(data) || Object.keys(data).some(key => !['group', 'fields'].includes(key)) || !GROUPS.includes(data.group) || !object(data.fields) || !Object.keys(data.fields).length) throw Error('势力更新格式无效。');
        if (typeof change.target !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(change.target) || ['constructor', 'prototype', '__proto__'].includes(change.target)) throw Error('势力主体 ID 无效。');
        const allowed = [...Object.keys(FIELDS[data.group]), ...Object.keys(LINKS[data.group]), 'metrics'];
        if (Object.keys(data.fields).some(key => !allowed.includes(key))) throw Error('势力更新包含未允许的字段。');
        const { doc: before, extra, locks } = source(ctx), next = clone(before);
        const found = GROUPS.find(group => Object.hasOwn(before[group], change.target));
        if (change.action === 'create') {
            if (found) throw Error('势力主体 ID 已存在。');
            if (typeof data.fields.name !== 'string' || !data.fields.name.trim()) throw Error('创建势力资料需要名称。');
            next[data.group][change.target] = { ...entity(data.group, data.fields.name), ...clone(data.fields) };
        } else {
            if (found !== data.group) throw Error('势力主体不存在或所属分类不匹配。');
            next[data.group][change.target] = { ...next[data.group][change.target], ...clone(data.fields) };
        }
        validate(next); enforceLocks(before, next, locks);
        const timestamp = typeof now === 'number' ? now : Date.parse(now);
        if (!Number.isFinite(timestamp)) throw Error('联动更新时间无效。');
        const backups = [...(extra.backups ?? []), { doc: clone(before), at: timestamp }].slice(-5);
        const patches = [{ path: storyRootPath(ctx, ROOT), value: JSON.stringify(next) },
          ...(isIndependent(ctx) || ctx.aminIndependentDraft ? [] : [{ path: [META, 'backups'], value: backups }]), ...historyPatch(ctx, next, extra.assessment, timestamp)];
        return { patches, summary: `势力资料 ${next[data.group][change.target].name}：${diff(before, next).length} 项变化` };
    },
};
