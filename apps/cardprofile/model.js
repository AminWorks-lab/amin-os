// Per-chat living copies of character-card descriptions written in the bracket template.
// The card keeps the original; the chat keeps {baseline, current} trees and a change log.
import { parseCard, writeCard, liftBlocks } from './format.js';

export const KEY = 'amin_os_card_profile_v1';
export const DIFF_MODES = Object.freeze(['summary', 'inline', 'off']);
export const LIMITS = Object.freeze({ profiles: 50, nodes: 5000, history: 500, key: 80, value: 20000, proposals: 300 });
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(Error(message), { code: 'CARD_PROFILE_INVALID' }); };

export const emptyStore = () => ({ version: 1, profiles: {} });
/** Store key: the card avatar for a card description, `wi:书名#uid` for a world-info entry. */
export const worldKey = (book, uid) => `wi:${book}#${uid}`;
export const noteKey = id => `note:${id}`;
export const NOTE_KINDS = Object.freeze({ world: '世界资料', character: '角色资料' });
// Copies come from a card description (no source), a world-info entry, or are created in the
// app (custom: pasted or AI-generated, sent as an extra block since there is no original text).
export const profileKey = profile => profile.source?.type === 'world' ? worldKey(profile.source.book, profile.source.uid) : profile.source?.type === 'custom' ? noteKey(profile.source.id) : profile.avatar;
export const isWorldPanel = profile => profile.source?.type === 'custom' && profile.source.kind === 'world';

export function validateNode(node, ids) {
    if (!object(node) || typeof node.id !== 'string' || !node.id || ids.has(node.id)) fail('角色资料条目编号无效或重复。');
    ids.add(node.id);
    if (!['group', 'field', 'text'].includes(node.kind) || typeof node.star !== 'boolean') fail('角色资料条目类型无效。');
    if (node.sep !== undefined && (typeof node.sep !== 'string' || !/^\s*[:：=]\s*$/.test(node.sep))) fail('角色资料分隔符无效。');
    if (node.block !== undefined && (node.block !== true || node.kind !== 'group')) fail('角色资料分组无效。');
    if (node.kind !== 'text' && (typeof node.key !== 'string' || node.key.length > LIMITS.key || /[\n\[\]]/.test(node.key) || (node.kind === 'field' && /[:：]/.test(node.key)) || !node.key.trim())) fail('角色资料键名无效：' + String(node.key).slice(0, 40));
    if (node.kind === 'group') { if (!Array.isArray(node.children)) fail('角色资料分组无效。'); for (const child of node.children) validateNode(child, ids); }
    else if (typeof node.value !== 'string' || node.value.length > LIMITS.value || node.value.includes('\n')) fail('角色资料内容无效或过长（不能换行）。');
    if (ids.size > LIMITS.nodes) fail('角色资料条目过多。');
}
export function validateTree(tree) {
    if (!object(tree) || typeof tree.name !== 'string' || !tree.name.trim() || /[=\[\]\n]/.test(tree.name)) fail('角色资料名称无效。');
    if (typeof tree.before !== 'string' || typeof tree.after !== 'string' || !Array.isArray(tree.children)) fail('角色资料结构无效。');
    const ids = new Set();
    for (const child of tree.children) validateNode(child, ids);
    walk(tree.children, (node, path) => { if (node.block && path.length > 1) fail('角色资料分组无效。'); });
    return ids;
}
export function validateProfile(profile) {
    if (!object(profile) || typeof profile.avatar !== 'string' || !profile.avatar || typeof profile.cardName !== 'string') fail('角色资料来源无效。');
    if (typeof profile.sourceHash !== 'string' || typeof profile.importedAt !== 'string' || !Number.isInteger(profile.nextId) || profile.nextId < 1) fail('角色资料来源无效。');
    if (typeof profile.replace !== 'boolean' || !DIFF_MODES.includes(profile.diff) || (profile.fallback !== undefined && typeof profile.fallback !== 'boolean')) fail('角色资料发送设置无效。');
    if (profile.source !== undefined) {
        const source = profile.source;
        if (object(source) && source.type === 'custom') {
            if (typeof source.id !== 'string' || !/^[\w-]{1,80}$/.test(source.id) || !Object.hasOwn(NOTE_KINDS, source.kind)) fail('自建资料的来源无效。');
        } else if (!object(source) || source.type !== 'world' || typeof source.book !== 'string' || !source.book || !['string', 'number'].includes(typeof source.uid) || typeof source.title !== 'string' || typeof source.text !== 'string' || source.text.length > 400000) fail('角色资料的世界书来源无效。');
    }
    if (profile.propose !== undefined && typeof profile.propose !== 'boolean') fail('角色资料建议开关无效。');
    if (profile.proposeMode !== undefined && !PROPOSE_MODES.includes(profile.proposeMode)) fail('角色资料建议方式无效。');
    if (profile.locked !== undefined && (!Array.isArray(profile.locked) || profile.locked.length > 1000 || profile.locked.some(id => typeof id !== 'string'))) fail('角色资料锁定分区无效。');
    if (profile.panel !== undefined) validatePanel(profile.panel);
    if (profile.ask !== undefined && (!object(profile.ask) || typeof profile.ask.by !== 'string' || profile.ask.by.length > LIMITS.key || typeof profile.ask.story !== 'boolean')) fail('“让 AI 改”的默认设置无效。');
    validateTree(profile.baseline); validateTree(profile.current);
    if (!Array.isArray(profile.history) || profile.history.length > LIMITS.history) fail('角色资料修改记录无效。');
    for (const entry of profile.history) if (!object(entry) || typeof entry.at !== 'string' || typeof entry.label !== 'string') fail('角色资料修改记录无效。');
    return profile;
}
// Character-panel play: the copy is a panel inside the story, and only the listed editors may
// rewrite it (each optionally limited to some top-level sections). USER_TOKEN is the player.
export const USER_TOKEN = '{{user}}';
export const PANEL_LIMITS = Object.freeze({ editors: 20, sections: 200, method: 300 });
// How a rewrite happens in the story, and whether the rewritten one notices. Unset = the story decides.
export const PANEL_METHODS = Object.freeze({ story: '不指定（交给剧情）', panel: '打开面板操作', ability: '使用能力', natural: '自然变化（没有超自然现象）', custom: '自定义' });
export const PANEL_AWARE = Object.freeze({ story: '不指定（交给剧情）', aware: '会察觉自己被改写', unaware: '不会察觉，以为自己一直如此' });
function validatePanel(panel) {
    if (!object(panel) || typeof panel.on !== 'boolean' || !Array.isArray(panel.editors) || panel.editors.length > PANEL_LIMITS.editors) fail('角色面板设置无效。');
    if (panel.method !== undefined && !Object.hasOwn(PANEL_METHODS, panel.method)) fail('面板改写方式无效。');
    if (panel.methodText !== undefined && (typeof panel.methodText !== 'string' || panel.methodText.length > PANEL_LIMITS.method || panel.methodText.includes('\n'))) fail('面板改写方式的描述无效（不能换行，最多 300 字）。');
    if (panel.aware !== undefined && !Object.hasOwn(PANEL_AWARE, panel.aware)) fail('面板“是否察觉”设置无效。');
    for (const editor of panel.editors) {
        if (!object(editor) || typeof editor.name !== 'string' || !editor.name.trim() || editor.name.length > LIMITS.key) fail('角色面板的改写者无效。');
        if (!Array.isArray(editor.sections) || editor.sections.length > PANEL_LIMITS.sections || editor.sections.some(id => typeof id !== 'string')) fail('角色面板的改写范围无效。');
    }
}
/** A panel's settings moved to another copy: sections are matched by name, unknown ones dropped. */
export function transferPanel(from, to, { on = from.panel?.on ?? false } = {}) {
    const names = new Map((from.current.children ?? []).filter(node => node.kind === 'group').map(node => [node.id, node.key]));
    const ids = new Map((to.current.children ?? []).filter(node => node.kind === 'group').map(node => [node.key, node.id]));
    const editors = (from.panel?.editors ?? []).map(editor => ({ name: editor.name, sections: editor.sections.map(id => ids.get(names.get(id))).filter(Boolean) }));
    const { method = 'story', methodText = '', aware = 'story' } = from.panel ?? {};
    return setOptions(to, { panel: { on, editors, method, methodText, aware } });
}
export const resolveName = (name, user) => name === USER_TOKEN ? (user || '用户') : name;
/** Settings added in 0.22: AI proposals on, nothing locked until the user locks a group. */
export function normalizeProfile(profile) {
    const next = { ...profile };
    if (next.propose === undefined) next.propose = true;
    if (next.locked === undefined) next.locked = [];
    if (next.proposeMode === undefined) next.proposeMode = 'review';
    return liftProfile(next);
}
/** Copies saved before 0.27.9 kept `名字=[ … ]` blocks after the first one as plain text in
 *  `after`. Lift them into groups the same way in baseline and current so ids still match. */
function liftProfile(profile) {
    const has = tree => /^[^=\[\]\n]+?\s*=\s*\[\s*$/m.test(tree?.after ?? '');
    if (!has(profile.current) && !has(profile.baseline)) return profile;
    const next = { ...profile, baseline: copy(profile.baseline), current: copy(profile.current) };
    let id = next.nextId;
    const lift = tree => { let local = next.nextId; const count = liftBlocks(tree, () => `n${local++}`); id = Math.max(id, local); return count; };
    if (next.baseline.after === next.current.after) { lift(next.baseline); lift(next.current); }
    else { lift(next.current); next.nextId = id; lift(next.baseline); }
    next.nextId = id;
    return next;
}
export const PROPOSAL_STATUS = Object.freeze(['pending', 'accepted', 'ignored', 'invalid', 'locked', 'undone']);
export const PROPOSE_MODES = Object.freeze(['review', 'auto']);
function validateProposal(entry) {
    if (!object(entry) || typeof entry.id !== 'string' || typeof entry.avatar !== 'string' || typeof entry.key !== 'string' || typeof entry.at !== 'string' || !Number.isInteger(entry.index) || !Array.isArray(entry.items) || entry.items.length > 50) fail('角色资料建议记录无效。');
    for (const item of entry.items) if (!object(item) || typeof item.id !== 'string' || !['set', 'add', 'remove'].includes(item.op) || typeof item.path !== 'string' || !PROPOSAL_STATUS.includes(item.status)) fail('角色资料建议条目无效。');
}
export function validateStore(store) {
    if (!object(store) || store.version !== 1 || !object(store.profiles)) fail('角色资料存储格式无效。');
    if (store.proposals !== undefined) { if (!Array.isArray(store.proposals) || store.proposals.length > LIMITS.proposals) fail('角色资料建议过多。'); store.proposals.forEach(validateProposal); }
    if (store.ask !== undefined && (!object(store.ask) || typeof store.ask.by !== 'string' || store.ask.by.length > LIMITS.key || typeof store.ask.story !== 'boolean')) fail('“让 AI 改”的默认设置无效。');
    if (Object.keys(store.profiles).length > LIMITS.profiles) fail('角色资料数量超过上限。');
    for (const [key, profile] of Object.entries(store.profiles)) { validateProfile(profile); if (profileKey(profile) !== key) fail('角色资料归属不一致。'); }
    return store;
}

/** Create a profile from a card description. Throws a parse error with its line number. */
export function createProfile({ avatar, cardName = '', description, hash, source, at = new Date().toISOString() }) {
    let next = 1;
    const tree = parseCard(description, () => `n${next++}`);
    const profile = normalizeProfile({ avatar, cardName, sourceHash: hash, importedAt: at, nextId: next, replace: true, diff: 'summary', baseline: tree, current: copy(tree), history: [], ...(source ? { source } : {}) });
    return validateProfile(profile);
}

// ---- tree helpers ----
export function walk(nodes, visit, trail = []) {
    for (const [index, node] of nodes.entries()) {
        const path = [...trail, node];
        if (visit(node, path, index, nodes) === false) return false;
        if (node.kind === 'group' && walk(node.children, visit, path) === false) return false;
    }
    return true;
}
export function locate(tree, id) {
    let found = null;
    walk(tree.children, (node, path, index, siblings) => { if (node.id === id) { found = { node, path, index, siblings }; return false; } });
    return found;
}
export const label = node => node.kind === 'text' ? (node.value.length > 16 ? node.value.slice(0, 16) + '…' : node.value) : node.key;
export const pathLabel = path => path.map(label).join(' / ');
export function indexById(tree) {
    const map = new Map();
    walk(tree.children, (node, path) => { map.set(node.id, { node, path }); });
    return map;
}

// ---- edits: each returns a new profile and appends one history entry ----
export function edit(profile, labelText, change, at = new Date().toISOString()) {
    const next = copy(profile);
    change(next);
    next.history = [...next.history, { at, label: labelText }].slice(-LIMITS.history);
    return validateProfile(next);
}
export function setNode(profile, id, { key, value, star }, { at = new Date().toISOString() } = {}) {
    const hit = locate(profile.current, id); if (!hit) fail('条目不存在，可能已被删除。');
    const before = hit.node;
    return edit(profile, `修改 ${pathLabel(hit.path)}`, next => {
        const node = locate(next.current, id).node;
        if (key !== undefined && node.kind !== 'text') node.key = String(key).trim();
        if (value !== undefined && node.kind !== 'group') node.value = String(value).replace(/\s*\n\s*/g, ' ').trim();
        if (star !== undefined) node.star = !!star;
    }, at);
}
export function addNode(profile, parentId, { kind = 'field', key = '', value = '', star = true, after = null } = {}, { at = new Date().toISOString() } = {}) {
    let created;
    const result = edit(profile, '新增条目', next => {
        const siblings = parentId == null ? next.current.children : locate(next.current, parentId)?.node.children;
        if (!siblings) fail('上级分组不存在。');
        created = { id: `n${next.nextId++}`, kind, star: !!star, ...(kind === 'text' ? {} : { key: String(key).trim() || '新条目' }), ...(kind === 'group' ? { children: [] } : { value: String(value).trim() }) };
        const position = after ? siblings.findIndex(node => node.id === after) + 1 : siblings.length;
        siblings.splice(position || siblings.length, 0, created);
    }, at);
    const hit = locate(result.current, created.id);
    result.history[result.history.length - 1].label = `新增 ${pathLabel(hit.path)}`;
    return { profile: result, id: created.id };
}
export function removeNode(profile, id, { at = new Date().toISOString() } = {}) {
    const hit = locate(profile.current, id); if (!hit) fail('条目不存在。');
    return edit(profile, `删除 ${pathLabel(hit.path)}`, next => { const target = locate(next.current, id); target.siblings.splice(target.index, 1); }, at);
}
export function moveNode(profile, id, offset, { at = new Date().toISOString() } = {}) {
    const hit = locate(profile.current, id); if (!hit) fail('条目不存在。');
    const to = hit.index + offset; if (to < 0 || to >= hit.siblings.length) return profile;
    return edit(profile, `调整顺序 ${pathLabel(hit.path)}`, next => { const target = locate(next.current, id); const [node] = target.siblings.splice(target.index, 1); target.siblings.splice(to, 0, node); }, at);
}
/** Put one node (and its subtree) back to the baseline, or re-insert a deleted baseline node. */
export function restoreNode(profile, id, { at = new Date().toISOString() } = {}) {
    const base = locate(profile.baseline, id); if (!base) fail('这是新增的条目，没有初始版本。');
    return edit(profile, `恢复初始 ${pathLabel(base.path)}`, next => {
        const original = copy(base.node), current = locate(next.current, id);
        // Baseline children that now live elsewhere keep their current place instead of being duplicated.
        const inside = new Set(current ? [...indexById({ children: [current.node] }).keys()] : []);
        const elsewhere = new Set([...indexById(next.current).keys()].filter(key => !inside.has(key)));
        const prune = node => { if (node.kind === 'group') node.children = node.children.filter(child => !elsewhere.has(child.id)).map(prune); return node; };
        prune(original);
        if (current) { current.siblings.splice(current.index, 1, original); return; }
        const parentId = base.path.length > 1 ? base.path.at(-2).id : null;
        const siblings = parentId == null ? next.current.children : locate(next.current, parentId)?.node.children ?? next.current.children;
        const previous = base.index > 0 ? base.siblings[base.index - 1].id : null;
        const position = previous ? siblings.findIndex(node => node.id === previous) + 1 : 0;
        siblings.splice(position, 0, original);
    }, at);
}
export function resetProfile(profile, { at = new Date().toISOString() } = {}) {
    return edit(profile, '全部恢复为初始版本', next => { next.current = copy(next.baseline); }, at);
}
export function setOptions(profile, { replace, diff, propose, proposeMode, lock, panel, ask, fallback }) {
    const next = copy(profile);
    // 让 AI 改 remembers who rewrites and whether to write it into the story, per copy.
    if (ask !== undefined) next.ask = { by: String(ask.by ?? next.ask?.by ?? '').trim().slice(0, LIMITS.key), story: ask.story ?? next.ask?.story ?? true };
    if (panel !== undefined) {
        const editors = (panel.editors ?? next.panel?.editors ?? []).map(editor => ({ name: String(editor.name ?? '').trim(), sections: [...new Set(editor.sections ?? [])].filter(id => next.current.children.some(node => node.id === id)) }));
        if (editors.some(editor => !editor.name)) fail('改写者需要名字。');
        const pick = (field, fallback) => panel[field] ?? next.panel?.[field] ?? fallback;
        next.panel = { on: pick('on', false), editors, method: pick('method', 'story'), methodText: String(pick('methodText', '')).replace(/\s*\n\s*/g, ' ').trim().slice(0, PANEL_LIMITS.method), aware: pick('aware', 'story') };
    }
    if (propose !== undefined) next.propose = !!propose;
    if (proposeMode !== undefined) { if (!PROPOSE_MODES.includes(proposeMode)) fail('建议方式无效。'); next.proposeMode = proposeMode; }
    if (lock) {
        if (!locate(next.current, lock.id)) fail('分组不存在。');
        const set = new Set(next.locked ?? []);
        if (lock.on) set.add(lock.id); else set.delete(lock.id);
        next.locked = [...set];
    }
    if (replace !== undefined) next.replace = !!replace;
    // World-info copies only: send the copy on its own when the book did not send the entry.
    if (fallback !== undefined) next.fallback = !!fallback;
    if (diff !== undefined) { if (!DIFF_MODES.includes(diff)) fail('对照格式无效。'); next.diff = diff; }
    return validateProfile(next);
}

// ---- comparison with the baseline ----
const same = (a, b) => a.kind === b.kind && a.key === b.key && a.value === b.value && a.star === b.star;
/** Changes by node id: modified fields/text, renamed groups, added and removed subtrees (top-most only). */
export function diffProfile(profile) {
    const base = indexById(profile.baseline), now = indexById(profile.current), changes = [];
    for (const [id, { node, path }] of now) {
        const old = base.get(id);
        if (!old) { if (path.length === 1 || base.has(path.at(-2).id)) changes.push({ type: 'added', id, node, path }); continue; }
        if (!same(old.node, node)) changes.push({ type: 'changed', id, node, before: old.node, path });
    }
    for (const [id, { node, path }] of base) {
        if (now.has(id)) continue;
        const parent = path.at(-2);
        if (!parent || now.has(parent.id)) changes.push({ type: 'removed', id, node, path });
    }
    return changes;
}
export const isChanged = profile => diffProfile(profile).length > 0;

const quote = text => `「${text}」`;
const shown = node => node.kind === 'group' ? '（分组）' : quote(node.value);
function summaryLine(change) {
    const where = pathLabel(change.path);
    if (change.type === 'added') return `- 新增 ${where}：${shown(change.node)}`;
    if (change.type === 'removed') return `- 删除 ${where}：初始${shown(change.node)}`;
    if (change.node.kind === 'group') return `- 改名 ${pathLabel(change.path.slice(0, -1).concat([change.before]))} → ${change.node.key}`;
    const renamed = change.before.key !== change.node.key ? `（原键名“${change.before.key}”）` : '';
    return `- 修改 ${where}${renamed}：初始${quote(change.before.value)} → 当前${quote(change.node.value)}`;
}
/** The text sent instead of the card description: current tree plus the chosen comparison. */
export function renderForPrompt(profile) {
    const changes = profile.diff === 'off' ? [] : diffProfile(profile);
    if (profile.diff === 'inline') {
        const changed = new Map(changes.filter(change => change.type === 'changed' && change.node.kind !== 'group').map(change => [change.id, change]));
        const added = new Set(changes.filter(change => change.type === 'added').map(change => change.id));
        const body = writeCard(profile.current, { annotate: node => changed.has(node.id) ? `（初始：${changed.get(node.id).before.value}）` : added.has(node.id) ? '（剧情中新增）' : '' });
        const rest = changes.filter(change => change.type === 'removed' || change.type === 'changed' && change.node.kind === 'group');
        return rest.length ? `${body}\n【与初始设定的差异：删除与改名】\n${rest.map(summaryLine).join('\n')}` : body;
    }
    const body = writeCard(profile.current);
    return changes.length ? `${body}\n【与初始设定的差异（以上为当前设定）】\n${changes.map(summaryLine).join('\n')}` : body;
}
