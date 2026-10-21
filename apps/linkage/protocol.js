import { MODULES, plain, validateJSON } from './policy.js';
import { parseModelJSON } from '../../ai/json.js';
import { getAdapter } from './registry.js';
import { canonicalAction } from './contract.js';
import { repairUpdate } from './repair.js';

export const OPEN = '<amin_update>', CLOSE = '</amin_update>';
// Accept Markdown escaping of delimiters only. Never unescape the JSON payload.
const tagPattern = () => /\\?<\/?amin\\?_update\\?>/g;
function tags(text) {
    return [...text.matchAll(tagPattern())].map(match => ({
        index: match.index, length: match[0].length, closing: match[0].includes('/'),
    }));
}
// Models split one turn into several blocks, mention the tag in prose, or get
// cut off before the closing tag. With repair on, every complete block that
// parses is merged in order; an unclosed last block is used when its JSON is
// complete. Each deviation is reported; nothing usable is a clear error.
function lenientBlocks(text, markers, notes) {
    const payloads = [];
    let open = null, stray = 0;
    for (const marker of markers) {
        if (!marker.closing) { if (open) stray++; open = marker; continue; }
        if (!open) { stray++; continue; }
        payloads.push({ text: text.slice(open.index + open.length, marker.index), closed: true }); open = null;
    }
    if (open) payloads.push({ text: text.slice(open.index + open.length), closed: false });
    const parsed = [], errors = [];
    for (const payload of payloads) {
        if (!payload.text.trim()) continue;
        try { parsed.push(parseModelJSON(payload.text, { label: '联动更新' })); }
        catch (error) { errors.push(payload.closed ? error : Error('更新块缺少结束标签 </amin_update>，内容不完整，可能是回复长度不够被截断；请调大回复长度后重新生成。')); }
    }
    if (!parsed.length) throw errors[0] ?? Error('每条消息必须只有一个完整的 amin_update 更新块。');
    if (parsed.some(item => !plain(item) || item.version !== 1 || !Array.isArray(item.changes))) return parsed.length === 1 ? parsed[0] : { version: 1, changes: null };
    if (parsed.length > 1) notes?.push(`回复包含 ${parsed.length} 个更新块，已按顺序合并。`);
    if (!payloads.at(-1).closed && errors.length === 0 && parsed.length) notes?.push('最后一个更新块缺少结束标签，内容完整，已照常使用。');
    if (errors.length) notes?.push(`有 ${errors.length} 个更新块无法解析，已忽略：${errors[0].message}`);
    if (stray) notes?.push('回复中有多余的 amin_update 标签，已忽略。');
    return parsed.length === 1 ? parsed[0] : { version: 1, changes: parsed.flatMap(item => item.changes) };
}
/** Validate one update. Legacy action names (e.g. set_fact, add_node) are
 * mapped to the adapter's current name unless `canonical:false` asks for the
 * literal payload, as idempotency checks against old receipts need. */
export function parseUpdate(input, { canonical = true, repair = false, notes, ...repairOptions } = {}) {
    let raw = input;
    if (typeof input === 'string') {
        if (input.length > 2 * 1024 * 1024) throw Error('一次联动更新超过 2 MiB。');
        const markers = tags(input);
        if (markers.length && repair) raw = lenientBlocks(input, markers, notes);
        else {
            if (markers.length) {
                if (markers.length !== 2 || markers[0].closing || !markers[1].closing) throw Error('每条消息必须只有一个完整的 amin_update 更新块。');
                raw = input.slice(markers[0].index + markers[0].length, markers[1].index);
            }
            // Tolerates a Markdown code fence or a sentence around the payload; the JSON itself is never repaired.
            raw = parseModelJSON(raw, { label: '联动更新' });
        }
    }
    validateJSON(raw);
    // Opt-in: fix predictable model slips before the strict checks; see repair.js.
    if (repair) { const result = repairUpdate(raw, repairOptions); raw = result.update; notes?.push(...result.notes); }
    if (!plain(raw) || raw.version !== 1 || Object.keys(raw).some(k => !['version','changes'].includes(k)) || !Array.isArray(raw.changes) || raw.changes.length > 64) throw Error('联动更新必须使用 version:1 和最多 64 项 changes。');
    for (const change of raw.changes) {
        if (!plain(change) || Object.keys(change).some(k => !['module','action','target','data','reason'].includes(k)) || !Object.hasOwn(MODULES, change.module)) throw Error('更新包含未知模块或字段。');
        if (typeof change.action !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(change.action) || !plain(change.data)) throw Error('更新 action 或 data 格式无效。');
        if (change.target !== undefined && (typeof change.target !== 'string' || !change.target || change.target.length > 300)) throw Error('更新 target 必须是已有对象标识或明确的新对象标识。');
        if (typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 2000) throw Error('每项更新必须说明已经发生的剧情依据（最多 2000 字）。');
    }
    const update = structuredClone(raw);
    if (canonical) for (const change of update.changes) change.action = canonicalAction(getAdapter(change.module)?.spec, change.action);
    return update;
}
export function hasUpdate(text) { return typeof text === 'string' && tagPattern().test(text); }
