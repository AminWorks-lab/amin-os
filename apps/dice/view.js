import { normalizeConfig, LIMITS } from './engine.js';
import { getSharedDiceService } from './service.js';
import {contextLine} from '../shared/context-line.js';
const mounted = new WeakMap();
const make = (tag, text = '', cls = '') => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
const modeNames = { generic: '通用骰', dnd: 'D&D', coc: 'CoC 7', history: '记录', presets: '预设' };
export function mount(target, { api: provided, getContext } = {}) {
    if (!target) throw Error('缺少骰子应用容器。');
    mounted.get(target)?.dispose();
    const api = provided ?? getSharedDiceService(getContext);
    let selected = 'generic', disposed = false, ownAction = false, selectedPreset = '', selectedRoll = null, historyPage = 0;
    const checked = new Set(), drafts = { generic: { mode: 'generic', label: '', formula: '1d20', batch: 1 }, dnd: { mode: 'dnd', label: '', advantage: 'normal', modifier: 0, dc: '', critical: 'check', batch: 1 }, coc: { mode: 'coc', label: '', skill: 50, bonus: 0, penalty: 0, difficulty: 'regular', batch: 1 } };
    const page = make('section', '', 'amin-page amin-dice'), context = make('div', '', 'amin-context'), tabs = make('div', '', 'amin-tabs'), notice = make('div', '', 'amin-notice'), body = make('div', '', 'amin-dice-body'), footer = make('div', '', 'amin-savebar');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '骰子页面'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const instance = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
    page.append(context, tabs, notice, body, footer); target.append(page);
    function say(text) { notice.textContent = text; }
    async function action(fn) {
        if (ownAction) return; ownAction = true; reflectBusy();
        try { await fn(); } catch (e) { say(e.message || '操作失败，请重试。'); } finally { ownAction = false; if (!disposed) { renderBody(); reflectBusy(); } }
    }
    function button(parent, label, fn, primary = false) {
        const b = make('button', label, primary ? 'amin-primary' : ''); b.type = 'button'; b.onclick = () => action(fn); parent.append(b); return b;
    }
    function card(title, parent = body) { const box = make('section', '', 'amin-card'); if (title) box.append(make('h3', title)); parent.append(box); return box; }
    function field(parent, label, key, options = {}) {
        const row = make('label', '', 'amin-field'), text = make('span', label), input = make(options.choices ? 'select' : 'input');
        input.setAttribute('aria-label', label);
        if (options.choices) for (const [value, title] of options.choices) { const o = make('option', title); o.value = value; input.append(o); }
        else { input.type = options.type || 'text'; if (options.min !== undefined) input.min = options.min; if (options.max !== undefined) input.max = options.max; if (input.type === 'number') { input.step = '1'; input.inputMode = 'numeric'; } else input.maxLength = options.maxLength || 80; }
        input.value = String(drafts[selected][key] ?? ''); if (options.placeholder) input.placeholder = options.placeholder;
        const update = () => { drafts[selected][key] = input.value; };
        input.addEventListener('input', update); input.addEventListener('change', update); row.append(text, input); parent.append(row); return input;
    }
    function grid(parent) { const g = make('div', '', 'amin-form-grid'); parent.append(g); return g; }
    function drawTabs() {
        tabs.replaceChildren();
        for (const [id, name] of Object.entries(modeNames)) {
            const b = make('button', name); b.type = 'button'; b.id = `dice-tab-${instance}-${id}`; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', `dice-body-${instance}`); b.setAttribute('aria-selected', String(selected === id)); b.tabIndex = selected === id ? 0 : -1;
            b.onclick = () => { selected = id; render(); };
            b.onkeydown = e => { const names = Object.keys(modeNames), index = names.indexOf(id); let next;
                if (e.key === 'ArrowRight') next = names[(index + 1) % names.length]; else if (e.key === 'ArrowLeft') next = names[(index + names.length - 1) % names.length]; else if (e.key === 'Home') next = names[0]; else if (e.key === 'End') next = names.at(-1); else return;
                e.preventDefault(); selected = next; render(); tabs.querySelector('[aria-selected="true"]')?.focus();
            }; tabs.append(b);
        }
        body.id = `dice-body-${instance}`; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', `dice-tab-${instance}-${selected}`);
    }
    async function roll(settings = drafts[selected]) { const record = await api.roll(settings); selectedRoll = record.id; checked.clear(); checked.add(record.id); say(api.status()); }
    function drawForm() {
        const c = card(modeNames[selected] + ' · 判定设置'), form = grid(c);
        field(form, '判定名称（可选）', 'label', { placeholder: selected === 'dnd' ? '例如：潜行穿过走廊' : selected === 'coc' ? '例如：侦查书房' : '例如：长剑伤害' });
        field(form, '重复次数', 'batch', { type: 'number', min: 1, max: LIMITS.batch });
        if (selected === 'generic') {
            field(form, '骰子公式', 'formula', { maxLength: LIMITS.formula, placeholder: '2d6+3 / 4d6kh3 / 1d8+1d4-2' });
            const quick = make('div', '', 'amin-toolbar amin-dice-quick'); c.append(quick);
            for (const sides of [4, 6, 8, 10, 12, 20, 100]) button(quick, `D${sides}`, () => { drafts.generic.formula = `1d${sides}`; return roll(drafts.generic); });
            c.append(make('p', '快捷骰会立即掷骰。公式支持多组骰子与整数加减；kh / kl 保留最高 / 最低的若干枚。', 'amin-help'));
        } else if (selected === 'dnd') {
            field(form, '骰法', 'advantage', { choices: [['normal', '普通 · 1D20'], ['advantage', '优势 · 2D20 取高'], ['disadvantage', '劣势 · 2D20 取低']] });
            field(form, '总修正值', 'modifier', { type: 'number', min: -10000, max: 10000 });
            field(form, 'DC / AC（可留空）', 'dc', { type: 'number', min: -10000, max: 10000, placeholder: '未设置时只展示骰点' });
            field(form, '自然 1 / 20 规则', 'critical', { choices: [['check', '属性检定 / 普通豁免 · 比较总值'], ['attack', '攻击 · 自然 1 失手、20 重击'], ['house', '房规 · 自然 1 失败、20 成功']] });
            c.append(make('p', '优势和劣势同时存在时，请选普通。默认属性检定不会因自然 1 / 20 自动失败 / 成功；死亡豁免需由主持人另行处理。', 'amin-help'));
        } else {
            field(form, '技能 / 属性值', 'skill', { type: 'number', min: 1, max: 999 });
            field(form, '要求难度', 'difficulty', { choices: [['regular', '普通 · 技能值'], ['hard', '困难 · 一半向下取整'], ['extreme', '极难 · 五分之一向下取整']] });
            field(form, '奖励骰', 'bonus', { choices: [['0', '无'], ['1', '1 枚'], ['2', '2 枚']] });
            field(form, '惩罚骰', 'penalty', { choices: [['0', '无'], ['1', '1 枚'], ['2', '2 枚']] });
            c.append(make('p', 'CoC 第七版：奖惩数量相抵，只重掷十位；00 + 0 为 100。01 大成功；本次目标低于 50 时 96–100 大失败，否则仅 100。', 'amin-help'));
        }
        const tools = make('div', '', 'amin-toolbar'); c.append(tools); button(tools, '掷骰并记录', () => roll(), true);
        button(tools, '保存为预设', () => { normalizeConfig(drafts[selected]); selectedPreset = ''; const presetMode = selected; selected = 'presets'; drawTabs(); drawPresets(presetMode); });
        const records = api.history(), current = records.find(r => r.id === selectedRoll) ?? records.at(-1);
        if (current) drawRecord(current, true); else body.append(make('p', '尚无骰点。结果只会在你点击掷骰时产生。', 'amin-empty'));
    }
    function drawRecord(record, latest = false) {
        const c = card(record.settings.label || modeNames[record.settings.mode]), heading = make('div', '', 'amin-dice-result-heading');
        const total = record.results.map(r => r.total).join(' / '); heading.append(make('strong', total, 'amin-dice-total'));
        const state = record.status === 'sent' ? record.linked ? `已发送 · 第 ${record.sent.messageIndex + 1} 楼` : '原消息已变化 · 保留原骰点' : record.status === 'appended' ? '已追加过 · 发送前请检查草稿' : '已记录 · 待追加';
        heading.append(make('span', `${state} · ${new Date(record.createdAt).toLocaleString()}`, 'amin-dice-meta')); c.append(heading);
        if (record.rerollOf) c.append(make('p', `明确重掷 · 来源 #${record.rerollOf.replace(/-/g, '').slice(0, 12)}`, 'amin-help'));
        c.append(make('pre', record.text, 'amin-dice-breakdown'));
        const toolbar = make('div', '', 'amin-toolbar'); c.append(toolbar);
        if (record.status !== 'sent') {
            const label = make('label', '', 'amin-dice-select'), check = make('input'); check.type = 'checkbox'; check.checked = checked.has(record.id); check.setAttribute('aria-label', `选中 ${record.settings.label || '骰点'} #${record.id.slice(0, 8)}`);
            check.onchange = () => { if (check.checked) checked.add(record.id); else checked.delete(record.id); drawFooter(); }; label.append(check, make('span', '加入本次发送')); toolbar.append(label);
            button(toolbar, '追加这次结果', () => api.append(record.id), latest);
        }
        button(toolbar, '复制结果', async () => { if (!globalThis.navigator?.clipboard?.writeText) throw Error('剪贴板不可用，请选择结果文字手动复制。'); await navigator.clipboard.writeText(record.text); say('已复制固定结果。'); });
        button(toolbar, '用相同设置重掷', async () => { const next = await api.reroll(record.id); selectedRoll = next.id; checked.clear(); checked.add(next.id); say(api.status()); });
    }
    function drawHistory() {
        const records = api.history().reverse(), pageSize = 30, pages = Math.max(1, Math.ceil(records.length / pageSize));
        historyPage = Math.min(historyPage, pages - 1);
        body.append(make('p', `当前聊天共 ${records.length} 条记录，第 ${historyPage + 1} / ${pages} 页。所有骰点完整保留；原消息已变化的记录仅作为历史凭据。`, 'amin-help'));
        if (!records.length) body.append(make('p', '当前聊天没有骰点记录。', 'amin-empty'));
        const toolbar = make('div', '', 'amin-toolbar'); body.append(toolbar);
        if (historyPage > 0) button(toolbar, '上一页', () => { historyPage--; });
        if (historyPage < pages - 1) button(toolbar, '下一页', () => { historyPage++; });
        for (const record of records.slice(historyPage * pageSize, (historyPage + 1) * pageSize)) drawRecord(record);
    }
    let presetDraftMode = 'generic', presetName = '';
    function drawPresets(fromMode) {
        if (fromMode) presetDraftMode = fromMode; body.replaceChildren();
        const c = card('保存当前判定'), form = grid(c), label = make('label', '', 'amin-field'), name = make('input'); name.value = presetName; name.maxLength = 60; name.setAttribute('aria-label', '预设名称'); name.oninput = () => { presetName = name.value; }; label.append(make('span', '预设名称'), name); form.append(label);
        const modeLabel = make('label', '', 'amin-field'), mode = make('select'); mode.setAttribute('aria-label', '保存哪一页的设置');
        for (const id of ['generic', 'dnd', 'coc']) { const o = make('option', modeNames[id]); o.value = id; mode.append(o); } mode.value = presetDraftMode; mode.onchange = () => { presetDraftMode = mode.value; selectedPreset = ''; }; modeLabel.append(make('span', '保存哪一页的设置'), mode); form.append(modeLabel);
        const toolbar = make('div', '', 'amin-toolbar'); c.append(toolbar);
        button(toolbar, selectedPreset ? '更新选中预设' : '保存新预设', async () => { const p = await api.savePreset(presetName, drafts[presetDraftMode], selectedPreset || null); selectedPreset = p.id; presetName = p.name; say(api.status()); }, true);
        if (selectedPreset) button(toolbar, '另存为新预设', () => { selectedPreset = ''; presetName = ''; });
        c.append(make('p', '预设跨聊天共用，仅保存规则与修正值；载入不会掷骰。', 'amin-help'));
        const presets = api.presets(); if (!presets.length) body.append(make('p', '还没有预设。可为常用武器、技能或调查员检定分别保存。', 'amin-empty'));
        for (const preset of presets) {
            const item = card(preset.name); item.append(make('p', `${modeNames[preset.settings.mode]} · ${preset.settings.label || preset.settings.formula || '检定'} · ${preset.settings.batch} 次`, 'amin-help'));
            const row = make('div', '', 'amin-toolbar'); item.append(row);
            button(row, '载入设置', () => { drafts[preset.settings.mode] = { ...preset.settings }; selectedPreset = preset.id; presetName = preset.name; presetDraftMode = preset.settings.mode; selected = preset.settings.mode; drawTabs(); say(`已载入「${preset.name}」，点击掷骰后产生新结果。`); });
            button(row, '删除预设', async () => { await api.deletePreset(preset.id); if (selectedPreset === preset.id) { selectedPreset = ''; presetName = ''; } say(api.status()); });
        }
    }
    function drawFooter() {
        footer.replaceChildren();
        const valid = new Set(api.history().filter(r => r.status !== 'sent').map(r => r.id)); for (const id of checked) if (!valid.has(id)) checked.delete(id);
        const append = button(footer, `追加选中结果${checked.size ? `（${checked.size}）` : ''}`, () => api.append([...checked]), true); append.disabled = !checked.size || ownAction || api.busy(); append.dataset.needsSelection = 'true';
        const undo = button(footer, '撤销刚才的追加', () => api.undoAppend()); undo.disabled = !api.canUndo() || ownAction || api.busy(); undo.dataset.needsUndo = 'true';
        if (api.dirty()) button(footer, '重试保存固定骰点', () => api.retrySave());
        footer.append(make('span', '与行动正文在同一条聊天消息发出。', 'amin-help'));
    }
    function reflectBusy() { for (const b of page.querySelectorAll('button:not([role="tab"])')) b.disabled = ownAction || api.busy() || b.dataset.needsSelection && !checked.size || b.dataset.needsUndo && !api.canUndo(); }
    function renderBody() { if (disposed) return; body.replaceChildren(); if (selected === 'history') drawHistory(); else if (selected === 'presets') drawPresets(); else drawForm(); drawFooter(); reflectBusy(); }
    function render() { if (disposed) return; const c = api.context(); context.textContent = contextLine(c, '本地骰点'); drawTabs(); renderBody(); }
    let chatMetadata = api.context()?.chatMetadata;
    const unsubscribe = api.subscribe(() => { if (disposed) return; if (chatMetadata !== api.context()?.chatMetadata) { chatMetadata = api.context()?.chatMetadata; selectedRoll = null; checked.clear(); } say(api.status()); render(); });
    say(api.status()); render();
    const result = { open() { render(); }, refresh() { render(); }, dispose() { disposed = true; unsubscribe(); page.remove(); mounted.delete(target); } }; mounted.set(target, result); return result;
}
