import { createGenerationService } from './service.js';
import { mountWorldbookSources } from '../worldbook-source-ui.js';

const labels = { status: '世界状态', characters: '人物卡', inventory: '背包与账本', relationships: '人物关系', scene: '时间与场景', journal: '剧情档案' };
const actionLabels = { 'set-field': '设置状态最终值', 'create-character': '新增人物', 'update-character': '补充人物资料', 'update-appearance': '设置外观', 'save-stat': '设置人物数值', 'create-item': '新增物品', 'update-item': '更新物品', 'create-balance': '新增账户', 'update-balance': '更新账户', 'set-condition': '设置物品状态', 'save-relationship': '建立或更新关系', 'set-time': '设置时间', 'save-scene': '建立或更新场景', 'save-schedule': '设置日程', 'save-fact': '记录事实', 'save-knowledge': '记录人物知情', 'save-hook': '记录伏笔', 'save-task': '记录任务', 'save-clue': '记录线索', 'draft-chronicle': '起草编年史' };
const fieldLabels = { name:'名称', title:'标题', description:'描述', notes:'备注', quantity:'数量', amount:'金额', value:'数值', unit:'单位', currency:'货币', kind:'类型', appearance:'外观', hairstyle:'发型', features:'特征', ownerId:'所属人物', characterId:'人物', from:'起点人物', to:'终点人物', sourceId:'起点人物', targetId:'终点人物', fromId:'起点人物', toId:'终点人物', label:'称呼', type:'类型', strength:'关系强度', reciprocal:'双向关系', enabled:'启用', equipped:'已装备', wear:'穿戴', slot:'部位', layer:'层次', condition:'状态', wetness:'潮湿程度', dirt:'污渍程度', damage:'损坏程度', content:'内容', text:'正文', reason:'原因', status:'状态', confidence:'可信度', location:'位置', mapId:'地图', nodeId:'地点', activate:'设为当前场景', year:'年', month:'月', day:'日', hour:'时', minute:'分', sourceStart:'来源起始序号（从 0 开始）', sourceEnd:'来源结束序号（含）' };
/** Lazy, local draft editor shared by the apps and the joint initializer. */
export function mountGeneration(target, options = {}) {
    const doc = options.document ?? target.ownerDocument ?? globalThis.document;
    const make = (tag, text = '', cls = '') => { const n = doc.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
    const root = make('details', '', 'amin-card amin-stack amin-generation');
    const statusOnly = options.modules?.length === 1 && options.modules[0] === 'status';
    const title = make('summary', statusOnly ? '按现有剧情更新状态' : options.joint ? '联合初始化' : 'AI 生成／补充'); root.append(title); target.append(root);
    let api, picker, unsubscribe, disposed = false, initialized = false, localBusy = false, controller, rows = [], notice, review, draftHost, mode, instruction, persona, chat, start, end;
    const controls = [], modules = [];
    const context = options.getContext ?? (() => globalThis.SillyTavern.getContext());
    const busy = () => localBusy || !!api?.busy?.();
    function say(text) { if (notice && !disposed) notice.textContent = text; }
    function clear(parent) { const nodes = new Set(); const visit = node => { nodes.add(node); for (const child of node.children ?? []) visit(child); }; visit(parent); for (let i = controls.length - 1; i >= 0; i--) if (nodes.has(controls[i].node)) controls.splice(i, 1); parent.replaceChildren(); }
    function lock() { for (const { node, blocked } of controls) node.disabled = !!blocked(); }
    function button(parent, text, action, blocked = () => busy()) {
        const node = make('button', text); node.type = 'button'; controls.push({ node, blocked });
        node.addEventListener('click', async () => { if (node.disabled || disposed) return; localBusy = true; lock(); try { await action(); } catch (e) { say(e.message ?? String(e)); } finally { localBusy = false; if (!disposed) { renderReview(); lock(); } } }); parent.append(node); return node;
    }
    function field(parent, text, tag = 'input') { const row = make('label', '', 'amin-field'), node = make(tag); node.setAttribute('aria-label', text); row.append(make('span', text), node); parent.append(row); controls.push({ node, blocked: () => busy() || !!api?.dirty?.() || !!api?.preview?.() }); return node; }
    function check(parent, text, checked) { const row = make('label', '', 'amin-check'), node = make('input'); node.type = 'checkbox'; node.checked = checked; node.setAttribute('aria-label', text); row.append(node, make('span', text)); parent.append(row); controls.push({ node, blocked: () => busy() || !!api?.dirty?.() || !!api?.preview?.() }); return node; }
    function renderDraft() {
        clear(draftHost); rows = []; const draft = api.draft(); if (!draft) return;
        draftHost.append(make('h3', '生成建议 · 可编辑并选择保存内容'));
        for (const warning of draft.warnings ?? []) draftHost.append(make('p', warning, 'amin-notice'));
        for (const [index, change] of draft.changes.entries()) {
            const card = make('section', '', 'amin-card amin-stack');
            const selected = check(card, `采用建议 ${index + 1} · ${labels[change.module] ?? change.module}`, true);
            card.append(make('h4', actionLabels[change.action] ?? '更新资料'));
            if (change.target) card.append(make('p', `关联记录：${change.target}`, 'amin-meta'));
            const basic = make('div', '', 'amin-form-grid'); card.append(basic);
            const advanced = make('details', '', 'amin-stack'); advanced.append(make('summary', '高级编辑'));
            const editor = field(advanced, `建议 ${index + 1} JSON`, 'textarea'); editor.rows = 7; editor.value = JSON.stringify(change, null, 2);
            const ordinary = [], invalid = new Set();
            function drawFields(value, path, prefix = '') {
                for (const [key, item] of Object.entries(value ?? {})) {
                    const caption = prefix + (fieldLabels[key] ?? key), keys = [...path, key];
                    if (item && typeof item === 'object' && !Array.isArray(item)) { drawFields(item, keys, caption + ' · '); continue; }
                    if (Array.isArray(item) || item === null) { basic.append(make('p', `${caption}：${Array.isArray(item) ? `${item.length} 项（可在高级编辑中调整）` : '未设置'}`, 'amin-meta')); continue; }
                    const accessible = `建议 ${index + 1} · ${caption}`;
                    const node = typeof item === 'boolean' ? check(basic, accessible, item) : field(basic, accessible, typeof item === 'string' && (item.length > 60 || /description|notes|content|text|reason|features/.test(key)) ? 'textarea' : 'input');
                    if (typeof item !== 'boolean') node.value = String(item);
                    if (typeof item === 'number') { node.type = 'number'; node.step = 'any'; }
                    ordinary.push({ node, keys, type: typeof item });
                    node.addEventListener(typeof item === 'boolean' ? 'change' : 'input', () => {
                        try {
                            const next = JSON.parse(editor.value); let parent = next;
                            for (const key of keys.slice(0, -1)) { if (!parent[key] || typeof parent[key] !== 'object') throw Error('建议结构已在高级编辑中改变，请先完成高级编辑。'); parent = parent[key]; }
                            const replacement = typeof item === 'boolean' ? node.checked : typeof item === 'number' ? Number(node.value) : node.value;
                            if (typeof item === 'number' && (!node.value.trim() || !Number.isFinite(replacement))) throw Error('请填写有效数字。');
                            parent[keys.at(-1)] = replacement; editor.value = JSON.stringify(next, null, 2); invalid.delete(node); node.setAttribute('aria-invalid', 'false');
                        } catch (e) { invalid.add(node); node.setAttribute('aria-invalid', 'true'); say(e.message ?? String(e)); }
                    });
                }
            }
            drawFields({ reason: change.reason ?? '' }, []); drawFields(change.data, ['data']);
            editor.addEventListener('input', () => { try { const next = JSON.parse(editor.value); invalid.clear(); for (const row of ordinary) { row.node.setAttribute('aria-invalid', 'false'); const value = row.keys.reduce((value, key) => value?.[key], next); if (row.type === 'boolean') row.node.checked = value === true; else row.node.value = value == null ? '' : String(value); } } catch { say('高级编辑暂不是有效 JSON，请修正后再预览。'); } });
            card.append(advanced);
            rows.push({ selected, editor, invalid }); draftHost.append(card);
        }
        button(draftHost, '预览所选变更', () => { const selected = rows.filter(row => row.selected.checked).map(row => { if (row.invalid.size) throw Error('请先修正建议中的无效字段。'); return JSON.parse(row.editor.value); }); if (!selected.length) throw Error('请至少选择一条建议。'); api.stage(selected); say('请核对整组变更，再确认保存。'); }, () => busy() || api.dirty() || !!api.preview());
    }
    function renderReview() {
        if (!review || disposed) return; clear(review); const preview = api.preview();
        if (preview) {
            review.append(make('h3', '保存前预览'));
            if (preview.summary) review.append(make('p', Array.isArray(preview.summary) ? preview.summary.join('；') : String(preview.summary), 'amin-meta'));
            for (const change of preview.changes ?? []) {
                review.append(make('p', `${labels[change.module] ?? '关联资料'} · ${actionLabels[change.action] ?? change.summary ?? '更新资料'}${change.reason ? '：' + change.reason : ''}`));
            }
            for (const error of preview.errors ?? []) review.append(make('p', String(error), 'amin-notice'));
            const details = make('details'); details.append(make('summary', '查看完整变更与更新前后资料'));
            const output = make('pre', JSON.stringify(preview, null, 2), 'amin-linkage-value'); output.style && (output.style.whiteSpace = 'pre-wrap'); details.append(output); review.append(details);
            button(review, '确认保存整组资料', async () => { await api.confirm(); clear(draftHost); rows = []; say('整组资料已保存。'); }, () => busy() || api.dirty() || !api.preview() || preview.valid === false || !!preview.errors?.length);
            button(review, '返回编辑建议', () => { api.discard(); say('已取消本次预览，可继续编辑建议。'); }, () => busy() || api.dirty());
        }
        if (api.dirty()) button(review, '重试保存生成资料', async () => { await api.retrySave(); clear(draftHost); rows = []; say('资料已保存，未重复执行变更。'); });
        lock();
    }
    function initialize() {
        if (initialized || disposed) return; initialized = true;
        try {
            api = options.service ?? createGenerationService(context, options.ai ? { ai: options.ai } : {});
            const body = make('div', '', 'amin-stack'); root.append(body);
            body.append(make('p', statusOnly ? '选择已有聊天楼层，结合当前状态和启用的状态规则生成建议。仅更新已有字段的值，保持类型；先编辑、勾选并预览，确认后才保存。使用世界状态 AI 渠道，不改写聊天正文，也不自动更改联动权限。' : '读取所选来源和所选应用的现有资料；为关联已有记录，还会读取人物的名称和 ID，涉及人物数值时读取可绑定字段，涉及场景时读取可见地图地点。生成只形成草稿；预览并确认后才保存，不会自动开启联动更新。', 'amin-meta'));
            const scope = make('div', '', 'amin-form-grid'); body.append(scope);
            const initial = options.modules ?? ['characters'];
            for (const id of Object.keys(labels)) if (statusOnly ? id === 'status' : id !== 'status' && (options.joint || initial.includes(id) || id === 'characters')) modules.push({ id, node: check(scope, `生成范围：${labels[id]}`, initial.includes(id) || !!options.joint) });
            mode = field(body, '生成方式', 'select');
            for (const [value, text] of (statusOnly ? [['update', '按剧情更新']] : [['create', '从零建立（仅新增，保留已有）'], ['supplement', '补充缺项'], ['update', '按剧情更新']])) { const option = make('option', text); option.value = value; mode.append(option); } mode.value = statusOnly ? 'update' : 'supplement';
            const sourceFields = make('fieldset', '', 'amin-stack'); body.append(sourceFields);
            controls.push({ node: sourceFields, blocked: () => busy() || api.dirty() || !!api.preview() });
            picker = (options.mountSources ?? mountWorldbookSources)(sourceFields, { context, value: { includeCharacter: false, readWorldbooks: false, selectedBooks: [] } });
            persona = check(body, '读取用户设定', false); chat = check(body, '读取指定聊天楼层', statusOnly);
            const range = make('div', '', 'amin-form-grid'); body.append(range); start = field(range, '起始楼层（从 1 开始）'); end = field(range, '结束楼层（含）');
            start.type = end.type = 'number'; start.min = end.min = '1'; start.value = String(statusOnly ? Math.max(1, (context()?.chat?.length ?? 1) - 19) : 1); end.value = String(Math.max(1, context()?.chat?.length ?? 1));
            instruction = field(body, '附加要求', 'textarea'); instruction.rows = 3; instruction.value = options.instruction ?? '';
            notice = make('p', '', 'amin-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); body.append(notice);
            const actions = make('div', '', 'amin-toolbar'); body.append(actions);
            button(actions, '生成资料草稿', async () => {
                controller = new AbortController();
                await api.generate({ modules: modules.filter(row => row.node.checked).map(row => row.id), mode: mode.value, instruction: instruction.value, sources: { ...picker.getValue(), includePersona: persona.checked, includeChat: chat.checked, start: Number(start.value) - 1, end: Number(end.value) - 1 } }, { signal: controller.signal });
                if (!disposed) { renderDraft(); say(api.draft()?.changes.length ? '生成完成，请检查和选择建议。' : '所选来源没有需要更新的内容，未修改资料。'); }
            }, () => busy() || api.dirty() || !!api.preview());
            const cancel = make('button', '停止生成'); cancel.type = 'button'; cancel.addEventListener('click', () => { controller?.abort(); api.cancel(); }); actions.append(cancel); controls.push({ node: cancel, blocked: () => !busy() });
            button(actions, '放弃生成草稿', () => { api.discard(); clear(draftHost); rows = []; say('已放弃草稿。'); }, () => busy() || api.dirty());
            draftHost = make('div', '', 'amin-stack'); review = make('section', '', 'amin-stack'); body.append(draftHost, review);
            unsubscribe = api.subscribe?.(() => { if (!disposed) { renderReview(); lock(); } }); renderReview(); lock();
        } catch (e) { root.append(make('p', e.message ?? String(e), 'amin-notice')); }
    }
    title.addEventListener('click', initialize); root.addEventListener('toggle', () => { if (root.open) initialize(); });
    return { element: root, open() { root.open = true; initialize(); }, dispose() { disposed = true; controller?.abort(); unsubscribe?.(); picker?.dispose(); if (!options.service) api?.dispose(); root.remove(); } };
}
