import { createFormControls } from '../../ui/forms.js';
import { mountGeneration } from '../generation/view.js';
import { uuid } from '../../uuid.js';
import { createCharactersService, getSharedCharactersService } from './service.js';
import { createDiceService, getSharedDiceService } from '../dice/service.js';
import { KNOWLEDGE_STATES } from '../journal/model.js';
import { attachLinkageBadge } from '../linkage/badge.js';

const mounted = new WeakMap();
const componentNames = { value: '数值', current: '当前值', max: '最大值' };
const checkNames = { none: '只显示数值', d20: 'D20（绑定值作为修正）', coc: 'CoC 7（绑定值作为技能）' };

export function mount(target, options = {}) {
    if (!target) throw Error('缺少人物卡容器。');
    if (mounted.has(target)) return mounted.get(target);
    const doc = options.document ?? target.ownerDocument ?? globalThis.document;
    const ownsService = !options.service && !options.api && !!options.getContext;
    const api = options.service ?? options.api ?? (ownsService ? createCharactersService(options.getContext) : getSharedCharactersService());
    const ownsDice = !options.diceService && !options.dice && !!options.getContext;
    const dice = options.diceService ?? options.dice ?? (ownsDice ? createDiceService(options.getContext) : getSharedDiceService());
    const formControls = createFormControls(doc, { register: node => controls.add({ node, blocked: () => node.dataset.fixed === 'true' || !!(form?.committed && api.dirty?.()) }) });
    const { make, select, grid, toolbar } = formControls;
    const page = make('section', '', 'amin-ui amin-app-page amin-characters');
    const context = make('div', '', 'amin-context'), notice = make('div', '', 'amin-notice');
    attachLinkageBadge(context, 'characters', { document: doc, getContext: () => api.context() });
    const body = make('div', '', 'amin-stack'), recovery = make('div', '', 'amin-toolbar');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    page.append(context, notice, body, recovery); target.append(page);
    const generationView = mountGeneration(page, { modules: ['characters'], getContext: options.getContext ?? (() => api.context()), document: doc, service: options.generationService, ai: options.ai });
    let disposed = false, running = false, form = null, selected = '', filter = '', contextStamp = '', deferredRefresh = false;
    const controls = new Set();
    const say = (text, state = '') => { if (!disposed) { notice.textContent = text; notice.dataset.state = state; } };
    const stamp = () => { const ctx = api.context(); return JSON.stringify([ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null, ctx?.characterId ?? null, ctx?.groupId ?? null]); };
    let metadata = api.context()?.chatMetadata;
    function updateContext() {
        const ctx = api.context();
        context.textContent = `当前聊天：${ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? '尚未打开'} · 当前分支人物卡 · 数值读取世界状态`;
    }
    function reflect() {
        const busy = running || !!api.busy?.() || !!dice.busy?.();
        page.setAttribute('aria-busy', String(busy));
        for (const control of controls) control.node.disabled = busy || !!control.blocked?.();
    }
    async function action(fn) {
        if (disposed || running) return;
        running = true; reflect();
        try { await fn(); }
        catch (error) { say(error?.message ?? String(error), 'error'); }
        finally { running = false; if (!disposed) { drawRecovery(); reflect(); } }
    }
    function button(parent, label, fn, { primary = false, danger = false, blocked } = {}) {
        const node = make('button', label, primary ? 'amin-primary' : danger ? 'amin-danger' : ''); node.type = 'button';
        const control = { node, blocked }; controls.add(control);
        node.addEventListener('click', () => { if (!node.disabled) void action(fn); }); parent.append(node); return node;
    }
    const field = (parent, label, value = '', multiline = false) => formControls.field(parent, label, value, { multi: multiline });
    function card(parent, title, cls = 'amin-card amin-stack') {
        const node = make('section', '', cls); if (title) node.append(make('h3', title)); parent.append(node); return node;
    }
    function clearBody() { controls.clear(); body.replaceChildren(); }
    const writable = () => !!api.dirty?.();
    function releasePreview(state) {
        if (state?.preview && JSON.stringify(api.preview?.()) === state.preview) api.discard?.();
        if (state) state.preview = null;
    }
    function finish(message) { form = null; render(); if (message) say(message, 'success'); }
    function cancel() { releasePreview(form); finish('已取消编辑。'); }
    function drawRecovery() {
        // Rebuilding only this small region leaves an open form and its focus intact.
        for (const control of [...controls]) if (control.recovery) controls.delete(control);
        recovery.replaceChildren();
        const before = new Set(controls);
        if (api.dirty?.()) button(recovery, '重试保存已确认的操作', async () => {
            const active = form;
            await api.retrySave();
            if (form === active && active?.committed) finish('人物与数值已保存。');
            else { say(api.status?.() || '人物与数值已保存。', 'success'); if (!form) render(); }
        });
        if (dice.dirty?.()) button(recovery, '重试保存固定骰点', async () => { await dice.retrySave(); say('固定骰点已保存，可以追加到聊天草稿。', 'success'); });
        for (const control of controls) if (!before.has(control)) control.recovery = true;
    }
    function openCharacter(character = null) {
        const token = api.capture(), state = { token, type: 'character', id: character?.id ?? uuid(), committed: false };
        form = state; clearBody();
        const panel = card(body, character ? '编辑人物卡' : '新增人物卡'), fields = grid(panel);
        const name = field(fields, '人物名称', character?.name ?? ''); name.maxLength = 120;
        const kind = select(fields, '人物类型', [['pc', '玩家角色（PC）'], ['npc', '非玩家角色（NPC）']], character?.kind ?? 'pc');
        const notes = field(fields, '人物备注', character?.notes ?? '', true); notes.maxLength = 4000;
        const appearancePanel = card(panel, '人物外观'), appearanceFields = grid(appearancePanel);
        const description = field(appearanceFields, '整体外观', character?.appearance?.description ?? '', true); description.maxLength = 4000;
        const hairstyle = field(appearanceFields, '发型', character?.appearance?.hairstyle ?? ''); hairstyle.maxLength = 500;
        const features = field(appearanceFields, '外貌特征', character?.appearance?.features ?? '', true); features.maxLength = 2000;
        appearancePanel.append(make('p', '这里记录人物自身外貌。当前穿戴直接读取背包中已装备的物品；换装和衣物湿污破损在背包修改。', 'amin-help'));
        const stats = card(panel, '属性与技能绑定'), rows = make('div', '', 'amin-stack');
        stats.append(make('p', '绑定世界状态中已有的数值。D20 使用绑定值作为修正值；若要使用力量等属性的修正，请绑定对应的修正字段。', 'amin-help'), rows);
        let bindings = []; try { bindings = api.bindings(); } catch (error) { say(error.message, 'error'); }
        if (!bindings.length) stats.append(make('p', '还没有可绑定的数值。请先在世界状态中建立人物项目和数字或进度字段，再刷新人物卡。', 'amin-empty'));
        const statRows = [];
        function addStat(stat = {}) {
            const wrapper = card(rows, '', 'amin-card amin-stack'), fields = grid(wrapper);
            const label = field(fields, '属性或技能名称', stat.label ?? ''); label.maxLength = 80;
            const paths = [...new Set(bindings.map(item => item.binding))]; if (stat.binding && !paths.includes(stat.binding)) paths.push(stat.binding);
            const binding = select(fields, '世界状态字段', [['', '请选择字段'], ...paths.map(path => [path, path + (!bindings.some(item => item.binding === path) ? '（当前不存在）' : '')])], stat.binding ?? '');
            const component = select(fields, '读取部分', Object.entries(componentNames), stat.component ?? 'value');
            const check = select(fields, '检定方式', Object.entries(checkNames), stat.check ?? 'none');
            const hint = make('p', '', 'amin-help'); wrapper.append(hint);
            function reflectBinding() {
                const candidates = bindings.filter(item => item.binding === binding.value), match = candidates.find(item => item.component === component.value);
                hint.textContent = match ? `当前绑定值：${match.value} · ${match.label || binding.value}` : binding.value ? '该字段的此部分当前不可读取。数字请选择“数值”，进度请选择“当前值”或“最大值”。' : '选择现有世界状态字段后显示当前值。';
            }
            binding.addEventListener('change', () => { const candidate = bindings.find(item => item.binding === binding.value); if (candidate) component.value = candidate.component; reflectBinding(); });
            component.addEventListener('change', reflectBinding); reflectBinding();
            const row = { id: stat.id ?? uuid(), label, binding, component, check };
            statRows.push(row);
            button(toolbar(wrapper), '移除这项绑定', () => { statRows.splice(statRows.indexOf(row), 1); wrapper.remove(); }, { danger: true, blocked: writable });
        }
        for (const stat of character?.stats ?? []) addStat(stat);
        button(toolbar(stats), '添加属性或技能', () => addStat(), { blocked: writable });
        const actions = toolbar(panel);
        button(actions, '保存人物卡', async () => {
            api.check(token);
            const input = { id: state.id, name: name.value, kind: kind.value, notes: notes.value, appearance: { description: description.value, hairstyle: hairstyle.value, features: features.value },
                stats: statRows.map(row => ({ id: row.id, label: row.label.value, binding: row.binding.value, component: row.component.value, check: row.check.value })) };
            try { await api.saveCharacter(input, token); }
            catch (error) { state.committed = !!api.dirty?.(); throw error; }
            if (form === state) { selected = state.id; finish('人物卡已保存，绑定数值继续以世界状态为准。'); }
        }, { primary: true, blocked: writable });
        button(actions, '取消编辑', cancel); name.focus?.(); drawRecovery(); reflect();
    }
    function deleteCharacter(character) {
        const token = api.capture(), state = { token, type: 'delete', committed: false }; form = state; clearBody();
        const panel = card(body, `删除人物：${character.name}`);
        panel.append(make('p', '人物卡将从当前分支移除。相关背包、账本和人物关系仍保留原有引用，可在对应应用中重新指定人物。'));
        const actions = toolbar(panel);
        button(actions, '确认删除人物', async () => {
            try { await api.deleteCharacter(character.id, token); }
            catch (error) { state.committed = !!api.dirty?.(); throw error; }
            if (form === state) { selected = ''; finish('人物卡已删除。'); }
        }, { danger: true, blocked: writable });
        button(actions, '取消编辑', cancel); reflect();
    }
    function openValue(character, stat) {
        const resolved = api.resolveStat(character.id, stat.id), token = api.capture();
        const state = { token, type: 'value', preview: null, committed: false }; form = state; clearBody();
        const panel = card(body, `修改数值：${character.name} · ${stat.label}`);
        panel.append(make('p', `世界状态：${stat.binding} · ${componentNames[stat.component]} · 当前 ${resolved.value}`, 'amin-meta'));
        const value = field(panel, '新的数值', resolved.value); value.type = 'number'; value.step = 'any';
        panel.append(make('p', '确认后直接更新世界状态，所有绑定此字段的人物卡和应用会读取同一数值。', 'amin-help'));
        const preview = card(panel, '变更预览', 'amin-result amin-stack'); preview.hidden = true;
        value.addEventListener('input', () => { releasePreview(state); preview.hidden = true; reflect(); });
        const actions = toolbar(panel);
        button(actions, '预览数值变更', () => {
            if (!value.value.trim() || !Number.isFinite(Number(value.value))) throw Error('请输入有限数值，再预览变更。');
            api.stageStatValue(character.id, stat.id, Number(value.value), token);
            state.preview = JSON.stringify(api.preview());
            preview.replaceChildren(make('h3', '变更预览'), make('p', `${character.name} · ${stat.label}：${resolved.value} → ${Number(value.value)}`));
            preview.hidden = false; say('核对数值后点击“确认更新世界状态”。');
        }, { blocked: writable });
        button(actions, '确认更新世界状态', async () => {
            if (!state.preview || JSON.stringify(api.preview()) !== state.preview) throw Error('预览已变化，请重新预览数值变更。');
            try { await api.confirm(); }
            catch (error) { state.committed = !!api.dirty?.(); throw error; }
            if (form === state) finish('世界状态数值已更新。');
        }, { primary: true, blocked: () => writable() || !state.preview });
        button(actions, '取消编辑', cancel); reflect();
    }
    function openCheck(character, stat) {
        const resolved = api.resolveStat(character.id, stat.id), token = api.capture(), diceToken = dice.capture();
        const state = { token, type: 'check', diceToken, record: null }; form = state; clearBody();
        const panel = card(body, `${stat.check === 'coc' ? 'CoC 7' : 'D20'} 检定：${character.name} · ${stat.label}`);
        panel.append(make('p', `读取世界状态 ${stat.binding} · ${componentNames[stat.component]} = ${resolved.value}`, 'amin-meta'));
        panel.append(make('p', stat.check === 'coc' ? '本次绑定值作为技能值。骰点在插件内生成，固定结果可单独追加到行动草稿。' : '本次绑定值直接作为 D20 修正值；不会自动换算属性加值。骰点不会自动修改世界状态或发动能力。', 'amin-help'));
        const fields = grid(panel), rollLabel = field(fields, '骰点名称', `${character.name} · ${stat.label}`.slice(0, 80)); rollLabel.maxLength = 80;
        const inputs = [rollLabel];
        let advantage, dc, difficulty, bonus, penalty;
        if (stat.check === 'coc') {
            difficulty = select(fields, '检定难度', [['regular', '普通'], ['hard', '困难'], ['extreme', '极难']], 'regular');
            bonus = select(fields, '奖励骰', [['0', '无'], ['1', '1 枚'], ['2', '2 枚']], '0');
            penalty = select(fields, '惩罚骰', [['0', '无'], ['1', '1 枚'], ['2', '2 枚']], '0'); inputs.push(difficulty, bonus, penalty);
        } else {
            advantage = select(fields, '优劣势', [['normal', '普通'], ['advantage', '优势'], ['disadvantage', '劣势']], 'normal');
            dc = field(fields, '目标 DC（可选）', ''); dc.type = 'number'; dc.step = '1'; inputs.push(advantage, dc);
        }
        const result = card(panel, '固定骰点', 'amin-result amin-stack'); result.hidden = true;
        function showRecord(record) {
            state.record = record;
            result.replaceChildren(make('h3', '固定骰点'), make('pre', record.text)); result.hidden = false;
            inputs.forEach(input => { input.dataset.fixed = 'true'; input.disabled = true; });
            button(toolbar(result), '追加固定结果到草稿', async () => {
                dice.check(diceToken); await dice.append(record.id, doc.querySelector?.('#send_textarea'));
                if (form === state) say('已追加固定骰点。继续编辑行动正文，再用聊天发送按钮一起发出。', 'success');
            });
        }
        const actions = toolbar(panel);
        button(actions, '执行本地检定', async () => {
            api.check(token); dice.check(diceToken);
            const current = api.resolveStat(character.id, stat.id);
            if (current.value !== resolved.value) throw Error('绑定数值已变化，请返回人物卡后重新打开检定。');
            const label = rollLabel.value;
            const settings = stat.check === 'coc'
                ? { mode: 'coc', label, skill: current.value, difficulty: difficulty.value, bonus: Number(bonus.value), penalty: Number(penalty.value), batch: 1 }
                : { mode: 'dnd', label, modifier: current.value, dc: dc.value, advantage: advantage.value, critical: 'check', batch: 1 };
            const before = new Set(dice.history().map(record => record.id));
            try {
                const record = await dice.roll(settings); dice.check(diceToken);
                if (form === state) { showRecord(record); say('本次骰点已固定。确认后可追加到草稿。', 'success'); }
            } catch (error) {
                // A failed disk save still owns a fixed local result. Surface it instead of rolling twice.
                try { dice.check(diceToken); const record = dice.history().find(item => !before.has(item.id) && item.settings?.label === label); if (record && form === state) showRecord(record); } catch { /* Old-chat results stay in that chat only. */ }
                throw error;
            }
        }, { primary: true, blocked: () => !!state.record || !!dice.dirty?.() });
        button(actions, '返回人物卡', () => finish()); reflect();
    }
    function drawSelected(character) {
        if (!character) return;
        const panel = card(body, `${character.name} · ${character.kind === 'npc' ? 'NPC' : 'PC'}`), actions = toolbar(panel);
        button(actions, '编辑人物卡', () => openCharacter(character), { blocked: writable });
        button(actions, '删除人物卡', () => deleteCharacter(character), { danger: true, blocked: writable });
        const related = toolbar(panel);
        for (const [app, label] of [['relationships', '人物关系'], ['journal', '人物记忆'], ['scene', '个人日程'], ['inventory', '资产与穿戴']]) button(related, label, async () => {
            const openApp = options.openApp ?? globalThis.AminOS?.openApp;
            if (!openApp) throw Error('请在 Amin OS 中打开关联应用。');
            await openApp(app);
            const EventType = doc.defaultView?.CustomEvent ?? globalThis.CustomEvent;
            doc.dispatchEvent?.(new EventType('amin:select-character', { detail: { characterId: character.id, app } }));
        });
        if (character.notes) panel.append(make('p', character.notes));
        const appearancePanel = card(panel, '外观与当前穿戴');
        try {
            const appearance = api.appearance?.(character.id) ?? { appearance: character.appearance ?? {}, worn: [] };
            for (const [key, label] of [['description', '整体外观'], ['hairstyle', '发型'], ['features', '外貌特征']]) if (appearance.appearance[key]) appearancePanel.append(make('p', `${label}：${appearance.appearance[key]}`));
            if (!Object.values(appearance.appearance).some(Boolean)) appearancePanel.append(make('p', '尚未登记人物外观，可在编辑人物卡中填写。', 'amin-help'));
            for (const item of appearance.worn) {
                const row = card(appearancePanel, `${item.slotLabel}${item.layerLabel ? ' · ' + item.layerLabel : ''}：${item.name}`);
                row.dataset.itemId = item.itemId;
                if (item.description) row.append(make('p', item.description));
                const condition = item.condition;
                row.append(make('p', `湿润 ${condition.wetness}/100 · 污渍 ${condition.dirt}/100 · 破损 ${condition.damage}/100`, 'amin-meta'));
                if (condition.notes) row.append(make('p', condition.notes));
            }
            if (!appearance.worn.length) appearancePanel.append(make('p', '背包中尚无已装备物品。', 'amin-empty'));
            appearancePanel.append(make('p', '穿戴与物品状态实时引用同一背包记录。', 'amin-help'));
        } catch (error) { appearancePanel.append(make('p', `穿戴暂时无法读取：${error.message}`, 'amin-help')); }
        if (!character.stats.length) panel.append(make('p', '还没有绑定属性或技能。编辑人物卡可添加世界状态字段。', 'amin-empty'));
        for (const stat of character.stats) {
            const item = card(panel, stat.label), row = make('p', '', 'amin-meta');
            item.append(row); let resolved;
            try { resolved = api.resolveStat(character.id, stat.id); row.textContent = `当前值：${resolved.value} · ${stat.binding} · ${componentNames[stat.component]}`; }
            catch (error) { row.textContent = error.message + ' 请编辑人物卡修复绑定。'; row.dataset.state = 'error'; }
            const tools = toolbar(item);
            button(tools, `修改 ${stat.label}`, () => openValue(character, stat), { blocked: () => !resolved || writable() });
            if (stat.check !== 'none') button(tools, `检定 ${stat.label}`, () => openCheck(character, stat), { primary: true, blocked: () => !resolved || !!dice.dirty?.() });
            else item.append(make('span', '只显示数值', 'amin-help'));
        }
        drawOverview(panel, character);
    }
    function drawOverview(panel, character) {
        if (!api.overview) return;
        try {
            const data = api.overview(character.id), section = card(panel, '人物关联总览');
            section.append(make('p', '读取当前分支的原始记录；在上方关联应用中修改。', 'amin-help'));
            const group = (title, values, describe, empty) => {
                const details = make('details', '', 'amin-card amin-stack');
                details.append(make('summary', `${title} · ${values.length} 项`));
                for (const value of values) {
                    const row = make('p', describe(value));
                    row.setAttribute('style', 'overflow-wrap:anywhere;white-space:pre-wrap;min-width:0');
                    details.append(row);
                }
                if (!values.length) details.append(make('p', empty, 'amin-empty'));
                section.append(details);
            };
            group('持有物品', data.items, item => `${item.name} × ${item.quantity}${item.equipped ? ' · 已装备' : ''}${item.notes ? '\n' + item.notes : ''}`, '没有绑定给此人物的物品。');
            group('资源与余额', data.balances, item => `${item.name}：${item.amount} ${item.unit}`, '没有绑定给此人物的资源。');
            group('人物关系', data.relationships, item => `${item.from.name} → ${item.to.name}：${item.label || item.type}${item.strength == null ? '' : ' · 强度 ' + item.strength}${item.notes ? '\n' + item.notes : ''}`, '没有此人物的关系记录。');
            group('已知事实与记忆', data.memories, item => `${KNOWLEDGE_STATES[item.state] ?? item.state} · ${item.fact?.title ?? item.title} · 可信度 ${item.confidence}%\n${item.belief || item.fact?.body || ''}${item.missing.length ? '\n引用提示：' + item.missing.join('；') : ''}${item.stale ? '\n来源提示：' + item.staleReason : ''}`, '没有此人物的记忆记录。');
            const scene = card(section, '位置与日程');
            scene.append(make('p', data.scene?.time ?? '场景暂时无法读取', 'amin-meta'));
            scene.append(make('p', data.scene?.present ? `已确认在场：${data.scene.present.name}` : '尚未在当前场景明确登记此人物；日程不能作为实际位置。'));
            const time = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
            group('个人日程（计划）', data.schedules, item => `${item.title} · ${time(item.startMinute)}–${time(item.endMinute)} · ${item.locationName}\n${!item.enabled ? '已停用' : item.due ? '当前计划时段' : '非当前时段'}${item.overlap ? ' · 日程重叠' : ''}${item.conflict ? ' · 与确认位置不符' : ''}`, '尚未登记个人日程。');
            section.append(make('p', '能力面板目前使用文本目标，不能可靠归属到人物 ID；请在能力面板查看生效中效果。', 'amin-help'));
            const actions = toolbar(section);
            button(actions, '查看能力面板', async () => {
                const openApp = options.openApp ?? globalThis.AminOS?.openApp;
                if (!openApp) throw Error('请在 Amin OS 中打开关联应用。');
                await openApp('effects');
            });
            for (const error of data.errors) section.append(make('p', `部分资料暂时无法读取：${error}`, 'amin-notice'));
        } catch (error) { panel.append(make('p', `人物总览暂时无法读取：${error.message}`, 'amin-help')); }
    }
    function render() {
        if (disposed) return;
        updateContext();
        if (form) { drawRecovery(); reflect(); return; }
        clearBody();
        try {
            const characters = api.read().characters;
            if (!characters.some(character => character.id === selected)) selected = characters[0]?.id ?? '';
            const actions = toolbar(body);
            button(actions, '新增人物卡', () => openCharacter(), { primary: true, blocked: writable });
            button(actions, '刷新人物与数值', () => { render(); say('已读取当前聊天的人物与世界状态。'); });
            if (!characters.length) body.append(make('p', '当前分支还没有人物卡。新增 PC 或 NPC，再绑定世界状态中的属性、技能、生命或理智。', 'amin-empty'));
            else {
                const fields = grid(body), search = field(fields, '筛选人物', filter); search.type = 'search';
                const choices = characters.filter(character => !filter || `${character.name} ${character.notes}`.toLowerCase().includes(filter.toLowerCase()));
                const selector = select(fields, '当前人物', [['', choices.length ? '请选择人物' : '没有匹配人物'], ...choices.map(character => [character.id, `${character.name} · ${character.kind === 'npc' ? 'NPC' : 'PC'}`])], choices.some(character => character.id === selected) ? selected : '');
                search.addEventListener('input', () => {
                    filter = search.value;
                    selector.replaceChildren();
                    const matches = characters.filter(character => !filter || `${character.name} ${character.notes}`.toLowerCase().includes(filter.toLowerCase()));
                    for (const [id, text] of [['', matches.length ? '请选择人物' : '没有匹配人物'], ...matches.map(character => [character.id, `${character.name} · ${character.kind === 'npc' ? 'NPC' : 'PC'}`])]) { const option = make('option', text); option.value = id; selector.append(option); }
                    selector.value = matches.some(character => character.id === selected) ? selected : '';
                });
                selector.addEventListener('change', () => { selected = selector.value; render(); });
                drawSelected(characters.find(character => character.id === selected));
            }
        } catch (error) { say(error.message, 'error'); body.append(make('p', '人物数据暂时无法读取，原始记录保留。请修复数据后刷新。', 'amin-empty')); }
        drawRecovery(); reflect();
    }
    function refresh() {
        if (disposed) return;
        const changed = metadata !== api.context()?.chatMetadata || contextStamp !== stamp();
        if (changed) { releasePreview(form); form = null; selected = ''; filter = ''; metadata = api.context()?.chatMetadata; contextStamp = stamp(); render(); say('已切换聊天，只显示当前聊天的人物。'); return; }
        updateContext();
        if (form) {
            // Never replace live input nodes in response to another app or background save.
            if (!running) {
                try { api.check(form.token); }
                catch {
                    if (form.type === 'check' && form.record) say('人物资料或数值已变化。本次骰点保留掷骰时的固定值，仍可追加到当前聊天草稿。');
                    else say('当前数据或聊天楼层已变化。编辑内容已保留；请复制需要的内容后取消编辑，再重新打开。', 'error');
                }
            }
            drawRecovery(); reflect();
        } else if (!running) {
            if (editingInput()) deferredRefresh = true;
            else { deferredRefresh = false; render(); }
        }
    }
    function editingInput() {
        let current = doc.activeElement;
        if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(current?.tagName)) return false;
        while (current) { if (current === page) return true; current = current.parentNode ?? current.parentElement ?? current.parent; }
        return false;
    }
    page.addEventListener('focusout', () => queueMicrotask(() => {
        if (!disposed && deferredRefresh && !editingInput()) refresh();
    }));
    contextStamp = stamp();
    const selectCharacter = event => {
        if (event.detail?.app !== 'characters' || !event.detail.characterId || disposed) return;
        if (form || running) { say('请先完成当前人物编辑，再跳转人物。'); return; }
        if (!api.read().characters.some(character => character.id === event.detail.characterId)) { say(`引用人物已不存在：${event.detail.characterId}`, 'error'); return; }
        selected = event.detail.characterId; filter = ''; render();
    };
    doc.addEventListener?.('amin:select-character', selectCharacter);
    const unsubscribe = api.subscribe?.(refresh) ?? (() => {}), unsubscribeDice = dice.subscribe?.(() => { if (!disposed) { drawRecovery(); reflect(); } }) ?? (() => {});
    const result = {
        open: refresh, refresh,
        dispose() {
            if (disposed) return; disposed = true; generationView.dispose(); releasePreview(form); unsubscribe(); unsubscribeDice(); doc.removeEventListener?.('amin:select-character', selectCharacter);
            if (ownsService) api.dispose(); if (ownsDice) dice.dispose(); controls.clear(); page.remove(); mounted.delete(target);
        },
    };
    mounted.set(target, result); render(); return result;
}
