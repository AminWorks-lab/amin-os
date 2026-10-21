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
/** Validate one update. Legacy action names (e.g. set_fact, add_node) are
 * mapped to the adapter's current name unless `canonical:false` asks for the
 * literal payload, as idempotency checks against old receipts need. */
export function parseUpdate(input, { canonical = true, repair = false, notes, ...repairOptions } = {}) {
    let raw = input;
    if (typeof input === 'string') {
        if (input.length > 2 * 1024 * 1024) throw Error('一次联动更新超过 2 MiB。');
        const markers = tags(input);
        if (markers.length) {
            if (markers.length !== 2 || markers[0].closing || !markers[1].closing) throw Error('每条消息必须只有一个完整的 amin_update 更新块。');
            raw = input.slice(markers[0].index + markers[0].length, markers[1].index);
        }
        // Tolerates a Markdown code fence or a sentence around the payload; the JSON itself is never repaired.
        raw = parseModelJSON(raw, { label: '联动更新' });
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
