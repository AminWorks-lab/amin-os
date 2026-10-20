import { readCharacters } from '../characters/model.js';
import { LIMITS, relationshipContext, sourceReferences } from './model.js';
import { UPDATE_CONTRACT, UPDATE_SPEC } from './updates.js';
import { parseUpdate } from '../linkage/protocol.js';
import { updateSchema } from '../linkage/contract.js';
import { parseModelJSON } from '../../ai/json.js';
import { runTask } from '../../ai/task.js';

export const RELATIONSHIP_PROMPT = `你负责根据已经发生的剧情提出人物关系变更建议。不要续写剧情，不要把计划、假设、传闻或阈值提示当成已经发生的事实。人物只能使用给定稳定 ID；不能按同名人物替换。关系有方向性，不自动建立反向关系。不确定时不提出变更。数值强度只能沿用明确量表与剧情依据，不自行引入好感数值。
只输出 JSON：{"version":1,"changes":[{"module":"relationships","action":"save-relationship","target":"关系稳定ID","data":{"fromId":"人物ID","toId":"人物ID","type":"信任","sources":[0]},"reason":"具体剧情依据"}]}。
无变化输出空 changes。每个关系至多提出一次最终变更。仅可使用 save-relationship 或 delete-relationship，不可改阈值规则或读取设置。save-relationship 为完整关系，保留未变化的标签、备注和强度；新关系请创建安全且不重复的 ID。sources 必须填写支持该变更的所选楼层索引。
${UPDATE_CONTRACT}`;

// Sent as response_format only when the relationships channel enables structured output.
export const RELATIONSHIP_SCHEMA = updateSchema('relationship_suggestions', [{ id: 'relationships', spec: UPDATE_SPEC, actions: ['save-relationship', 'delete-relationship'] }], { maxItems: 30 });

export function parseSuggestions(raw) {
    if (typeof raw !== 'string' || raw.length > 160000) throw Error('关系建议响应为空或超过容量。');
    // Shared protocol checks (version, fields, reason, data) come from parseUpdate;
    // this preview only narrows the result to relationship save/delete changes.
    const { changes } = parseUpdate(parseModelJSON(raw, { label: '关系更新建议' }));
    if (changes.length > 30) throw Error('关系建议格式或数量不兼容。');
    if (changes.some(change => change.module !== 'relationships' || !['save-relationship', 'delete-relationship'].includes(change.action))) throw Error('关系建议只能包含人物关系的新增、修改或删除。');
    const targets = changes.map(change => change.target);
    if (new Set(targets).size !== targets.length) throw Error('同一关系出现多份建议，请让模型仅输出最终变更。');
    return changes;
}

export async function draftRelationships({ ai, ctx, start, end, instruction = '', signal, check = () => {} }) {
    if (!ai?.capture || !ai?.generate) throw Error('共享 AI 尚未就绪，请先检查 AI 设置。');
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= (ctx.chat?.length ?? 0) || end - start + 1 > LIMITS.sources) throw Error(`请选择有效的来源楼层，最多 ${LIMITS.sources} 楼。`);
    if (typeof instruction !== 'string' || instruction.length > LIMITS.text) throw Error(`补充要求最多 ${LIMITS.text} 字。`);
    const indices = Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
    sourceReferences(ctx.chat, indices);
    const sources = indices.map(index => ({ index, floor: index + 1, name: String(ctx.chat[index].name ?? ''), isUser: !!ctx.chat[index].is_user, text: String(ctx.chat[index].mes ?? '') }));
    if (sources.reduce((length, source) => length + source.text.length, 0) > 60000) throw Error('所选剧情超过 60000 字，请缩小来源范围。');
    const characters = readCharacters(ctx).characters.map(({ id, name, kind, notes }) => ({ id, name, kind, notes }));
    if (characters.length < 2) throw Error('请先在人物卡建立至少两个人物。');
    const prompt = JSON.stringify({ characters, relationships: relationshipContext(ctx).relationships, sources, instruction });
    const snapshot = ai.capture('relationships');
    check();
    const context = { ...ctx, chat: structuredClone(ctx.chat), chatMetadata: structuredClone(ctx.chatMetadata) };
    const changes = await runTask('人物关系 · 剧情更新', { ai, ctx: context, system: RELATIONSHIP_PROMPT, payload: prompt, parse: parseSuggestions, schema: RELATIONSHIP_SCHEMA, signal, check, snapshot,
        include: { includeEffects: false, includeJournal: false, includeScene: false, includeLinkage: false },
        cancelled: aborted => aborted.reason ?? Error('已取消关系建议。'), emptyMessage: '关系建议响应为空或超过容量。' });
    return { changes, sources: indices };
}
