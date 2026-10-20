import { HISTORY_KEY, readHistory } from '../../dice/service.js';
import { normalizeConfig } from '../../dice/engine.js';
import { renderContract } from '../contract.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const spec = { notes: '只读：仅可引用已有固定骰点结果；不得生成、修改、删除或重掷骰点，任何 action 都会被拒绝。需要新判定时由用户在骰子应用执行。', actions: [] };

export const adapter = {
    id: 'dice', label: '固定骰点',
    paths: [[HISTORY_KEY]],
    spec, contract: renderContract(spec),
    read(ctx) {
        const raw = ctx?.chatMetadata?.[HISTORY_KEY];
        if (raw === undefined) return { version: 1, readOnly: true, rolls: [] };
        if (!object(raw) || raw.version !== undefined && raw.version !== 1 || !Array.isArray(raw.rolls)) throw Error('骰点历史版本或格式不兼容。');
        const records = readHistory(ctx), ids = new Set();
        if (records.length !== raw.rolls.length) throw Error('骰点历史包含损坏记录，不能作为可信结果。');
        return { version: 1, readOnly: true, rolls: records.map(record => {
            if (!record.id || ids.has(record.id) || !record.text || !record.results.length || record.results.some(result => !object(result) || !Number.isFinite(result.total)) || record.status !== undefined && !['rolled', 'appended', 'sent'].includes(record.status)) throw Error('骰点记录无效或 ID 重复。');
            ids.add(record.id); normalizeConfig(record.settings);
            const linked = record.status === 'sent' && Number.isInteger(record.sent?.messageIndex) && ctx?.chat?.[record.sent.messageIndex]?.is_user === true && ctx.chat[record.sent.messageIndex].mes === record.sent.messageText;
            return { id: record.id, createdAt: record.createdAt, settings: record.settings, results: record.results, text: record.text, status: record.status ?? 'rolled', rerollOf: record.rerollOf ?? null, linked };
        }) };
    },
    readForPrompt(ctx) {
        const source = adapter.read(ctx);
        // A local roll or abandoned candidate is not part of the story until its
        // fixed result has actually been sent in this branch's user message.
        return { ...source, rolls: source.rolls.filter(record => record.linked) };
    },
    apply() { throw Error('骰子为只读模块：模型不能掷骰、改写固定结果或发送状态，请在骰子应用手动操作。'); },
};
