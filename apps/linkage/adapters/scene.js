import { KEY, readCurrentScene, readStore, appendEvent, transition, assertReferences, absencePreview } from '../../scene/model.js';
import { renderContract, canonicalChange } from '../contract.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = {
    'set-time': ['clock'], 'advance-time': ['minutes'], 'log-activity': ['activity', 'count'],
    'save-scene': ['name', 'participants', 'participantIds', 'weather', 'objects', 'notes', 'mapId', 'nodeId', 'activate'],
    'switch-scene': [], 'leave-scene': [], 'confirm-presence': ['characterIds'],
    'save-schedule': ['characterId', 'title', 'startMinute', 'endMinute', 'mapId', 'nodeId', 'weekdays', 'enabled', 'notes'],
    'delete-schedule': [], 'settle-absence': [],
};
const targetActions = new Set(['save-scene', 'switch-scene', 'confirm-presence', 'save-schedule', 'delete-schedule', 'settle-absence']);
const spec = {
    notes: '日程只是预测，不推翻明确在场、不改地图；耗时与离场规则由用户配置。',
    actions: [
        { name: 'advance-time', args: 'minutes:int>0' },
        { name: 'log-activity', aliases: ['activity'], args: 'activity:dialogue|shortRest|longRest|travel,count?:1..1000 int', note: '按用户耗时规则推进；重生成不重复计时' },
        { name: 'set-time', args: 'clock:{year,month,day,hour,minute}', note: '校正剧情时钟', more: 'clock 另可含 calendarLabel?,calendar?:{monthLengths,monthNames,weekDays,epochWeekday}' },
        { name: 'save-scene', upserts: 'scene', args: 'name?,participants?,participantIds?:[人物ID],weather?,objects?,notes?,mapId?,nodeId?,activate?:bool', note: 'target=场景ID；新建必填 name' },
        { name: 'switch-scene', note: 'target=场景ID' },
        { name: 'leave-scene' },
        { name: 'confirm-presence', args: 'characterIds:[人物ID]', note: 'target=场景ID；只记录剧情明确在场者' },
        { name: 'save-schedule', upserts: 'schedule', args: 'characterId,title,startMinute:0..1439,endMinute:1..1440,mapId,nodeId,weekdays?:[int],enabled?:bool,notes?', note: 'target=日程ID；结束早于开始=跨夜；weekdays 从0起，空=每日', advanced: true },
        { name: 'delete-schedule', note: 'target=日程ID', advanced: true },
        { name: 'settle-absence', note: 'target=已到期的离场规则ID；按用户既有规则更新场景，不改规则', advanced: true },
    ],
};

export const adapter = {
    id: 'scene', label: '场景、时间与日程', paths: [[KEY], ['amin_os_characters_v1'], ['dynamicMapV1']],
    spec, contract: renderContract(spec),
    read(ctx) {
        const state = readCurrentScene(ctx);
        // Referenced IDs belong to scene records; labels/content from other modules follow their own read policy.
        return { ...state, pendingAbsence: absencePreview(state) };
    },
    apply(ctx, input, { operationId, now } = {}) {
        const change = canonicalChange(spec, input);
        if (!Object.hasOwn(fields, change.action)) throw Error('场景不支持此联动操作。');
        if (!object(change.data) || Object.keys(change.data).some(key => !fields[change.action].includes(key))) throw Error('场景联动参数含不支持的字段。');
        if (targetActions.has(change.action) && !safeId(change.target)) throw Error('场景联动目标 ID 无效。');
        if (typeof change.reason !== 'string' || !change.reason.trim()) throw Error('场景变更需要剧情依据。');
        if (!safeId(operationId)) throw Error('场景联动操作编号无效。');
        const state = readCurrentScene(ctx), data = { ...structuredClone(change.data), reason: change.reason }, options = { at: now };
        if (change.action === 'save-scene') {
            if (data.activate !== undefined && typeof data.activate !== 'boolean') throw Error('场景进入开关无效。');
            const { activate, reason, ...scene } = data;
            data.scene = { ...state.scenes[change.target], ...scene, ...(state.scenes[change.target] ? { id: change.target } : {}) };
            data.activate = activate; data.reason = reason; options.sceneId = change.target;
        } else if (['switch-scene', 'confirm-presence'].includes(change.action)) data.sceneId = change.target;
        else if (change.action === 'save-schedule') {
            const existing = state.schedules.find(item => item.id === change.target);
            const { reason, ...schedule } = data;
            data.schedule = { ...existing, ...schedule, ...(existing ? { id: change.target } : {}) }; options.entryId = change.target;
        } else if (change.action === 'delete-schedule') data.id = change.target;
        else if (change.action === 'settle-absence') data.ruleIds = [change.target];
        // The scene model keeps its own operation names for history entries.
        const op = change.action === 'log-activity' ? 'activity' : change.action;
        assertReferences(ctx, op, data, state);
        const result = transition(state, op, data, options);
        const value = appendEvent(readStore(ctx), ctx.chat, { ...result, op }, { eventId: operationId, at: now });
        const label = result.details.sceneName || result.details.entry?.title || result.details.changes?.map(item => item.title).join('、') || op;
        return { patches: [{ path: [KEY], value }], summary: `场景与时间：${label}；${change.reason}` };
    },
};
