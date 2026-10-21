import { KEY, empty, read, current, validateRecord, fieldKey, path, diff } from '../../information/model.js';
import { renderContract, canonicalChange } from '../contract.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const exact = (value, fields) => {
    const extra = object(value) ? Object.keys(value).filter(key => !fields.includes(key)) : [];
    if (!object(value) || extra.length) throw Error(`信息面板更新包含未知字段或格式无效${extra.length ? '：' + extra.join('、') : ''}。`);
};
function text(value, label, max = 12000, allowEmpty = true) {
    if (typeof value !== 'string' || value.length > max || !allowEmpty && !value.trim()) throw Error(label + '不是有效的长度受限文本。');
    return value;
}
function validateField(input) {
    exact(input, ['id', 'category', 'label', 'value', 'status']);
    if (!safeId(input.id)) throw Error('信息字段需要安全、唯一的稳定 ID。');
    const status = input.status ?? 'known';
    if (!['known', 'inferred', 'unknown'].includes(status)) throw Error('模型只能标记已知、推断或未知信息。');
    return { id: input.id, category: text(input.category, '字段分类', 120, false), label: text(input.label, '字段名称', 120, false), value: text(input.value, '字段内容'), status };
}
function store(ctx) {
    const raw = ctx?.chatMetadata?.[KEY];
    if (raw === undefined) return empty();
    if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.history) || typeof raw.enabled !== 'boolean' || !Number.isInteger(raw.limit) || raw.limit < 1) throw Error('信息面板历史格式不兼容，原始资料未改写。');
    const ids = new Set();
    for (const event of raw.history) {
        if (!object(event) || typeof event.id !== 'string' || !event.id || ids.has(event.id) || !Array.isArray(event.path) || event.path.some(part => typeof part !== 'string') || typeof event.recordId !== 'string') throw Error('信息面板历史记录损坏，原始资料未改写。');
        ids.add(event.id);
        if (event.snapshot != null) { validateRecord(event.snapshot); if (event.recordId !== event.snapshot.id) throw Error('信息面板历史目标与快照不一致。'); }
        if (event.before != null) validateRecord(event.before);
    }
    return read(ctx);
}
// Match the native model's baseline/removal semantics, supplying a deterministic
// event ID/time instead of invoking its UUID/clock-dependent apply helper.
function append(source, chat, record, reason, operationId, at) {
    const snapshot = validateRecord(record), before = current(source, chat).find(item => item.id === snapshot.id);
    const now = new Set(snapshot.fields.map(fieldKey)), removed = new Map((before?.removed ?? []).map(field => [fieldKey(field), field]));
    for (const field of before?.fields ?? []) if (!now.has(fieldKey(field))) removed.set(fieldKey(field), { category: field.category, label: field.label });
    for (const key of now) removed.delete(key);
    const baseline = snapshot.baselineFields ?? before?.baselineFields ?? before?.fields ?? [];
    snapshot.baselineFields = clone(baseline);
    const original = new Map(baseline.map(field => [fieldKey(field), field]));
    snapshot.modifiedFields = snapshot.fields.filter(field => !original.has(fieldKey(field)) || original.get(fieldKey(field)).value !== field.value).map(fieldKey);
    for (const field of baseline) if (!now.has(fieldKey(field))) removed.set(fieldKey(field), { category: field.category, label: field.label });
    snapshot.removed = [...removed.values()];
    const next = clone(source), prior = before ?? { ...snapshot, fields: baseline };
    next.history.push({ id: operationId, recordId: snapshot.id, path: path(chat), at, reason, before: clone(prior), snapshot, changes: diff(prior, snapshot) });
    return next;
}

const DATA_FIELDS = { 'create-panel': ['name', 'kind', 'fields'], 'create-field': ['field'], 'update-field': ['fieldId', 'value', 'status'], 'delete-field': ['fieldId'] };
const spec = {
    notes: 'target=面板ID。field={id,category,label,value:文本,status?:known|inferred|unknown}；不改已有字段的编号、分类、名称或面板类型。',
    actions: [
        { name: 'create-panel', creates: 'record', aliases: ['create'], args: 'name,kind:person|thing|world,fields:[field]' },
        { name: 'create-field', aliases: ['add_field'], args: 'field' },
        { name: 'update-field', aliases: ['set_field'], args: 'fieldId,value?,status?', note: '至少一项' },
        { name: 'delete-field', aliases: ['remove_field'], args: 'fieldId' },
    ],
};

export const adapter = {
    id: 'information', label: '信息面板',
    paths: [[KEY]],
    spec, contract: renderContract(spec), dataFields: action => DATA_FIELDS[action],
    read(ctx) { const source = store(ctx); return { version: 1, enabled: source.enabled, records: current(source, ctx?.chat) }; },
    readForPrompt(ctx) {
        const source = store(ctx);
        return { version: 1, enabled: source.enabled, records: source.enabled ? current(source, ctx?.chat).map(record => ({
            id: record.id, name: record.name, kind: record.kind, mode: record.mode,
            // Keep update targets visible, but do not promote unknown or inferred
            // values to facts. Baselines and raw sources stay in the local model.
            fields: record.fields.map(field => ({ id: field.id, category: field.category, label: field.label, status: field.status,
                ...(!['unknown', 'inferred'].includes(field.status) ? { value: field.value } : {}),
            })),
            removed: (record.removed ?? []).map(field => ({ category: field.category, label: field.label })),
        })) : [] };
    },
    apply(ctx, input, { operationId, now } = {}) {
        const change = canonicalChange(spec, input);
        if (change?.module !== 'information' || !['create-panel', 'create-field', 'update-field', 'delete-field'].includes(change.action)) throw Error('不支持的信息面板联动操作。');
        if (typeof change.target !== 'string' || !change.target) throw Error('信息面板目标 ID 无效。');
        if (typeof operationId !== 'string' || !operationId || !Number.isFinite(Date.parse(now))) throw Error('信息面板操作标识或时间无效。');
        text(change.reason, '更新依据', 4000, false);
        const source = store(ctx), records = current(source, ctx?.chat);
        if (source.history.some(event => event.id === operationId)) throw Error('此信息面板操作已经应用，不能重复提交。');
        let record = records.find(item => item.id === change.target);
        if (change.action === 'create-panel') {
            exact(change.data, DATA_FIELDS[change.action]);
            if (!safeId(change.target) || record) throw Error('新面板 ID 无效或已存在。');
            if (records.length >= 1000 || !Array.isArray(change.data.fields) || change.data.fields.length > 80) throw Error('信息面板或字段数量超过上限。');
            record = validateRecord({ id: change.target, name: text(change.data.name, '面板名称', 120, false), kind: change.data.kind, mode: 'forward', fields: change.data.fields.map(validateField) });
        } else {
            if (!record) throw Error('信息面板不存在于当前剧情分支。');
            record = clone(record);
            if (change.action === 'create-field') {
                exact(change.data, DATA_FIELDS[change.action]);
                const field = validateField(change.data.field);
                if (record.fields.length >= 80 || record.fields.some(item => item.id === field.id)) throw Error('字段 ID 已存在或字段数量超过上限。');
                record.fields.push(field);
            } else {
                exact(change.data, DATA_FIELDS[change.action]);
                const index = record.fields.findIndex(item => item.id === change.data.fieldId);
                if (index < 0) throw Error('信息面板字段不存在。');
                if (change.action === 'delete-field') record.fields.splice(index, 1);
                else {
                    if (!Object.hasOwn(change.data, 'value') && !Object.hasOwn(change.data, 'status')) throw Error('信息字段没有提供待修改内容。');
                    if (Object.hasOwn(change.data, 'value')) record.fields[index].value = text(change.data.value, '字段内容');
                    const status = change.data.status ?? 'known';
                    if (!['known', 'inferred', 'unknown'].includes(status)) throw Error('模型不能把字段标记为用户编辑或自行编造。');
                    record.fields[index].status = status;
                }
            }
            validateRecord(record);
        }
        return { patches: [{ path: [KEY], value: append(source, ctx?.chat, record, change.reason, operationId, now) }], summary: `信息面板 ${record.name}：${change.action}${change.data.fieldId ? ' ' + change.data.fieldId : ''}` };
    },
};
