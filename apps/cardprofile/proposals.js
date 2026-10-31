// AI proposals for the living card copy. The model appends an HTML comment, which chat
// windows do not display:
//   <!--amin_card [{"op":"set","path":"分区/分组/键","value":"…","reason":"…"}] -->
// Proposals are only recorded here; the user accepts or ignores each one under the message.
import { edit, locate, pathLabel, walk, LIMITS } from './model.js';

export const TAG = 'amin_card';
const BLOCK = /<!--\s*amin_card\b([\s\S]*?)-->/g;
const MAX_ITEMS = 20;
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = text => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
const segment = text => clean(text).replace(/^\*+\s*/, '').replace(/\s*[:：]\s*$/, '');

/** Rules appended to the prompt while a chat has a copy that accepts proposals. */
export function buildRules(profiles) {
    const names = profiles.map(profile => profile.current.name);
    const locked = profiles.flatMap(profile => (profile.locked ?? []).map(id => locate(profile.current, id)).filter(Boolean).map(hit => pathLabel(hit.path).replace(/ \/ /g, '/')));
    const who = names.length > 1 ? `（群聊：每项加 "char":"角色名"，可选 ${names.join('、')}）` : '';
    return [
        `【角色设定更新】角色描述（${names.join('、')}=[…]）是该角色的当前设定。只有当本轮剧情让设定发生了持续性的变化（关系、身份、外貌服装、装备、能力、偏好、性格成长等）时，才在回复最末尾另起一行输出一个 HTML 注释（不会显示给用户）：`,
        `<!--${TAG} [{"op":"set","path":"分区/分组/键","value":"新的完整内容","reason":"本轮剧情依据"}] -->`,
        `op：set 修改已有条目；add 在 path 指向的分组下新增（必填 key 和 value，或用 "items":[{"key":"…","value":"…"}] 新增一个分组）；remove 删除条目。path 按角色描述里的键名逐层用 / 连接（同名键可写 键#2）。一次最多 ${MAX_ITEMS} 项。大多数回合没有变化，不要输出${who}。`,
        locked.length ? `以下分区不要提议修改：${locked.join('、')}。` : '',
    ].filter(Boolean).join('\n');
}

/** Find proposal blocks in a reply. Returns {items, errors}; never throws on model output. */
export function extract(text) {
    const items = [], errors = [];
    if (typeof text !== 'string' || !text.includes(TAG)) return { items, errors };
    for (const match of text.matchAll(BLOCK)) {
        const raw = match[1].trim();
        try {
            const value = JSON.parse(raw.startsWith('[') || raw.startsWith('{') ? raw : raw.slice(raw.search(/[[{]/)));
            for (const item of Array.isArray(value) ? value : [value]) if (object(item)) items.push(item);
        } catch { errors.push('角色设定建议不是有效的 JSON，已忽略。'); }
    }
    if (items.length > MAX_ITEMS) { errors.push(`角色设定建议超过 ${MAX_ITEMS} 项，只保留前 ${MAX_ITEMS} 项。`); items.length = MAX_ITEMS; }
    return { items, errors };
}

/** Resolve "分区/分组/键#2" to a node; field/group keys only. Throws a readable error. */
export function resolvePath(tree, path) {
    const parts = String(path ?? '').split(/\s*\/\s*/).map(segment).filter(Boolean);
    if (!parts.length) throw Error('缺少路径。');
    let nodes = tree.children, hit = null, trail = [];
    for (const part of parts) {
        const [, name, nth] = part.match(/^(.*?)(?:#(\d+))?$/);
        const matches = (nodes ?? []).filter(node => node.kind !== 'text' && segment(node.key) === name);
        if (!matches.length) throw Error(`找不到“${[...trail.map(node => node.key), name].join('/')}”。`);
        if (matches.length > 1 && !nth) throw Error(`“${name}”有 ${matches.length} 个同名条目，请写成 ${name}#2 这样的序号。`);
        hit = matches[(Number(nth) || 1) - 1];
        if (!hit) throw Error(`“${name}”没有第 ${nth} 个。`);
        trail.push(hit); nodes = hit.children;
    }
    return { node: hit, path: trail };
}

const lockedBy = (profile, path) => {
    const locked = new Set(profile.locked ?? []);
    return path.find(node => locked.has(node.id)) ?? null;
};

/** Check one raw item against the copy. Returns a stored item {id, op, path, …, status, error?}. */
export function checkItem(profile, raw, id) {
    const op = ['set', 'add', 'remove'].includes(raw.op) ? raw.op : raw.op === 'update' ? 'set' : raw.op === 'delete' ? 'remove' : raw.op;
    const item = { id, op: ['set', 'add', 'remove'].includes(op) ? op : 'set', path: clean(raw.path).slice(0, 400), reason: clean(raw.reason).slice(0, 500), status: 'pending' };
    if (raw.key !== undefined) item.key = segment(raw.key).slice(0, LIMITS.key);
    if (raw.value !== undefined) item.value = clean(typeof raw.value === 'string' ? raw.value : JSON.stringify(raw.value)).slice(0, LIMITS.value);
    if (Array.isArray(raw.items)) item.items = raw.items.filter(object).slice(0, 30).map(child => ({ key: segment(child.key).slice(0, LIMITS.key), value: clean(child.value).slice(0, LIMITS.value) }));
    try {
        if (!['set', 'add', 'remove'].includes(op)) throw Error(`不支持的操作“${raw.op}”。`);
        const hit = resolvePath(profile.current, item.path);
        const locked = lockedBy(profile, hit.path);
        if (locked) { item.status = 'locked'; return item; }
        if (op === 'set') {
            if (hit.node.kind !== 'field') throw Error('只能修改带内容的条目，分组请用 add/remove。');
            if (typeof item.value !== 'string') throw Error('缺少新内容。');
            if (item.value === hit.node.value) throw Error('与当前内容相同。');
            item.before = hit.node.value;
        } else if (op === 'add') {
            if (hit.node.kind !== 'group') throw Error('新增的位置必须是分组。');
            if (!item.key || /[\[\]:：]/.test(item.key)) throw Error('新增条目需要有效的键名。');
            if (item.items ? !item.items.length || item.items.some(child => !child.key || /[\[\]:：]/.test(child.key)) : typeof item.value !== 'string') throw Error('新增条目缺少内容。');
        } else if (hit.node.kind === 'field') item.before = hit.node.value;
    } catch (error) { item.status = 'invalid'; item.error = error.message; }
    return item;
}

/** Apply one accepted item to the copy (paths are resolved again: the copy may have changed). */
export function applyItem(profile, item, { at = new Date().toISOString() } = {}) {
    const hit = resolvePath(profile.current, item.path);
    if (lockedBy(profile, hit.path)) throw Error('这个分区已锁定，先在应用里解除锁定。');
    const where = pathLabel(hit.path), why = item.reason ? `（${item.reason}）` : '';
    return edit(profile, `采纳 AI 建议：${item.op === 'set' ? '修改' : item.op === 'add' ? '新增' : '删除'} ${where}${item.op === 'add' ? ' / ' + item.key : ''}${why}`, next => {
        const target = locate(next.current, hit.node.id);
        // Each applied item remembers how to undo itself (see undoItem).
        if (item.op === 'set') { if (target.node.kind !== 'field') throw Error('只能修改带内容的条目。'); item.undo = { id: target.node.id, value: target.node.value }; target.node.value = item.value; }
        else if (item.op === 'remove') { item.undo = { node: copy(target.node), parentId: hit.path.at(-2)?.id ?? null, index: target.index }; target.siblings.splice(target.index, 1); }
        else {
            if (target.node.kind !== 'group') throw Error('新增的位置必须是分组。');
            const make = (fields) => ({ id: `n${next.nextId++}`, star: true, ...fields });
            const created = item.items
                ? make({ kind: 'group', key: item.key, children: item.items.map(child => make({ kind: 'field', key: child.key, value: child.value })) })
                : make({ kind: 'field', key: item.key, value: item.value });
            target.node.children.push(created); item.undo = { id: created.id };
        }
    }, at);
}

/** Reverse one applied item. Throws when the copy no longer has what it changed. */
export function undoItem(profile, item, { at = new Date().toISOString() } = {}) {
    const undo = item.undo;
    if (!undo) throw Error('这条改动没有可撤销的记录。');
    const text = describe(item).title;
    return edit(profile, `撤销 AI 建议：${text}`, next => {
        if (item.op === 'set') { const hit = locate(next.current, undo.id); if (!hit) throw Error('条目已被删除，无法撤销。'); hit.node.value = undo.value; }
        else if (item.op === 'add') { const hit = locate(next.current, undo.id); if (!hit) throw Error('新增的条目已被删除。'); hit.siblings.splice(hit.index, 1); }
        else {
            if (locate(next.current, undo.node.id)) throw Error('条目已经存在。');
            const siblings = undo.parentId == null ? next.current.children : locate(next.current, undo.parentId)?.node.children;
            if (!siblings) throw Error('原来所在的分组已被删除，无法撤销。');
            siblings.splice(Math.min(undo.index, siblings.length), 0, copy(undo.node));
        }
    }, at);
}

/** Stable identity of one reply candidate, so a proposal stays with the swipe it came from. */
export function messageKey(message, index) {
    const swipe = message?.swipe_id ?? 0;
    return [index, swipe, message?.send_date ?? message?.swipe_info?.[swipe]?.send_date ?? ''].join('|');
}

/** Which copy a reply belongs to: the explicit char name, the group speaker, or the only copy. */
export function targetAvatar(item, message, profiles) {
    const named = clean(item.char);
    if (named) { const hit = profiles.find(profile => profile.current.name === named || profile.cardName === named); if (hit) return hit.avatar; }
    const speaker = message?.original_avatar ?? null;
    if (speaker && profiles.some(profile => profile.avatar === speaker)) return speaker;
    const byName = profiles.find(profile => profile.cardName && profile.cardName === message?.name);
    if (byName) return byName.avatar;
    return profiles.length === 1 ? profiles[0].avatar : null;
}

export function describe(item) {
    const where = item.path.replace(/\s*\/\s*/g, ' / ');
    if (item.op === 'set') return { title: `修改 ${where}`, before: item.before ?? '', after: item.value ?? '' };
    if (item.op === 'remove') return { title: `删除 ${where}`, before: item.before ?? '', after: '' };
    const after = item.items ? item.items.map(child => `${child.key}：${child.value}`).join('；') : item.value ?? '';
    return { title: `新增 ${where} / ${item.key ?? ''}`, before: '', after };
}

export const pendingCount = proposals => (proposals ?? []).reduce((sum, entry) => sum + entry.items.filter(item => item.status === 'pending').length, 0);
export { walk, copy };
