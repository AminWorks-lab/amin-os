import {getManager} from './runtime.js';
import {createMoreMenu} from '../../ui/tabs.js';

const el = (tag, text, cls) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (cls) element.className = cls;
    return element;
};
let instance = 0;

export async function mount(target, {manager} = {}) {
    const api = manager ?? await getManager();
    const id = `amin-worldbooks-${++instance}`;
    const page = el('div', null, 'amin-page amin-app-page amin-worldbooks');
    const intro = el('div', null, 'amin-context');
    const tabs = el('nav', null, 'amin-tabs');
    const notice = el('p', null, 'amin-notice');
    const body = el('section', null, 'amin-stack');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '世界书管理页面');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    body.id = `${id}-body`;
    body.setAttribute('role', 'tabpanel');
    page.append(intro, tabs, notice, body);
    target.append(page);

    let tab = '角色组合', role = api.context()?.id, profile = api.profile();
    let names = [], query = '', entryQuery = '', book = '', loadingBook = '', data = null;
    let selected = new Set(), bookEpoch = 0, catalogEpoch = 0, disposed = false, selecting = false;
    const expanded = new Set();
    const say = text => notice.textContent = text;
    const button = (parent, text, fn, primary = false, available = () => true) => {
        const b = el('button', text, primary ? 'amin-primary' : '');
        b.type = 'button';
        b.disabled = !available();
        b.onclick = async () => {
            if (b.disabled) return;
            b.disabled = true;
            b.setAttribute('aria-busy', 'true');
            try { await fn(); } catch (error) { say(error.message); }
            finally { b.disabled = !available(); b.removeAttribute('aria-busy'); }
        };
        parent.append(b);
        return b;
    };
    const check = (parent, text, on, fn) => {
        const label = el('label', null, 'amin-wb-check'), input = el('input');
        input.type = 'checkbox';
        input.checked = on;
        input.onchange = () => fn(input.checked);
        label.append(input, el('span', text));
        parent.append(label);
        return input;
    };
    const search = (parent, label, value, fn) => {
        const row = el('label', null, 'amin-field'), input = el('input');
        input.type = 'search';
        input.value = value;
        input.placeholder = '输入关键词筛选';
        input.oninput = () => fn(input.value);
        row.append(el('span', label), input);
        parent.append(row);
    };
    const card = (parent, title) => {
        const c = el('section', null, 'amin-card amin-stack');
        if (title) c.append(el('h3', title, 'amin-section-heading'));
        parent.append(c);
        return c;
    };
    const fold = (parent, key, title) => {
        const c = el('details', null, 'amin-card amin-wb-fold');
        c.append(el('summary', title));
        c.open = expanded.has(key);
        c.ontoggle = () => {
            if (!c.isConnected) return;
            if (c.open) expanded.add(key); else expanded.delete(key);
        };
        parent.append(c);
        return c;
    };
    const empty = (parent, text) => parent.append(el('p', text, 'amin-empty'));
    const modes = [['keep', '保持原样'], ['on', '启用'], ['off', '关闭']];
    const tabNames = ['角色组合', '展示范围', '接管记录'];
    const tabButtons = tabNames.map((name, index) => {
        const b = el('button', name);
        b.type = 'button';
        b.id = `${id}-tab-${index}`;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-controls', body.id);
        b.onclick = () => { tab = name; render(); };
        b.onkeydown = event => {
            let next;
            if (event.key === 'ArrowRight') next = (index + 1) % tabNames.length;
            else if (event.key === 'ArrowLeft') next = (index + tabNames.length - 1) % tabNames.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabNames.length - 1;
            else return;
            event.preventDefault();
            tab = tabNames[next];
            render();
            tabButtons[next].focus();
        };
        tabs.append(b);
        return b;
    });

    function setRule(entryId, mode) {
        profile.entries[book] ??= {};
        if (mode === 'keep') delete profile.entries[book][entryId];
        else profile.entries[book][entryId] = mode;
    }

    async function loadBook(name) {
        const run = ++bookEpoch, current = role;
        book = ''; data = null; selected.clear(); loadingBook = name;
        render();
        say('正在读取世界书条目…');
        try {
            const result = await api.load(name);
            if (disposed || run !== bookEpoch || current !== role || api.context()?.id !== current) return;
            loadingBook = '';
            if (!profile.books.includes(name) || !api.globals().includes(name)) { render(); return; }
            book = name; data = result; entryQuery = '';
            render();
        } catch (error) {
            if (!disposed && run === bookEpoch) { loadingBook = ''; render(); say(error.message); }
            throw error;
        }
    }

    async function refresh() {
        // Catalog refreshes must not cancel an in-flight entry read.
        const run = ++catalogEpoch;
        const result = await api.catalog();
        if (disposed || run !== catalogEpoch) return;
        names = result;
        render();
    }

    async function apply(remember) {
        const captured = role;
        if (!captured) throw Error('请先打开单人角色卡');
        await api.apply(captured, profile, remember);
        if (book && role === captured) await loadBook(book);
    }

    function renderEntries(parent, state) {
        if (!book || !data) return;
        const c = card(parent, `条目 · ${book}`);
        const allEntries = Object.entries(data.entries ?? {});
        c.append(el('p', '条目默认保持原样。修改只影响启用开关，仍遵循原本的触发规则；保存组合或临时应用后生效。'));
        search(c, '搜索条目名称、UID 或正文', entryQuery, value => { entryQuery = value; drawList(); });

        const selection = el('div', null, 'amin-result amin-stack');
        const count = el('p');
        count.setAttribute('role', 'status');
        count.setAttribute('aria-live', 'polite');
        const selectionActions = el('div', null, 'amin-toolbar');
        const batchActions = el('div', null, 'amin-toolbar');
        selectionActions.setAttribute('aria-label', '条目勾选范围');
        batchActions.setAttribute('aria-label', '所选条目操作');
        selection.append(count, selectionActions, batchActions);
        c.append(selection);

        let shownEntries = [];
        const selectShown = button(selectionActions, '勾选搜索结果', () => {
            shownEntries.forEach(([entryId]) => selected.add(entryId)); drawList();
        }, false, () => shownEntries.length > 0);
        const clearSelection = button(selectionActions, '清空勾选', () => {
            selected.clear(); drawList();
        }, false, () => selected.size > 0);
        const batchButtons = modes.map(([mode, label]) => button(batchActions, '所选' + label, () => {
            for (const entryId of selected) setRule(entryId, mode);
            drawList();
            say(`已将 ${selected.size} 个所选条目设置为${label}，保存组合或临时应用后生效。`);
        }, false, () => selected.size > 0));

        const advanced = fold(c, 'entry-batch', '更多批量操作');
        advanced.append(el('p', '以下操作覆盖整本世界书，包含搜索结果之外的条目。恢复原样会撤销条目覆盖，不撤下世界书。'));
        const all = el('div', null, 'amin-toolbar');
        all.setAttribute('aria-label', '整本世界书条目操作');
        advanced.append(all);
        for (const [mode, label] of [['on', '全部启用'], ['off', '全部关闭'], ['keep', '全部恢复原样']]) {
            button(all, label, () => {
                if (mode === 'keep') profile.entries[book] = {};
                else for (const [entryId] of allEntries) setRule(entryId, mode);
                drawList();
                say(`「${book}」已设置${label}，保存组合或临时应用后生效。`);
            }, false, () => mode === 'keep' || allEntries.length > 0);
        }
        const onlySelected = button(all, '仅启用所选条目', () => {
            if (!selected.size) throw Error('请先勾选要启用的条目');
            for (const [entryId] of allEntries) setRule(entryId, selected.has(entryId) ? 'on' : 'off');
            drawList();
            say('已设置：所选条目启用，其余关闭。保存组合或临时应用后生效。');
        }, false, () => selected.size > 0);
        const list = el('div', null, 'amin-stack');
        c.append(list);

        function updateSelection() {
            const visibleSelected = shownEntries.filter(([entryId]) => selected.has(entryId)).length;
            const hiddenSelected = selected.size - visibleSelected;
            count.textContent = `显示 ${shownEntries.length} / ${allEntries.length} 个条目 · 已勾选 ${selected.size} 个${hiddenSelected ? `（其中 ${hiddenSelected} 个不在当前搜索结果中）` : ''}`;
            selectShown.disabled = !shownEntries.length;
            clearSelection.disabled = !selected.size;
            for (const b of [...batchButtons, onlySelected]) b.disabled = !selected.size;
        }

        function drawList() {
            list.replaceChildren();
            shownEntries = allEntries.filter(([entryId, entry]) => `${entryId} ${entry.comment ?? ''} ${entry.content ?? ''}`.toLowerCase().includes(entryQuery.toLowerCase()));
            updateSelection();
            for (const [entryId, entry] of shownEntries) {
                const row = el('article', null, 'amin-wb-entry amin-stack');
                check(row, entry.comment || `条目 ${entryId}`, selected.has(entryId), on => {
                    if (on) selected.add(entryId); else selected.delete(entryId);
                    updateSelection();
                });
                const owned = state.session.entries.find(record => record.book === book && record.id === entryId);
                const original = owned ? owned.before.value === true : entry.disable === true;
                row.append(el('p', `UID ${entryId} · 原状态：${original ? '关闭' : '启用'} → 当前：${entry.disable === true ? '关闭' : '启用'}${owned ? ' · 插件接管' : ''}`));
                const field = el('label', null, 'amin-field'), select = el('select');
                for (const [value, label] of modes) {
                    const option = el('option', label); option.value = value; select.append(option);
                }
                select.value = profile.entries[book]?.[entryId] ?? 'keep';
                select.setAttribute('aria-label', `条目 ${entryId} 的角色设置`);
                select.onchange = () => setRule(entryId, select.value);
                field.append(el('span', '角色组合中的设置'), select);
                row.append(field);
                const detail = el('details');
                detail.append(el('summary', '查看原文'), el('pre', entry.content ?? ''));
                row.append(detail);
                if (owned) {
                    const actions = el('div', null, 'amin-toolbar'); row.append(actions);
                    button(actions, '保留此状态', async () => { await api.keepEntry(book, entryId); await loadBook(book); });
                }
                list.append(row);
            }
            if (!shownEntries.length) empty(list, allEntries.length ? '没有匹配条目。修改搜索关键词可查看其他条目，已勾选项目仍会保留。' : '这本世界书还没有条目。可先在酒馆世界书编辑器中添加内容。');
        }
        drawList();
    }

    function render() {
        if (disposed) return;
        const current = api.context();
        if (current?.id !== role) {
            role = current?.id; profile = api.profile(); book = ''; loadingBook = ''; data = null;
            selected.clear(); entryQuery = ''; bookEpoch++;
        }
        const state = api.snapshot();
        intro.textContent = current
            ? `${current.name} · 已选 ${profile.books.length} 本世界书 · ${state.paused ? '自动应用已暂停' : '自动应用开启'}`
            : '打开单人角色卡后可设置专属组合；群聊不套用组合。';
        tabButtons.forEach((b, index) => {
            const active = tabNames[index] === tab;
            b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
            if (active) body.setAttribute('aria-labelledby', b.id);
        });
        say(api.message() || '只撤回插件自己接管的改动。');
        body.replaceChildren();
        const toolbar = el('div', null, 'amin-toolbar');
        body.append(toolbar);
        // The list follows host worldbook and chat events; the menu keeps a manual fallback.
        toolbar.append(createMoreMenu(document, { label: '更多世界书操作', items: () => [{ label: '重新读取世界书列表', title: '仅在列表与酒馆不一致时使用', run: () => refresh().catch(error => say(error.message)) }] }).element);
        button(toolbar, state.paused ? '恢复自动应用' : '暂停自动应用', () => api.pause(!state.paused));

        if (tab === '展示范围') {
            const c = card(body, '选择插件内展示的世界书');
            c.append(el('p', '勾选后可在“角色组合”中管理；展示选择不改变全局启用状态，也不会撤销角色组合。'));
            const count = el('p', null, 'amin-result'), list = el('div', null, 'amin-stack');
            search(c, '搜索世界书', query, value => { query = value; draw(); });
            c.append(count, list);
            function draw() {
                list.replaceChildren();
                const matches = names.filter(name => name.toLowerCase().includes(query.toLowerCase()));
                count.textContent = `显示 ${matches.length} / ${names.length} 本 · 已选择展示 ${api.snapshot().visible.length} 本`;
                for (const name of matches) check(list, name, api.snapshot().visible.includes(name), async on => {
                    try {
                        const visible = api.snapshot().visible.filter(value => value !== name);
                        if (on) visible.push(name);
                        await api.setVisible(visible);
                    } catch (error) { say(error.message); }
                });
                if (!matches.length) empty(list, names.length ? '没有匹配的世界书。试试其他关键词。' : '暂无可展示的世界书。添加或导入世界书后会自动出现在这里。');
            }
            draw();
            return;
        }

        if (tab === '接管记录') {
            const c = card(body, '本次接管');
            c.append(el('p', `临时启用 ${state.session.books.length} 本世界书 · 接管 ${state.session.entries.length} 个条目。选择“保留”后，该项不再随离开角色自动撤回。`));
            const actions = el('div', null, 'amin-toolbar'); c.append(actions);
            button(actions, '撤回全部插件改动并暂停', () => api.withdraw());
            for (const name of state.session.books) {
                const row = el('div', null, 'amin-toolbar');
                row.append(el('span', name + ' · 插件临时启用'));
                button(row, '保留为全局启用', () => api.keepBook(name));
                c.append(row);
            }
            const groups = new Map();
            for (const record of state.session.entries) {
                if (!groups.has(record.book)) groups.set(record.book, []);
                groups.get(record.book).push(record);
            }
            for (const [name, records] of groups) {
                const group = fold(c, 'record:' + name, `${name} · ${records.length} 个条目改动`);
                for (const record of records) {
                    const row = el('div', null, 'amin-toolbar');
                    row.append(el('span', `条目 ${record.id} · ${record.before.value === true ? '关闭' : '启用'} → ${record.after.value ? '关闭' : '启用'}`));
                    button(row, '保留此状态', () => api.keepEntry(record.book, record.id));
                    group.append(row);
                }
            }
            if (!state.session.books.length && !state.session.entries.length) empty(c, '当前没有接管项目。应用角色组合后，插件接管的世界书和条目会显示在这里。');
            const messages = api.messages(), logs = fold(body, 'logs', `操作提示 · ${messages.length} 条`);
            for (const text of messages) logs.append(el('p', text));
            if (!messages.length) empty(logs, '暂无操作记录。');
            return;
        }

        const actionCard = card(body, '当前角色组合');
        const actions = el('div', null, 'amin-toolbar'); actionCard.append(actions);
        const canApply = () => Boolean(role) && !selecting;
        button(actions, '保存角色组合并应用', () => apply(true), true, canApply);
        button(actions, '仅本次临时应用', () => apply(false), false, canApply);
        button(actions, '重新应用已保存组合', async () => {
            profile = api.profile(); await api.apply(role, profile, true); await api.sync(true);
            if (book) await loadBook(book);
        }, false, canApply);
        actionCard.append(el('p', state.paused ? '自动应用已暂停，保存只记录设置；恢复后生效。' : '离开角色时撤回接管项目；同角色切换聊天保持组合。'));
        if (!role) empty(actionCard, '请先打开单人角色卡，再选择和应用角色组合。你仍可管理展示范围或查看接管记录。');
        if (!state.visible.length) {
            empty(actionCard, '尚未选择展示的世界书。先选择展示范围，再为角色勾选组合。');
            button(actions, '选择要展示的世界书', () => { tab = '展示范围'; render(); tabButtons[1].focus(); });
        }

        const picker = fold(body, 'book-picker', `选择启用的世界书 · 已选 ${profile.books.length} 本`);
        picker.append(el('p', '勾选后自动保存并应用当前角色组合；取消勾选只撤回插件接管的改动。'));
        const choices = el('div', null, 'amin-wb-choices'); picker.append(choices);
        const globals = api.globals();
        for (const name of state.visible) {
            const exists = names.includes(name);
            const status = !exists ? '世界书不存在或已改名' : state.session.books.includes(name) ? '插件临时启用' : globals.includes(name) ? '已全局启用（非插件接管）' : '未全局启用';
            const row = el('div', null, 'amin-wb-entry'); choices.append(row);
            check(row, name, profile.books.includes(name), async on => {
                const captured = role;
                selecting = true;
                profile.books = profile.books.filter(value => value !== name);
                if (on) profile.books.push(name);
                profile.entries[name] ??= {};
                render();
                let failure = '';
                try { await api.apply(captured, profile, true); } catch (error) { failure = error.message; }
                finally { selecting = false; render(); if (failure) say(failure); }
            }).disabled = !role || selecting || (!exists && !profile.books.includes(name));
            row.append(el('small', status));
        }
        if (!state.visible.length) empty(choices, '展示范围为空。切换到“展示范围”选择要管理的世界书。');

        const activeBooks = profile.books.filter(name => names.includes(name) && globals.includes(name));
        const entryCard = card(body, '管理世界书条目');
        const fields = el('div', null, 'amin-form-grid'); entryCard.append(fields);
        const entryPicker = el('label', null, 'amin-field'), select = el('select');
        entryPicker.append(el('span', '当前角色已启用的世界书'));
        const placeholder = el('option', activeBooks.length ? '选择一本世界书查看条目' : '当前角色组合没有已启用的世界书');
        placeholder.value = ''; select.append(placeholder);
        for (const name of activeBooks) {
            const option = el('option', name); option.value = name; select.append(option);
        }
        select.value = activeBooks.includes(loadingBook || book) ? loadingBook || book : '';
        select.disabled = !role || selecting || !activeBooks.length;
        select.onchange = async () => {
            const name = select.value;
            if (!name) { bookEpoch++; book = ''; loadingBook = ''; data = null; selected.clear(); render(); return; }
            try { await loadBook(name); } catch (error) { say(error.message); }
        };
        entryPicker.append(select); fields.append(entryPicker);
        if (loadingBook) empty(entryCard, `正在读取「${loadingBook}」的条目…`);
        else if (!activeBooks.length) empty(entryCard, state.paused ? '自动应用已暂停。恢复自动应用并启用世界书后，可在这里管理条目。' : '在上方“选择启用的世界书”中为角色勾选世界书，应用后即可管理条目。');
        else if (!book) empty(entryCard, '选择一本世界书，查看原文或调整当前角色的条目开关。');
        if (activeBooks.includes(book)) renderEntries(body, state);
        const hidden = profile.books.filter(name => !state.visible.includes(name));
        if (hidden.length) body.append(el('p', `组合中另有 ${hidden.length} 本未在此展示；可在展示范围中选中管理。`, 'amin-result'));
    }

    // Re-read the catalog when the host reports worldbook or chat changes.
    const hostCtx = globalThis.SillyTavern?.getContext?.(), events = hostCtx?.eventTypes ?? hostCtx?.event_types ?? {};
    let catalogTimer = null;
    const hostChanged = () => { clearTimeout(catalogTimer); catalogTimer = setTimeout(() => { if (!disposed) refresh().catch(error => say(error.message)); }, 150); };
    const hostEvents = ['WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'CHAT_CHANGED'].map(name => events[name]).filter(Boolean);
    for (const name of hostEvents) hostCtx?.eventSource?.on?.(name, hostChanged);
    const stopHost = () => { clearTimeout(catalogTimer); for (const name of hostEvents) { if (hostCtx?.eventSource?.removeListener) hostCtx.eventSource.removeListener(name, hostChanged); else hostCtx?.eventSource?.off?.(name, hostChanged); } };
    const unsubscribeManager = api.subscribe(render), unsubscribe = () => { unsubscribeManager(); stopHost(); };
    try { await refresh(); } catch (error) {
        disposed = true; bookEpoch++; catalogEpoch++; unsubscribe(); page.remove(); throw error;
    }
    return {
        open: refresh,
        dispose() { disposed = true; bookEpoch++; catalogEpoch++; unsubscribe(); page.remove(); },
    };
}
