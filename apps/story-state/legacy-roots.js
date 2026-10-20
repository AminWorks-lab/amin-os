// Read-only shapes of retired storage formats. Only explicit migration and
// legacy readers use them; nothing here writes or replays old storage.
import { sha256HexSync } from '../tts/source-hash.js';

/** Native LittleWhiteBox variable roots once owned by Amin OS (0.16–0.17). */
export const ROOTS = Object.freeze({
    characters: 'AminOS人物', inventory: 'AminOS背包', relationships: 'AminOS关系',
    scene: 'AminOS场景', journal: 'AminOS剧情', effects: 'AminOS效果',
    map: 'AminOS地图', information: 'AminOS信息', dice: 'AminOS骰子',
});
export const NATIVE_VARIABLE_ROOTS = Object.freeze({ status: '状态栏', organizations: '势力资料' });
export const CURRENT_STORY_KEY = 'amin_os_current_story_v1';
export const CURRENT_STORY_OWNER = 'amin-os/current-story-v1';
export const CURRENT_STORY_FORMAT = 'amin-os-current-story';

const JSON_ROOTS = new Set([...Object.values(ROOTS), ...Object.values(NATIVE_VARIABLE_ROOTS)]);
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_BYTES = 32 * 1024 * 1024;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fail(code, message) { throw Object.assign(Error(message), { code }); }

export function legacyRuleRoot(path) {
    const text = String(path ?? '').replace(/^\.+/u, '');
    if (text[0] !== '[') return text.split(/[.\[]/u, 1)[0].trim();
    const match = /^\[(?:"([^"]*)"|'([^']*)'|([^\]]*))\]/u.exec(text);
    return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}
function canonical(value, stack = new Set(), depth = 0) {
    if (depth > 80) fail('STORY_CURRENT_INVALID', '当前状态嵌套过深。');
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || stack.has(value))
        fail('STORY_CURRENT_INVALID', '当前状态必须是有效 JSON 数据。');
    stack.add(value);
    let result;
    if (Array.isArray(value)) {
        result = Array.from({ length: value.length }, (_, index) => {
            if (!own(value, index)) fail('STORY_CURRENT_INVALID', '当前状态数组不能包含空位。');
            return canonical(value[index], stack, depth + 1);
        });
    } else {
        result = {};
        for (const key of Object.keys(value).sort()) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('STORY_CURRENT_INVALID', '当前状态包含受保护的字段。');
            result[key] = canonical(value[key], stack, depth + 1);
        }
    }
    stack.delete(value);
    return result;
}
const serialized = value => JSON.stringify(canonical(value));
const digest = value => 'sha256:' + sha256HexSync(serialized(value));
function validateEncodedState(record) {
    if (!plain(record) || record.version !== 2 || !plain(record.variables) || !plain(record.rules)
        || Object.keys(record.variables).some(root => !JSON_ROOTS.has(root))
        || Object.entries(record.rules).some(([path, rule]) => !JSON_ROOTS.has(legacyRuleRoot(path)) || !plain(rule))
        || !Array.isArray(record.jsonStringRoots)
        || record.jsonStringRoots.some(root => typeof root !== 'string' || !JSON_ROOTS.has(root) || !own(record.variables, root))
        || new Set(record.jsonStringRoots).size !== record.jsonStringRoots.length)
        fail('STORY_CURRENT_CORRUPT', '当前状态结构无效。');
}

/** Validates a 0.17 current-story export record; it is never written again. */
export function validateCurrentStoryRecord(value) {
    const record = canonical(value);
    if (!plain(record) || record.version !== 1 || record.owner !== CURRENT_STORY_OWNER || typeof record.chat !== 'string'
        || !record.chat || !Number.isSafeInteger(record.revision) || record.revision < 1
        || !Array.isArray(record.backups) || record.backups.length > 5 || !HASH.test(record.hash ?? '')
        || Object.keys(record).sort().join(',') !== 'backups,chat,current,hash,owner,revision,version')
        fail('STORY_CURRENT_CORRUPT', '当前状态记录格式无效，原资料未改写。');
    for (const item of [record.current, ...record.backups]) {
        if (!plain(item) || Object.keys(item).sort().join(',') !== 'at,hash,label,state'
            || !HASH.test(item.hash ?? '') || !Number.isFinite(item.at) || item.at < 0
            || typeof item.label !== 'string' || item.label.length > 160)
            fail('STORY_CURRENT_CORRUPT', '当前状态或备份条目格式无效。');
        validateEncodedState(item.state);
        if (digest(item.state) !== item.hash) fail('STORY_CURRENT_CORRUPT', '当前状态或备份校验不一致，已停止读取。');
    }
    const { hash, ...data } = record;
    if (digest(data) !== hash) fail('STORY_CURRENT_CORRUPT', '当前状态记录校验不一致，已停止读取。');
    if (new TextEncoder().encode(serialized(record)).length > MAX_BYTES)
        fail('STORY_CURRENT_TOO_LARGE', '当前状态与最近备份超过单个文件大小限制。');
    return record;
}
