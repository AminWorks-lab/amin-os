import { KEY, STATUS_PATH, readCharacters, readStore, appendSnapshot, validateCharacter, validateStat, validateAppearance, validId, bindings } from '../../characters/model.js';
import { renderContract, canonicalChange } from '../contract.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(data, allowed) {
    if (!object(data) || Object.keys(data).some(key => !allowed.includes(key))) throw Error('人物联动参数包含不支持的字段。');
}
function stats(input) {
    if (!Array.isArray(input)) throw Error('人物绑定必须是数组。');
    return input.map(stat => { fields(stat, ['id', 'label', 'binding', 'component', 'check']); return validateStat(stat); });
}
function checkBindings(ctx, previous, next) {
    const changed = next.stats.filter(stat => !previous?.stats.some(old => old.id === stat.id && old.binding === stat.binding && old.component === stat.component));
    if (!changed.length) return;
    const available = bindings(ctx);
    for (const stat of changed) if (!available.some(field => field.binding === stat.binding && field.component === stat.component)) throw Error(`人物绑定不存在或类型不匹配：${stat.binding}。请先建立世界状态字段。`);
}

const spec = {
    notes: 'target=人物ID。属性数值改 status，穿戴改 inventory。',
    advancedNotes: 'stat={id,label,binding:"项目名.字段名",component:value|current|max,check:none|d20|coc}，binding 须为已有世界状态字段。',
    actions: [
        { name: 'create-character', creates: 'person', args: 'name,kind:pc|npc,notes?,appearance?:{description,hairstyle,features}', advancedArgs: ',stats?:[stat]' },
        { name: 'update-character', aliases: ['save-character'], args: '同上，按需' },
        { name: 'update-appearance', aliases: ['set-appearance'], args: 'description?,hairstyle?,features?' },
        { name: 'save-stat', args: 'id,label,binding,component,check', advanced: true },
        { name: 'delete-stat', args: 'statId', advanced: true },
        { name: 'delete-character', note: '其他应用保留原ID引用', advanced: true },
    ],
};

export const adapter = {
    id: 'characters', label: '人物卡与外观',
    paths: [[KEY], [...STATUS_PATH]],
    spec, contract: renderContract(spec),
    read: ctx => readCharacters(ctx),
    apply(ctx, input, { operationId, now }) {
        const change = canonicalChange(spec, input);
        const state = readCharacters(ctx), previous = state.characters.find(person => person.id === change.target), data = change.data;
        if (typeof change.reason !== 'string' || !change.reason.trim()) throw Error('人物更新需要剧情原因。');
        if (change.action !== 'create-character' && !previous) throw Error('人物已不存在于当前剧情分支。');
        let next = previous;
        if (['create-character', 'update-character'].includes(change.action)) {
            fields(data, ['name', 'kind', 'notes', 'stats', 'appearance']);
            if (change.action === 'create-character' && (!validId(change.target) || previous)) throw Error('新增人物编号无效或已存在。');
            next = validateCharacter({ ...(previous ?? { kind: 'npc', notes: '', stats: [] }), ...data, id: change.target, ...(data.stats === undefined ? {} : { stats: stats(data.stats) }) });
            checkBindings(ctx, previous, next);
        } else if (change.action === 'delete-character') {
            fields(data, []); state.characters = state.characters.filter(person => person.id !== change.target); next = null;
        } else if (change.action === 'update-appearance') {
            fields(data, ['description', 'hairstyle', 'features']);
            next = validateCharacter({ ...previous, appearance: validateAppearance({ ...previous.appearance, ...data }) });
        } else if (change.action === 'save-stat') {
            fields(data, ['id', 'label', 'binding', 'component', 'check']);
            const stat = validateStat(data), index = previous.stats.findIndex(value => value.id === stat.id);
            next = structuredClone(previous);
            if (index < 0) next.stats.push(stat); else next.stats[index] = stat;
            next = validateCharacter(next); checkBindings(ctx, previous, next);
        } else if (change.action === 'delete-stat') {
            fields(data, ['statId']);
            if (!previous.stats.some(stat => stat.id === data.statId)) throw Error('人物属性绑定已不存在。');
            next = validateCharacter({ ...previous, stats: previous.stats.filter(stat => stat.id !== data.statId) });
        } else throw Error('不支持的人物联动操作。');
        if (next) {
            const index = state.characters.findIndex(person => person.id === next.id);
            if (index < 0) state.characters.push(next); else state.characters[index] = next;
        }
        const summary = `${change.action === 'delete-character' ? '移除' : change.action === 'create-character' ? '新增' : '更新'}人物「${next?.name ?? previous.name}」`;
        return { patches: [{ path: [KEY], value: appendSnapshot(readStore(ctx), ctx.chat, state, { id: operationId, at: now, reason: change.reason }) }], summary };
    },
};
