import { getSharedCardProfileService } from './service.js';
import { diffProfile, pathLabel, locate, DIFF_MODES, USER_TOKEN, NOTE_KINDS } from './model.js';
import { describe, storyLine } from './proposals.js';
import { contextLine } from '../shared/context-line.js';

const node = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
const DIFF_LABELS = { summary: '末尾汇总差异', inline: '改动处行内标注', off: '不附对照' };

export function mount(target, { service } = {}) {
    const api = service ?? getSharedCardProfileService();
    const page = node('div', null, 'amin-page amin-app-page amin-cardprofile');
    const intro = node('div', null, 'amin-context'), notice = node('div', null, 'amin-notice'), body = node('section', null, 'amin-stack');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    page.append(intro, notice, body); target.append(page);

    let avatar = '', layout = {}, asks = {}, draft = null, generating = null, worlds = null, picks = new Set(), query = '', onlyChanged = false, editing = null, previewed = null, busy = false;
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
        if (!entries.some(entry => entry.key === avatar)) avatar = (entries.find(entry => entry.profile) ?? entries[0]).key;
        if (entries.length > 1) {
            const row = node('label', '角色', 'amin-field'), select = node('select');
            for (const entry of entries) { const option = node('option', entry.name + (entry.kind === 'world' ? `（世界书：${entry.book}）` : entry.kind === 'note' ? `（${NOTE_KINDS[entry.noteKind]}）` : entry.profile ? '' : '（未导入）')); option.value = entry.key; select.append(option); }
            select.value = avatar; select.onchange = () => { avatar = select.value; editing = null; previewed = null; render(); };
            row.append(select); body.append(row);
        }
        const entry = entries.find(item => item.key === avatar);
        if (!entry.profile) importPage(entry); else profilePage(entry);
        notePanel();
        worldPanel();
        if (focusSearch) { const input = body.querySelector('[data-cardprofile-search="1"]'); input?.focus(); if (input && Number.isInteger(caret)) input.setSelectionRange(caret, caret); }
    }

    function importPage(entry) {
        const intro = card(entry.name);
        intro.append(node('p', '把角色卡描述里“名字=[ 分区:[ *键: 值 ] ]”格式的设定导入为本聊天的副本。角色卡本身不会被修改；导入后，发送时会用副本的当前版本替换角色描述。多人卡的角色设定在世界书里时，用下面的“从世界书导入”。', 'amin-meta'));
        if (!entry.description.trim()) { intro.append(node('p', '这张卡的描述为空。', 'amin-empty')); return; }
        const actions = toolbar(intro);
        button(actions, '预览导入', () => { previewed = api.preview(entry.key); say(''); render(); }, previewed ? '' : 'amin-primary');
        if (!previewed) return;
        let groups = 0, fields = 0;
        const count = nodes => { for (const item of nodes) { if (item.kind === 'group') { groups++; count(item.children); } else fields++; } };
        count(previewed.current.children);
        intro.append(node('p', `识别到 ${previewed.current.children.length} 个分区、${groups} 个分组、${fields} 个条目。`));
        const list = node('ul', null, 'amin-cardprofile-sections');
        for (const item of previewed.current.children) list.append(node('li', item.kind === 'group' ? item.key : (item.key ?? item.value)));
        intro.append(list);
        button(toolbar(intro), '确认导入', async () => { await api.importCard(entry.key); previewed = null; say('已导入，发送时将使用本聊天的副本。'); render(); }, 'amin-primary');
    }

    // 让 AI 改: describe a change, review the AI's items, apply the chosen ones (optionally as a story event).
    function askPanel(entry) {
        const state = asks[entry.key] ??= { request: '', by: '', story: true, items: null, running: null };
        const panel = card('让 AI 改');
        const askRow = node('label', '要怎么改', 'amin-field'), ask = node('textarea');
        ask.rows = 2; ask.value = state.request; ask.placeholder = '例如：经过这次冒险，她对主角的态度变得亲近，相关的关系和性格条目都更新一下';
        ask.oninput = () => { state.request = ask.value; };
        askRow.append(ask); panel.append(askRow);
        const byRow = node('label', '由谁改写', 'amin-field'), by = node('select');
        for (const [value, text] of [['', '不指定（只是修改资料）'], ...actorNames(entry).map(name => [name, name])]) { const option = node('option', text); option.value = value; by.append(option); }
        by.value = state.by; by.onchange = () => { state.by = by.value; render(); };
        byRow.append(by); panel.append(byRow);
        if (state.by) {
            const storyRow = node('label', null, 'amin-check'), story = node('input'); story.type = 'checkbox'; story.checked = state.story;
            story.onchange = () => { state.story = story.checked; };
            storyRow.append(story, node('span', '采纳后把改写写入聊天输入框（不自动发送）')); panel.append(storyRow);
        }
        const actions = toolbar(panel);
        if (state.running) button(actions, '取消', () => state.running.abort());
        else button(actions, state.items ? '重新让 AI 改' : '让 AI 改', () => {
            const run = state.running = new AbortController(); state.items = null; say('AI 正在修改…'); render();
            api.askEdits(entry.key, { request: state.request, by: state.by }, { signal: run.signal })
                .then(items => { state.items = items; say(items.some(item => item.status === 'pending') ? '检查下面的修改，采纳后才会写入。' : 'AI 给出的修改都无法应用，看看原因后重试。', items.some(item => item.status === 'pending') ? '' : 'error'); },
                    error => say(run.signal.aborted ? '已取消。' : error.message, run.signal.aborted ? '' : 'error'))
                .finally(() => { if (state.running === run) state.running = null; render(); });
        }, 'amin-primary');
        if (!state.items) return;
        const list = node('ul', null, 'amin-cardprofile-proposals');
        const chosen = new Set(state.items.filter(item => item.status === 'pending').map(item => item.id));
        for (const item of state.items) {
            const text = describe(item), li = node('li', null, 'amin-cardprofile-proposal');
            li.dataset.status = item.status;
            const head = node('label', null, 'amin-check');
            if (item.status === 'pending') { const check = node('input'); check.type = 'checkbox'; check.checked = true; check.onchange = () => { if (check.checked) chosen.add(item.id); else chosen.delete(item.id); }; head.append(check); }
            head.append(node('strong', text.title)); li.append(head);
            if (text.before) li.append(node('div', `当前：${text.before}`, 'amin-cardprofile-proposal-before'));
            if (text.after) li.append(node('div', `${item.op === 'set' ? '改为' : '内容'}：${text.after}`, 'amin-cardprofile-proposal-after'));
            if (item.reason) li.append(node('div', `说明：${item.reason}`, 'amin-cardprofile-proposal-reason'));
            if (item.status === 'invalid') li.append(node('div', `无法应用：${item.error}`, 'amin-turn-error'));
            list.append(li);
        }
        panel.append(list);
        const finish = toolbar(panel);
        if (chosen.size) button(finish, '采纳勾选的修改', async () => {
            const picked = state.items.filter(item => chosen.has(item.id));
            if (!picked.length) { say('没有勾选任何修改。', 'error'); return; }
            const done = await api.applyEdits(entry.key, picked);
            let told = '';
            if (state.by && state.story && done.length) {
                const lines = done.map(item => storyLine({ by: state.by, target: entry.profile.current.name, path: item.op === 'add' ? [...item.names, item.key] : item.names, before: item.op === 'set' ? item.before : undefined, after: item.op === 'add' && item.items ? item.items.map(child => `${child.key}：${child.value}`).join('；') : item.value, op: item.op }));
                told = appendStory(lines.join('\n')) ? '，改写已追加到聊天输入框' : `。聊天输入框不可用，可以手动发送：${lines.join(' ')}`;
            }
            const failed = picked.length - done.length;
            state.items = null; state.request = '';
            say(`已应用 ${done.length} 项${failed ? `，${failed} 项无法应用` : ''}${told}。`); render();
        }, 'amin-primary');
        button(finish, '放弃', () => { state.items = null; say(''); render(); });
    }

    // 世界资料 / 角色资料 created here: paste a template or let the AI draft one, check it, create.
    function notePanel() {
        const panel = card('新建资料（世界 / 角色）');
        panel.append(node('p', '没有现成模板时，在这里新建一份“名字=[ … ]”格式的资料：可以自己粘贴，也可以让 AI 从角色卡、世界书和最近的聊天整理。新建的资料发送时作为额外设定附上，同样可以编辑、让 AI 按剧情修改，也能开启面板玩法（世界资料就是世界面板）。', 'amin-meta'));
        if (!draft) { button(toolbar(panel), '新建资料', () => { draft = { kind: 'world', name: '', request: '', text: '', use: { cards: true, worldbooks: true, chat: true } }; render(); }); return; }
        const kindRow = node('label', '类型', 'amin-field'), kind = node('select');
        for (const [value, text] of Object.entries(NOTE_KINDS)) { const option = node('option', text); option.value = value; kind.append(option); }
        kind.value = draft.kind; kind.onchange = () => { draft.kind = kind.value; };
        kindRow.append(kind);
        const nameRow = node('label', '名字（可空，AI 会自己取）', 'amin-field'), name = node('input'); name.value = draft.name; name.oninput = () => { draft.name = name.value; }; nameRow.append(name);
        const askRow = node('label', '给 AI 的要求（可空）', 'amin-field'), ask = node('textarea'); ask.rows = 2; ask.value = draft.request; ask.placeholder = '例如：重点整理魔法体系和各国关系；允许补充资料没写的细节'; ask.oninput = () => { draft.request = ask.value; }; askRow.append(ask);
        const use = node('div', null, 'amin-cardprofile-scope');
        for (const [key, text] of [['cards', '角色卡'], ['worldbooks', '世界书'], ['chat', '最近 30 楼聊天']]) {
            const row = node('label', null, 'amin-check'), check = node('input'); check.type = 'checkbox'; check.checked = draft.use[key] !== false;
            check.onchange = () => { draft.use[key] = check.checked; }; row.append(check, node('span', text)); use.append(row);
        }
        panel.append(kindRow, nameRow, askRow, node('span', 'AI 参考的资料', 'amin-meta'), use);
        const actions = toolbar(panel);
        if (generating) button(actions, '取消生成', () => { generating.abort(); });
        else button(actions, draft.text ? '让 AI 重新生成' : '让 AI 生成', () => {
            // Not awaited: the button helper blocks other buttons while it runs, and 取消生成 must stay usable.
            const run = generating = new AbortController(), target = draft; say('AI 正在整理资料…'); render();
            api.generateNote({ kind: target.kind, name: target.name, request: target.request, use: target.use }, { signal: run.signal })
                .then(text => { target.text = text; say('已生成，检查后点“创建”。可以直接修改下面的文本。'); }, error => say(run.signal.aborted ? '已取消生成。' : error.message, run.signal.aborted ? '' : 'error'))
                .finally(() => { if (generating === run) generating = null; render(); });
        }, draft.text ? '' : 'amin-primary');
        const textRow = node('label', '模板（可以直接粘贴或修改）', 'amin-field'), text = node('textarea');
        text.rows = 12; text.value = draft.text; text.placeholder = '世界名=[\n世界概况:[\n*时代: …\n]\n]'; text.oninput = () => { draft.text = text.value; };
        textRow.append(text); panel.append(textRow);
        const finish = toolbar(panel);
        button(finish, '创建', async () => {
            const key = await api.createNote({ kind: draft.kind, text: draft.text });
            avatar = key; layout[key] = 'panel'; draft = null; say('已创建。'); render();
        }, 'amin-primary');
        button(finish, '取消', () => { generating?.abort(); draft = null; render(); });
    }

    // Multi-character cards keep each character in a world-info entry: one copy per entry,
    // swapped in for the entry's text when it is sent. The entries themselves stay as they are.
    function worldPanel() {
        const panel = card('从世界书导入（多人卡）');
        panel.append(node('p', '多人卡把每个角色的设定放在世界书条目里时，在这里勾选条目，每个条目各生成一份副本。世界书本身不改、条目保持启用；发送时在发送内容里找到条目原文，换成副本的当前版本。', 'amin-meta'));
        button(toolbar(panel), worlds ? '重新读取' : '读取世界书条目', async () => { worlds = await api.worldCandidates(); picks = new Set(); say(''); render(); }, worlds ? '' : 'amin-primary');
        if (!worlds) return;
        for (const text of worlds.failed) panel.append(node('p', `读取失败：${text}`, 'amin-meta amin-cardprofile-miss'));
        if (!worlds.entries.length) { panel.append(node('p', '本聊天用到的世界书里没有“名字=[ … ]”格式的条目。', 'amin-empty')); return; }
        const list = node('div', null, 'amin-stack amin-cardprofile-world');
        for (const item of worlds.entries) {
            const id = `${item.book}#${item.uid}`, row = node('label', null, 'amin-check'), box = node('input');
            box.type = 'checkbox'; box.disabled = item.imported; box.checked = item.imported || picks.has(id);
            box.onchange = () => { if (box.checked) picks.add(id); else picks.delete(id); };
            const notes = [item.imported && '已导入', item.disabled && '条目未启用', !item.constant && !item.disabled && '非常驻：只在被触发的回合替换'].filter(Boolean);
            row.append(box, node('span', `${item.title || item.name}（${item.book}）${notes.length ? ' · ' + notes.join(' · ') : ''}`));
            list.append(row);
        }
        panel.append(list);
        button(toolbar(panel), '导入选中条目', async () => {
            const chosen = worlds.entries.filter(item => !item.imported && picks.has(`${item.book}#${item.uid}`));
            if (!chosen.length) { say('先勾选要导入的条目。', 'error'); return; }
            const keys = await api.importWorld(chosen);
            worlds = null; picks = new Set(); avatar = keys[0] ?? avatar;
            say(`已导入 ${keys.length} 个条目，可以在上面的“角色”里切换。`); render();
        }, 'amin-primary');
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
            button(actions, '保留当前副本', async () => { await api.keepCopy(entry.key); say('已保留副本。'); render(); });
            button(actions, '按新卡重新导入', async () => {
                if (!globalThis.confirm?.('按新卡重新导入会丢弃本聊天副本里的全部改动，确定吗？')) return;
                await api.reimport(entry.key); say('已按新卡重新导入。'); render();
            }, 'amin-danger');
        }

        const settings = card(null);
        const top = node('div', null, 'amin-cardprofile-settings');
        const replace = node('label', null, 'amin-check'), box = node('input');
        box.type = 'checkbox'; box.checked = profile.replace;
        box.onchange = async () => { try { await api.options(entry.key, { replace: box.checked }); say(entry.kind === 'note' ? (box.checked ? '发送时会附上这份资料。' : '已暂停发送这份资料。') : box.checked ? '发送时将用副本替换。' : entry.kind === 'world' ? '已暂停替换，发送世界书原文。' : '已暂停替换，发送原角色卡描述。'); } catch (error) { say(error.message, 'error'); } render(); };
        replace.append(box, node('span', entry.kind === 'note' ? '发送时附上这份资料' : entry.kind === 'world' ? '发送时用副本替换世界书条目原文' : '发送时用副本替换角色描述'));
        const modeRow = node('label', '对照', 'amin-field'), mode = node('select');
        for (const value of DIFF_MODES) { const option = node('option', DIFF_LABELS[value]); option.value = value; mode.append(option); }
        mode.value = profile.diff;
        mode.onchange = async () => { try { await api.options(entry.key, { diff: mode.value }); } catch (error) { say(error.message, 'error'); } render(); };
        const propose = node('label', 'AI 按剧情修改', 'amin-field'), proposeMode = node('select');
        for (const [value, text] of [['off', '关闭'], ['review', '先审核（在回复下采纳）'], ['auto', '自动应用（可在回复下撤销）']]) { const option = node('option', text); option.value = value; proposeMode.append(option); }
        proposeMode.value = profile.propose ? profile.proposeMode : 'off';
        proposeMode.onchange = async () => {
            const value = proposeMode.value;
            try { await api.options(entry.key, value === 'off' ? { propose: false } : { propose: true, proposeMode: value }); say({ off: '已关闭 AI 修改。', review: 'AI 的修改建议会显示在对应回复下面，采纳后才生效。', auto: 'AI 的修改会自动应用，在对应回复下面可以逐条撤销。' }[value]); }
            catch (error) { say(error.message, 'error'); }
            render();
        };
        propose.append(proposeMode);
        modeRow.append(mode); top.append(replace, propose, modeRow); settings.append(top);
        panelSettings(settings, entry);
        const result = entry.result;
        settings.append(node('p', [
            changes.length ? `与初始版本相比有 ${changes.length} 处改动` : '与初始版本相同',
            !profile.replace ? (entry.kind === 'note' ? '暂停发送' : '替换已暂停') : !result ? '本次打开后还没有发送过' : entry.kind === 'note' ? '最近一次发送已附上' : result.matched ? '最近一次发送已替换' : entry.kind === 'world' ? '最近一次发送没找到条目原文，按世界书原样发送（条目没激活，或导入后被改过）' : '最近一次发送没找到角色描述，按原卡发送（可能是预设用别的方式引用了描述）',
        ].join(' · '), result && !result.matched && profile.replace ? 'amin-meta amin-cardprofile-miss' : 'amin-meta'));

        askPanel(entry);

        let pending = [];
        try { pending = api.pending().filter(item => item.avatar === entry.key); } catch {}
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

        const view = layout[entry.key] ?? (profile.panel?.on ? 'panel' : 'tree');
        const switcher = toolbar(body);
        button(switcher, view === 'panel' ? '切换到编辑视图' : '切换到面板视图', () => { layout[entry.key] = view === 'panel' ? 'tree' : 'panel'; render(); });
        if (view === 'panel') { body.append(panelView(entry, byId, touched)); return; }
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
        button(toolbar(body), '新增分区', async () => { const id = await api.add(entry.key, null, { kind: 'group', key: '新分区', star: false }); opened.add(id); editing = id; render(); });

        const removed = changes.filter(change => change.type === 'removed');
        if (removed.length) {
            const lost = card(`已删除的初始条目 · ${removed.length}`);
            for (const change of removed) {
                const row = node('div', null, 'amin-cardprofile-removed');
                row.append(node('span', pathLabel(change.path)));
                button(row, '恢复', async () => { await api.restore(entry.key, change.id); render(); });
                lost.append(row);
            }
        }

        const extra = card(null);
        const preview = node('details'); preview.append(node('summary', '预览发送内容'));
        preview.ontoggle = () => { if (preview.open && preview.childElementCount === 1) { const pre = node('pre', api.rendered(entry.key), 'amin-cardprofile-preview'); preview.append(pre); } };
        const history = node('details'); history.append(node('summary', `修改记录 · ${profile.history.length}`));
        const log = node('ol', null, 'amin-cardprofile-history');
        for (const item of [...profile.history].reverse().slice(0, 100)) log.append(node('li', `${new Date(item.at).toLocaleString()} · ${item.label}`));
        history.append(log);
        extra.append(preview, history);
        const danger = toolbar(extra);
        button(danger, '全部恢复为初始版本', async () => { if (!globalThis.confirm?.('把这个角色的副本全部恢复为导入时的版本吗？')) return; await api.reset(entry.key); render(); });
        button(danger, '删除副本', async () => { if (!globalThis.confirm?.(entry.kind === 'note' ? '删除这份资料和它的修改记录吗？' : entry.kind === 'world' ? '删除后恢复为直接发送世界书条目原文，副本和修改记录都会删除。确定吗？' : '删除后恢复为直接发送原角色卡描述，副本和修改记录都会删除。确定吗？')) return; await api.remove(entry.key); render(); }, 'amin-danger');
    }

    const userName = () => globalThis.SillyTavern?.getContext?.()?.name1 || '用户';
    function panelSettings(parent, entry) {
        const profile = entry.profile, panel = profile.panel ?? { on: false, editors: [] };
        const row = node('label', null, 'amin-check'), box = node('input');
        box.type = 'checkbox'; box.checked = panel.on;
        box.onchange = async () => {
            try {
                const editors = panel.editors.length ? panel.editors : [{ name: USER_TOKEN, sections: [] }];
                await api.options(entry.key, { panel: { on: box.checked, editors }, ...(box.checked && !profile.propose ? { propose: true } : {}) });
                if (box.checked) layout[entry.key] = 'panel';
                say(box.checked ? '已开启角色面板玩法：剧情里有权限的人改写面板后，改动会按“AI 按剧情修改”的方式审核或自动应用。' : '已关闭角色面板玩法，恢复普通的角色资料。');
            } catch (error) { say(error.message, 'error'); }
            render();
        };
        row.append(box, node('span', entry.noteKind === 'world' ? '世界面板玩法：剧情里有人可以改写这个世界的面板' : '角色面板玩法：剧情里有人可以改写这个角色的面板'));
        parent.append(row);
        if (!panel.on) return;
        const box2 = node('div', null, 'amin-stack amin-cardprofile-editors');
        box2.append(node('p', '能改写面板的人（{{user}} 是你扮演的角色）。不选分区表示全部分区都能改。AI 写出的改写会标明是谁改的，没有权限的改写不生效。', 'amin-meta'));
        const sections = profile.current.children.filter(item => item.kind === 'group');
        const save = editors => api.options(entry.key, { panel: { on: true, editors } }).then(() => render(), error => say(error.message, 'error'));
        const ctx = globalThis.SillyTavern?.getContext?.();
        const known = [...new Set([USER_TOKEN, ...(ctx?.characters ?? []).map(card => card.name).filter(Boolean), ...api.snapshot().filter(item => item.profile).map(item => item.profile.current.name)])];
        panel.editors.forEach((editor, index) => {
            const line = node('div', null, 'amin-cardprofile-editor-row');
            const name = node('input'); name.value = editor.name; name.setAttribute('aria-label', '改写者名字'); name.setAttribute('list', 'amin-cardprofile-names');
            name.onchange = () => { const next = structuredClone(panel.editors); next[index].name = name.value.trim(); if (next[index].name) save(next); else say('改写者需要名字。', 'error'); };
            line.append(name);
            const scope = node('div', null, 'amin-cardprofile-scope');
            for (const section of sections) {
                const label = node('label', null, 'amin-check'), check = node('input'); check.type = 'checkbox'; check.checked = editor.sections.includes(section.id);
                check.onchange = () => { const next = structuredClone(panel.editors), set = new Set(next[index].sections); if (check.checked) set.add(section.id); else set.delete(section.id); next[index].sections = [...set]; save(next); };
                label.append(check, node('span', section.key)); scope.append(label);
            }
            line.append(node('span', editor.sections.length ? '只能改：' : '全部分区（或只勾选部分）：', 'amin-meta'), scope);
            button(line, '移除', () => save(panel.editors.filter((_, i) => i !== index)), 'amin-cardprofile-mini');
            box2.append(line);
        });
        const list = node('datalist'); list.id = 'amin-cardprofile-names';
        for (const value of known) { const option = node('option'); option.value = value; list.append(option); }
        box2.append(list);
        button(toolbar(box2), '添加改写者', () => save([...panel.editors, { name: '新的改写者', sections: [] }]));
        parent.append(box2);
    }
    // Read-only game-style panel: sections as cards, changed values highlighted. Click to edit.
    function panelView(entry, byId, touched) {
        const profile = entry.profile, root = node('div', null, 'amin-cardprofile-panel');
        root.append(node('h3', profile.current.name, 'amin-cardprofile-panel-name'));
        const open = id => { layout[entry.key] = 'tree'; editing = id; for (const step of locate(profile.current, id)?.path ?? []) opened.add(step.id); render(); };
        const rows = (nodes, parent) => {
            for (const item of nodes) {
                const change = byId.get(item.id);
                if (item.kind === 'group') {
                    const sub = node('div', null, 'amin-cardprofile-panel-group');
                    sub.append(node('div', item.key, 'amin-cardprofile-panel-subhead'));
                    rows(item.children, sub); parent.append(sub); continue;
                }
                const row = node('div', null, 'amin-cardprofile-panel-row'); row.tabIndex = 0; row.setAttribute('role', 'button');
                if (change) row.dataset.changed = change.type;
                if (item.kind === 'field') row.append(node('span', item.key, 'amin-cardprofile-panel-key'), node('span', item.value || '—', 'amin-cardprofile-panel-value'));
                else row.append(node('span', item.value, 'amin-cardprofile-panel-value'));
                if (change?.type === 'changed' && change.before.value !== undefined && change.before.value !== item.value) row.append(node('span', `原：${change.before.value}`, 'amin-cardprofile-panel-before'));
                row.onclick = () => open(item.id); row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(item.id); } };
                parent.append(row);
            }
        };
        const loose = [];
        for (const item of profile.current.children) {
            if (item.kind !== 'group') { loose.push(item); continue; }
            const section = node('section', null, 'amin-cardprofile-panel-section');
            if (touched.has(item.id) || byId.has(item.id)) section.dataset.changed = '1';
            section.append(node('h4', item.key, 'amin-cardprofile-panel-head'));
            rows(item.children, section); root.append(section);
        }
        if (loose.length) { const section = node('section', null, 'amin-cardprofile-panel-section'); rows(loose, section); root.firstChild.after(section); }
        root.append(node('p', '点任意一项进入编辑。高亮的是与初始版本不同的地方。', 'amin-meta'));
        return root;
    }
    function actorNames(entry) {
        const user = userName(), names = (entry.profile.panel?.editors ?? []).map(editor => editor.name === USER_TOKEN ? user : editor.name);
        const ctx = globalThis.SillyTavern?.getContext?.();
        for (const item of api.snapshot()) if (item.profile) names.push(item.profile.current.name);
        for (const card of ctx?.characters ?? []) if (card?.name) names.push(card.name);
        return [...new Set([user, ...names])].filter(name => name && name !== entry.profile.current.name).concat(entry.profile.current.name);
    }
    function appendStory(text) {
        const input = document.querySelector('#send_textarea');
        if (!input || input.disabled || input.readOnly) return false;
        input.value = input.value?.trim() ? `${input.value.replace(/\s+$/u, '')}\n${text}` : text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    function moveButtons(parent, entry, item, total, index) {
        if (index > 0) button(parent, '上移', async () => { await api.move(entry.key, item.id, -1); render(); });
        if (index < total - 1) button(parent, '下移', async () => { await api.move(entry.key, item.id, 1); render(); });
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
            lock.onchange = async () => { try { await api.options(entry.key, { lock: { id: item.id, on: lock.checked } }); say(lock.checked ? `已锁定“${item.key}”，AI 不会提议修改。` : `已解除锁定“${item.key}”。`); } catch (error) { say(error.message, 'error'); lock.checked = !lock.checked; } };
            lockRow.append(lock, node('span', '锁定：AI 不提议修改这个分组')); box.append(lockRow);
        }
        if (change?.type === 'changed' && change.before.kind !== 'group') box.append(node('p', `初始：${change.before.key ? change.before.key + '：' : ''}${change.before.value}`, 'amin-meta'));
        const actions = toolbar(box);
        const save = button(actions, '保存', async () => {
            await api.set(entry.key, item.id, { ...(key ? { key: key.value } : {}), ...(value ? { value: value.value } : {}), star: star.checked });
            editing = null; say('已保存。'); render();
        }, 'amin-primary');
        let actor = null;
        if (entry.profile.panel?.on && item.kind !== 'group') {
            // Like 能力面板: the player decides who did the rewrite in the story (no permission check here).
            const row = node('label', '由谁改写（写入剧情时）', 'amin-field'); actor = node('select');
            for (const name of actorNames(entry)) { const option = node('option', name); option.value = name; actor.append(option); }
            row.append(actor); box.append(row);
        }
        if (entry.profile.panel?.on && item.kind !== 'group') button(actions, '保存并写入剧情', async () => {
            const hit = locate(entry.profile.current, item.id), path = hit.path.map(step => step.key ?? step.value);
            const after = value ? value.value.trim() : item.value, newKey = key ? key.value.trim() : item.key;
            await api.set(entry.key, item.id, { ...(key ? { key: key.value } : {}), ...(value ? { value: value.value } : {}), star: star.checked }, `${actor?.value || userName()} 改写面板：${path.join(' / ')}`);
            if (newKey && newKey !== item.key) path[path.length - 1] = newKey;
            const line = storyLine({ by: actor?.value || userName(), target: entry.profile.current.name, path, before: item.kind === 'field' && item.value ? item.value : undefined, after });
            editing = null;
            say(appendStory(line) ? '已保存，并把这次改写追加到聊天输入框，检查后点发送。' : `已保存。聊天输入框当前不可用，可以手动发送：${line}`); render();
        });
        button(actions, '取消', () => { editing = null; render(); });
        if (item.kind === 'group') {
            button(actions, '新增条目', async () => { const id = await api.add(entry.key, item.id, { kind: 'field', key: '新条目', star: true }); opened.add(item.id); editing = id; render(); });
            button(actions, '新增分组', async () => { const id = await api.add(entry.key, item.id, { kind: 'group', key: '新分组', star: true }); opened.add(item.id); opened.add(id); editing = id; render(); });
        }
        moveButtons(actions, entry, item, total, index);
        if (change?.type !== 'added') button(actions, '恢复初始', async () => { await api.restore(entry.key, item.id); editing = null; render(); });
        button(actions, '删除', async () => {
            if (item.kind === 'group' && item.children.length && !globalThis.confirm?.(`删除“${item.key}”及其中 ${item.children.length} 项吗？`)) return;
            await api.removeNode(entry.key, item.id); editing = null; render();
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
