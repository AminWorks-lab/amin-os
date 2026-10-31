// Per-chat living copies of character-card descriptions written in the bracket template.
// The card keeps the original; the chat keeps {baseline, current} trees and a change log.
import { parseCard, writeCard } from './format.js';

export const KEY = 'amin_os_card_profile_v1';
export const DIFF_MODES = Object.freeze(['summary', 'inline', 'off']);
export const LIMITS = Object.freeze({ profiles: 50, nodes: 5000, history: 500, key: 80, value: 20000 });
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(Error(message), { code: 'CARD_PROFILE_INVALID' }); };

export const emptyStore = () => ({ version: 1, profiles: {} });

export function validateNode(node, ids) {
    if (!object(node) || typeof node.id !== 'string' || !node.id || ids.has(node.id)) fail('角色资料条目编号无效或重复。');
    ids.add(node.id);
    if (!['group', 'field', 'text'].includes(node.kind) || typeof node.star !== 'boolean') fail('角色资料条目类型无效。');
    if (node.sep !== undefined && (typeof node.sep !== 'string' || !/^\s*[:：]\s*$/.test(node.sep))) fail('角色资料分隔符无效。');
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
    return ids;
}
export function validateProfile(profile) {
    if (!object(profile) || typeof profile.avatar !== 'string' || !profile.avatar || typeof profile.cardName !== 'string') fail('角色资料来源无效。');
    if (typeof profile.sourceHash !== 'string' || typeof profile.importedAt !== 'string' || !Number.isInteger(profile.nextId) || profile.nextId < 1) fail('角色资料来源无效。');
    if (typeof profile.replace !== 'boolean' || !DIFF_MODES.includes(profile.diff)) fail('角色资料发送设置无效。');
    validateTree(profile.baseline); validateTree(profile.current);
    if (!Array.isArray(profile.history) || profile.history.length > LIMITS.history) fail('角色资料修改记录无效。');
    for (const entry of profile.history) if (!object(entry) || typeof entry.at !== 'string' || typeof entry.label !== 'string') fail('角色资料修改记录无效。');
    return profile;
}
export function validateStore(store) {
    if (!object(store) || store.version !== 1 || !object(store.profiles)) fail('角色资料存储格式无效。');
    if (Object.keys(store.profiles).length > LIMITS.profiles) fail('角色资料数量超过上限。');
    for (const [avatar, profile] of Object.entries(store.profiles)) { validateProfile(profile); if (profile.avatar !== avatar) fail('角色资料归属不一致。'); }
    return store;
}

/** Create a profile from a card description. Throws a parse error with its line number. */
export function createProfile({ avatar, cardName = '', description, hash, at = new Date().toISOString() }) {
    let next = 1;
    const tree = parseCard(description, () => `n${next++}`);
    const profile = { avatar, cardName, sourceHash: hash, importedAt: at, nextId: next, replace: true, diff: 'summary', baseline: tree, current: copy(tree), history: [] };
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
function edit(profile, labelText, change, at) {
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
export function setOptions(profile, { replace, diff }) {
    const next = copy(profile);
    if (replace !== undefined) next.replace = !!replace;
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
