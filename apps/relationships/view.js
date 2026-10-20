import { mountGeneration } from '../generation/view.js';
import { createRelationshipsService, getSharedRelationshipsService } from './service.js';
import { personLabel, renderRelationshipGraph } from './graph.js';
import { evidenceMatches } from './model.js';
import {contextLine} from '../shared/context-line.js';
import {linkedEmpty} from '../shared/open-app.js';
import { attachLinkageBadge } from '../linkage/badge.js';

const mounted = new WeakMap();

export function mount(target, options = {}) {
    if (mounted.has(target)) return mounted.get(target);
    const document = options.document ?? target.ownerDocument ?? globalThis.document;
    const ownService = !options.api && !options.service && !!options.getContext;
    const api = options.api ?? options.service ?? (ownService ? createRelationshipsService(options.getContext) : getSharedRelationshipsService());
    const make = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
    const page = make('section', '', 'amin-page amin-app-page amin-relationships');
    const context = make('div', '', 'amin-context'), notice = make('div', '', 'amin-notice');
    attachLinkageBadge(context, 'relationships', { getContext: () => api.context?.() });
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const retryPanel = make('div', '', 'amin-stack'), review = make('div', '', 'amin-stack'), controls = make('div', '', 'amin-card amin-stack');
    const graphPanel = make('section', '', 'amin-card amin-stack'), editorHost = make('section', '', 'amin-stack');
    const listPanel = make('section', '', 'amin-stack'), settingsPanel = make('details', '', 'amin-card amin-stack');
    const aiPanel = make('details', '', 'amin-card amin-stack'), rulesPanel = make('details', '', 'amin-card amin-stack'), alertsPanel = make('section', '', 'amin-stack');
    page.append(context, notice, retryPanel, controls, aiPanel, alertsPanel, graphPanel, editorHost, review, listPanel, rulesPanel, settingsPanel); target.append(page);
    const generationView = mountGeneration(page, { modules: ['relationships'], getContext: options.getContext ?? (() => api.context()), document: document, service: options.generationService, ai: options.ai });
    let state = null, characters = [], focusId = '', direction = 'all', query = '', editor = null, disposed = false, error = '', committedEditor = false, unavailable = false, graphWidth = 0, graphVisible = null, graphLayout = 'network', positionOwner = null;
    const graphPositions = new Map();
    const aiDraft = { start: null, end: null, instruction: '' };
    const locked = () => unavailable || api.busy() || api.dirty() || !!api.preview();
    const say = (message, failed = false) => { error = failed ? message : ''; notice.textContent = message; notice.dataset.state = failed ? 'error' : api.busy() ? 'busy' : message ? 'success' : ''; };
    const run = async task => { try { error = ''; await task(); } catch (reason) { say(reason?.message ?? String(reason), true); } finally { if (!disposed) updateLocks(); } };
    function button(label, task, { primary = false, mutation = false, disabled = false } = {}) {
        const node = make('button', label, primary ? 'amin-primary' : ''); node.type = 'button'; node.disabled = disabled || (mutation && locked());
        if (mutation) { node.dataset.mutation = 'true'; node.dataset.unavailable = disabled ? 'true' : 'false'; }
        node.addEventListener('click', () => { if (!node.disabled) return run(task); }); return node;
    }
    function field(parent, label, value, change, { multi = false, type = 'text', help = '', full = false } = {}) {
        const row = make('label', '', 'amin-field' + (full ? ' amin-span-full' : '')), input = make(multi ? 'textarea' : 'input');
        input.value = value ?? ''; input.setAttribute('aria-label', label); if (!multi) input.type = type;
        if (type === 'number') input.step = 'any';
        input.addEventListener('input', () => { change(input.value); }); row.append(make('span', label), input); if (help) row.append(make('small', help)); parent.append(row); return input;
    }
    function select(parent, label, value, choices, change) {
        const row = make('label', '', 'amin-field'), input = make('select'); input.setAttribute('aria-label', label);
        for (const [id, text] of choices) { const option = make('option', text); option.value = id; input.append(option); }
        input.value = value; input.addEventListener('change', () => change(input.value)); row.append(make('span', label), input); parent.append(row); return input;
    }
    const person = id => characters.find(item => item.id === id) ?? { id, name: `未解析人物（${id}）`, missing: true };
    const description = edge => `${person(edge.fromId).name} → ${person(edge.toId).name}`;
    function updateLocks() {
        const busy = api.busy(), block = locked(); page.setAttribute('aria-busy', String(busy));
        for (const node of page.querySelectorAll?.('[data-mutation]') ?? []) node.disabled = block || node.dataset.unavailable === 'true' || (node.dataset.minimumPeople === 'true' && characters.length < 2);
        if (editor) for (const node of editor.inputs) node.disabled = block;
        if (editor?.save) editor.save.disabled = block || (editor.kind !== 'rule' && !editor.draft.id && characters.length < 2);
    }
    function clearEditor() { editor = null; committedEditor = false; editorHost.replaceChildren(); }
    function openEditor(relationship = null) {
        if (editor) { say('还有一份关系草稿。请先预览保存，或取消编辑。', true); return; }
        if (locked()) throw Error('请先处理待确认操作或重试保存。');
        const draft = relationship ? structuredClone(relationship) : { fromId: focusId || characters[0]?.id || '', toId: characters.find(item => item.id !== (focusId || characters[0]?.id))?.id || '', type: '', label: '', notes: '' };
        const token = api.capture(), panel = make('section', '', 'amin-card amin-stack amin-relationship-editor');
        panel.append(make('h3', relationship ? '编辑人物关系' : '新增人物关系'), make('p', '从发起者指向对象。反向关系需要单独建立；强度由你明确填写，可留空。', 'amin-meta'));
        const form = make('div', '', 'amin-form-grid'); panel.append(form);
        const inputs = [];
        const choices = [['', '请选择人物'], ...characters.map(item => [item.id, personLabel(item)])];
        for (const [key, label] of [['fromId', '关系发起者'], ['toId', '关系对象']]) {
            const available = [...choices];
            if (draft[key] && !characters.some(item => item.id === draft[key])) available.push([draft[key], person(draft[key]).name + ' · 保留原引用']);
            inputs.push(select(form, label, draft[key], available, value => { draft[key] = value; }));
        }
        inputs.push(field(form, '关系类型', draft.type, value => { draft.type = value; }, { help: '例如信任、师徒、敌对、亲属。' }));
        inputs.push(field(form, '关系标签（可选）', draft.label, value => { draft.label = value; }, { help: '查看关系时优先显示此标签；留空显示关系类型。' }));
        inputs.push(field(form, '强度（可选）', draft.strength, value => { if (value.trim() === '') delete draft.strength; else draft.strength = Number(value); }, { type: 'number', help: '没有默认好感值；数值含义由你的规则决定。' }));
        inputs.push(field(form, '关系备注（可选）', draft.notes, value => { draft.notes = value; }, { multi: true, full: true }));
        let reason = '';
        inputs.push(field(form, '本次调整依据（可选）', '', value => { reason = value; }, { multi: true, full: true, help: '记录这次修改的原因。原有 AI 来源会保留在历史快照中。' }));
        const actions = make('div', '', 'amin-toolbar');
        const save = button('预览保存关系', () => { api.stage('save', { relationship: draft, reason }, token); render(); }, { primary: true, mutation: true });
        actions.append(save, button('取消编辑', () => { if (api.preview()) api.discard(); clearEditor(); render(); say('已取消编辑。'); }));
        panel.append(actions); editorHost.replaceChildren(panel); editor = { kind: 'relationship', draft, token, panel, inputs, save }; updateLocks(); inputs[0]?.focus();
    }
    function openRuleEditor(rule = null) {
        if (editor) throw Error('请先保存或取消当前草稿。');
        if (locked()) throw Error('请先处理待确认操作或重试保存。');
        const draft = rule ? structuredClone(rule) : { relationshipId: state.relationships[0]?.id ?? '', operator: 'gte', value: 0, message: '', enabled: true, repeat: 'once' };
        const token = api.capture(), panel = make('section', '', 'amin-card amin-stack amin-relationship-editor'), form = make('div', '', 'amin-form-grid');
        panel.append(make('h3', rule ? '编辑关系阈值' : '新增关系阈值'), make('p', '规则保存后，仅在已确认的强度从条件外进入条件内时提醒。提醒不会自动编造事件，也不会修改其他应用。', 'amin-meta'), form);
        const choices = state.relationships.map(edge => [edge.id, description(edge) + ' · ' + (edge.label || edge.type)]);
        if (draft.relationshipId && !choices.some(([id]) => id === draft.relationshipId)) choices.push([draft.relationshipId, '原关系已不存在 · ' + draft.relationshipId]);
        const inputs = [select(form, '阈值所属关系', draft.relationshipId, [['', '请选择关系'], ...choices], value => { draft.relationshipId = value; }),
            select(form, '阈值比较方式', draft.operator, [['gte', '达到或超过'], ['lte', '降到或低于']], value => { draft.operator = value; }),
            field(form, '阈值数值', draft.value, value => { draft.value = value.trim() ? Number(value) : NaN; }, { type: 'number' }),
            select(form, '提醒频率', draft.repeat, [['once', '同一规则只提醒一次'], ['crossing', '每次重新跨越阈值时提醒']], value => { draft.repeat = value; }),
            field(form, '阈值提醒内容', draft.message, value => { draft.message = value; }, { multi: true, full: true }),
            select(form, '阈值规则状态', String(draft.enabled), [['true', '启用'], ['false', '停用']], value => { draft.enabled = value === 'true'; })];
        const actions = make('div', '', 'amin-toolbar');
        const save = button('预览保存阈值', () => { api.saveThresholdRule(draft, token); render(); }, { primary: true, mutation: true });
        actions.append(save, button('取消编辑', () => { if (api.preview()) api.discard(); clearEditor(); render(); })); panel.append(actions);
        editorHost.replaceChildren(panel); editor = { kind: 'rule', draft, token, panel, inputs, save }; updateLocks(); inputs[0]?.focus();
    }
    function renderAI() {
        const open = aiPanel.open; aiPanel.replaceChildren(make('summary', '根据剧情提出关系更新')); aiPanel.open = open;
        const count = api.context?.()?.chat?.length ?? 0;
        if (aiDraft.start === null) { aiDraft.start = String(Math.max(1, count - 5)); aiDraft.end = String(Math.max(1, count)); }
        aiPanel.append(make('p', '选择已经发生的剧情，AI 只提出带来源和原因的关系变更。核对整批预览后应用。渠道沿用 AI 设置中的“人物关系”。', 'amin-meta'));
        const form = make('div', '', 'amin-form-grid');
        const inputs = [field(form, '关系分析起始楼层', aiDraft.start, value => { aiDraft.start = value; }, { type: 'number' }),
            field(form, '关系分析结束楼层', aiDraft.end, value => { aiDraft.end = value; }, { type: 'number' }),
            field(form, '关系分析补充要求', aiDraft.instruction, value => { aiDraft.instruction = value; }, { multi: true, full: true, help: '楼层号从 1 开始，每次最多 30 楼。量表未约定时不会默认增加好感值。' })];
        for (const input of inputs) { input.dataset.mutation = 'true'; input.disabled = locked(); }
        const actions = make('div', '', 'amin-toolbar');
        const generate = button('分析所选剧情', async () => {
            if (editor) throw Error('请先保存或取消当前草稿。');
            await api.suggestUpdates({ start: Number(aiDraft.start) - 1, end: Number(aiDraft.end) - 1, instruction: aiDraft.instruction }); render();
        }, { primary: true, mutation: true, disabled: count === 0 || characters.length < 2 });
        generate.dataset.minimumPeople = 'true';
        actions.append(generate, button('取消关系分析', () => api.cancelSuggestions(), { disabled: !api.generating?.() }));
        aiPanel.append(form, actions);
        if (!count) aiPanel.append(make('p', '当前聊天没有来源楼层。', 'amin-empty'));
    }
    function renderRules() {
        const rules = state.thresholdRules ?? [], alerts = state.thresholdAlerts ?? [];
        const open = rulesPanel.open; rulesPanel.replaceChildren(make('summary', `关系阈值与提醒记录 · ${rules.length} 条规则`)); rulesPanel.open = open;
        rulesPanel.append(make('p', '旧值和新值都明确记录强度时才比较。建立或修改规则时不会补发当前已满足的条件；之后跨越阈值才提醒。', 'amin-meta'));
        rulesPanel.append(button('新增阈值规则', () => openRuleEditor(), { mutation: true, disabled: !state.relationships.length }));
        for (const rule of rules) {
            const edge = state.relationships.find(value => value.id === rule.relationshipId), item = make('article', '', 'amin-card amin-stack');
            item.append(make('h4', edge ? description(edge) + ' · ' + (edge.label || edge.type) : '原关系已不存在 · ' + rule.relationshipId), make('p', `${rule.enabled ? '启用' : '停用'} · ${rule.operator === 'gte' ? '≥' : '≤'} ${rule.value} · ${rule.repeat === 'once' ? '只提醒一次' : '每次跨越提醒'}`), make('p', rule.message, 'amin-relationship-notes'));
            const actions = make('div', '', 'amin-toolbar'); actions.append(button('编辑阈值', () => openRuleEditor(rule), { mutation: true }), button('预览删除阈值', () => { api.stage('delete-rule', { id: rule.id }); render(); }, { mutation: true })); item.append(actions); rulesPanel.append(item);
        }
        alertsPanel.replaceChildren();
        const unread = alerts.filter(alert => !alert.acknowledged);
        alertsPanel.hidden = !unread.length;
        if (unread.length) alertsPanel.append(make('h3', `关系阈值提醒 · ${unread.length} 项`), make('p', '以下是规则提示，不表示相应剧情已经发生。', 'amin-meta'));
        for (const alert of [...alerts].reverse()) {
            const item = make('article', '', 'amin-card amin-stack'), edge = state.relationships.find(value => value.id === alert.relationshipId);
            item.append(make('h4', edge ? description(edge) : '原关系 · ' + alert.relationshipId), make('p', alert.message, 'amin-relationship-notes'), make('p', `强度 ${alert.previousStrength ?? '未设'} → ${alert.strength} · 条件 ${alert.operator === 'gte' ? '≥' : '≤'} ${alert.value}${alert.acknowledged ? ' · 已读' : ''}`, 'amin-meta'));
            if (!alert.acknowledged) item.append(button('预览标记已读', () => { api.stage('acknowledge-alert', { id: alert.id }); render(); }, { mutation: true }));
            (alert.acknowledged ? rulesPanel : alertsPanel).append(item);
        }
    }
    function renderControls() {
        controls.replaceChildren(make('h3', '关系视图'));
        const form = make('div', '', 'amin-form-grid');
        const extra = [...new Set((state?.relationships ?? []).flatMap(edge => [edge.fromId, edge.toId]))].filter(id => !characters.some(item => item.id === id));
        select(form, '聚焦人物', focusId, [['', '全部人物'], ...characters.map(item => [item.id, personLabel(item)]), ...extra.map(id => [id, person(id).name])], value => { focusId = value; direction = 'all'; renderControls(); renderGraph(); renderList(); });
        const directionSelect = select(form, '关系方向', direction, [['all', '全部方向'], ['out', '该人物指向别人'], ['in', '别人指向该人物']], value => { direction = value; renderGraph(); renderList(); });
        directionSelect.disabled = !focusId;
        field(form, '搜索人物、类型或备注', query, value => { query = value; renderGraph(); renderList(); }, { full: true });
        const actions = make('div', '', 'amin-toolbar');
        const create = button('新增人物关系', () => openEditor(), { primary: true, mutation: true, disabled: characters.length < 2 }); create.dataset.minimumPeople = 'true';
        actions.append(create); controls.append(form, actions);
        if (characters.length < 2) controls.append(linkedEmpty(make, '先在人物卡建立至少两个人物，再选择关系两端。已有关系仍保留。', 'characters', { onError: error => say(error.message, true) }));
    }
    function renderGraph() {
        graphPanel.replaceChildren(make('h3', '人物关系地图'), make('p', '选中人物后突出本人和直接关联人物，其余人物淡化保留。箭头表示关系方向；分层仅表示连接远近，不代表辈分。节点网络可拖动人物调整位置，位置仅在本次查看中保留；可缩放或滚动查看大图。', 'amin-meta'));
        graphWidth = graphPanel.clientWidth || 0;
        const style = document.defaultView?.getComputedStyle?.(graphPanel);
        const availableWidth = graphWidth ? graphWidth - (parseFloat(style?.paddingLeft) || 0) - (parseFloat(style?.paddingRight) || 0) - 2 : undefined;
        select(graphPanel, '地图布局', graphLayout, [['network', '节点网络'], ['map', '分层地图'], ['ring', '圆环布局']], value => { graphLayout = value; renderGraph(); });
        if (focusId) graphPanel.append(button('取消人物聚焦', () => { focusId = ''; direction = 'all'; renderControls(); renderGraph(); renderList(); }));
        if (graphLayout === 'network') graphPanel.append(button('重置节点位置', () => { graphPositions.clear(); renderGraph(); }));
        const narrow = (availableWidth || document.defaultView?.innerWidth || 800) < 560;
        const visible = graphVisible ?? !narrow;
        graphPanel.append(button(visible ? '收起关系图' : '展开关系图', () => { graphVisible = !visible; renderGraph(); }));
        if (!visible) { graphPanel.append(make('p', '下方列表展示完整关系。可用聚焦人物、关系方向和搜索缩小范围。', 'amin-meta')); return; }
        const result = renderRelationshipGraph(document, characters, state.relationships, { focusId, layout: graphLayout, savedPositions: graphPositions, onMove: (id, point) => graphPositions.set(id, point), activeEdgeIds: filteredRelationships().map(edge => edge.id), width: availableWidth, onSelect: id => { focusId = focusId === id ? '' : id; direction = 'all'; renderControls(); renderGraph(); renderList(); controls.querySelector?.('select')?.focus(); } });
        if (!result.graph.nodes.length) { graphPanel.append(linkedEmpty(make, '还没有人物。请先在人物卡建立人物资料。', 'characters', { onError: error => say(error.message, true) })); return; }
        graphPanel.append(result.element);
        if (result.graph.omittedNodes || result.graph.omittedEdges) graphPanel.append(make('p', `图中显示 ${result.graph.nodes.length} / ${result.graph.totalNodes} 个人物、${result.graph.edges.length} / ${result.graph.totalEdges} 条关系。超过 128 人时保留聚焦人物；下方列表保留全部符合筛选的关系。`, 'amin-meta'));
    }
    function filteredRelationships() {
        const search = query.trim().toLocaleLowerCase();
        return state.relationships.filter(edge => (!focusId || (direction === 'out' ? edge.fromId === focusId : direction === 'in' ? edge.toId === focusId : edge.fromId === focusId || edge.toId === focusId)) && (!search || [person(edge.fromId).name, person(edge.toId).name, edge.type, edge.label, edge.notes].join('\n').toLocaleLowerCase().includes(search)));
    }
    function renderList() {
        listPanel.replaceChildren();
        const entries = filteredRelationships();
        listPanel.append(make('h3', `关系列表 · ${entries.length} 条`));
        if (!entries.length) { listPanel.append(make('p', state.relationships.length ? '没有符合当前筛选的关系。' : '还没有已确认的人物关系。', 'amin-empty')); return; }
        const list = make('ul', '', 'amin-stack amin-relationships-list');
        for (const edge of entries) {
            const item = make('li', '', 'amin-card amin-stack');
            item.append(make('p', description(edge), 'amin-relationship-direction'), make('p', `类型：${edge.type}${edge.label ? ' · 标签：' + edge.label : ''}`));
            item.append(make('p', `${personLabel(person(edge.fromId))} → ${personLabel(person(edge.toId))}`, 'amin-meta'));
            if (edge.strength !== undefined) item.append(make('p', '已设强度：' + edge.strength));
            if (edge.notes) item.append(make('p', edge.notes, 'amin-relationship-notes'));
            if (edge.evidence) {
                const evidence = make('details'); evidence.append(make('summary', '更新依据与来源'), make('p', edge.evidence.reason, 'amin-relationship-notes'));
                evidence.append(make('p', `${{ manual: '手动确认', ai: 'AI 建议确认', linkage: '统一联动更新' }[edge.evidence.origin]}${edge.evidence.sources.length ? ` · 第 ${edge.evidence.sources.map(source => source.index + 1).join('、')} 楼` : ' · 未绑定聊天楼层'}`, 'amin-meta'));
                if (!evidenceMatches(edge.evidence, api.context?.()?.chat ?? [])) evidence.append(make('p', '来源楼层已变化或不在当前分支，保留原来源证据；不会按同名人物或新正文替换。', 'amin-meta'));
                for (const source of edge.evidence.sources) {
                    let original = null;
                    if (source.revision.startsWith('[')) {
                        try { original = JSON.parse(source.revision)[2]; } catch { /* Damaged old evidence is reported below. */ }
                    } else if (evidenceMatches({ sources: [source] }, api.context?.()?.chat ?? [])) {
                        original = api.context?.()?.chat?.[source.index]?.mes ?? null;
                    }
                    evidence.append(make('pre', `第 ${source.index + 1} 楼：${original ?? '来源正文不在当前分支；保留来源指纹，切回原消息可查看。'}`));
                }
                item.append(evidence);
            }
            if (person(edge.fromId).missing || person(edge.toId).missing) item.append(make('p', '部分人物在当前分支不存在。保留原 ID 引用；可编辑为当前人物，不会按同名人物自动替换。', 'amin-meta'));
            const actions = make('div', '', 'amin-toolbar');
            const edit = button('编辑关系', () => openEditor(edge), { mutation: true }); edit.setAttribute('aria-label', '编辑关系：' + description(edge));
            const remove = button('预览删除', () => { if (editor) throw Error('请先保存或取消关系草稿。'); api.stage('delete', { id: edge.id }, api.capture()); render(); }, { mutation: true }); remove.setAttribute('aria-label', '预览删除：' + description(edge)); remove.className = 'amin-danger';
            actions.append(edit, remove); item.append(actions); list.append(item);
        }
        listPanel.append(list); updateLocks();
    }
    function renderReview() {
        review.replaceChildren(); const pending = api.preview(); if (!pending) return;
        const panel = make('section', '', 'amin-card amin-stack amin-result'); panel.append(make('h3', '待确认 · ' + pending.label));
        const summary = typeof pending.summary === 'string' ? pending.summary : Array.isArray(pending.summary) ? pending.summary.join('\n') : pending.summary ? JSON.stringify(pending.summary, null, 2) : '';
        if (summary) panel.append(make('p', summary, 'amin-relationship-notes'));
        if (pending.relationship) { const edge = pending.relationship; panel.append(make('p', description(edge), 'amin-relationship-direction'), make('p', `类型：${edge.type}${edge.label ? ' · 标签：' + edge.label : ''}${edge.strength !== undefined ? ' · 强度：' + edge.strength : ''}`)); if (edge.notes) panel.append(make('p', edge.notes, 'amin-relationship-notes')); }
        const actions = make('div', '', 'amin-toolbar');
        actions.append(button('确认应用一次', async () => {
            const savesEditor = ['save', 'save-rule'].includes(pending.op) && !!editor;
            try { await api.confirm(); if (savesEditor) clearEditor(); render(); say('关系操作已保存。'); }
            catch (reason) { committedEditor = savesEditor && api.dirty(); render(); throw reason; }
        }, { primary: true, disabled: api.busy() }), button('取消预览', () => { api.discard(); render(); }, { disabled: api.busy() }));
        panel.append(actions); review.append(panel);
    }
    function renderSettings() {
        const open = settingsPanel.open; settingsPanel.replaceChildren(make('summary', '上下文读取设置')); settingsPanel.open = open;
        settingsPanel.append(make('p', '默认仅本地记录。启用后，普通正文生成可读取当前分支、人物引用完整的已确认关系；草稿和其他分支不参与。', 'amin-meta'));
        if (api.managed?.()) settingsPanel.append(make('p', '当前已启用统一联动。关系上下文由世界状态的联动设置控制，此处旧读取开关暂不参与注入。', 'amin-meta'));
        if (!api.supported) settingsPanel.append(make('p', '当前宿主未提供完整的普通正文读取接口。可保存设置，宿主接口可用时才会附加关系。', 'amin-meta'));
        const row = make('label', '', 'amin-check'), input = make('input'); input.type = 'checkbox'; input.checked = !!state.settings.includeInContext; input.setAttribute('aria-label', '普通正文读取人物关系'); input.disabled = locked();
        row.append(input, make('span', '普通正文读取人物关系（当前分支、人物引用完整）')); settingsPanel.append(row);
        settingsPanel.append(button('预览读取设置', () => { if (editor) throw Error('请先保存或取消关系草稿。'); api.stage('settings', { includeInContext: input.checked }, api.capture()); render(); }, { mutation: true }));
    }
    function render() {
        if (disposed) return;
        const owner = api.context?.()?.chatMetadata; if (owner !== positionOwner) { graphPositions.clear(); positionOwner = owner; }
        try { api.capture(); state = api.read(); characters = api.characters(); unavailable = false; }
        catch (reason) {
            unavailable = true; say(reason.message, true); context.textContent = contextLine(api.context?.(), '数据不可读取');
            // Unreadable data leaves no empty cards or summary-less <details> behind.
            for (const panel of [controls, aiPanel, alertsPanel, rulesPanel, graphPanel, review, listPanel, settingsPanel, retryPanel]) { panel.replaceChildren(); panel.hidden = true; }
            updateLocks(); return;
        }
        const people = new Set([...characters.map(item => item.id), ...state.relationships.flatMap(edge => [edge.fromId, edge.toId])]);
        if (focusId && !people.has(focusId)) { focusId = ''; direction = 'all'; }
        context.textContent = contextLine(api.context?.(), '当前分支', `${characters.length} 个人物`, `${state.relationships.length} 条有向关系`, state.settings.includeInContext ? '已允许 AI 读取' : '仅本地记录');
        for (const panel of [controls, aiPanel, alertsPanel, rulesPanel, graphPanel, review, listPanel, settingsPanel, retryPanel]) panel.hidden = false;
        renderControls(); renderAI(); renderRules(); renderGraph(); renderList(); renderReview(); renderSettings(); retryPanel.replaceChildren();
        if (api.dirty()) {
            const card = make('section', '', 'amin-card amin-stack'); card.append(make('h3', '保存尚未完成'), make('p', '已确认操作保留在当前聊天内存中。重试只保存同一项变更，不重复建立关系。'), button('重试保存', async () => { await api.retrySave(); if (committedEditor) clearEditor(); render(); say('已保存此前确认的关系操作。'); }, { primary: true, disabled: api.busy() })); retryPanel.append(card);
        }
        if (editor && !api.dirty()) { try { api.check(editor.token); } catch { error = '聊天、分支或人物资料已变化。关系草稿仍在此处，可复制内容；请取消编辑后重新选择人物。'; } }
        say(error || api.status(), !!error); updateLocks();
    }
    const unsubscribe = api.subscribe(render); render();
    const Observer = document.defaultView?.ResizeObserver;
    const observer = Observer ? new Observer(() => { if (!disposed && !unavailable && state && graphPanel.clientWidth > 0 && Math.abs(graphPanel.clientWidth - graphWidth) > .5) renderGraph(); }) : null;
    observer?.observe(graphPanel);
    const selectCharacter = event => {
        if (disposed || event?.detail?.app !== 'relationships' || typeof event.detail.characterId !== 'string') return;
        focusId = event.detail.characterId; direction = 'all'; query = ''; api.sync?.(); render(); controls.querySelector?.('select')?.focus();
    };
    document.addEventListener?.('amin:select-character', selectCharacter);
    const view = { open() { if (!disposed) { api.sync?.(); render(); } }, dispose() { if (disposed) return; disposed = true; generationView.dispose(); document.removeEventListener?.('amin:select-character', selectCharacter); observer?.disconnect(); unsubscribe(); if (ownService) api.dispose(); page.remove(); mounted.delete(target); } };
    mounted.set(target, view); return view;
}
