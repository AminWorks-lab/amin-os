// AI proposals for the living card copy. The model appends an HTML comment, which chat
// windows do not display:
//   <!--amin_card [{"op":"set","path":"分区/分组/键","value":"…","reason":"…"}] -->
// Proposals are only recorded here; the user accepts or ignores each one under the message.
import { edit, locate, pathLabel, walk, LIMITS, resolveName, isWorldPanel } from './model.js';

export const TAG = 'amin_card';
const BLOCK = /<!--\s*amin_card\b([\s\S]*?)-->/g;
const MAX_ITEMS = 20;
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = text => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
const segment = text => clean(text).replace(/^\*+\s*/, '').replace(/\s*[:：]\s*$/, '').replace(/\s*\/\s*/g, '/');

/** Rules appended to the prompt while a chat has a copy that accepts proposals. */
/** Who may rewrite a panel, as the model should read it: "名字（全部）" / "名字（仅 分区、分区）". */
export function panelEditors(profile, user) {
    return (profile.panel?.editors ?? []).map(editor => {
        const sections = editor.sections.map(id => profile.current.children.find(node => node.id === id)?.key).filter(Boolean);
        return `${resolveName(editor.name, user)}（${sections.length ? '仅 ' + sections.join('、') : '全部'}）`;
    });
}

/** How rewrites of this panel happen in the story, as one sentence ('' when left to the story). */
export function panelManner(profile) {
    const panel = profile.panel ?? {}, text = panel.methodText?.trim(), name = profile.current.name;
    const how = { panel: '改写者打开并操作这个面板来改写', ability: `改写者使用能力${text ? `「${text}」` : ''}来改写`, natural: '没有任何超自然现象，设定就这样自然地变成了新的样子', custom: text || '' }[panel.method] ?? '';
    const aware = { aware: `${name} 会察觉到自己被改写`, unaware: `${name} 不会察觉，认为自己一直如此` }[panel.aware] ?? '';
    return [how, aware].filter(Boolean).join('；');
}

export function buildRules(profiles, { user = '' } = {}) {
    const names = profiles.map(profile => profile.current.name);
    const locked = profiles.flatMap(profile => (profile.locked ?? []).map(id => locate(profile.current, id)).filter(Boolean).map(hit => pathLabel(hit.path).replace(/ \/ /g, '/')));
    const who = names.length > 1 ? `（有多份设定：每项必须加 "char":"设定名"，可选 ${names.join('、')}）` : '';
    return [
        `【角色设定更新】设定资料（${names.join('、')}=[…]）是这些角色（或世界）的当前设定。只有当本轮剧情让设定发生了持续性的变化（关系、身份、外貌服装、装备、能力、偏好、性格成长、世界局势与规则等）时，才在回复最末尾另起一行输出一个 HTML 注释（不会显示给用户）：`,
        `<!--${TAG} [{"op":"set","path":"分区/分组/键","value":"新的完整内容","reason":"本轮剧情依据"}] -->`,
        `op：set 修改已有条目；add 在 path 指向的分组下新增（必填 key 和 value，或用 "items":[{"key":"…","value":"…"}] 新增一个分组）；remove 删除条目。path 按设定里的键名逐层用 / 连接，从分区开始写，不要带最外层的名字（同名键可写 键#2，键名本身带 / 的照原样写）。一次最多 ${MAX_ITEMS} 项。大多数回合没有变化，不要输出${who}。`,
        locked.length ? `以下分区不要提议修改：${locked.join('、')}。` : '',
        ...profiles.filter(profile => profile.panel?.on).map(profile => {
            const editors = panelEditors(profile, user);
            const kind = isWorldPanel(profile) ? '世界面板' : '角色面板';
            return `【${kind}】${profile.current.name} 的设定是剧情中真实存在的${kind}，${editors.length ? `只有 ${editors.join('、')} 能在剧情里改写它` : '目前没有人能改写它'}。剧情里有人改写这个面板时，按改写内容输出上述注释，每项加 "by":"改写者名字"，改写后的设定会真实生效，下一轮按新面板演绎；${panelManner(profile) ? `改写方式：${panelManner(profile)}；` : ''}没有权限的人改写不会生效。剧情自然发展带来的变化不加 by。`;
        }),
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

/** Split a path on "/", keeping keys that contain "/" themselves (起源/来历) in one piece. */
export function splitPath(tree, path) {
    const parts = String(path ?? '').split(/\s*\/\s*/).map(segment).filter(Boolean);
    const slashed = new Set();
    walk(tree?.children ?? [], node => { if (node.kind !== 'text' && node.key.includes('/')) slashed.add(segment(node.key)); });
    if (!slashed.size) return parts;
    const out = [];
    for (let index = 0; index < parts.length;) {
        let size = 1;
        for (let end = parts.length; end > index + 1; end--) {
            const joined = parts.slice(index, end).join('/');
            if (slashed.has(joined.replace(/#\d+$/, ''))) { size = end - index; break; }
        }
        out.push(parts.slice(index, index + size).join('/')); index += size;
    }
    return out;
}

/** Resolve "分区/分组/键#2" to a node; field/group keys only. Throws a readable error. */
export function resolvePath(tree, path) {
    try { return resolveExact(tree, path); }
    catch (error) {
        // Models sometimes skip the upper levels ("简要描述/…" instead of "分区/分组/简要描述/…").
        // Accept that only when the written keys match exactly one place in the tree.
        const parts = splitPath(tree, path);
        if (!parts.length || parts.some(part => /#\d+$/.test(part))) throw error;
        const found = [];
        const visit = (nodes, trail) => {
            for (const node of nodes ?? []) {
                if (node.kind === 'text') continue;
                const next = [...trail, node];
                if (next.length > parts.length && next.slice(-parts.length).every((step, index) => segment(step.key) === parts[index])) found.push(next);
                if (node.kind === 'group') visit(node.children, next);
            }
        };
        visit(tree.children, []);
        if (found.length === 1) return { node: found[0].at(-1), path: found[0] };
        if (found.length > 1) throw Error(`“${parts.join('/')}”在多个地方都有，请从分区开始写完整路径。`);
        throw error;
    }
}
function resolveExact(tree, path) {
    const parts = splitPath(tree, path);
    // Models often start the path with the copy's own name ("伊地知虹夏/重要关系/…"): drop it
    // unless a top-level section really has that name.
    if (parts.length > 1 && segment(tree.name ?? '') === parts[0].replace(/#\d+$/, '') && !(tree.children ?? []).some(node => node.kind !== 'text' && segment(node.key) === parts[0])) parts.shift();
    if (!parts.length) throw Error('缺少路径。');
    let nodes = tree.children, hit = null, trail = [];
    for (const part of parts) {
        const [, name, nth] = part.match(/^(.*?)(?:#(\d+))?$/);
        const matches = (nodes ?? []).filter(node => node.kind !== 'text' && segment(node.key) === name);
        if (!matches.length) {
            // Loose match: ignore spaces and full-width/half-width differences before giving up.
            const loose = text => text.normalize('NFKC').replace(/\s+/g, '');
            const near = (nodes ?? []).filter(node => node.kind !== 'text' && loose(segment(node.key)) === loose(name));
            if (near.length === 1 && !nth) { hit = near[0]; trail.push(hit); nodes = hit.children; continue; }
            const here = (nodes ?? []).filter(node => node.kind !== 'text').map(node => segment(node.key)).slice(0, 12);
            throw Error(`找不到“${[...trail.map(node => node.key), name].join('/')}”${here.length ? `（这一层有：${here.join('、')}）` : '（上一层不是分组）'}。`);
        }
        if (matches.length > 1 && !nth) throw Error(`“${name}”有 ${matches.length} 个同名条目，请写成 ${name}#2 这样的序号。`);
        hit = matches[(Number(nth) || 1) - 1];
        if (!hit) throw Error(`“${name}”没有第 ${nth} 个。`);
        trail.push(hit); nodes = hit.children;
    }
    return { node: hit, path: trail };
}

/** For a path that does not resolve: the deepest existing group it starts with (trail, [] for
 *  the top level) and the names below it that are missing. null when no group fits. */
export function missingPart(tree, path) {
    const parts = splitPath(tree, path);
    if (parts.length > 1 && segment(tree.name ?? '') === parts[0] && !(tree.children ?? []).some(node => node.kind !== 'text' && segment(node.key) === parts[0])) parts.shift();
    const loose = text => text.normalize('NFKC').replace(/\s+/g, '');
    let nodes = tree.children, trail = [];
    for (const [index, part] of parts.entries()) {
        const [, name, nth] = part.match(/^(.*?)(?:#(\d+))?$/);
        let matches = (nodes ?? []).filter(node => node.kind === 'group' && segment(node.key) === name);
        if (!matches.length) matches = (nodes ?? []).filter(node => node.kind === 'group' && loose(segment(node.key)) === loose(name));
        const hit = matches.length === 1 && !nth ? matches[0] : nth ? matches[Number(nth) - 1] : null;
        if (!hit) {
            if (matches.length > 1) return null;
            // An entry with this name is already here (a field, or a duplicate without #n):
            // that is a mistake in the path, not a missing section. 事件#7 past the last 事件 is new.
            const same = (nodes ?? []).filter(node => node.kind !== 'text' && loose(segment(node.key)) === loose(name));
            if (same.length && !(nth && Number(nth) > same.length && index === parts.length - 1)) return null;
            const rest = parts.slice(index).map(value => value.replace(/#\d+$/, ''));
            return rest.every(value => value && !/[\[\]:：]/.test(value)) ? { trail, rest } : null;
        }
        trail.push(hit); nodes = hit.children;
    }
    return null;
}

/** A trail of nodes written back as a path resolvePath accepts (键#2 for repeated keys). */
export function pathText(tree, trail) {
    let siblings = tree.children;
    return trail.map(node => {
        const same = siblings.filter(other => other.kind !== 'text' && segment(other.key) === segment(node.key));
        siblings = node.children ?? [];
        return segment(node.key) + (same.length > 1 ? `#${same.indexOf(node) + 1}` : '');
    }).join('/');
}

const lockedBy = (profile, path) => {
    const locked = new Set(profile.locked ?? []);
    return path.find(node => locked.has(node.id)) ?? null;
};

/** Check one raw item against the copy. Returns a stored item {id, op, path, …, status, error?}. */
/** The panel editor entry that lets `by` rewrite the section `path` starts in (null when none). */
export function panelPermission(profile, by, path, user) {
    const editor = (profile.panel?.editors ?? []).find(value => resolveName(value.name, user) === by);
    if (!editor) return { ok: false, error: `${by} 没有改写${profile.current.name}面板的权限。` };
    if (editor.sections.length && !editor.sections.includes(path[0]?.id)) return { ok: false, error: `${by} 只能改写${profile.current.name}面板的 ${editor.sections.map(id => profile.current.children.find(node => node.id === id)?.key).filter(Boolean).join('、')}。` };
    return { ok: true };
}

export function checkItem(profile, raw, id, { user = '' } = {}) {
    const op = ['set', 'add', 'remove'].includes(raw.op) ? raw.op : raw.op === 'update' ? 'set' : raw.op === 'delete' ? 'remove' : raw.op;
    const item = { id, op: ['set', 'add', 'remove'].includes(op) ? op : 'set', path: clean(raw.path).slice(0, 400), reason: clean(raw.reason).slice(0, 500), status: 'pending' };
    if (raw.key !== undefined) item.key = segment(raw.key).slice(0, LIMITS.key);
    if (raw.value !== undefined) item.value = clean(typeof raw.value === 'string' ? raw.value : JSON.stringify(raw.value)).slice(0, LIMITS.value);
    if (raw.by !== undefined && clean(raw.by)) item.by = clean(raw.by).slice(0, LIMITS.key);
    if (Array.isArray(raw.items)) item.items = raw.items.filter(object).slice(0, 30).map(child => ({ key: segment(child.key).slice(0, LIMITS.key), value: clean(child.value).slice(0, LIMITS.value) }));
    try {
        if (!['set', 'add', 'remove'].includes(op)) throw Error(`不支持的操作“${raw.op}”。`);
        let hit;
        try { hit = op === 'add' && !item.path ? { node: null, path: [] } : resolvePath(profile.current, item.path); }
        catch (error) {
            // A section or entry the copy does not have yet: add it (creating the missing
            // sections) instead of failing, when everything above it exists.
            const missing = op === 'remove' ? null : missingPart(profile.current, item.path);
            if (!missing) throw error;
            if (op === 'set') {
                // set only becomes add for a new entry in a section that exists (事件#7 after six 事件).
                if (typeof item.value !== 'string' || missing.rest.length !== 1 || !missing.trail.length) throw error;
                item.op = 'add'; item.key = missing.rest.at(-1); missing.rest = missing.rest.slice(0, -1);
            } else if (!item.key && !item.items) { item.key = missing.rest.at(-1); missing.rest = missing.rest.slice(0, -1); }
            if (missing.rest.length) item.create = missing.rest;
            item.path = pathText(profile.current, missing.trail);
            hit = { node: missing.trail.at(-1) ?? null, path: missing.trail };
        }
        const locked = lockedBy(profile, hit.path);
        if (locked) { item.status = 'locked'; return item; }
        if (item.by && profile.panel?.on) { const allowed = panelPermission(profile, item.by, hit.path, user); if (!allowed.ok) throw Error(allowed.error); }
        if (item.op === 'set' && hit.node.kind === 'group') {
            // set on a group: models mean its one content field (or the one named 描述/内容…).
            const fields = hit.node.children.filter(node => node.kind === 'field');
            const pick = fields.length === 1 ? fields[0] : fields.find(node => ['描述', '内容', '说明', '简介', '概述', '简要描述'].includes(segment(node.key)));
            if (!pick) throw Error(`“${segment(hit.node.key)}”是分组，里面有：${fields.map(node => segment(node.key)).slice(0, 12).join('、') || '（没有条目）'}。请改具体的条目，或用 add/remove。`);
            item.path = pathText(profile.current, [...hit.path, pick]);
            hit.node = pick; hit.path = [...hit.path, pick];
        }
        if (item.op === 'set') {
            if (hit.node.kind !== 'field') throw Error('只能修改带内容的条目，分组请用 add/remove。');
            if (typeof item.value !== 'string') throw Error('缺少新内容。');
            if (item.value === hit.node.value) throw Error('与当前内容相同。');
            item.before = hit.node.value;
        } else if (item.op === 'add') {
            if (hit.node && hit.node.kind !== 'group') throw Error('新增的位置必须是分组。');
            if (!item.key || /[\[\]:：]/.test(item.key)) throw Error('新增条目需要有效的键名。');
            if (item.items ? !item.items.length || item.items.some(child => !child.key || /[\[\]:：]/.test(child.key)) : typeof item.value !== 'string') throw Error('新增条目缺少内容。');
        } else if (hit.node.kind === 'field') item.before = hit.node.value;
    } catch (error) { item.status = 'invalid'; item.error = error.message; }
    return item;
}

/** Apply one accepted item to the copy (paths are resolved again: the copy may have changed). */
export function applyItem(profile, item, { at = new Date().toISOString() } = {}) {
    const hit = item.op === 'add' && !item.path ? { node: null, path: [] } : resolvePath(profile.current, item.path);
    if (lockedBy(profile, hit.path)) throw Error('这个分区已锁定，先在应用里解除锁定。');
    const where = [pathLabel(hit.path), ...(item.create ?? [])].filter(Boolean).join(' / ') || '最外层', why = item.reason ? `（${item.reason}）` : '';
    return edit(profile, `${item.by ? `${item.by} 改写面板` : '采纳 AI 建议'}：${item.op === 'set' ? '修改' : item.op === 'add' ? '新增' : '删除'} ${where}${item.op === 'add' ? ' / ' + item.key : ''}${why}`, next => {
        const target = hit.node ? locate(next.current, hit.node.id) : null;
        // Each applied item remembers how to undo itself (see undoItem).
        if (item.op === 'set') { if (target.node.kind !== 'field') throw Error('只能修改带内容的条目。'); item.undo = { id: target.node.id, value: target.node.value }; target.node.value = item.value; }
        else if (item.op === 'remove') { item.undo = { node: copy(target.node), parentId: hit.path.at(-2)?.id ?? null, index: target.index }; target.siblings.splice(target.index, 1); }
        else {
            if (target && target.node.kind !== 'group') throw Error('新增的位置必须是分组。');
            const make = (fields) => ({ id: `n${next.nextId++}`, star: true, ...fields });
            let children = target ? target.node.children : next.current.children, top = null;
            for (const name of item.create ?? []) {
                const group = make({ kind: 'group', key: name, star: false, children: [] });
                children.push(group); top ??= group; children = group.children;
            }
            const created = item.items
                ? make({ kind: 'group', key: item.key, children: item.items.map(child => make({ kind: 'field', key: child.key, value: child.value })) })
                : make({ kind: 'field', key: item.key, value: item.value });
            children.push(created); item.undo = { id: (top ?? created).id };
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

/** Which copy a reply belongs to (returns its store key): the explicit char name, the group
 *  speaker's own card, or the only copy. Multi-character world-info copies need the char name. */
export function targetAvatar(item, message, profiles) {
    const key = profile => profile.key ?? profile.avatar;
    const named = clean(item.char);
    if (named) { const hit = profiles.find(profile => profile.current.name === named) ?? profiles.find(profile => profile.cardName === named && !profile.source); if (hit) return key(hit); }
    const cards = profiles.filter(profile => !profile.source);
    const speaker = message?.original_avatar ?? null;
    if (speaker) { const hit = cards.find(profile => profile.avatar === speaker); if (hit) return key(hit); }
    const byName = cards.find(profile => profile.cardName && profile.cardName === message?.name);
    if (byName && profiles.length === cards.length) return key(byName);
    return profiles.length === 1 ? key(profiles[0]) : null;
}

export function describe(item) {
    const text = describeOp(item);
    return item.by ? { ...text, title: `${item.by} 改写：${text.title}` } : text;
}
function describeOp(item) {
    const where = item.path.replace(/\s*\/\s*/g, ' / ');
    if (item.op === 'set') return { title: `修改 ${where}`, before: item.before ?? '', after: item.value ?? '' };
    if (item.op === 'remove') return { title: `删除 ${where}`, before: item.before ?? '', after: '' };
    const after = item.items ? item.items.map(child => `${child.key}：${child.value}`).join('；') : item.value ?? '';
    const place = [where, ...(item.create ?? [])].filter(Boolean).join(' / ');
    return { title: `新增 ${place ? place + ' / ' : ''}${item.key ?? ''}${item.create?.length ? `（新建分区 ${item.create.join(' / ')}）` : ''}`, before: '', after };
}

/** The line appended to the chat draft when the player rewrites a panel from the app. */
export function storyLine({ by, target, path, before, after, op, manner = '' }) {
    const line = storyText({ by, target, path, before, after, op });
    return manner ? `${line}（${manner}）` : line;
}
function storyText({ by, target, path, before, after, op }) {
    const where = path.join('/');
    if (op === 'remove') return `【面板改写】${by} 抹去了 ${target} 面板上的 ${where}`;
    return before === undefined ? `【面板改写】${by} 在 ${target} 的面板上写下：${where}：${after}`
        : `【面板改写】${by} 把 ${target} 面板上的 ${where} 从“${before}”改成了“${after}”`;
}

export const pendingCount = proposals => (proposals ?? []).reduce((sum, entry) => sum + entry.items.filter(item => item.status === 'pending').length, 0);
export { walk, copy };
