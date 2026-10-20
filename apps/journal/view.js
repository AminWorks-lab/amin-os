import { createFormControls } from '../../ui/forms.js';
import { mountGeneration } from '../generation/view.js';
import { uuid } from '../../uuid.js';
import { STATUSES, TASK_STATUSES, CLUE_STATUSES, KINDS, TRUTHS, KNOWLEDGE_STATES, change, changeWithContext, compile, inspectEntries, filterEntries, sourceFromRange, exportRecords, parseImport,
    parsePriorImport, memoryEntries, autoSettings, configureAuto, dueRanges, currentDrafts, resolveAutoDraft } from './model.js';
import { createJournal, getSharedService } from './service.js';
import { readCurrentScene, formatGameTime } from '../scene/model.js';
import { readInventory } from '../inventory/model.js';
import { readCharacters } from '../characters/model.js';
import {contextLine} from '../shared/context-line.js';
import {linkedEmpty} from '../shared/open-app.js';
import { attachLinkageBadge } from '../linkage/badge.js';

const mounted = new WeakMap();
const tabNames = { task: '任务', clue: '线索', hook: '伏笔', chronicle: '编年史', memory: '事实与记忆', auto: '自动整理', prior: '前作参考', references: '引用预览', transfer: '导入 / 导出' };

export function mount(target, options = {}) {
    if (mounted.has(target)) return mounted.get(target);
    const doc = options.document ?? target.ownerDocument ?? document;
    const ownService = !options.api && !!options.getContext;
    const api = options.api ?? (ownService ? createJournal(options.getContext, options.ai ? { ai: options.ai } : {}) : getSharedService());
    const formControls = createFormControls(doc, { rows: 5 });
    const { make, select, checkbox, grid, toolbar } = formControls;
    const instance = 'journal-' + uuid();
    const page = make('section', '', 'amin-page amin-app-page amin-journal'), context = make('div', '', 'amin-context');
    attachLinkageBadge(context, 'journal', { getContext: () => api.context?.() });
    const tabs = make('div', '', 'amin-tabs'), notice = make('div', '', 'amin-notice'), body = make('section', '', 'amin-stack');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '剧情档案页面');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    body.id = instance + '-body'; body.setAttribute('role', 'tabpanel');
    page.append(context, tabs, notice, body); target.append(page);
    const generationView = mountGeneration(page, { modules: ['journal'], getContext: options.getContext ?? (() => api.context()), document: doc, service: options.generationService, ai: options.ai });
    let selected = options.characterId ? 'memory' : 'hook', memoryCharacterId = options.characterId ?? '', form = null, controller = null, disposed = false;
    const filters = { query: '', status: '', scope: 'current', dueOnly: false };
    const say = (text, state = '') => { if (!disposed) { notice.textContent = text; notice.dataset.state = state; } };
    const stop = () => { controller?.abort(); controller = null; };
    const touch = () => { if (form) { form.dirty = true; form.revision++; } };
    body.addEventListener('input', touch); body.addEventListener('change', touch);

    function button(parent, label, action, primary = false) {
        const element = make('button', label, primary === true ? 'amin-primary' : typeof primary === 'string' ? primary : '');
        element.type = 'button'; element.addEventListener('click', async () => {
            if (element.disabled || disposed) return;
            element.disabled = true;
            try { await action(); } catch (error) { say(error.message, 'error'); }
            finally { element.disabled = false; }
        }); parent.append(element); return element;
    }
    const field = (parent, label, value = '', multiline = false) => formControls.field(parent, label, value, { multi: multiline });
    function section(title, parent = body, className = 'amin-card amin-stack') {
        const card = make('section', '', className); if (title) card.append(make('h3', title)); parent.append(card); return card;
    }
    function go(action) {
        if (form && (form.dirty || controller)) { say('有未保存的编辑，请先保存或点击“取消编辑”。'); return; }
        stop(); form = null; action();
    }
    function finish(message) { stop(); form = null; render(); say(message, 'success'); }
    function currentTime() {
        try { const scene = readCurrentScene(api.context()); return { clock: structuredClone(scene.clock), label: scene.clock ? formatGameTime(scene.clock, scene.periods) : '' }; }
        catch { return { clock: null, label: '' }; }
    }
    function drawTabs() {
        tabs.replaceChildren();
        for (const [id, label] of Object.entries(tabNames)) {
            const element = button(tabs, label, () => go(() => { selected = id; filters.status = ''; render(); }));
            element.id = instance + '-tab-' + id; element.setAttribute('role', 'tab'); element.setAttribute('aria-controls', body.id);
            element.setAttribute('aria-selected', String(selected === id)); element.tabIndex = selected === id ? 0 : -1;
            element.addEventListener('keydown', event => {
                const ids = Object.keys(tabNames), index = ids.indexOf(id); let next;
                if (event.key === 'ArrowRight') next = ids[(index + 1) % ids.length];
                else if (event.key === 'ArrowLeft') next = ids[(index + ids.length - 1) % ids.length];
                else if (event.key === 'Home') next = ids[0]; else if (event.key === 'End') next = ids.at(-1); else return;
                event.preventDefault(); go(() => { selected = next; filters.status = ''; render(); [...tabs.children].find(tab => tab.getAttribute('aria-selected') === 'true')?.focus(); });
            });
        }
        body.setAttribute('aria-labelledby', instance + '-tab-' + selected);
    }

    function showSources(parent, entry) {
        const details = make('details'); details.append(make('summary', '来源与保存位置')); parent.append(details);
        if (entry.gameTimeText) details.append(make('p', '剧情时间：' + entry.gameTimeText, 'amin-meta'));
        if (entry.savedAt) details.append(make('p', `保存于第 ${entry.savedFloor} 楼 · ${new Date(entry.savedAt).toLocaleString()}`, 'amin-meta'));
        if (entry.sourceNote) details.append(make('p', entry.sourceNote, 'amin-meta'));
        if (entry.sources) {
            details.append(make('p', `来源：第 ${entry.sources.start + 1}–${entry.sources.end + 1} 楼（保存时的正文）`, 'amin-meta'));
            for (const source of entry.sources.messages) {
                const block = make('details'); block.append(make('summary', `第 ${source.index + 1} 楼 · ${source.name || (source.isUser ? '用户' : '角色')}`), make('pre', source.text)); details.append(block);
            }
        } else details.append(make('p', entry.kind === 'prior' ? `前作：${entry.origin?.work ?? ''} · 原档案 ${entry.origin?.recordId || '未记录'}。仅作为前作背景参考。` : '尚未绑定本聊天来源，不能启用引用。', 'amin-meta'));
        if (entry.kind === 'prior' && entry.origin?.sources) {
            const original = make('details'); original.append(make('summary', '前作保存的原文（非本聊天楼层）'));
            for (const source of entry.origin.sources.messages) original.append(make('p', `前作第 ${source.index + 1} 楼 · ${source.name}`, 'amin-meta'), make('pre', source.text));
            details.append(original);
        }
    }

    function openForm(entry = null, copy = false) {
        stop();
        const token = api.capture(), ctx = api.check(token), kind = entry?.kind ?? selected;
        const time = currentTime(), chat = ctx.chat ?? [], latestFloor = Math.max(1, chat.length), editable = entry && !copy;
        const savedClock = editable ? structuredClone(entry.gameTime) : copy ? structuredClone(entry.gameTime) : time.clock;
        const initialTimeText = editable ? entry.gameTimeText : entry?.gameTimeText || time.label;
        const state = { token, id: editable ? entry.id : uuid(), dirty: false, revision: 0, valid: true };
        form = state; body.replaceChildren();
        const card = section(`${editable ? '编辑' : '新增'}${KINDS[kind]}`), fields = grid(card);
        const title = field(fields, '标题', entry?.title ?? ''); title.maxLength = 120;
        const gameTime = field(fields, '剧情时间（可选）', initialTimeText); gameTime.maxLength = 160;
        const actors = field(fields, '关联人物（逗号分隔，可选）', entry?.actors?.join('，') ?? '');
        let hookStatus, remindAfter, recordStatus, goal, progress, deadline, reward, clueSource, confidence, task, links;
        if (['task','clue'].includes(kind)) {
            recordStatus = select(fields, '状态', Object.entries(kind === 'task' ? TASK_STATUSES : CLUE_STATUSES), entry?.status ?? (kind === 'task' ? 'open' : 'unverified'));
            links = Object.fromEntries([['characterIds','关联人物 ID'],['locationIds','关联地点 ID'],['itemIds','关联物品 ID']].map(([key,label]) => [key, field(fields, label + '（逗号分隔）', entry?.[key]?.join(', ') ?? '')]));
            const catalogs = { characterIds: readCharacters(ctx).characters, locationIds: Object.values(readCurrentScene(ctx).scenes), itemIds: readInventory(ctx).items };
            for (const [key,label] of [['characterIds','人物'],['locationIds','地点'],['itemIds','物品']]) {
                const picker = select(fields, '选择关联' + label, [['','请选择'], ...(catalogs[key] ?? []).map(item => [item.id, item.name || item.title || item.id])]);
                button(fields, '添加关联' + label, () => {
                    if (!picker.value) return;
                    const ids = links[key].value.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean);
                    links[key].value = [...new Set([...ids, picker.value])].join(', '); touch();
                });
            }
            if (kind === 'task') {
                goal = field(fields, '任务目标', entry?.goal ?? '', true);
                progress = field(fields, '进度（0–100）', entry?.progress ?? 0); progress.type = 'number'; progress.min = 0; progress.max = 100;
                deadline = field(fields, '期限（可选）', entry?.deadline ?? '');
                reward = field(fields, '奖励说明（可选）', entry?.reward ?? '', true);
            } else {
                clueSource = field(fields, '线索来源', entry?.source ?? '');
                confidence = field(fields, '可信程度（0–100）', entry?.confidence ?? 50); confidence.type = 'number'; confidence.min = 0; confidence.max = 100;
                const choices = [['','未关联任务'], ...inspectEntries(api.read(), chat).filter(item => item.current && item.kind === 'task').map(item => [item.id,item.title])];
                if (entry?.taskId && !choices.some(([id]) => id === entry.taskId)) choices.push([entry.taskId, '原任务已缺失 · ' + entry.taskId]);
                task = select(fields, '关联任务', choices, entry?.taskId ?? '');
            }
            card.append(make('p', '编号用于关联现有资料。进度与确认程度仅作记录；保存不会自动完成任务、发放奖励或更改背包。', 'amin-help'));
        }
        if (kind === 'hook') {
            hookStatus = select(fields, '伏笔状态', Object.entries(STATUSES), editable ? entry.status : 'open');
            remindAfter = field(fields, '经过多少楼层后提醒（可选）', entry?.remindAfter ?? ''); remindAfter.type = 'number'; remindAfter.min = 1; remindAfter.max = 100000; remindAfter.step = 1;
        }
        const bodyInput = field(fields, kind === 'hook' ? '伏笔内容' : kind === 'chronicle' ? '编年史正文' : '内容说明', entry?.body ?? '', true); bodyInput.maxLength = 60000;
        const sourceCard = section('绑定来源', card);
        sourceCard.append(make('p', `目前加载 ${chat.length} 个楼层，楼层号从 1 开始。来源正文会随保存一起留档。`, 'amin-help'));
        const bind = checkbox(sourceCard, '绑定当前聊天的来源楼层', editable ? !!entry.sources : chat.length > 0); bind.disabled = chat.length === 0;
        const range = grid(sourceCard), start = field(range, '起始楼层', editable && entry.sources ? entry.sources.start + 1 : latestFloor), end = field(range, '结束楼层', editable && entry.sources ? entry.sources.end + 1 : latestFloor);
        for (const input of [start, end]) { input.type = 'number'; input.min = 1; input.max = Math.max(1, chat.length); input.step = 1; }
        const sourcePreview = make('pre'); sourcePreview.hidden = true; sourceCard.append(sourcePreview);
        const reflectRange = () => { range.hidden = !bind.checked; sourcePreview.hidden = true; };
        bind.addEventListener('change', reflectRange); reflectRange();
        const rangeValues = () => { if (!bind.checked) throw Error('请先勾选绑定来源楼层'); return { start: Number(start.value) - 1, end: Number(end.value) - 1 }; };
        button(toolbar(sourceCard), '查看所选来源', () => {
            const context = api.check(token), values = rangeValues(), source = sourceFromRange(context.chat, values.start, values.end);
            sourcePreview.textContent = source.messages.map(message => `第 ${message.index + 1} 楼 · ${message.name}\n${message.text}`).join('\n\n'); sourcePreview.hidden = false;
        });
        const sourceNote = field(sourceCard, '来源备注（可选）', editable ? entry.sourceNote : copy ? `复制自档案「${entry.title}」。请核对本分支来源。` : '', true); sourceNote.maxLength = 1000;
        const reference = checkbox(card, '启用后续生成引用（当前分支）', editable && entry.enabled);
        card.append(make('p', '保存只收纳资料。勾选引用后，已确认且来源仍有效的条目才会提供给模型；伏笔提醒只显示在应用中。', 'amin-help'));
        let candidate;
        if (kind === 'chronicle') {
            const draftCard = section('AI 整理', card), instruction = field(draftCard, '整理要求（可选）', '', true);
            draftCard.append(make('p', '使用 AI 设置中“剧情档案”的渠道与预设，准确读取上方选定楼层。生成后先预览、采用，再保存。', 'amin-help'));
            const actions = toolbar(draftCard), preview = section('AI 草稿预览', draftCard, 'amin-result amin-stack'); preview.hidden = true;
            candidate = field(preview, 'AI 草稿（可修改）', '', true); candidate.maxLength = 60000;
            button(toolbar(preview), '采用草稿到正文', () => { if (form !== state || !state.valid) throw Error('编辑来源已变化，请重新打开表单'); bodyInput.value = candidate.value; touch(); say('已采用到正文，请核对并点击“保存编年史”。'); });
            const generate = button(actions, '生成编年史草稿', async () => {
                if (controller) throw Error('正在生成，请先取消当前生成');
                if (!state.valid) throw Error('来源已变化，请取消编辑后重新打开');
                api.check(token); const values = rangeValues(), baseline = state.revision, requestController = new AbortController(); controller = requestController;
                cancel.hidden = false; save.disabled = true; preview.hidden = true; say('正在整理所选楼层…', 'busy');
                try {
                    const result = await api.generateDraft(token, { ...values, title: title.value, current: bodyInput.value, instruction: instruction.value, gameTimeText: gameTime.value },
                        { signal: requestController.signal, check: () => { if (disposed || form !== state || baseline !== state.revision || !state.valid) throw Error('编辑内容已变化，旧生成结果已丢弃，请重新生成'); } });
                    if (requestController.signal.aborted || form !== state) return;
                    candidate.value = result; preview.hidden = false; say('草稿已生成，可修改后采用。点击保存才会写入档案。');
                } catch (error) { if (form === state) say(requestController.signal.aborted ? '生成已取消，原正文保持不变。' : error.message, requestController.signal.aborted ? '' : 'error'); }
                finally { if (controller === requestController) controller = null; cancel.hidden = true; save.disabled = !state.valid; }
            }, true);
            const cancel = button(actions, '取消生成', () => { controller?.abort(); }); cancel.hidden = true;
            if (!chat.length) generate.disabled = true;
        }
        const savebar = toolbar(card, 'amin-savebar');
        const save = button(savebar, '保存' + KINDS[kind], async () => {
            if (controller) throw Error('请先完成或取消生成');
            if (!state.valid) throw Error('来源已变化，请取消编辑后重新打开');
            const context = api.check(token), values = bind.checked ? rangeValues() : null;
            const record = { id: state.id, kind, title: title.value, body: bodyInput.value, actors: actors.value.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean),
                enabled: reference.checked, sources: values ? sourceFromRange(context.chat, values.start, values.end) : null,
                sourceNote: sourceNote.value, gameTime: gameTime.value === initialTimeText ? savedClock : null, gameTimeText: gameTime.value,
                ...(['task','clue'].includes(kind) ? { status: recordStatus.value, ...Object.fromEntries(Object.entries(links).map(([key,input]) => [key,input.value.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean)])) } : {}),
                ...(kind === 'task' ? { goal: goal.value, progress: Number(progress.value), deadline: deadline.value, reward: reward.value } : {}),
                ...(kind === 'clue' ? { source: clueSource.value, confidence: Number(confidence.value), taskId: task.value || null } : {}),
                ...(kind === 'hook' ? { status: hookStatus.value, remindAfter: remindAfter.value } : {}) };
            await api.save(token, store => change(store, context.chat, editable ? 'update' : 'create', record, token.operationId));
            if (form === state) finish('已保存' + (record.enabled ? '并启用引用。' : '，引用保持关闭。'));
        }, true);
        button(savebar, '取消编辑', () => { stop(); form = null; render(); say('已取消编辑。'); });
        title.focus(); say('编辑中；来源变化或切换聊天会使当前操作失效。');
    }

    function deleteForm(entry) {
        const token = api.capture(); form = { dirty: false, revision: 0, token, valid: true }; body.replaceChildren();
        const card = section('删除档案：' + entry.title);
        card.append(make('p', '删除后，本分支当前楼层及之后不再显示或引用此条目。更早楼层和其他分支的记录保留。'));
        const actions = toolbar(card);
        button(actions, '确认删除', async () => { const ctx = api.check(token); await api.save(token, store => change(store, ctx.chat, 'delete', { id: entry.id }, token.operationId)); finish('档案已删除。'); }, 'amin-danger');
        button(actions, '取消编辑', () => { form = null; render(); });
    }

    function drawEntries() {
        const ctx = api.context(), store = api.read(), entries = inspectEntries(store, ctx?.chat ?? []), tools = toolbar(body);
        button(tools, '新增' + KINDS[selected], () => openForm(), true);
        button(tools, '刷新', render);
        const controls = grid(body), query = field(controls, '搜索标题、正文或人物', filters.query); query.type = 'search';
        const scope = select(controls, '显示范围', [['current', '当前分支'], ['inactive', '来源变化 / 其他分支'], ['all', '全部保存记录']], filters.scope);
        let status, due;
        if (['task','clue'].includes(selected)) status = select(controls, '状态筛选', [['','全部状态'], ...Object.entries(selected === 'task' ? TASK_STATUSES : CLUE_STATUSES)], filters.status);
        if (selected === 'hook') {
            status = select(controls, '状态筛选', [['', '全部状态'], ...Object.entries(STATUSES)], filters.status);
            due = checkbox(controls, '只看已到提醒间隔的伏笔', filters.dueOnly);
        }
        // Search and filters appear once this kind has records; an empty kind shows only its empty state and add button.
        controls.hidden = !entries.some(entry => entry.kind === selected);
        const list = make('div', '', 'amin-stack'); body.append(list);
        function drawList() {
            list.replaceChildren(); const matching = filterEntries(entries, { ...filters, kind: selected });
            if (!matching.length) { list.append(make('p', entries.some(entry => entry.kind === selected) ? '没有匹配条目，试试调整筛选条件。' : selected === 'hook' ? '还没有伏笔。记下一个线索，或先选择它的来源楼层。' : selected === 'chronicle' ? '还没有编年史。选定一段对话后，可以手工记录或让 AI 起草摘要。' : `还没有${KINDS[selected]}，点击上方新增。`, 'amin-empty')); return; }
            for (const entry of [...matching].reverse()) {
                const card = section(entry.title, list), labels = [entry.kind === 'hook' ? STATUSES[entry.status] : entry.kind === 'task' ? TASK_STATUSES[entry.status] : entry.kind === 'clue' ? CLUE_STATUSES[entry.status] : '已保存', entry.current ? '当前分支' : '原分支记录', entry.enabled && !entry.stale ? '引用已启用' : '不参与引用'];
                if (entry.due) labels.push('已到提醒间隔'); if (entry.gameTimeText) labels.push(entry.gameTimeText);
                card.append(make('p', labels.join(' · '), 'amin-meta'), make('pre', entry.body));
                if (entry.kind === 'task') card.append(make('p', `目标：${entry.goal} · 进度：${entry.progress}%`, 'amin-meta'), make('p', `期限：${entry.deadline || '未设定'} · 奖励说明：${entry.reward || '未设定'}`, 'amin-meta'));
                if (entry.kind === 'clue') card.append(make('p', `来源：${entry.source || '未注明'} · 可信程度：${entry.confidence}% · 关联任务：${entries.find(item => item.current && item.kind === 'task' && item.id === entry.taskId)?.title ?? (entry.taskId ? '已缺失 (' + entry.taskId + ')' : '无')}`, 'amin-meta'));
                if (['task','clue'].includes(entry.kind)) for (const [key,label] of [['characterIds','人物'],['locationIds','地点'],['itemIds','物品']]) if (entry[key]?.length) card.append(make('p', `关联${label}编号：${entry[key].join('、')}`, 'amin-meta'));
                if (entry.actors.length) card.append(make('p', '关联人物：' + entry.actors.join('、'), 'amin-meta'));
                if (entry.stale) card.append(make('p', entry.staleReason + '；不会附加到生成中。', 'amin-notice'));
                showSources(card, entry); const actions = toolbar(card);
                if (entry.current) {
                    button(actions, '编辑', () => openForm(entry));
                    button(actions, entry.enabled ? '关闭引用' : '启用引用', async () => {
                        const token = api.capture(), context = api.check(token);
                        await api.save(token, s => change(s, context.chat, 'reference', { id: entry.id, enabled: !entry.enabled }, token.operationId));
                        finish(entry.enabled ? '已关闭此条目的引用。' : '已启用此条目的后续生成引用。');
                    });
                    if (entry.kind === 'hook') for (const [state, label] of Object.entries(STATUSES)) if (state !== entry.status) button(actions, '标为' + label, async () => {
                        const token = api.capture(), context = api.check(token);
                        await api.save(token, s => change(s, context.chat, 'update', { ...entry, status: state }, token.operationId)); finish('伏笔已标为' + label + '。');
                    });
                    button(actions, '删除', () => deleteForm(entry), 'amin-danger');
                } else button(actions, '复制内容为本分支新条目', () => openForm(entry, true));
            }
        }
        query.addEventListener('input', () => { filters.query = query.value; drawList(); });
        scope.addEventListener('change', () => { filters.scope = scope.value; drawList(); });
        status?.addEventListener('change', () => { filters.status = status.value; drawList(); });
        due?.addEventListener('change', () => { filters.dueOnly = due.checked; drawList(); }); drawList();
    }

    function bindMemorySources(card, entry, ctx) {
        const chat = ctx.chat ?? [], sourceCard = section('获知或确认的来源楼层', card), values = grid(sourceCard);
        const bind = checkbox(sourceCard, '绑定当前聊天的来源楼层', entry ? !!entry.sources : chat.length > 0); bind.disabled = !chat.length;
        const start = field(values, '起始楼层', entry?.sources ? entry.sources.start + 1 : Math.max(1, chat.length));
        const end = field(values, '结束楼层', entry?.sources ? entry.sources.end + 1 : Math.max(1, chat.length));
        for (const input of [start, end]) { input.type = 'number'; input.min = 1; input.max = Math.max(1, chat.length); input.step = 1; }
        const sourceNote = field(sourceCard, '来源说明', entry?.sourceNote ?? '', true); sourceNote.maxLength = 1000;
        return context => ({ sources: bind.checked ? sourceFromRange(context.chat, Number(start.value) - 1, Number(end.value) - 1) : null, sourceNote: sourceNote.value });
    }

    function openMemoryForm(kind, entry = null) {
        stop(); const token = api.capture(), ctx = api.check(token), time = currentTime(), people = readCharacters(ctx).characters;
        const facts = inspectEntries(api.read(), ctx.chat).filter(item => item.kind === 'fact' && item.current);
        form = { dirty: false, revision: 0, token, valid: true }; const state = form; body.replaceChildren();
        const card = section((entry ? '编辑' : '新增') + (kind === 'fact' ? '事实' : '人物记忆')), fields = grid(card);
        let title, content, truth, person, fact, known, confidence, belief, learnedFrom, learnedAt;
        if (kind === 'fact') {
            title = field(fields, '事实标题', entry?.title ?? ''); title.maxLength = 120;
            content = field(fields, '事实内容', entry?.body ?? '', true); content.maxLength = 60000;
            truth = select(fields, '确认程度', Object.entries(TRUTHS), entry?.truth ?? 'confirmed');
            card.append(make('p', '事实只保存一份；人物可以知情、听到不同传闻或遗忘它。未证实内容不会自动成为确定事实。', 'amin-help'));
        } else {
            const personChoices = [['', '请选择人物'], ...people.map(item => [item.id, `${item.name} · ${item.id}`])];
            if (entry && !people.some(item => item.id === entry.characterId)) personChoices.push([entry.characterId, `人物已缺失 · ${entry.characterId}`]);
            person = select(fields, '人物', personChoices, entry?.characterId ?? memoryCharacterId);
            const factChoices = [['', '请选择事实'], ...facts.map(item => [item.id, item.title])];
            if (entry && !facts.some(item => item.id === entry.factId)) factChoices.push([entry.factId, `事实已缺失 · ${entry.factId}`]);
            fact = select(fields, '关联事实', factChoices, entry?.factId ?? '');
            known = select(fields, '认知状态', Object.entries(KNOWLEDGE_STATES), entry?.state ?? 'known');
            confidence = field(fields, '可信程度（0–100）', entry?.confidence ?? 100); confidence.type = 'number'; confidence.min = 0; confidence.max = 100;
            belief = field(fields, '人物理解或传闻内容（可选）', entry?.belief ?? '', true); belief.maxLength = 6000;
            const sourceChoices = [['', '亲历 / 其他来源'], ...people.map(item => [item.id, `${item.name} · ${item.id}`])];
            if (entry?.learnedFromId && !people.some(item => item.id === entry.learnedFromId)) sourceChoices.push([entry.learnedFromId, `人物已缺失 · ${entry.learnedFromId}`]);
            learnedFrom = select(fields, '从谁得知', sourceChoices, entry?.learnedFromId ?? '');
            learnedAt = field(fields, '获知时间', entry?.learnedAtText ?? time.label); learnedAt.maxLength = 160;
            card.append(make('p', '人物按稳定编号关联。留空“人物理解”表示与事实内容一致；传闻可信程度表示该人物的判断。遗忘保留历史，不删除事实。', 'amin-help'));
        }
        const sources = bindMemorySources(card, entry, ctx), enabled = checkbox(card, '启用后续生成引用（当前分支）', entry?.enabled ?? false);
        card.append(make('p', '此开关同时控制普通生成与统一联动的资料读取。事实和人物记忆分别启用；记忆不能通过关联编号公开未启用的事实正文。', 'amin-help'));
        const actions = toolbar(card, 'amin-savebar');
        button(actions, kind === 'fact' ? '保存事实' : '保存人物记忆', async () => {
            if (!state.valid) throw Error('来源已变化，请取消编辑后重新打开');
            const context = api.check(token), currentFacts = inspectEntries(api.read(), context.chat), selectedFact = kind === 'knowledge' ? currentFacts.find(item => item.id === fact.value && item.kind === 'fact' && item.current) : null;
            const record = { ...(entry ?? {}), id: entry?.id ?? uuid(), kind, ...sources(context), enabled: enabled.checked,
                ...(kind === 'fact' ? { title: title.value, body: content.value, truth: truth.value } : { title: selectedFact?.title ?? entry?.title ?? '人物记忆', body: '', factId: fact.value,
                    characterId: person.value, state: known.value, confidence: Number(confidence.value), belief: belief.value, learnedFromId: learnedFrom.value || null,
                    learnedAtText: learnedAt.value, gameTime: learnedAt.value === time.label ? time.clock : learnedAt.value === entry?.learnedAtText ? entry?.gameTime ?? null : null }) };
            await api.save(token, store => changeWithContext(store, context, entry ? 'update' : 'create', record, token.operationId));
            finish('已保存' + (kind === 'fact' ? '事实。' : '人物记忆。'));
        }, true);
        button(actions, '取消编辑', () => { form = null; render(); });
    }

    function drawMemory() {
        const ctx = api.context(), entries = inspectEntries(api.read(), ctx.chat), facts = entries.filter(item => item.kind === 'fact' && item.current), people = readCharacters(ctx).characters;
        const tools = toolbar(body); button(tools, '新增事实', () => openMemoryForm('fact'), true);
        button(tools, '新增人物记忆', () => openMemoryForm('knowledge')).disabled = !facts.length || !people.length;
        body.append(make('p', '事实与人物认知分别记录。先建立事实，再登记谁知道、如何得知、传闻可信度和遗忘状态；未登记不代表所有人都知道。', 'amin-help'));
        const choices = [['', '所有人物'], ...people.map(item => [item.id, `${item.name} · ${item.id}`])];
        if (memoryCharacterId && !people.some(item => item.id === memoryCharacterId)) choices.push([memoryCharacterId, `人物已缺失 · ${memoryCharacterId}`]);
        const filter = select(body, '筛选人物记忆', choices, memoryCharacterId);
        filter.addEventListener('change', () => { memoryCharacterId = filter.value; render(); });
        if (!people.length) body.append(linkedEmpty(make, '请先在人物卡建立人物，再登记记忆。', 'characters', { onError: error => say(error.message, 'error') }));
        const factList = section(`事实 · ${facts.length} 条`);
        if (!facts.length) factList.append(make('p', '尚未登记事实。', 'amin-empty'));
        for (const entry of facts) {
            const card = section(entry.title, factList); card.append(make('p', `${TRUTHS[entry.truth]} · ${entry.id} · ${entry.enabled && !entry.stale ? '引用已启用' : '不参与引用'}`, 'amin-meta'), make('pre', entry.body));
            showSources(card, entry); const actions = toolbar(card);
            button(actions, '编辑事实', () => openMemoryForm('fact', entry)); button(actions, '删除事实', () => deleteForm(entry), 'amin-danger');
        }
        const memories = memoryEntries(ctx, { characterId: memoryCharacterId }), list = section(`人物记忆 · ${memories.length} 条`);
        if (!memories.length) list.append(make('p', '没有匹配的人物记忆。', 'amin-empty'));
        for (const entry of memories) {
            const card = section(`${entry.characterName} · ${entry.fact?.title ?? entry.title}`, list);
            card.append(make('p', `${KNOWLEDGE_STATES[entry.state]} · 可信程度 ${entry.confidence}% · ${entry.learnedAtText || '获知时间未填'}`, 'amin-meta'), make('pre', entry.belief || entry.fact?.body || '关联事实不可用'));
            if (entry.learnedFromId) card.append(make('p', '从谁得知：' + entry.learnedFromName, 'amin-meta'));
            if (entry.missing.length) card.append(make('p', entry.missing.join('；') + '；请手动核对编号，不会自动按姓名替换。', 'amin-notice'));
            if (entry.fact?.stale) card.append(make('p', '关联事实来源未绑定或已变化，不能作为有效引用。', 'amin-notice'));
            showSources(card, entry); const actions = toolbar(card);
            button(actions, '编辑记忆', () => openMemoryForm('knowledge', entry));
            if (entry.state !== 'forgotten') button(actions, '标记遗忘', async () => {
                const token = api.capture(), context = api.check(token);
                await api.save(token, store => changeWithContext(store, context, 'update', { ...entry, state: 'forgotten' }, token.operationId)); finish('已标记遗忘，原有事实与历史仍保留。');
            });
            button(actions, '删除记忆', () => deleteForm(entry), 'amin-danger');
        }
    }

    function openAutoDraft(draft) {
        const token = api.capture(); form = { dirty: false, revision: 0, token, valid: true }; const state = form; body.replaceChildren();
        const card = section('审核自动编年史草稿'), title = field(card, '草稿标题', draft.title), content = field(card, '草稿正文', draft.body, true);
        title.maxLength = 120; content.maxLength = 60000; showSources(card, draft);
        card.append(make('p', '确认后新增一条编年史，引用保持关闭；不会覆盖已有编年史。', 'amin-help'));
        const actions = toolbar(card, 'amin-savebar');
        button(actions, '确认保存编年史', async () => {
            if (controller || !state.valid) throw Error('请先等待生成完成，或在来源变化后重新打开草稿');
            const ctx = api.check(token); await api.save(token, store => resolveAutoDraft(store, ctx.chat, draft.id, 'accept', { title: title.value, body: content.value }, token.operationId)); finish('草稿已确认保存，引用保持关闭。');
        }, true);
        button(actions, '重新生成该范围', async () => {
            if (state.dirty) throw Error('草稿有未保存修改，请先确认保存或取消编辑');
            if (controller) throw Error('正在生成，请稍候');
            api.check(token); const request = new AbortController(); controller = request;
            try { await api.generateAutoDraft({ draftId: draft.id, signal: request.signal }); if (form === state && !request.signal.aborted) finish('已更新同一范围的待确认草稿。'); }
            finally { if (controller === request) controller = null; }
        });
        button(actions, '忽略该范围', async () => {
            if (controller) throw Error('请先取消生成'); const ctx = api.check(token);
            await api.save(token, store => resolveAutoDraft(store, ctx.chat, draft.id, 'dismiss', {}, token.operationId)); finish('已忽略此范围，不会重复自动生成。');
        });
        button(actions, '取消编辑', () => { stop(); form = null; render(); });
    }

    function drawAuto() {
        const store = api.read(), ctx = api.context(), settings = autoSettings(store), token = api.capture(), card = section('自动编年史');
        card.append(make('p', '默认关闭。每累计指定楼层，使用“剧情档案”的 AI 渠道产生待确认草稿；只在正常对话生成完成后检查，每次整理一个待处理范围。草稿确认前不参与剧情引用。', 'amin-help'));
        const enabled = checkbox(card, '启用自动编年史', settings.enabled), fields = grid(card), every = field(fields, '每多少楼整理一次', settings.every), start = field(fields, '从第几楼开始累计', store.autoChronicle ? settings.start + 1 : ctx.chat.length + 1);
        every.type = start.type = 'number'; every.min = 2; every.max = 1000; every.step = start.step = 1; start.min = 1;
        const instruction = field(card, '自动整理要求', settings.instruction, true); instruction.maxLength = 4000;
        for (const input of [enabled, every, start, instruction]) for (const event of ['input', 'change']) input.addEventListener(event, () => { form ??= { dirty: true, revision: 0, token, valid: true }; touch(); });
        const actions = toolbar(card);
        button(actions, '保存自动整理设置', async () => {
            api.check(token); await api.save(token, current => configureAuto(current, { enabled: enabled.checked, every: Number(every.value), start: Number(start.value) - 1, instruction: instruction.value })); finish('自动整理设置已保存。');
        }, true);
        button(actions, '取消编辑', () => { form = null; render(); });
        const due = dueRanges(store, ctx.chat); card.append(make('p', `已到间隔但尚未整理：${due.length} 段。`, 'amin-meta'));
        const generate = button(actions, '生成下一段待确认草稿', async () => {
            if (form?.dirty) throw Error('请先保存自动整理设置');
            await api.generateAutoDraft(); if (!disposed && !form) render(); say(api.status());
        }); generate.disabled = !due.length || api.autoBusy?.();
        const drafts = currentDrafts(store, ctx.chat).filter(draft => draft.status === 'ready'), list = section(`待确认草稿 · ${drafts.length} 条`);
        if (!drafts.length) list.append(make('p', '没有待确认草稿。已确认或忽略的相同范围不会重复提交。', 'amin-empty'));
        for (const draft of drafts) {
            const row = section(draft.title, list); row.append(make('p', `来源：第 ${draft.sources.start + 1}–${draft.sources.end + 1} 楼`, 'amin-meta'), make('pre', draft.body));
            button(toolbar(row), '审核草稿', () => openAutoDraft(draft), true);
        }
    }

    function openPriorReference(entry) {
        const token = api.capture(); form = { dirty: false, revision: 0, token, valid: true }; const state = form; body.replaceChildren();
        const card = section('核对前作参考'), title = field(card, '参考标题', entry.title), content = field(card, '参考内容', entry.body, true);
        title.maxLength = 120; content.maxLength = 60000;
        card.append(make('p', `前作：${entry.origin.work} · 原档案：${entry.origin.recordId || '未记录'}\n${entry.origin.sourceNote}`, 'amin-meta'));
        const confirmed = checkbox(card, '我已核对来源，将这些内容仅作为前作背景参考', false), enabled = checkbox(card, '启用后续生成引用（当前分支）', entry.enabled);
        const actions = toolbar(card, 'amin-savebar');
        button(actions, '确认前作引用范围', async () => {
            if (!state.valid || !confirmed.checked) throw Error('请先核对并勾选前作来源确认');
            const ctx = api.check(token); await api.save(token, store => change(store, ctx.chat, 'update', { ...entry, title: title.value, body: content.value, enabled: enabled.checked, explicitReference: true }, token.operationId)); finish('前作参考已保存。');
        }, true);
        button(actions, '取消编辑', () => { form = null; render(); });
    }

    function drawPrior() {
        const entries = inspectEntries(api.read(), api.context().chat).filter(entry => entry.kind === 'prior' && entry.current), importCard = section('选用前作剧情档案');
        importCard.append(make('p', '粘贴前作导出的剧情档案，选择需要的条目并明确确认。前作保留原作来源，不伪装成本聊天的来源楼层，不自动改变当前人物、物品或世界状态。', 'amin-help'));
        const work = field(importCard, '前作名称'), sourceNote = field(importCard, '前作来源说明', '', true), raw = field(importCard, '前作剧情档案 JSON', '', true);
        work.maxLength = 120; sourceNote.maxLength = 2000; const preview = make('div', '', 'amin-stack'); importCard.append(preview);
        for (const input of [work, sourceNote, raw]) input.addEventListener('input', () => { preview.replaceChildren(); form = { dirty: true, revision: 0 }; });
        button(toolbar(importCard), '预览并选择前作条目', () => {
            const records = parsePriorImport(raw.value, { work: work.value, sourceNote: sourceNote.value }), token = api.capture(), baseline = JSON.stringify([raw.value, work.value, sourceNote.value]);
            if (!records.length) throw Error('前作档案没有可选择的条目');
            form = { dirty: true, revision: 0, token, valid: true }; preview.replaceChildren();
            const selectedRecords = records.map(record => {
                const card = section(record.title, preview), checked = checkbox(card, '选用：' + record.title, false); card.append(make('pre', record.body)); return { record, checked };
            });
            const confirm = checkbox(preview, '我已核对前作来源，仅选用勾选的条目作为背景', false);
            button(toolbar(preview), '确认保存选中的前作条目', async () => {
                if (!confirm.checked) throw Error('请先勾选前作来源确认');
                if (baseline !== JSON.stringify([raw.value, work.value, sourceNote.value])) throw Error('前作资料已修改，请重新预览');
                const chosen = selectedRecords.filter(item => item.checked.checked).map(item => item.record);
                if (!chosen.length) throw Error('请至少选择一个前作条目');
                const ctx = api.check(token); await api.save(token, store => chosen.reduce((next, record, index) => change(next, ctx.chat, 'create', record, token.operationId + ':' + index), store));
                finish(`已保存 ${chosen.length} 条前作参考，引用保持关闭，可逐条启用。`);
            }, true);
        });
        button(toolbar(importCard), '取消编辑', () => { form = null; render(); });
        const list = section(`已选用的前作参考 · ${entries.length} 条`);
        for (const entry of entries) {
            const card = section(entry.title, list); card.append(make('p', `${entry.origin.work} · ${entry.enabled && !entry.stale ? '引用已启用' : '不参与引用'}`, 'amin-meta'), make('pre', entry.body)); showSources(card, entry);
            const actions = toolbar(card); button(actions, '核对并设置引用', () => openPriorReference(entry));
            if (entry.enabled) button(actions, '关闭前作引用', async () => { const token = api.capture(), ctx = api.check(token); await api.save(token, store => change(store, ctx.chat, 'reference', { id: entry.id, enabled: false }, token.operationId)); finish('已关闭前作引用。'); });
            button(actions, '删除前作参考', () => deleteForm(entry), 'amin-danger');
        }
    }

    function drawReferences() {
        const store = api.read(), ctx = api.context(), all = inspectEntries(store, ctx?.chat ?? []), active = all.filter(entry => entry.current && !entry.stale && entry.enabled);
        const card = section(`当前引用 · ${active.length} 条`);
        card.append(make('p', '以下内容会用于当前分支的后续生成。关闭单条引用即可停止附加；来源变动后的记录自动排除。', 'amin-help'));
        if (!api.supported) card.append(make('p', '当前前端缺少聊天提示接口；仍可管理记录、预览和复制。', 'amin-notice'));
        let prompt;
        try { prompt = compile(store, ctx?.chat ?? []); } catch (error) { prompt = error.message; say(prompt, 'error'); }
        card.append(make('pre', prompt || '没有启用引用的有效条目。'));
        if (prompt) button(toolbar(card), '复制引用预览', async () => { const clipboard = doc.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard; if (!clipboard?.writeText) throw Error('剪贴板不可用，请手动选择预览文字复制'); await clipboard.writeText(prompt); say('已复制引用预览。'); });
    }

    function drawTransfer() {
        const exportCard = section('导出当前分支'), output = field(exportCard, '剧情档案 JSON', exportRecords(api.read(), api.context()?.chat ?? []), true); output.readOnly = true;
        exportCard.append(make('p', '导出当前分支仍存在的档案及保存时的来源正文。其他分支与删除历史不包含在导出文件中。', 'amin-help'));
        const exportActions = toolbar(exportCard);
        button(exportActions, '复制 JSON', async () => { const clipboard = doc.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard; if (!clipboard?.writeText) { output.focus(); output.select(); throw Error('剪贴板不可用，已选中文本，请手动复制'); } await clipboard.writeText(output.value); say('已复制当前分支档案。'); });
        const importCard = section('导入到当前聊天'), raw = field(importCard, '粘贴剧情档案 JSON', '', true);
        importCard.append(make('p', '导入先预览，明确保存后才写入。每条导入记录的引用默认关闭，需要重新绑定当前聊天来源才可启用。', 'amin-help'));
        const preview = make('div', '', 'amin-stack'); importCard.append(preview);
        raw.addEventListener('input', () => { preview.replaceChildren(); form = { dirty: !!raw.value.trim(), revision: 0 }; });
        button(toolbar(importCard), '验证并预览导入', () => {
            const records = parseImport(raw.value), token = api.capture(), baseline = raw.value; preview.replaceChildren();
            form = { dirty: true, revision: 0, token, valid: true };
            if (!records.length) throw Error('导入内容没有档案');
            preview.append(make('p', `即将导入 ${records.length} 条；引用全部关闭。`, 'amin-notice'));
            for (const record of records) { const row = section(KINDS[record.kind] + ' · ' + record.title, preview); row.append(make('pre', record.body)); }
            button(toolbar(preview), '确认保存导入', async () => {
                if (baseline !== raw.value) throw Error('导入内容已变动，请重新验证');
                const context = api.check(token);
                await api.save(token, store => records.reduce((next, record, index) => change(next, context.chat, 'create', record, token.operationId + ':' + index), store));
                finish(`已导入 ${records.length} 条档案，引用保持关闭。`);
            }, true);
        });
        button(toolbar(importCard), '取消编辑', () => { form = null; render(); say('已取消导入。'); });
    }

    function render() {
        if (disposed) return;
        stop(); form = null; body.replaceChildren(); drawTabs();
        const ctx = api.context(); context.textContent = contextLine(ctx, `当前加载 ${ctx?.chat?.length ?? 0} 楼`);
        if (!ctx?.chatMetadata || ctx?.getCurrentChatId?.() == null) { body.append(make('p', '打开一个聊天后，即可管理它的伏笔与编年史。', 'amin-empty')); return; }
        try { if (selected === 'references') drawReferences(); else if (selected === 'transfer') drawTransfer(); else if (selected === 'memory') drawMemory(); else if (selected === 'auto') drawAuto(); else if (selected === 'prior') drawPrior(); else drawEntries(); }
        catch (error) { say(error.message, 'error'); }
    }
    const unsubscribe = api.subscribe(event => {
        if (disposed) return;
        if (event?.type === 'chat') { stop(); form = null; filters.query = ''; filters.status = ''; filters.scope = 'current'; filters.dueOnly = false; render(); say(api.status()); }
        else if (event?.type === 'source' && form) { form.valid = false; stop(); say('来源楼层已变化，当前编辑无法保存。请复制需要保留的草稿，再取消编辑并重新绑定来源。', 'error'); }
        else if (!form && event?.type !== 'prompt') { render(); say(api.status(), event?.error ? 'error' : ''); }
        else if (!form) say(api.status());
    });
    function selectCharacter(event) {
        if (event?.detail?.app !== 'journal' || typeof event.detail.characterId !== 'string') return;
        go(() => { selected = 'memory'; memoryCharacterId = event.detail.characterId; render(); });
    }
    doc.addEventListener?.('amin:select-character', selectCharacter);
    const view = { open(options = {}) { if (!form) { if (options.tab && Object.hasOwn(tabNames, options.tab)) selected = options.tab; if (options.characterId) { selected = 'memory'; memoryCharacterId = options.characterId; } render(); } }, dispose() { if (disposed) return; disposed = true; generationView.dispose(); stop(); unsubscribe(); doc.removeEventListener?.('amin:select-character', selectCharacter); if (ownService) api.dispose(); page.remove(); mounted.delete(target); } };
    mounted.set(target, view); render(); say(api.status()); return view;
}
