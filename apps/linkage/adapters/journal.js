import { KEY, readStore, currentEntries, memoryEntries, sourceFromRange, sourceState, referenceState, changeWithContext, putAutoDraft } from '../../journal/model.js';
import { KEY as CHARACTERS_KEY, readCharacters, validId } from '../../characters/model.js';
import { renderContract } from '../contract.js';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (data, allowed) => {
    if (!plain(data) || Object.keys(data).some(key => !allowed.includes(key))) throw Error('剧情档案更新包含未知字段');
};
const RANGE = ['sourceStart', 'sourceEnd'];
function source(ctx, data) {
    const start = data.sourceStart ?? ctx.chat.length - 1, end = data.sourceEnd ?? start;
    return sourceFromRange(ctx.chat, start, end);
}
function withoutRange(data) {
    const { sourceStart, sourceEnd, ...rest } = data; return rest;
}
const spec = {
    notes: 'target=档案ID。新记录须用户确认后才启用，不能当已知事实。新建 set_* 时 title(≤120)/body 必填；characterIds/locationIds(场景ID)/itemIds 为ID数组≤32项。',
    actions: [
        { name: 'set_fact', args: 'title?,body?,truth?:confirmed|uncertain|disputed', note: '传闻用 uncertain' },
        { name: 'set_knowledge', args: 'factId?,characterId?,state?:known|rumor|forgotten,belief?,confidence?:0..100,learnedFromId?:人物ID|null,learnedAtText?', note: '新建必填 factId/characterId；同人同事实仅一条' },
        { name: 'forget', note: 'target=记忆ID；仅标记遗忘，保留来源' },
        { name: 'set_hook', args: 'title?,body?,status?:open|resolved|abandoned,remindAfter?:1..100000 int|null,actors?:[人物名]' },
        { name: 'set_task', args: 'title?,body?,goal?,status?:open|active|completed|abandoned,progress?:0..100,deadline?,reward?,characterIds?,locationIds?,itemIds?', note: '完成需明确剧情依据；奖励说明不等于发放' },
        { name: 'set_clue', args: 'title?,body?,status?:unverified|confirmed,source?,confidence?:0..100,taskId?:任务ID|null,characterIds?,locationIds?,itemIds?', note: '可信度不等于确认；线索不自动完成任务' },
        { name: 'delete', note: '保留历史' },
        { name: 'draft_chronicle', args: 'title,body,sourceStart:int,sourceEnd:int', note: '仅生成待审核编年史草稿', advanced: true },
    ],
    sources: 'set_* 的 data 另可含 sourceStart?/sourceEnd?:int（从0起、含首尾的已加载楼层，省略为最后一楼）与 sourceNote?:≤1000。',
};

export const adapter = {
    id: 'journal', label: '剧情档案与记忆', paths: [[KEY], [CHARACTERS_KEY]],
    spec, contract: renderContract(spec),
    read(ctx) {
        const chat = ctx?.chat ?? [], entries = currentEntries(readStore(ctx), chat);
        return {
            entries: entries.map(({ savedAt, savedFloor, eventId, sources, ...record }) => ({ ...record,
                sourceRange: sources ? { start: sources.start, end: sources.end } : null,
                sourceValid: record.kind === 'prior' ? record.explicitReference === true : sourceState(sources, chat).valid })),
            memories: memoryEntries(ctx).map(({ id, factId, characterId, characterName, learnedFromId, learnedFromName, state, belief, confidence, learnedAtText, missing }) => ({
                id, factId, characterId, characterName, learnedFromId, learnedFromName, state, belief, confidence, learnedAtText, missing,
            })),
        };
    },
    readForPrompt(ctx) {
        const chat = ctx?.chat ?? [], records = currentEntries(readStore(ctx), chat), facts = new Map(records.filter(record => record.kind === 'fact').map(record => [record.id, record]));
        const people = new Set(readCharacters(ctx).characters.map(person => person.id));
        const enabled = record => record.confirmed === true && record.enabled === true && referenceState(record, chat).valid
            && (record.kind !== 'knowledge' || (people.has(record.characterId) && referenceState(facts.get(record.factId), chat).valid));
        return {
            entries: records.filter(enabled).map(({ savedAt, savedFloor, eventId, sources, origin, ...record }) => ({ ...record,
                ...(origin ? { origin: { work: origin.work, recordId: origin.recordId, kind: origin.kind, sourceNote: origin.sourceNote } } : {}),
                sourceRange: sources ? { start: sources.start, end: sources.end } : null,
            })),
            unavailable: records.filter(record => !enabled(record)).map(record => ({ id: record.id, kind: record.kind, availableForReference: false })),
        };
    },
    apply(ctx, change, { operationId, now } = {}) {
        if (!plain(change) || typeof change.reason !== 'string' || !change.reason.trim() || !validId(change.target)) throw Error('剧情档案更新需要安全的目标编号和变更原因');
        if (typeof operationId !== 'string' || !operationId || (typeof now !== 'string' && !(now instanceof Date))) throw Error('剧情档案联动缺少协调器操作编号或时间');
        const store = readStore(ctx), records = currentEntries(store, ctx.chat), before = records.find(record => record.id === change.target), data = change.data ?? {};
        const at = now instanceof Date ? now.toISOString() : now;
        if (store.events.some(event => event.id === operationId) || (store.draftEvents ?? []).some(event => event.id === operationId)) return { patches: [{ path: [KEY], value: store }], summary: `已处理剧情档案操作：${change.target}` };
        let next, label;
        if (change.action === 'draft_chronicle') {
            fields(data, ['title','body', ...RANGE]);
            if (!Number.isInteger(data.sourceStart) || !Number.isInteger(data.sourceEnd)) throw Error('编年史草稿必须明确来源范围');
            next = putAutoDraft(store, ctx.chat, { id: change.target, title: data.title, body: data.body, sources: source(ctx, data) }, operationId, at); label = '新增待确认编年史草稿';
        } else if (change.action === 'delete') {
            fields(data, []);
            if (!before || !['fact','knowledge','hook','task','clue'].includes(before.kind)) throw Error('仅可删除当前分支已有的事实、人物记忆、伏笔、任务或线索');
            next = changeWithContext(store, ctx, 'delete', { id: before.id }, operationId, at); label = '删除档案';
        } else if (change.action === 'forget') {
            fields(data, []);
            if (before?.kind !== 'knowledge') throw Error('遗忘操作需要已有的人物记忆');
            next = changeWithContext(store, ctx, 'update', { ...before, state: 'forgotten' }, operationId, at); label = '标记遗忘';
        } else {
            const kind = { set_fact: 'fact', set_knowledge: 'knowledge', set_hook: 'hook', set_task: 'task', set_clue: 'clue' }[change.action];
            if (!kind) throw Error('不支持的剧情档案操作');
            if (before && before.kind !== kind) throw Error('不能变更已有档案的类型');
            const allowed = kind === 'task' ? ['title','body','goal','status','progress','deadline','reward','characterIds','locationIds','itemIds','sourceNote', ...RANGE]
                : kind === 'clue' ? ['title','body','status','source','confidence','taskId','characterIds','locationIds','itemIds','sourceNote', ...RANGE]
                : kind === 'fact' ? ['title','body','truth','sourceNote', ...RANGE]
                : kind === 'knowledge' ? ['factId','characterId','state','belief','confidence','learnedFromId','learnedAtText','sourceNote', ...RANGE]
                    : ['title','body','status','remindAfter','actors','sourceNote', ...RANGE];
            fields(data, allowed);
            const record = { ...(before ?? {}), ...withoutRange(data), id: change.target, kind, sources: source(ctx, data), enabled: before?.enabled ?? false };
            if (kind === 'knowledge') {
                const fact = records.find(item => item.id === record.factId && item.kind === 'fact'), people = new Set(readCharacters(ctx).characters.map(person => person.id));
                if (!fact) throw Error('记忆关联的事实不存在');
                if (!people.has(record.characterId) || (record.learnedFromId && !people.has(record.learnedFromId))) throw Error('记忆关联的人物不存在');
                record.title = fact.title; record.body = '';
            }
            next = changeWithContext(store, ctx, before ? 'update' : 'create', record, operationId, at); label = `${before ? '更新' : '新增'}${kind === 'fact' ? '事实' : kind === 'knowledge' ? '人物记忆' : kind === 'task' ? '任务' : kind === 'clue' ? '线索' : '伏笔'}`;
        }
        return { patches: [{ path: [KEY], value: next }], summary: `${label}：${change.target} · ${change.reason.trim()}` };
    },
};
