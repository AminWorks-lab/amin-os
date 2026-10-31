import { getSharedCardProfileService } from './service.js';
import { diffProfile, pathLabel, DIFF_MODES } from './model.js';
import { describe } from './proposals.js';
import { contextLine } from '../shared/context-line.js';

const node = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
const DIFF_LABELS = { summary: '末尾汇总差异', inline: '改动处行内标注', off: '不附对照' };

export function mount(target, { service } = {}) {
    const api = service ?? getSharedCardProfileService();
    const page = node('div', null, 'amin-page amin-app-page amin-cardprofile');
    const intro = node('div', null, 'amin-context'), notice = node('div', null, 'amin-notice'), body = node('section', null, 'amin-stack');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    page.append(intro, notice, body); target.append(page);

    let avatar = '', query = '', onlyChanged = false, editing = null, previewed = null, busy = false;
    const opened = new Set(), say = (text, state = '') => { notice.textContent = text; notice.dataset.state = state; };
    const button = (parent, text, fn, cls = '') => {
        const b = node('button', text, cls); b.type = 'button';
        b.onclick = async event => {
            event.stopPropagation(); if (busy) return;
            busy = true; b.disabled = true;
            try { await fn(); } catch (error) { say(error.message, 'error'); } finally { busy = false; b.disabled = false; }
        };
        parent.append(b); return b;
    };
    const toolbar = parent => { const t = node('div', null, 'amin-toolbar'); parent.append(t); return t; };
    const card = (title, parent = body) => { const c = node('section', null, 'amin-card amin-stack'); if (title) c.append(node('h3', title, 'amin-section-heading')); parent.append(c); return c; };
    const marked = (text, cls) => {
        const span = node('span', null, cls), q = query.trim().toLowerCase();
        if (!q) { span.textContent = text; return span; }
        let rest = text, at;
        while (rest && (at = rest.toLowerCase().indexOf(q)) >= 0) { span.append(rest.slice(0, at), node('mark', rest.slice(at, at + q.length))); rest = rest.slice(at + q.length); }
        span.append(rest); return span;
    };

    function render() {
        const focusSearch = document.activeElement?.dataset?.cardprofileSearch === '1', caret = document.activeElement?.selectionStart;
        body.replaceChildren();
        let entries;
        try { entries = api.snapshot(); intro.textContent = contextLine(globalThis.SillyTavern?.getContext?.(), '本聊天的角色设定副本'); }
        catch (error) { intro.textContent = '角色卡资料'; body.append(node('p', error.message, 'amin-empty')); return; }
        if (!entries.length) { body.append(node('p', '当前聊天没有角色卡。打开一个角色或群聊后再使用。', 'amin-empty')); return; }
        if (!entries.some(entry => entry.avatar === avatar)) avatar = (entries.find(entry => entry.profile) ?? entries[0]).avatar;
        if (entries.length > 1) {
            const row = node('label', '角色', 'amin-field'), select = node('select');
            for (const entry of entries) { const option = node('option', entry.name + (entry.profile ? '' : '（未导入）')); option.value = entry.avatar; select.append(option); }
            select.value = avatar; select.onchange = () => { avatar = select.value; editing = null; previewed = null; render(); };
            row.append(select); body.append(row);
        }
        const entry = entries.find(item => item.avatar === avatar);
        if (!entry.profile) return importPage(entry);
        profilePage(entry);
        if (focusSearch) { const input = body.querySelector('[data-cardprofile-search="1"]'); input?.focus(); if (input && Number.isInteger(caret)) input.setSelectionRange(caret, caret); }
    }

    function importPage(entry) {
        const intro = card(entry.name);
        intro.append(node('p', '把角色卡描述里“名字=[ 分区:[ *键: 值 ] ]”格式的设定导入为本聊天的副本。角色卡本身不会被修改；导入后，发送时会用副本的当前版本替换角色描述。', 'amin-meta'));
        if (!entry.description.trim()) { intro.append(node('p', '这张卡的描述为空。', 'amin-empty')); return; }
        const actions = toolbar(intro);
        button(actions, '预览导入', () => { previewed = api.preview(entry.avatar); say(''); render(); }, previewed ? '' : 'amin-primary');
        if (!previewed) return;
        let groups = 0, fields = 0;
        const count = nodes => { for (const item of nodes) { if (item.kind === 'group') { groups++; count(item.children); } else fields++; } };
        count(previewed.current.children);
        intro.append(node('p', `识别到 ${previewed.current.children.length} 个分区、${groups} 个分组、${fields} 个条目。`));
        const list = node('ul', null, 'amin-cardprofile-sections');
        for (const item of previewed.current.children) list.append(node('li', item.kind === 'group' ? item.key : (item.key ?? item.value)));
        intro.append(list);
        button(toolbar(intro), '确认导入', async () => { await api.importCard(entry.avatar); previewed = null; say('已导入，发送时将使用本聊天的副本。'); render(); }, 'amin-primary');
    }

    function profilePage(entry) {
        const profile = entry.profile, changes = diffProfile(profile);
        const byId = new Map(changes.map(change => [change.id, change]));
        const touched = new Set();
        for (const change of changes) for (const step of change.path.slice(0, change.type === 'removed' ? -1 : undefined)) touched.add(step.id);

        if (entry.cardChanged) {
            const warn = card('角色卡描述已修改');
            warn.dataset.state = 'warning';
            warn.append(node('p', '角色卡的描述在导入后被改过。当前仍按本聊天的副本发送；可以保留副本，或按新卡重新导入（副本里的改动会丢失）。', 'amin-meta'));
            const actions = toolbar(warn);
            button(actions, '保留当前副本', async () => { await api.keepCopy(entry.avatar); say('已保留副本。'); render(); });
            button(actions, '按新卡重新导入', async () => {
                if (!globalThis.confirm?.('按新卡重新导入会丢弃本聊天副本里的全部改动，确定吗？')) return;
                await api.reimport(entry.avatar); say('已按新卡重新导入。'); render();
            }, 'amin-danger');
        }

        const settings = card(null);
        const top = node('div', null, 'amin-cardprofile-settings');
        const replace = node('label', null, 'amin-check'), box = node('input');
        box.type = 'checkbox'; box.checked = profile.replace;
        box.onchange = async () => { try { await api.options(entry.avatar, { replace: box.checked }); say(box.checked ? '发送时将替换角色描述。' : '已暂停替换，发送原角色卡描述。'); } catch (error) { say(error.message, 'error'); } render(); };
        replace.append(box, node('span', '发送时用副本替换角色描述'));
        const modeRow = node('label', '对照', 'amin-field'), mode = node('select');
        for (const value of DIFF_MODES) { const option = node('option', DIFF_LABELS[value]); option.value = value; mode.append(option); }
        mode.value = profile.diff;
        mode.onchange = async () => { try { await api.options(entry.avatar, { diff: mode.value }); } catch (error) { say(error.message, 'error'); } render(); };
        const propose = node('label', null, 'amin-check'), proposeBox = node('input');
        proposeBox.type = 'checkbox'; proposeBox.checked = profile.propose;
        proposeBox.onchange = async () => { try { await api.options(entry.avatar, { propose: proposeBox.checked }); say(proposeBox.checked ? 'AI 会在设定变化时提议修改，建议显示在对应回复下面。' : '已关闭 AI 提议。'); } catch (error) { say(error.message, 'error'); } render(); };
        propose.append(proposeBox, node('span', '让 AI 按剧情提议修改（在回复下审核）'));
        modeRow.append(mode); top.append(replace, propose, modeRow); settings.append(top);
        const result = entry.result;
        settings.append(node('p', [
            changes.length ? `与初始版本相比有 ${changes.length} 处改动` : '与初始版本相同',
            !profile.replace ? '替换已暂停' : !result ? '本次打开后还没有发送过' : result.matched ? '最近一次发送已替换' : '最近一次发送没找到角色描述，按原卡发送（可能是预设用别的方式引用了描述）',
        ].join(' · '), result && !result.matched && profile.replace ? 'amin-meta amin-cardprofile-miss' : 'amin-meta'));

        let pending = [];
        try { pending = api.pending().filter(item => item.avatar === entry.avatar); } catch {}
        const count = pending.reduce((sum, item) => sum + item.items.filter(value => value.status === 'pending').length, 0);
        if (count) {
            const box = card(`待审核的 AI 建议 · ${count}`);
            box.append(node('p', '也可以在对应回复下面直接采纳或忽略。', 'amin-meta'));
            const list = node('ul', null, 'amin-cardprofile-proposals');
            for (const proposal of pending) for (const item of proposal.items) {
                if (item.status !== 'pending') continue;
                const text = describe(item), li = node('li', null, 'amin-cardprofile-proposal');
                li.dataset.status = 'pending';
                li.append(node('strong', `第 ${proposal.index + 1} 楼 · ${text.title}`));
                if (text.before) li.append(node('div', `当前：${text.before}`, 'amin-cardprofile-proposal-before'));
                if (text.after) li.append(node('div', `${item.op === 'set' ? '改为' : '内容'}：${text.after}`, 'amin-cardprofile-proposal-after'));
                if (item.reason) li.append(node('div', `依据：${item.reason}`, 'amin-cardprofile-proposal-reason'));
                const actions = toolbar(li);
                button(actions, '采纳', async () => { await api.accept(proposal.id, [item.id]); render(); }, 'amin-primary');
                button(actions, '忽略', async () => { await api.ignore(proposal.id, [item.id]); render(); });
                list.append(li);
            }
            box.append(list);
        }

        const tools = toolbar(body);
        const searchRow = node('label', null, 'amin-field amin-cardprofile-search'), search = node('input');
        search.type = 'search'; search.placeholder = '搜索键名或内容'; search.value = query; search.dataset.cardprofileSearch = '1'; search.setAttribute('aria-label', '搜索角色资料');
        search.oninput = event => { query = search.value; if (!event.isComposing) render(); };
        search.addEventListener('compositionend', () => { query = search.value; render(); });
        searchRow.append(search); tools.append(searchRow);
        button(tools, onlyChanged ? '显示全部' : '只看改动', () => { onlyChanged = !onlyChanged; render(); });
        button(tools, '全部折叠', () => { opened.clear(); render(); });

        const q = query.trim().toLowerCase();
        const hit = item => !q || [item.key, item.value].some(text => typeof text === 'string' && text.toLowerCase().includes(q));
        const visible = item => {
            if (onlyChanged && !byId.has(item.id) && !touched.has(item.id)) return false;
            if (hit(item)) return true;
            return item.kind === 'group' && item.children.some(visible);
        };
        const tree = node('div', null, 'amin-cardprofile-tree');
        const draw = (nodes, parent, parentId) => {
            let shown = 0;
            for (const [index, item] of nodes.entries()) {
                if (!visible(item)) continue;
                shown++;
                if (item.kind === 'group') parent.append(group(entry, item, byId, touched, nodes.length, index, parentId, draw));
                else parent.append(leaf(entry, item, byId.get(item.id), nodes.length, index));
            }
            return shown;
        };
        if (!draw(profile.current.children, tree, null)) tree.append(node('p', q ? '没有匹配的条目。' : onlyChanged ? '还没有改动。' : '副本是空的。', 'amin-empty'));
        body.append(tree);
        button(toolbar(body), '新增分区', async () => { const id = await api.add(entry.avatar, null, { kind: 'group', key: '新分区', star: false }); opened.add(id); editing = id; render(); });

        const removed = changes.filter(change => change.type === 'removed');
        if (removed.length) {
            const lost = card(`已删除的初始条目 · ${removed.length}`);
            for (const change of removed) {
                const row = node('div', null, 'amin-cardprofile-removed');
                row.append(node('span', pathLabel(change.path)));
                button(row, '恢复', async () => { await api.restore(entry.avatar, change.id); render(); });
                lost.append(row);
            }
        }

        const extra = card(null);
        const preview = node('details'); preview.append(node('summary', '预览发送内容'));
        preview.ontoggle = () => { if (preview.open && preview.childElementCount === 1) { const pre = node('pre', api.rendered(entry.avatar), 'amin-cardprofile-preview'); preview.append(pre); } };
        const history = node('details'); history.append(node('summary', `修改记录 · ${profile.history.length}`));
        const log = node('ol', null, 'amin-cardprofile-history');
        for (const item of [...profile.history].reverse().slice(0, 100)) log.append(node('li', `${new Date(item.at).toLocaleString()} · ${item.label}`));
        history.append(log);
        extra.append(preview, history);
        const danger = toolbar(extra);
        button(danger, '全部恢复为初始版本', async () => { if (!globalThis.confirm?.('把这个角色的副本全部恢复为导入时的版本吗？')) return; await api.reset(entry.avatar); render(); });
        button(danger, '删除副本', async () => { if (!globalThis.confirm?.('删除后恢复为直接发送原角色卡描述，副本和修改记录都会删除。确定吗？')) return; await api.remove(entry.avatar); render(); }, 'amin-danger');
    }

    function moveButtons(parent, entry, item, total, index) {
        if (index > 0) button(parent, '上移', async () => { await api.move(entry.avatar, item.id, -1); render(); });
        if (index < total - 1) button(parent, '下移', async () => { await api.move(entry.avatar, item.id, 1); render(); });
    }
    const badge = (change, inside) => change ? node('span', change.type === 'added' ? '新增' : '已改', 'amin-cardprofile-badge') : inside ? node('span', '内有改动', 'amin-cardprofile-badge amin-cardprofile-badge-soft') : null;

    function group(entry, item, byId, touched, total, index, parentId, draw) {
        const details = node('details', null, 'amin-cardprofile-group');
        details.open = opened.has(item.id) || !!query.trim();
        details.ontoggle = () => { if (details.open) opened.add(item.id); else opened.delete(item.id); };
        const summary = node('summary');
        summary.append(marked((item.star ? '*' : '') + item.key, 'amin-cardprofile-key'));
        const mark = badge(byId.get(item.id), touched.has(item.id)); if (mark) summary.append(mark);
        if ((entry.profile.locked ?? []).includes(item.id)) summary.append(node('span', '🔒 AI 不改', 'amin-cardprofile-lock'));
        details.append(summary);
        if (editing === item.id) details.append(editor(entry, item, byId.get(item.id), total, index));
        const children = node('div', null, 'amin-cardprofile-children');
        draw(item.children, children, item.id);
        details.append(children);
        if (editing !== item.id) {
            const edit = button(summary, '编辑', () => { editing = item.id; opened.add(item.id); render(); }, 'amin-cardprofile-mini');
            edit.setAttribute('aria-label', `编辑分组 ${item.key}`);
            edit.addEventListener('click', event => event.preventDefault());
        }
        return details;
    }

    function leaf(entry, item, change, total, index) {
        if (editing === item.id) return editor(entry, item, change, total, index);
        const row = node('div', null, 'amin-cardprofile-leaf');
        row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', `编辑 ${item.key ?? item.value}`);
        const open = () => { editing = item.id; render(); };
        row.onclick = open; row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
        if (item.kind === 'field') row.append(marked((item.star ? '*' : '') + item.key, 'amin-cardprofile-key'), marked(item.value || '（空）', 'amin-cardprofile-value'));
        else row.append(marked((item.star ? '*' : '') + item.value, 'amin-cardprofile-value amin-cardprofile-text'));
        const mark = badge(change, false); if (mark) row.append(mark);
        if (change?.type === 'changed' && change.before.value !== undefined && change.before.value !== item.value) row.append(node('span', `初始：${change.before.value}`, 'amin-cardprofile-before'));
        return row;
    }

    function editor(entry, item, change, total, index) {
        const box = node('div', null, 'amin-cardprofile-editor amin-stack');
        let key, value;
        if (item.kind !== 'text') {
            const row = node('label', item.kind === 'group' ? '分组名' : '键名', 'amin-field'); key = node('input'); key.value = item.key; row.append(key); box.append(row);
        }
        if (item.kind !== 'group') {
            const row = node('label', '内容', 'amin-field'); value = node('textarea'); value.rows = Math.min(8, Math.max(2, Math.ceil(item.value.length / 40))); value.value = item.value; row.append(value); box.append(row);
            value.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) save.click(); };
        }
        const starRow = node('label', null, 'amin-check'), star = node('input'); star.type = 'checkbox'; star.checked = item.star; starRow.append(star, node('span', '带 * 号')); box.append(starRow);
        if (item.kind === 'group') {
            const lockRow = node('label', null, 'amin-check'), lock = node('input'); lock.type = 'checkbox'; lock.checked = (entry.profile.locked ?? []).includes(item.id);
            lock.onchange = async () => { try { await api.options(entry.avatar, { lock: { id: item.id, on: lock.checked } }); say(lock.checked ? `已锁定“${item.key}”，AI 不会提议修改。` : `已解除锁定“${item.key}”。`); } catch (error) { say(error.message, 'error'); lock.checked = !lock.checked; } };
            lockRow.append(lock, node('span', '锁定：AI 不提议修改这个分组')); box.append(lockRow);
        }
        if (change?.type === 'changed' && change.before.kind !== 'group') box.append(node('p', `初始：${change.before.key ? change.before.key + '：' : ''}${change.before.value}`, 'amin-meta'));
        const actions = toolbar(box);
        const save = button(actions, '保存', async () => {
            await api.set(entry.avatar, item.id, { ...(key ? { key: key.value } : {}), ...(value ? { value: value.value } : {}), star: star.checked });
            editing = null; say('已保存。'); render();
        }, 'amin-primary');
        button(actions, '取消', () => { editing = null; render(); });
        if (item.kind === 'group') {
            button(actions, '新增条目', async () => { const id = await api.add(entry.avatar, item.id, { kind: 'field', key: '新条目', star: true }); opened.add(item.id); editing = id; render(); });
            button(actions, '新增分组', async () => { const id = await api.add(entry.avatar, item.id, { kind: 'group', key: '新分组', star: true }); opened.add(item.id); opened.add(id); editing = id; render(); });
        }
        moveButtons(actions, entry, item, total, index);
        if (change?.type !== 'added') button(actions, '恢复初始', async () => { await api.restore(entry.avatar, item.id); editing = null; render(); });
        button(actions, '删除', async () => {
            if (item.kind === 'group' && item.children.length && !globalThis.confirm?.(`删除“${item.key}”及其中 ${item.children.length} 项吗？`)) return;
            await api.removeNode(entry.avatar, item.id); editing = null; render();
        }, 'amin-danger');
        queueMicrotask(() => (value ?? key)?.focus());
        return box;
    }

    const unsubscribe = api.subscribe(() => { if (!editing) render(); });
    render();
    return {
        open() { if (!editing) render(); },
        dispose() { unsubscribe(); page.remove(); },
    };
}
