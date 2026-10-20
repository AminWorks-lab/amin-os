import { mountGeneration } from '../generation/view.js';
import { getSharedService } from './service.js';
import { installUnifiedWorldbook, inspectUnifiedWorldbook } from './lorebook.js';
import { uuid } from '../../uuid.js';
import { renderContextBudgetControls, renderContextBudgetReport } from './context-budget-view.js';
import {contextLine} from '../shared/context-line.js';

const mounted = new WeakMap();
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const values = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
const sourceLabel = source => typeof source === 'string' ? source : Number.isInteger(source?.index) ? `第 ${source.index + 1} 楼${Number.isInteger(source.swipe) && source.swipe > 0 ? ` · 第 ${source.swipe + 1} 个候选` : ''}` : '当前聊天';

/** The same page is mounted in the OS workbench and the current-floor workbench. */
export function mount(target, options = {}) {
    if (mounted.has(target)) return mounted.get(target);
    const document = options.document ?? target.ownerDocument ?? globalThis.document;
    const api = options.api ?? getSharedService();
    const getContext = options.getContext ?? (() => globalThis.SillyTavern.getContext());
    const check = options.check ?? (() => {});
    const worldbook = options.worldbook ?? { install: installUnifiedWorldbook, inspect: inspectUnifiedWorldbook };
    const independent = () => api.isIndependent?.() === true || api.nativeState2Status?.()?.mode === 'independent' || api.status?.()?.mode === 'independent';
    const make = (tag, content = '', className = '') => { const element = document.createElement(tag); element.textContent = content; if (className) element.className = className; return element; };
    if (document.head && !document.getElementById?.('amin-linkage-style')) {
        const style = make('link'); style.id = 'amin-linkage-style'; style.rel = 'stylesheet'; style.href = new URL('../../ui-linkage.css', import.meta.url).href; document.head.append(style);
    }
    const page = make('section', '', 'amin-page amin-app-page amin-linkage amin-stack');
    const context = make('div', '', 'amin-context'), notice = make('p', '', 'amin-notice');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const settingsPanel = make('section', '', 'amin-card amin-stack'), retryPanel = make('section', '', 'amin-stack');
    const nativePanel = make('section', '', 'amin-card amin-stack');
    const diagnosticsPanel = make('details', '', 'amin-card amin-stack');
    const budgetReportPanel = make('section', '', 'amin-card amin-stack');
    const reviewPanel = make('section', '', 'amin-stack'), suggestionsPanel = make('section', '', 'amin-card amin-stack');
    const promptPanel = make('details', '', 'amin-card amin-stack'), referencesPanel = make('details', '', 'amin-card amin-stack');
    const manualPanel = make('details', '', 'amin-card amin-stack'), dataPanel = make('details', '', 'amin-card amin-stack');
    page.append(context, notice, nativePanel, diagnosticsPanel, retryPanel, reviewPanel, settingsPanel, suggestionsPanel, promptPanel, dataPanel, budgetReportPanel, referencesPanel, manualPanel); target.append(page);
    const generationView = mountGeneration(page, { joint: true, getContext, document, service: options.generationService, ai: options.ai });
    let disposed = false, unavailable = false, localBusy = false, message = '', failed = false;
    let lastServiceStatus = '', referenceRepairPlan = null;
    let saved = null, draft = null, settingsDirty = false, moduleRows = [], inputNodes = [], draftNotice, saveButton;
    let dataValue, dataStatus, dataCache = '', dataError = '', savedDataReport = null;
    let promptValue, promptStatus, worldbookStatus, installButton, inspectButton, pasted = '';
    let moduleControls = [], extraControl;
    let modulesSignature = '';
    let promptCache = '', promptError = '', worldbookTemplate = null, worldbookMessage = '尚未检查当前聊天的绑定世界书。';
    let manualFrom = '', manualTo = '', manualLabel = '';

    const busy = () => localBusy || api.busy();
    const locked = () => unavailable || busy() || api.dirty() || !!api.preview();
    function say(value, error = false) { message = value; failed = error; notice.textContent = value; notice.dataset.state = error ? 'error' : busy() ? 'busy' : value ? 'success' : ''; }
    async function run(task) {
        if (disposed || localBusy) return;
        localBusy = true; message = ''; failed = false; updateLocks();
        try { check(); await task(); }
        catch (error) { say(error?.message ?? String(error), true); }
        finally { localBusy = false; if (!disposed) render(); }
    }
    function button(label, task, { primary = false, lock = 'mutation' } = {}) {
        const element = make('button', label, primary ? 'amin-primary' : ''); element.type = 'button'; element.dataset.linkageLock = lock;
        element.addEventListener('click', () => { if (!element.disabled) return run(task); }); return element;
    }
    function checkbox(label, checked, change, accessible = label) {
        const row = make('label', '', 'amin-check'), input = make('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', accessible);
        input.addEventListener('change', () => { if (!input.disabled) { change(input.checked); markDraft(); } }); row.append(input, make('span', label)); return { row, input };
    }
    function markDraft() {
        settingsDirty = JSON.stringify(draft) !== JSON.stringify(saved);
        if (draftNotice) draftNotice.textContent = settingsDirty ? '设置尚未保存。条目预览和后续生成仍使用已保存的配置。' : '设置已保存到当前聊天。隐藏桌面磁贴不会停用这里的模块。';
        updateModuleStates(); updateLocks();
    }
    function moduleConfig(row) { return draft.modules[row.id] ?? { enabled: row.enabled === true, read: row.read === true, write: row.write === true }; }
    function setModule(row, key, value) {
        const flags = { ...moduleConfig(row), [key]: value };
        if (key === 'read' && !value) flags.write = false;
        if (key === 'write' && value) flags.read = true;
        if (row.id === 'dice' || row.writable === false) flags.write = false;
        draft.modules[row.id] = flags;
    }
    function updateModuleStates() {
        for (const controls of moduleControls) {
            const current = moduleConfig(controls.module);
            controls.enabled.checked = current.enabled === true; controls.read.checked = current.read === true; controls.write.checked = current.write === true;
            controls.state.textContent = (!current.enabled ? '未加入联动' : `${current.read ? '提供资料' : '不提供资料'} · ${current.write ? '允许更新' : '禁止更新'}`) + (!controls.module.available ? ' · 当前尚无资料' : '');
        }
    }
    function updateLocks() {
        const block = locked(); page.setAttribute('aria-busy', String(busy()));
        for (const element of page.querySelectorAll?.('[data-linkage-lock]') ?? []) {
            const lock = element.dataset.linkageLock;
            element.disabled = lock === 'busy' ? busy() || unavailable : lock === 'confirm' ? busy() || unavailable || api.dirty() || !api.preview() : block || ((lock === 'links' || lock === 'migration') && settingsDirty);
        }
        for (const input of inputNodes) input.disabled = block;
        for (const controls of moduleControls) {
            const current = moduleConfig(controls.module);
            controls.enabled.disabled = block;
            controls.read.disabled = controls.write.disabled = block || !current.enabled;
            if (controls.module.id === 'dice' || controls.module.writable === false) controls.write.disabled = true;
        }
        if (saveButton) saveButton.disabled = block || !settingsDirty;
        if (installButton) { installButton.hidden = independent(); installButton.disabled = independent() || block || settingsDirty || !saved?.enabled; }
        if (dataStatus) dataStatus.textContent = settingsDirty ? '正在显示已保存配置的资料来源；未保存的修改尚未生效。' : dataError || (saved?.dataSource === 'external' ? '已选择由预设／世界书提供资料；Amin 不再插入重复资料。请确认外部宏覆盖全部已选模块。' : dataCache ? `按已保存的模块读取权限生成 · ${dataCache.length} 字符。` : '当前没有允许注入的资料。');
        if (promptStatus) promptStatus.textContent = settingsDirty
            ? independent() ? '正在显示插件按已保存设置提供的 Amin 更新规则；请先保存用户补充要求。' : '正在显示已保存设置生成的条目；先保存设置，再更新世界书。'
            : promptError || (saved?.enabled ? `${independent() ? '插件直接提供的 Amin 更新规则；不合并旧世界书条目的前后文' : worldbookTemplate === null ? '变量更新规则；检查绑定世界书后可合并条目手写前后文' : '已合并上次检查的世界书前后文；在世界书中修改后请重新检查'} · ${promptCache.length} 字符。` : '联动总开关已关闭，当前不会提供联动资料或接受模型更新。');
    }
    function renderSettings() {
        settingsPanel.replaceChildren(make('h3', '联动范围与更新权限'), make('p', independent()
            ? 'Amin 校验回复中的 <amin_update>，将允许的变更写入当前剧情资料。可先预览确认，也可校验后自动应用。资料使用稳定 ID 相互引用；关闭模块不会删除已有记录。'
            : '小白变量 2.0 根据世界书规则自动执行 <state> 更新；Amin 从同一份变量刷新应用。资料使用稳定 ID 相互引用；关闭模块不会删除已有记录。', 'amin-meta'));
        inputNodes = []; moduleControls = [];
        const enabled = checkbox('启用统一联动更新', draft.enabled === true, value => { draft.enabled = value; }); inputNodes.push(enabled.input); settingsPanel.append(enabled.row);
        if (independent()) {
            const row = make('label', '', 'amin-field'), control = make('select'); control.setAttribute('aria-label', '模型更新方式');
            for (const [value, label] of [['review', '先预览，确认后应用'], ['auto', '校验通过后自动应用']]) { const option = make('option', label); option.value = value; control.append(option); }
            control.value = draft.mode === 'auto' ? 'auto' : 'review';
            control.addEventListener('change', () => { draft.mode = control.value; markDraft(); }); inputNodes.push(control);
            row.append(make('span', '模型更新方式'), control, make('small', '自动模式也会校验整组变更；发生错误时保留原资料。')); settingsPanel.append(row);
        }
        const advanced = checkbox('发送高级动作说明', draft.advancedActions === true, value => { draft.advancedActions = value; }); inputNodes.push(advanced.input);
        settingsPanel.append(advanced.row, make('p', '默认只发送常用动作以节省上下文；开启后附带阈值规则、日程、属性绑定、周期结算、编年史草稿等不常用动作的说明。关闭时模型输出的这些动作仍会照常校验。', 'amin-meta'));
        const sourceRow = make('label', '', 'amin-field'), sourceControl = make('select'); sourceControl.setAttribute('aria-label', '资料发送来源');
        for (const [value, label] of [['amin', 'Amin 插入消息上下文'], ['external', '预设／世界书自行提供']]) { const option = make('option', label); option.value = value; sourceControl.append(option); }
        sourceControl.value = draft.dataSource === 'external' ? 'external' : 'amin';
        sourceControl.addEventListener('change', () => { draft.dataSource = sourceControl.value; markDraft(); }); inputNodes.push(sourceControl);
        sourceRow.append(make('span', '资料发送来源'), sourceControl, make('small', independent()
            ? '选择外部来源后，Amin 不再插入当前剧情资料。请使用自己的预设、世界书或自定义宏提供所有选中模块的资料；Amin 更新规则仍照常使用。'
            : '选择外部来源后，Amin 不再插入当前剧情资料。请确认预设或世界书的小白变量宏提供所有选中模块的资料；统一世界书更新规则仍照常使用。')); settingsPanel.append(sourceRow);
        const budgetControls = renderContextBudgetControls(settingsPanel, { document, settings: draft, report: savedDataReport, onRefresh: () => run(() => { savedDataReport = api.dataPromptReport?.() ?? null; renderSettings(); for (const details of settingsPanel.querySelectorAll?.('details') ?? []) details.open = true; updateLocks(); }), onChange: value => { draft.contextBudget = value; markDraft(); } });
        inputNodes.push(...budgetControls.inputs);
        const modules = make('div', '', 'amin-linkage-modules');
        for (const module of moduleRows) {
            const current = moduleConfig(module), card = make('section', '', 'amin-linkage-module amin-stack'); card.dataset.module = module.id;
            const state = make('p', '', 'amin-meta'); card.append(make('h4', module.label || module.id), state);
            if (!module.available) card.append(make('p', module.reason || (['status','map'].includes(module.id) ? '可先启用联动；世界状态字段和地图需要先在对应应用中初始化。' : '尚无资料，可先启用；允许更新后可通过统一更新建立支持的新记录。'), 'amin-meta'));
            const controls = make('div', '', 'amin-linkage-permissions');
            const enabled = checkbox('启用此模块', current.enabled === true, value => setModule(module, 'enabled', value), `${module.label || module.id} · 启用此模块`);
            const read = checkbox('提供资料给模型', current.read === true, value => setModule(module, 'read', value), `${module.label || module.id} · 提供资料给模型`);
            const write = checkbox('允许模型更新', current.write === true, value => setModule(module, 'write', value), `${module.label || module.id} · 允许模型更新`);
            controls.append(enabled.row, read.row, write.row); card.append(controls); modules.append(card); moduleControls.push({ module, state, enabled: enabled.input, read: read.input, write: write.input });
            if (module.id === 'dice' || module.writable === false) card.append(make('p', '此模块仅提供已记录的结果，模型不能改写骰点。', 'amin-meta'));
        }
        settingsPanel.append(modules,make('p','允许模型更新时会同时提供当前资料；取消提供资料也会关闭更新权限。','amin-meta'));
        if (typeof api.saveScopeTemplate === 'function') {
            const template = api.scopeTemplate();
            const templateActions = make('div', '', 'amin-toolbar');
            templateActions.append(button('将已保存范围设为通用模板', async () => {
                await api.saveScopeTemplate(); renderSettings();
                say('通用模板已保存。未单独保存联动设置的聊天自动采用；已有聊天配置优先。');
            }, { lock: 'links' }));
            if (template) templateActions.append(button('将通用模板载入当前草稿', () => {
                const value = api.scopeTemplate();
                if (!value) throw Error('通用模板已不存在。');
                draft.enabled = value.enabled; draft.modules = clone(value.modules);
                renderSettings(); say('已载入通用范围，请点击“保存联动设置”应用到当前聊天。');
            }));
            settingsPanel.append(make('h4', '通用联动范围模板'), make('p',
                `${template ? '已设置通用模板。' : '尚未设置通用模板。'}保存前请先保存上面的联动设置。模板只包含总开关与模块权限；没有单独配置的聊天自动采用。单独保存后仅影响当前聊天，分支继承原聊天配置。${independent() ? 'Amin 更新规则由插件直接提供。' : '世界书仍需绑定统一条目。'}`, 'amin-meta'), templateActions);
        }
        const rulesLabel = independent() ? '用户补充要求' : '额外联动规则';
        const rulesRow = make('label', '', 'amin-field'); extraControl = make('textarea'); extraControl.rows = 5; extraControl.maxLength = 40000; extraControl.value = draft.extraRules ?? ''; extraControl.setAttribute('aria-label', rulesLabel);
        extraControl.placeholder = '例如：只有正文明确发生的变化才能更新；传闻不得直接写成已确认事实。';
        extraControl.addEventListener('input', () => { draft.extraRules = extraControl.value; markDraft(); }); inputNodes.push(extraControl);
        rulesRow.append(make('span', rulesLabel), extraControl, make('small', independent()
            ? '手写业务规则填写在这里，随当前聊天保存，由插件加入实际发送的 Amin 更新规则；不会读取旧条目前后文。请保持与上面的模块更新权限一致。'
            : '随当前聊天保存，并写入统一世界书条目。请保持与上面的模块更新权限一致。')); settingsPanel.append(rulesRow);
        draftNotice = make('p', '', 'amin-meta');
        saveButton = button('保存联动设置', async () => {
            await api.saveSettings(clone(draft)); saved = clone(api.settings()); draft = clone(saved); draft.modules ??= {}; settingsDirty = false;
            renderSettings(); refreshPrompt(); say(independent() ? '联动设置已保存。展开 Amin 更新规则预览可查看实际发送内容。' : '联动设置已保存。展开统一条目可查看当前内容。');
        }, { primary: true });
        const reset = button('放弃未保存修改', () => { saved = clone(api.settings()); draft = clone(saved); draft.modules ??= {}; settingsDirty = false; renderSettings(); say('已恢复当前聊天中保存的联动设置。'); });
        const actions = make('div', '', 'amin-toolbar'); actions.append(saveButton, reset); settingsPanel.append(draftNotice, actions); markDraft();
    }
    function renderNativeState2() {
        const status = api.nativeState2Status?.();
        if (independent()) {
            referenceRepairPlan = null;
            nativePanel.replaceChildren(make('h3', '当前剧情资料 · Amin 独立存储'),
                make('p', '人物、背包、场景等应用读取同一份当前剧情资料。回复中的 <amin_update> 由 Amin 校验和应用，不按旧楼层或候选回复恢复变量。', 'amin-meta'),
                make('p', status?.message || (status?.enabled ? '当前剧情资料已启用。' : '请先导入旧资料，或开始空白剧情资料。'), status?.ready === false ? 'amin-notice' : 'amin-meta'),
                button('打开设置 → 剧情存储', async () => {
                    if (options.openStorySettings) return options.openStorySettings();
                    if (typeof globalThis.AminOS?.openApp !== 'function') throw Error('请打开 Amin 设置中的「剧情存储」。');
                    await globalThis.AminOS.openApp('settings');
                    const pane = document.querySelector?.('[data-app="settings"]');
                    const tab = [...(pane?.querySelectorAll?.('button') ?? [])].find(node => node.textContent === '剧情存储');
                    if (tab) tab.click();
                }, { lock: 'busy' }));
            return;
        }
        const available = status?.available === true, migrated = status?.migrated === true;
        nativePanel.replaceChildren(make('h3', '剧情变量 · 小白变量 2.0'), make('p', '回复中的 <state> 由小白变量 2.0 自动执行；Amin 读取结果并刷新人物、背包、场景等应用。', 'amin-meta'));
        nativePanel.append(make('p', status?.message || (available ? migrated ? '当前剧情资料已迁移到变量 2.0。' : '可初始化或迁移当前聊天的剧情变量。' : '请先启用小白盒子的变量 2.0，再刷新本页。'), available ? 'amin-meta' : 'amin-notice'));
        if(migrated && status?.ready===false){
            nativePanel.append(make('p',status.restoreError?'恢复失败：'+status.restoreError:status.restoring?'正在恢复当前分支，请稍候。':'当前分支尚未恢复完成。','amin-notice'));
            if(typeof api.retryState2Restore==='function')nativePanel.append(button('重试恢复当前分支',async()=>{const result=await api.retryState2Restore();say(result.message||'当前分支状态已恢复。');},{lock:'busy'}));
        }
        if (migrated && status?.ready===false && typeof api.inspectStoryReferences==='function') {
            nativePanel.append(button('检查剧情存档引用',async()=>{referenceRepairPlan=null;referenceRepairPlan=await api.inspectStoryReferences();say(referenceRepairPlan.repairs.length?'已检查，请核对下方楼层后确认。':'没有发现可重新关联的校验失配。');},{lock:'busy'}));
            if(referenceRepairPlan?.repairs?.length){
                nativePanel.append(make('p','校验不一致的楼层：'+referenceRepairPlan.repairs.map(r=>r.index+1).join('、')+'。这些楼层的外置存档仍可读取。确认后保留各楼原有存档，只重新关联当前消息；若正文实际改变了剧情，原存档可能不再符合新剧情。','amin-notice'));
                nativePanel.append(button('确认采用这些楼层的原有存档',async()=>{const result=await api.repairStoryReferences(referenceRepairPlan);referenceRepairPlan=null;say(result.message);},{lock:'busy'}));
            }
        }
        if (!available) nativePanel.append(make('p', '在小白盒子中启用变量 2.0 后，Amin 才能读取并更新当前聊天的剧情资料。', 'amin-meta'));
        if (available && typeof api.migrateState2 === 'function') {
            nativePanel.append(button('初始化／迁移剧情变量', async () => {
                if (settingsDirty) throw Error('请先保存或放弃上方的联动设置修改。');
                const result = await api.migrateState2();
                say(result?.message || (result?.changed ? '剧情变量已迁移。' : '剧情变量已是最新状态。'));
            }, { primary: !migrated, lock: 'migration' }), make('p', '迁移前会保留备份和旧记录；发现已有变量冲突会提示，不直接覆盖。', 'amin-meta'));
        }
    }
    function renderDiagnostics() {
        diagnosticsPanel.hidden = typeof api.updateDiagnostics !== 'function';
        if (diagnosticsPanel.hidden) return;
        const records = api.updateDiagnostics() ?? [];
        diagnosticsPanel.replaceChildren(make('summary', `${independent() ? '本轮与近期剧情更新记录' : '本轮与近期变量更新记录'}（${records.length}）`),
            make('p', independent() ? '仅显示当前聊天近期的更新记录。模型变更须通过 Amin 校验；当前剧情资料以已应用的结果为准。'
                : '仅保留当前聊天、本次运行的有限记录；刷新或切换聊天后清空，不写入聊天或外置存档。记录反映观察到的变量变化，不保证每项模型指令都已执行。', 'amin-meta'));
        if (typeof api.clearUpdateDiagnostics === 'function') diagnosticsPanel.append(button('清空更新记录', async () => { await api.clearUpdateDiagnostics(); }, { lock: 'busy' }));
        if (!records.length) diagnosticsPanel.append(make('p', '尚无本次运行的更新记录。', 'amin-meta'));
        const labels = independent()
            ? { changed: '剧情资料已更新', 'native-error': '更新校验失败', unknown: '无法比较更新前后', 'state-without-change': '收到更新，资料未变化', 'no-state': '未收到剧情更新' }
            : { changed: '观察到变量变化', 'native-error': '小白报告更新错误', unknown: '无法比较更新前后', 'state-without-change': '收到 <state>，未观察到变化', 'no-state': '未收到 <state>，未观察到变化' };
        for (const record of records.slice(0, 24)) {
            const entry = make('section', '', 'amin-stack');
            entry.append(make('h4', `${Number.isInteger(record.index) ? `第 ${record.index + 1} 楼` : '当前回复'}${Number.isInteger(record.swipe) ? ` · Swipe ${record.swipe + 1}` : ''} · ${labels[record.outcome] ?? '更新记录'}`),
                make('p', `来源：${record.source || '未知'} · ${record.receivedState ? '检测到更新块' : '未检测到更新块'}`, 'amin-meta'));
            for (const error of (record.errors ?? []).slice(0, 5)) entry.append(make('p', `${independent() ? '更新反馈' : '小白反馈'}：${error}`, 'amin-notice'));
            for (const warning of (record.warnings ?? []).slice(0, 4)) entry.append(make('p', warning, 'amin-meta'));
            for (const change of (record.changes ?? []).slice(0, 40)) {
                const row = make('div', '', 'amin-card amin-stack');
                row.append(make('strong', change.path), make('p', `更新前：${change.before}`), make('p', `更新后：${change.after}`)); entry.append(row);
            }
            diagnosticsPanel.append(entry);
        }
    }
    function refreshPrompt() {
        try { const dynamic = text(api.prompt()); promptCache = !independent() && dynamic && worldbookTemplate !== null ? worldbookTemplate.replace('{{amin_os_linkage}}', () => dynamic) : dynamic; promptError = ''; }
        catch (error) { promptCache = ''; promptError = error?.message ?? String(error); }
        if (promptValue) promptValue.value = promptCache;
    }
    function createPromptPanel() {
        promptPanel.append(make('summary', independent() ? 'Amin 更新规则与旧条目检查' : '统一世界书条目与预览'), make('p', independent()
            ? '插件直接提供 <amin_update> 格式、模块权限和更新规则。这里预览和复制的内容与实际发送的规则一致。检查绑定世界书仅检查旧条目，不合并其前后文；手写业务规则请填入“用户补充要求”。当前资料按“资料发送来源”设置提供。'
            : '统一世界书条目提供小白变量 2.0 的 <state> 更新格式和规则。当前资料按上方“资料发送来源”设置提供，Amin 模式的内容可在下方“消息内资料预览”查看。此处使用已保存配置；检查绑定世界书后会合并条目手写前后文。', 'amin-meta'));
        promptStatus = make('p', '', 'amin-meta'); promptValue = make('textarea', '', 'amin-linkage-code'); promptValue.readOnly = true; promptValue.rows = 14; promptValue.setAttribute('aria-label', independent() ? '更新规则预览内容' : '统一条目预览内容');
        const actions = make('div', '', 'amin-toolbar');
        actions.append(button(independent() ? '刷新更新规则预览' : '刷新条目预览', () => { refreshPrompt(); if (promptError) throw Error(promptError); say(independent() ? '已刷新插件实际发送的 Amin 更新规则预览。' : '已刷新统一条目预览。'); }, { lock: 'busy' }), button(independent() ? '复制更新规则' : '复制条目预览', async () => {
            refreshPrompt(); if (promptError) throw Error(promptError); if (!promptCache) throw Error(independent() ? '当前没有可复制的更新规则。' : '当前没有可复制的条目内容。');
            const clipboard = options.clipboard ?? document.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard;
            if (clipboard?.writeText) { try { await clipboard.writeText(promptCache); say(independent() ? '已复制插件实际发送的 Amin 更新规则。' : '已复制统一条目完整内容。'); return; } catch { /* The selected preview is a usable fallback in restricted webviews. */ } }
            promptPanel.open = true; promptValue.focus(); promptValue.select?.(); say(independent() ? '请从已选中的更新规则预览中手动复制。' : '请从已选中的预览文本中手动复制。');
        }, { lock: 'busy' }));
        worldbookStatus = make('p', worldbookMessage, 'amin-meta');
        inspectButton = button('检查绑定世界书', async () => {
            worldbookTemplate=null;refreshPrompt();
            const result = await worldbook.inspect({ getContext }); check(); worldbookMessage = `世界书「${result.name}」：` + (result.message || (result.exists ? '已安装统一条目' : '尚未安装统一条目'));
            worldbookTemplate=typeof result.content==='string'&&result.content.split('{{amin_os_linkage}}').length===2?result.content:null;refreshPrompt();
            worldbookStatus.textContent = worldbookMessage; say(worldbookMessage, result.valid === false && result.exists === true);
        }, { lock: 'busy' });
        installButton = button('安装／更新统一条目', async () => {
            if (settingsDirty) throw Error('请先保存联动设置。');
            const result = await worldbook.install({ getContext }); check();
            worldbookMessage = `世界书「${result.name}」：` + (result.message || `${result.action || '已更新'}统一条目（UID ${result.uid}）。`);
            if (result.warning) worldbookMessage += '\n' + result.warning;
            worldbookStatus.textContent = worldbookMessage; say(worldbookMessage, !!result.warning);
        }, { primary: true });
        const worldbookActions = make('div', '', 'amin-toolbar'); worldbookActions.append(inspectButton, installButton);
        promptPanel.append(promptStatus, promptValue, actions, worldbookStatus, worldbookActions, make('p', independent()
            ? '独立模式的 Amin 更新规则由插件直接提供，不依赖旧世界书条目。世界书检查仅报告旧条目状态，不将其原文加入本预览。手写业务规则请放入“用户补充要求”并保存；当前资料按所选来源单独提供。'
            : '世界书模板在生成时只展开变量 2.0 更新规则，不包含插件生成的当前应用资料。再次安装保留条目的停用、位置、触发设置及自定义规则。额外联动规则按聊天保存。', 'amin-meta'));
    }
    function refreshData(report = null) {
        try { if (report?.error) throw Error(report.error); dataCache = text(report ? report.prompt : api.dataPrompt?.() ?? ''); dataError = ''; }
        catch (error) { dataCache = ''; dataError = error?.message ?? String(error); }
        if (dataValue) dataValue.value = dataCache;
    }
    function createDataPanel() {
        dataPanel.append(make('summary', '消息内资料预览'), make('p', '选择 Amin 作为资料来源时，插件按模块的“提供资料给模型”权限，将当前资料插入发给 AI 的消息上下文；不写入世界书，也不保存到可见聊天正文。选择预设／世界书来源时，Amin 停止注入。此预览使用已保存的配置。', 'amin-meta'));
        dataStatus = make('p', '', 'amin-meta'); dataValue = make('textarea', '', 'amin-linkage-code'); dataValue.readOnly = true; dataValue.rows = 14; dataValue.setAttribute('aria-label', '消息内资料预览内容');
        dataPanel.append(dataStatus, dataValue, button('刷新消息内资料预览', () => { refreshData(); if (dataError) throw Error(dataError); say('已刷新消息内资料预览。'); }, { lock: 'busy' }));
    }
    function renderReview() {
        reviewPanel.replaceChildren(); const pending = api.preview(); reviewPanel.hidden=!pending;if (!pending) return;
        const card = make('section', '', 'amin-card amin-stack amin-result'); card.append(make('h3', pending.label || (independent() ? 'Amin 剧情更新待确认' : '历史 Amin 更新待确认')));
        if (pending.summary) card.append(make('p', Array.isArray(pending.summary) ? pending.summary.join('\n') : text(pending.summary), 'amin-linkage-text'));
        if (pending.source) card.append(make('p', '来源：' + sourceLabel(pending.source), 'amin-meta'));
        const changes = values(pending.changes ?? pending.operations);
        for (const change of changes) {
            const row = make('article', '', 'amin-linkage-change amin-stack'), module = moduleRows.find(item => item.id === change.module);
            row.append(make('h4', [...new Set([module?.label || change.module || '关联资料', change.label || change.action || change.op || '', change.target || ''].filter(Boolean))].join(' · ')));
            if (change.summary) row.append(make('p', text(change.summary), 'amin-linkage-text'));
            if (Object.hasOwn(change, 'before') || Object.hasOwn(change, 'after')) {
                const comparison = make('div', '', 'amin-linkage-comparison');
                for (const [key, label] of [['before', '更新前'], ['after', '更新后']]) { const column = make('div', '', 'amin-stack'); column.append(make('strong', label), make('pre', text(change[key]) || '无', 'amin-linkage-value')); comparison.append(column); }
                const details=make('details');details.append(make('summary','查看更新前后的完整资料'),comparison);row.append(details);
            } else { const content = change.value ?? change.payload ?? change.data ?? change.patch; if (content !== undefined) row.append(make('pre', text(content), 'amin-linkage-value')); }
            if (change.reason) row.append(make('p', '原因：' + change.reason, 'amin-meta')); card.append(row);
        }
        for (const warning of values(pending.warnings)) card.append(make('p', text(warning), 'amin-meta'));
        for (const error of values(pending.errors)) card.append(make('p', text(error), 'amin-notice'));
        const actions = make('div', '', 'amin-toolbar');
        const confirm = button('确认整组更新一次', async () => { await api.confirm(); say('整组关联更新已应用并保存。'); }, { primary: true, lock: 'confirm' });
        if (values(pending.errors).length || pending.valid === false) confirm.dataset.linkageInvalid = 'true';
        actions.append(confirm, button('放弃这组更新', () => { api.discard(); say('已放弃待确认更新，当前资料保持原值。'); }, { lock: 'busy' }));
        card.append(make('p', independent() ? '确认前不会改写当前剧情资料。请核对人物、物品、数值及关联关系；确认后整组变更一起保存。'
            : '这是旧版 Amin 更新建议。确认前不会写入各应用；请核对人物、物品与数值的对应关系。新回复由小白变量 2.0 处理。', 'amin-meta'), actions); reviewPanel.append(card);
    }
    function renderSuggestions() {
        suggestionsPanel.replaceChildren(make('h3', independent() ? 'Amin 剧情更新建议' : '历史 Amin 更新建议'));
        const suggestions = values(api.suggestions());
        suggestionsPanel.hidden = !suggestions.length;
        if (!suggestions.length) return;
        suggestionsPanel.append(make('p', independent() ? '回复中的 <amin_update> 会先校验整组变更。预览模式下由你确认；自动模式下校验通过后应用。'
            : '仅用于处理升级前收到的 <amin_update> 建议；新回复由小白变量 2.0 自动更新。', 'amin-meta'));
        for (const suggestion of suggestions) {
            const row = make('article', '', 'amin-linkage-suggestion amin-stack');
            row.append(make('strong', sourceLabel(suggestion.source)), make('p', suggestion.label || '一组关联更新', 'amin-meta'));
            const source = make('details'); source.append(make('summary', '查看原始更新内容'), make('pre', text(suggestion.text), 'amin-linkage-value')); row.append(source);
            if (suggestion.error) row.append(make('p', text(suggestion.error), 'amin-meta'));
            row.append(button('校验并预览这组更新', async () => { await api.stageSuggestion(suggestion.id); say('已校验更新建议，请检查整组变更。'); })); suggestionsPanel.append(row);
        }
    }
    function renderReferences() {
        const open = referencesPanel.open; referencesPanel.replaceChildren(make('summary', '跨应用引用检查')); referencesPanel.open = open;
        try {
            const report = api.references(), entities = values(report.entities), links = values(report.links), unresolved = values(report.unresolved);
            const entityName = id => entities.find(item => item.id === id)?.label || id;
            referencesPanel.append(make('p', `${entities.length} 个实体 · ${links.length} 条关联 · ${unresolved.length} 条未解析引用`, 'amin-meta'));
            if (!unresolved.length) referencesPanel.append(make('p', '当前检查未发现未解析引用。', 'amin-empty'));
            else {
                const list = make('ul', '', 'amin-linkage-reference-list');
                for (const item of unresolved) list.append(make('li', typeof item === 'string' ? item : [item.label || item.message || item.reason, item.module, item.fromId || item.sourceId || item.from, item.targetId || item.toId || item.target || item.to].filter(Boolean).map(text).join(' · ') || text(item)));
                referencesPanel.append(list, make('p', '未解析引用会保留原 ID，不会按同名记录自动替换。请到对应应用修正后重新检查。', 'amin-meta'));
            }
            const details = make('details'); details.append(make('summary', '查看已有的条目关联'));
            if (!links.length) details.append(make('p', '当前没有条目间的关联。', 'amin-empty'));
            else {
                const list=make('ul','','amin-linkage-reference-list');
                for(const link of links)list.append(make('li',`${entityName(link.from)} → ${entityName(link.to)}${link.label?' · '+link.label:''}`));
                details.append(list);
            }
            details.append(make('p','由人物归属、穿戴、日程等字段产生的关联，在对应应用中修改。','amin-meta'));referencesPanel.append(details);
            if(typeof api.saveLinks==='function') {
                const manual=make('section','','amin-stack');manual.append(make('h4','手动关联'),make('p','选择两个现有条目，补充它们的关联说明。删除只解除手动关联，不删除原条目。','amin-meta'));
                if(settingsDirty)manual.append(make('p','请先保存或放弃上方的联动设置修改，再编辑手动关联。','amin-meta'));
                const form=make('div','','amin-form-grid');
                const selectEntity=(label,value,onChange)=>{
                    const row=make('label','','amin-field'),select=make('select');select.setAttribute('aria-label',label);select.dataset.linkageLock='links';
                    const placeholder=make('option','请选择条目');placeholder.value='';select.append(placeholder);
                    for(const entity of entities){const option=make('option',`${moduleRows.find(item=>item.id===entity.module)?.label||entity.module||'条目'} · ${entity.label||entity.id}${entity.label&&entity.label!==entity.id?' · '+entity.id:''}`);option.value=entity.id;select.append(option);}
                    select.value=entities.some(item=>item.id===value)?value:'';select.addEventListener('change',()=>onChange(select.value));row.append(make('span',label),select);form.append(row);return select;
                };
                selectEntity('关联来源条目',manualFrom,value=>{manualFrom=value;});selectEntity('关联目标条目',manualTo,value=>{manualTo=value;});
                const labelRow=make('label','','amin-field amin-span-full'),label=make('input');label.type='text';label.value=manualLabel;label.maxLength=200;label.setAttribute('aria-label','关联说明');label.dataset.linkageLock='links';label.addEventListener('input',()=>{manualLabel=label.value;});labelRow.append(make('span','关联说明'),label);form.append(labelRow);manual.append(form);
                manual.append(button('保存新关联',async()=>{
                    if(!manualFrom||!manualTo||!entities.some(item=>item.id===manualFrom)||!entities.some(item=>item.id===manualTo))throw Error('请选择仍然存在的来源和目标条目。');
                    if(!manualLabel.trim())throw Error('请填写关联说明。');
                    const current=api.settings().links??[];await api.saveLinks([...current,{id:options.createId?.()??uuid(),from:manualFrom,to:manualTo,label:manualLabel.trim()}]);manualFrom='';manualTo='';manualLabel='';say('已保存两个条目之间的关联。');
                },{primary:true,lock:'links'}));
                const manualLinks=api.settings().links??[];
                if(!manualLinks.length)manual.append(make('p','还没有手动添加的关联。','amin-empty'));
                for(const link of manualLinks){const row=make('article','','amin-linkage-suggestion amin-stack');row.append(make('p',`${entityName(link.from)} → ${entityName(link.to)}`),make('p',link.label,'amin-meta'));const remove=button('解除手动关联',async()=>{await api.saveLinks((api.settings().links??[]).filter(item=>item.id!==link.id));say('已解除手动关联，原条目仍保留。');},{lock:'links'});remove.setAttribute('aria-label',`解除手动关联：${link.label}`);row.append(remove);manual.append(row);}
                referencesPanel.append(manual);
            }
            referencesPanel.append(button('刷新引用检查', () => { renderReferences(); say('已重新检查跨应用引用。'); }, { lock: 'busy' }));
        } catch (error) { referencesPanel.append(make('p', error?.message ?? String(error), 'amin-notice')); }
    }
    function createManualPanel() {
        manualPanel.append(make('summary', independent() ? '手动校验 Amin 剧情更新' : '手动导入旧版 Amin 更新建议'));
        const input = make('textarea'); input.rows = 6; input.setAttribute('aria-label', '待校验的统一更新内容'); input.placeholder = '粘贴模型返回的统一更新块，再校验并预览。';
        input.addEventListener('input', () => { pasted = input.value; });
        manualPanel.append(input, button('校验并预览粘贴内容', async () => { if (!pasted.trim()) throw Error('请先粘贴更新内容。'); await api.stage(pasted); say('已校验更新内容，请检查整组变更。'); }), make('p', independent()
            ? '粘贴 <amin_update> 更新内容后先校验并预览，确认后才会写入当前剧情资料。'
            : '此入口仅供处理旧版 <amin_update>。新回复的 <state> 由小白变量 2.0 执行；粘贴内容不会直接写入应用。', 'amin-meta'));
    }
    function render() {
        if (disposed) return;
        try {
            check(); const current = api.settings(); moduleRows = api.modules(); unavailable = false;
            savedDataReport = typeof api.dataPromptReport === 'function' ? api.dataPromptReport() : null;
            const nextModulesSignature=JSON.stringify(moduleRows), modulesChanged=nextModulesSignature!==modulesSignature;modulesSignature=nextModulesSignature;
            const changed = !saved || JSON.stringify(current) !== JSON.stringify(saved);
            if (!saved || (changed && !settingsDirty)) { saved = clone(current); draft = clone(current); draft.modules ??= {}; settingsDirty = false; renderSettings(); }
            else if (changed) { saved = clone(current); markDraft(); }
            else if(modulesChanged)renderSettings();
            context.textContent = contextLine(getContext(), current.enabled ? independent() ? 'Amin 独立剧情资料' : '小白变量 2.0' : '联动尚未启用', `已选 ${moduleRows.filter(row => row.enabled).length} 个模块`);
            renderNativeState2(); renderDiagnostics(); refreshPrompt(); refreshData(savedDataReport); renderReview(); renderSuggestions(); renderReferences(); retryPanel.replaceChildren();retryPanel.hidden=!api.dirty();
            budgetReportPanel.replaceChildren(); budgetReportPanel.hidden = typeof api.dataPromptReport !== 'function';
            if (!budgetReportPanel.hidden) renderContextBudgetReport(budgetReportPanel, savedDataReport, { document });
            if (api.dirty()) retryPanel.append(make('h3', '保存尚未完成'), make('p', '已确认变更保留在当前聊天内存中。重试只保存这组结果，不再执行一次更新。', 'amin-meta'), button('重试保存整组更新', async () => { await api.retrySave(); say('此前确认的整组更新已保存。'); }, { primary: true, lock: 'busy' }));
            const status = api.status(), serviceStatus = typeof status === 'string' ? status : status?.message || '';
            if(serviceStatus!==lastServiceStatus){lastServiceStatus=serviceStatus;if(!localBusy){message='';failed=false;}}
            if (!message) { notice.textContent = serviceStatus; notice.dataset.state = busy() ? 'busy' : ''; }
            else say(message, failed);
        } catch (error) { unavailable = true; context.textContent = contextLine(getContext(), '联动不可用'); say(error?.message ?? String(error), true); }
        updateLocks();
        for (const element of page.querySelectorAll?.('[data-linkage-invalid]') ?? []) element.disabled = true;
    }
    createPromptPanel(); createDataPanel(); createManualPanel(); const unsubscribe = api.subscribe(render); render();
    function revealWithinPanel(section) {
        // scrollIntoView also scrolls outer ancestors, including the host page.
        // This workbench owns its tab's scrollport; leave the chat and viewport alone.
        if (!section.getBoundingClientRect || !target.getBoundingClientRect) return;
        const offset = section.getBoundingClientRect().top - target.getBoundingClientRect().top - (target.clientTop || 0);
        target.scrollTop = Math.max(0, (target.scrollTop || 0) + offset);
    }
    const view = { element: page, open(section) {
        if(disposed)return;render();
        if(section==='prompt'){promptPanel.open=true;revealWithinPanel(promptPanel);promptPanel.querySelectorAll?.('summary')?.[0]?.focus?.({preventScroll:true});}
        else if(section==='updates')revealWithinPanel(api.preview()?reviewPanel:nativePanel);
        else if(section==='joint'){
            generationView.open();const element=generationView.element;element.querySelector?.('summary')?.focus?.({preventScroll:true});
            // Scroll only the nearest scrolling pane (the OS window), never the host page.
            // Sections above may still grow while they load, so align once more shortly after.
            const reveal=()=>{if(disposed||!element.getBoundingClientRect)return;let pane=target;while(pane&&pane.parentElement&&!(pane.scrollHeight>pane.clientHeight&&/auto|scroll/.test(globalThis.getComputedStyle?.(pane)?.overflowY??'')))pane=pane.parentElement;
                if(pane?.getBoundingClientRect&&pane!==document.documentElement&&pane!==document.body)pane.scrollTop+=element.getBoundingClientRect().top-pane.getBoundingClientRect().top;};
            reveal();globalThis.setTimeout?.(reveal,300);
        }
    }, dispose() { if (disposed) return; disposed = true; generationView.dispose(); unsubscribe?.(); page.remove(); mounted.delete(target); } };
    mounted.set(target, view); return view;
}
