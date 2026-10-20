import { getSharedSavesService } from './service.js';
import {contextLine} from '../shared/context-line.js';

const mounted = new WeakMap();
const tabs = { saves: '剧情存档', transfer: '导入 / 导出' };
const moduleLabels = {
    characters: '角色档案', inventory: '物品与经济', relationships: '人物关系', scene: '场景与时间',
    effects: '持续效果', dice: '固定骰点', journal: '剧情档案', information: '信息面板', informationLibrary: '信息资料库', map: '地图',
    status: '世界状态', worldStatus: '世界状态', organizations: '势力资料', linkage: '统一联动设置与记录',
};
const confirmLabels = { save: '确认创建存档', restore: '确认恢复到当前楼层', delete: '确认删除存档', import: '确认导入存档', branch: '确认新建并恢复分支', 'checkpoint-settings': '确认检查点设置' };

function moduleRows(snapshot) {
    return Object.entries(snapshot?.modules ?? {}).filter(([, value]) => value !== null).map(([id, value]) => ({
        id,
        label: moduleLabels[id] ?? id,
        version: value && typeof value === 'object' && Number.isInteger(value.version) ? value.version
            : value && typeof value === 'object' && Number.isInteger(value.版本) ? value.版本 : null,
    }));
}
function when(value) {
    const date = new Date(value), time = date.getTime();
    return Number.isFinite(time) ? date.toLocaleString() : String(value || '时间未知');
}
function sourceText(source = {}) {
    const floor = Number.isInteger(source.floor) ? (source.floor > 0 ? `第 ${source.floor} 楼` : '聊天开始前') : '来源楼层未知';
    const candidate = Number.isInteger(source.candidate) ? ` · 第 ${source.candidate + 1} 个候选`
        : source.candidate === undefined || source.candidate === null || source.candidate === '' ? '' : ` · 候选 ${source.candidate}`;
    return floor + candidate;
}

export function mount(target, options = {}) {
    if (!target) throw Error('缺少剧情存档应用容器。');
    const existing = mounted.get(target); if (existing) { existing.open(); return existing; }
    const doc = options.document ?? target.ownerDocument ?? document;
    const api = options.api ?? getSharedSavesService(options.getContext);
    const visibleTabs = api.captureCheckpoint ? { ...tabs, checkpoints: '楼层检查点' } : tabs;
    const getContext = options.getContext ?? api.context ?? (() => globalThis.SillyTavern?.getContext?.());
    const make = (tag, text = '', className = '') => {
        const element = doc.createElement(tag); element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    const instance = `amin-saves-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    const page = make('section', '', 'amin-page amin-app-page amin-saves'), context = make('div', '', 'amin-context');
    const tablist = make('div', '', 'amin-tabs'), notice = make('div', '', 'amin-notice');
    const review = make('section', '', 'amin-stack'), body = make('section', '', 'amin-stack');
    tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', '剧情存档页面');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    body.id = instance + '-body'; body.setAttribute('role', 'tabpanel');
    page.append(context, tablist, notice, review, body); target.append(page);

    let selected = 'saves', disposed = false, ownAction = false, message = '', failed = false;
    let nameDraft = '', noteDraft = '', importText = '', inspected = null, exportText = '', exportName = '';
    let checkpointDraft = null, observedMetadata = null;
    const say = (text, error = false) => { message = String(text ?? ''); failed = error; };
    function section(title, parent = body, className = 'amin-card amin-stack') {
        const card = make('section', '', className); if (title) card.append(make('h3', title)); parent.append(card); return card;
    }
    function toolbar(parent, className = 'amin-toolbar') { const row = make('div', '', className); parent.append(row); return row; }
    function field(parent, label, value, onInput, { multiline = false, full = false, readonly = false } = {}) {
        const wrap = make('label', '', 'amin-field' + (full ? ' amin-span-full' : ''));
        const input = make(multiline ? 'textarea' : 'input'); input.value = value ?? ''; input.setAttribute('aria-label', label);
        if (multiline) input.rows = 6; if (readonly) { input.readOnly = true; input.setAttribute('readonly', ''); }
        if (onInput) input.addEventListener('input', () => onInput(input.value));
        wrap.append(make('span', label), input); parent.append(wrap); return input;
    }
    function action(fn) {
        return async () => {
            if (disposed || ownAction || api.busy()) return;
            ownAction = true; failed = false; render();
            try { await fn(); if (!message) say(api.status()); }
            catch (error) { say(error?.message || '操作失败，请重试。', true); }
            finally { ownAction = false; if (!disposed) render(); }
        };
    }
    function button(parent, label, fn, className = '') {
        const element = make('button', label, className); element.type = 'button'; element.disabled = ownAction || api.busy();
        element.addEventListener('click', action(fn)); parent.append(element); return element;
    }
    function ensureNoPreview() { if (api.preview()) throw Error('请先确认或取消当前预览。'); }
    function drawTabs() {
        tablist.replaceChildren();
        for (const [id, label] of Object.entries(visibleTabs)) {
            const element = make('button', label); element.type = 'button'; element.id = `${instance}-tab-${id}`;
            element.setAttribute('role', 'tab'); element.setAttribute('aria-controls', body.id);
            element.setAttribute('aria-selected', String(selected === id)); element.tabIndex = selected === id ? 0 : -1;
            element.addEventListener('click', () => { if (disposed) return; selected = id; render(); });
            element.addEventListener('keydown', event => {
                const ids = Object.keys(visibleTabs), index = ids.indexOf(id); let next;
                if (event.key === 'ArrowRight') next = ids[(index + 1) % ids.length];
                else if (event.key === 'ArrowLeft') next = ids[(index + ids.length - 1) % ids.length];
                else if (event.key === 'Home') next = ids[0]; else if (event.key === 'End') next = ids.at(-1); else return;
                event.preventDefault(); selected = next; render();
                [...tablist.children].find(tab => tab.getAttribute('aria-selected') === 'true')?.focus();
            });
            tablist.append(element);
        }
        body.setAttribute('aria-labelledby', `${instance}-tab-${selected}`);
    }
    function snapshotMeta(parent, snapshot) {
        const modules = moduleRows(snapshot);
        parent.append(make('p', `${when(snapshot.createdAt)} · ${sourceText(snapshot.source)} · 格式 v${snapshot.version}`, 'amin-meta'));
        parent.append(make('p', modules.length
            ? `模块（${modules.length}）：${modules.map(item => item.label + (item.version == null ? '' : ` v${item.version}`)).join('、')}`
            : '模块：此存档没有可恢复的应用状态。', 'amin-meta'));
        if (snapshot.note) parent.append(make('p', snapshot.note));
    }
    function drawChanges(parent, changes = []) {
        const heading = make('div', '', 'amin-section-heading'); heading.append(make('h3', '逐模块变化'), make('span', `${changes.length} 个模块`, 'amin-meta')); parent.append(heading);
        if (!changes.length) { parent.append(make('p', '当前状态与目标存档没有可应用的模块差异。', 'amin-empty')); return; }
        for (const change of changes) {
            const card = section(change.label || moduleLabels[change.module] || change.module || '应用状态', parent, 'amin-card amin-stack');
            const before = change.before == null || change.before === '' ? '无当前资料' : String(change.before);
            const after = change.after == null || change.after === '' ? '存档中无资料' : String(change.after);
            card.append(make('p', `当前：${before}`), make('p', `应用后：${after}`));
            if (before === after) card.append(make('p', '数量摘要相同，但模块内容有变化；请展开核对字段。', 'amin-meta'));
            const details = Array.isArray(change.details) ? change.details : [];
            if (details.length) {
                const disclosure = make('details'), omitted = Number.isInteger(change.omitted) && change.omitted > 0 ? change.omitted : 0;
                disclosure.append(make('summary', `查看字段变化（${details.length} 条${omitted ? `，另有 ${omitted} 条未显示` : ''}）`));
                for (const difference of details) {
                    const row = make('div', '', 'amin-card amin-stack'), path = String(difference.path || '模块根');
                    row.append(make('strong', path));
                    const oldValue = String(difference.before ?? '无');
                    const newValue = String(difference.after ?? '无');
                    row.append(make('p', `当前值：${oldValue}${difference.beforeTruncated ? '（已截短）' : ''}`));
                    row.append(make('p', `应用后：${newValue}${difference.afterTruncated ? '（已截短）' : ''}`));
                    disclosure.append(row);
                }
                card.append(disclosure);
            } else card.append(make('p', '此模块会发生变化；当前预览没有提供更细的字段差异。', 'amin-meta'));
        }
    }
    function drawReview() {
        review.replaceChildren(); const pending = api.preview(); if (!pending) return;
        const summary = pending.summary ?? {}, kind = summary.kind ?? '';
        const panel = section(`待确认 · ${pending.label}`, review, 'amin-result amin-stack');
        if (summary.name) panel.append(make('p', `名称：${summary.name}`));
        if (kind === 'restore') {
            panel.append(make('p', '确认后会把所选存档的应用状态应用到当前聊天末尾。聊天消息、回复候选和正文不会回退或删除。'));
            const limit = api.read().checkpointSettings?.limit ?? 10;
            if (summary.backup) {
                const backup = section('确认时创建的安全备份', panel, 'amin-card amin-stack');
                backup.append(make('strong', summary.backup.name), make('p', `${when(summary.backup.createdAt)} · 编号 ${summary.backup.id}`, 'amin-meta'));
                backup.append(make('p', `此备份尚未写入；确认恢复时会先一起保存。安全备份与楼层检查点共用最近 ${limit} 份的上限。`, 'amin-help'));
            } else panel.append(make('p', `确认恢复时会先自动保存当前应用状态；安全备份与楼层检查点共用最近 ${limit} 份的上限。`, 'amin-help'));
            panel.append(make('p', '已有完整来源检查点时，可使用“从此处新开分支”继续旧楼剧情。', 'amin-help'));
        } else if (kind === 'branch') {
            panel.append(make('p', `将从${sourceText(summary.source)}创建独立聊天，并恢复当时记录的完整应用状态。原聊天仍保留，缺失的旧楼数据不会由当前状态推算。`));
        } else if (kind === 'delete') panel.append(make('p', '这会删除所选命名存档；当前应用状态和聊天消息不会改变。'));
        else if (kind === 'import') panel.append(make('p', '导入只把已验证的存档收入当前聊天，不会立即恢复，也不会改动聊天消息。'));
        else if (kind === 'save') panel.append(make('p', '确认后保存当前允许范围内的应用状态及消息来源修订；不会替换聊天正文，也不收录全局设置、API 配置或密钥。'));
        if (summary.snapshot) panel.append(make('p', `${when(summary.snapshot.createdAt)} · ${sourceText(summary.snapshot.source)}`, 'amin-meta'));
        if (Array.isArray(summary.moduleNames)) panel.append(make('p', summary.moduleNames.length ? `包含模块：${summary.moduleNames.join('、')}` : '当前没有可保存的应用状态。', 'amin-meta'));
        if (kind === 'restore' || summary.changes?.length) drawChanges(panel, summary.changes);
        if (Array.isArray(summary.warnings) && summary.warnings.length) {
            const warnings = section('需要留意', panel, 'amin-card amin-stack');
            for (const warning of summary.warnings) warnings.append(make('p', String(warning)));
        }
        const actions = toolbar(panel, 'amin-savebar');
        button(actions, confirmLabels[kind] ?? '确认应用一次', async () => { await api.confirm(); inspected = null; checkpointDraft = null; say(api.status(), false); }, kind === 'delete' ? 'amin-danger' : 'amin-primary');
        button(actions, '取消预览', () => { api.discard(); say(api.status(), false); });
    }
    function drawRetry() {
        if (!api.dirty()) return;
        const card = section('保存尚未完成', body, 'amin-result amin-stack');
        card.append(make('p', '已确认的变化保留在当前聊天内存中。请重试保存；重试不会再次恢复、导入或删除。'));
        button(toolbar(card), '重试保存', async () => { await api.retrySave(); say(api.status(), false); }, 'amin-primary');
    }
    function drawSnapshot(snapshot, parent, { backup = false, checkpoint = false } = {}) {
        const card = section(snapshot.name, parent); snapshotMeta(card, snapshot);
        if (backup) card.append(make('p', '自动安全备份，可用于撤销一次恢复。', 'amin-help'));
        const actions = toolbar(card);
        button(actions, backup ? '预览恢复此备份' : '预览恢复', () => { ensureNoPreview(); api.stageRestore(snapshot.id); });
        if (api.stageBranch) {
            const availability = api.branchAvailability(snapshot.id);
            const branch = button(actions, '从此处新开分支', () => { ensureNoPreview(); api.stageBranch(snapshot.id); });
            if (!availability.available) { branch.disabled = true; branch.title = availability.reason; card.append(make('p', availability.reason, 'amin-help')); }
        }
        button(actions, '导出 JSON', () => {
            exportText = api.exportSave(snapshot.id); exportName = snapshot.name; selected = 'transfer';
            inspected = null; say(`已生成「${snapshot.name}」的导出 JSON。`, false);
        });
        if (!backup) button(actions, checkpoint ? '删除检查点' : '删除存档', () => { ensureNoPreview(); api.stageDelete(snapshot.id); }, 'amin-danger');
    }
    function drawSaves(store) {
        const create = section('创建当前状态存档'), grid = make('div', '', 'amin-form-grid'); create.append(grid);
        field(grid, '存档名称', nameDraft, value => { nameDraft = value; });
        field(grid, '备注（可选）', noteDraft, value => { noteDraft = value; }, { multiline: true, full: true });
        create.append(make('p', '保存应用状态与核验分支所需的消息来源修订。恢复不会替换聊天消息；全局界面设置、模型 API 配置与密钥不会进入存档。', 'amin-help'));
        button(toolbar(create), '预览创建存档', () => { ensureNoPreview(); api.stageSave({ name: nameDraft, note: noteDraft }); }, 'amin-primary');

        const list = section('命名存档');
        if (!store.saves.length) list.append(make('p', '还没有命名存档。填写名称并预览后，确认一次即可保存当前应用状态。', 'amin-empty'));
        for (const snapshot of [...store.saves].reverse()) drawSnapshot(snapshot, list);
        const backups = section(`自动安全备份 · 与检查点共用最近 ${store.checkpointSettings?.limit ?? 10} 份`);
        backups.append(make('p', '每次恢复前自动建立；它们同样只包含允许范围内的应用状态。', 'amin-help'));
        if (!store.backups.length) backups.append(make('p', '还没有安全备份。第一次确认恢复时会自动创建。', 'amin-empty'));
        for (const snapshot of [...store.backups].reverse()) drawSnapshot(snapshot, backups, { backup: true });
    }
    function drawCheckpoints(store) {
        const settings = store.checkpointSettings ?? { enabled: true, limit: 10 }, draft = checkpointDraft ??= { ...settings };
        const config = section('自动记录完整楼层状态');
        config.append(make('p', '只记录当前聊天末尾实际存在的完整状态。后续楼层与候选分别保留；消息被编辑或切换候选后，只有来源完全匹配的记录才能新开分支。旧历史不会补造检查点。', 'amin-help'));
        const enabledLabel = make('label', '', 'amin-check'), enabled = make('input'); enabled.type = 'checkbox'; enabled.checked = draft.enabled;
        enabled.setAttribute('aria-label', '启用自动楼层检查点'); enabled.addEventListener('change', () => { draft.enabled = enabled.checked; });
        enabledLabel.append(enabled, make('span', '启用自动楼层检查点')); config.append(enabledLabel);
        const limit = field(config, '自动检查点保留数量', String(draft.limit), value => { draft.limit = Number(value); }); limit.type = 'number'; limit.min = '1'; limit.max = '24'; limit.step = '1';
        button(toolbar(config), '预览检查点设置', () => { ensureNoPreview(); api.stageCheckpointSettings(draft); });
        if (api.checkpointStatus?.()) config.append(make('p', api.checkpointStatus(), 'amin-notice'));
        const actions = toolbar(config);
        button(actions, '立即记录当前楼层', async () => { ensureNoPreview(); const saved = await api.captureCheckpoint(); say(saved ? '已记录当前楼层完整状态。' : '空聊天尚无可记录楼层。'); }, 'amin-primary');
        const list = section(`楼层检查点 · ${store.checkpoints?.length ?? 0} 份`);
        list.append(make('p', (store.storage?.external ? '检查点保存在外部存储，聊天内只保留引用。' : '外部存储不可用时，聊天内最多保留 2 份完整检查点。') + '同一状态修订只记录一次；自动检查点、恢复前备份和操作前备份按保留数量滚动淘汰。长期保留请另建命名存档或导出 JSON。', 'amin-help'));
        if (!store.checkpoints?.length) list.append(make('p', '尚无完整楼层检查点。可立即记录当前楼层，或等待后续消息和应用更新。', 'amin-empty'));
        for (const saved of [...(store.checkpoints ?? [])].reverse()) drawSnapshot(saved, list, { checkpoint: true });
    }
    function drawTransfer() {
        const importing = section('导入已验证的 Amin OS 存档');
        const importArea = field(importing, '粘贴存档 JSON', importText, value => { importText = value; inspected = null; }, { multiline: true, full: true });
        importArea.spellcheck = false;
        importing.append(make('p', '先验证格式、版本、大小和模块内容。验证不会写入；导入后也不会自动恢复。', 'amin-help'));
        button(toolbar(importing), '验证 JSON', async () => {
            ensureNoPreview(); inspected = await api.inspectImport(importText); say('JSON 已验证，可核对后预览导入。', false);
        }, 'amin-primary');
        if (inspected) {
            const result = section('验证通过 · ' + inspected.name, importing, 'amin-result amin-stack'); snapshotMeta(result, inspected);
            button(toolbar(result), '预览收纳到当前聊天', () => { ensureNoPreview(); api.stageImport(importText); });
        }
        const exporting = section(exportName ? `导出 · ${exportName}` : '导出存档');
        if (!exportText) exporting.append(make('p', '在“剧情存档”页选择一个命名存档或安全备份，再点击“导出 JSON”。', 'amin-empty'));
        else {
            const output = field(exporting, '存档 JSON', exportText, null, { multiline: true, full: true, readonly: true }); output.spellcheck = false;
            const actions = toolbar(exporting);
            button(actions, '复制导出 JSON', async () => {
                const clipboard = doc.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard;
                if (clipboard?.writeText) { await clipboard.writeText(exportText); say('已复制导出 JSON。', false); }
                else { output.focus(); output.select?.(); say('剪贴板不可用，已选中 JSON，请手动复制。', false); }
            }, 'amin-primary');
            button(actions, '清除导出预览', () => { exportText = ''; exportName = ''; });
        }
    }
    function render() {
        if (disposed) return;
        let store;
        try { store = api.read(); }
        catch (error) {
            context.textContent = contextLine(getContext?.(), '存档不可读取'); tablist.replaceChildren(); review.replaceChildren();
            body.replaceChildren(make('p', error.message, 'amin-empty')); notice.textContent = ''; return;
        }
        const ctx = getContext?.();
        if (observedMetadata !== ctx?.chatMetadata) { checkpointDraft = null; observedMetadata = ctx?.chatMetadata; }
        context.textContent = contextLine(ctx, `${store.saves.length} 个命名存档`, `${store.backups.length} 个安全备份`);
        drawTabs(); drawReview(); body.replaceChildren(); drawRetry();
        if (selected === 'saves') drawSaves(store); else if (selected === 'checkpoints') drawCheckpoints(store); else drawTransfer();
        notice.textContent = failed ? message : (message || api.status()); notice.dataset.state = failed ? 'error' : api.busy() || ownAction ? 'busy' : '';
    }
    const unsubscribe = api.subscribe(() => { if (!disposed) { if (!failed) message = api.status(); render(); } });
    render();
    const view = {
        open() { if (!disposed) render(); },
        refresh() { if (!disposed) render(); },
        dispose() { if (disposed) return; disposed = true; unsubscribe(); page.remove(); if (mounted.get(target) === view) mounted.delete(target); },
    };
    mounted.set(target, view); return view;
}
