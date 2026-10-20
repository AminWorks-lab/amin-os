import { createFormControls } from '../../ui/forms.js';
import { mountGeneration } from '../generation/view.js';
import { uuid } from '../../uuid.js';
import { createInventoryService, getSharedInventoryService } from './service.js';
import { WEAR_SLOTS, WEAR_LAYERS } from './model.js';
import { attachLinkageBadge } from '../linkage/badge.js';

const mounted = new WeakMap();
const TABS = { items: '物品', wear: '穿戴与外观', balances: '资源与货币', ledger: '变更账本' };
const OP_LABELS = { 'save-item': '登记 / 编辑物品', 'delete-item': '移除空物品记录', 'consume-item': '消耗物品', 'transfer-item': '转交物品', 'equip-item': '调整装备', 'set-condition': '更新物品状态', 'save-balance': '登记 / 编辑资源', 'delete-balance': '移除空资源账户', 'adjust-balance': '资源收支', 'transfer-balance': '转交资源', restore: '恢复存档' };

/** Every write uses the shared preview/confirm operation; reopening never repeats it. */
export function mount(target, options = {}) {
    if (mounted.has(target)) return mounted.get(target);
    const doc = options.document ?? target.ownerDocument ?? document;
    const ownService = !options.service && !options.api && !!options.getContext;
    const api = options.service ?? options.api ?? (ownService ? createInventoryService(options.getContext) : getSharedInventoryService());
    const formControls = createFormControls(doc, { rows: 3, register: (node, kind) => register(node, kind) });
    const { make, select, checkbox, grid, toolbar } = formControls;
    const page = make('section', '', 'amin-ui amin-page amin-app-page amin-inventory');
    const context = make('div', '', 'amin-context'), tabs = make('nav', '', 'amin-tabs'), notice = make('div', '', 'amin-notice');
    attachLinkageBadge(context, 'inventory', { getContext: () => api.context?.() });
    const review = make('section', '', 'amin-stack'), body = make('section', '', 'amin-stack');
    const instance = 'amin-inventory-' + uuid();
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '背包与资源页面');
    body.id = instance + '-body'; body.setAttribute('role', 'tabpanel');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    page.append(context, tabs, notice, review, body); target.append(page);
    const generationView = mountGeneration(page, { modules: ['inventory'], getContext: options.getContext ?? (() => api.context()), document: doc, service: options.generationService, ai: options.ai });
    let selected = 'items', form = null, disposed = false, working = false;
    const filters = { owner: '', query: '', kind: '', count: 50 };
    let bodyControls = [], reviewControls = [], list = null, state = null, characters = [];

    const say = (message, mode = '') => { if (!disposed) { notice.textContent = message; notice.dataset.state = mode; } };
    const busy = () => working || !!api.busy();
    const dirty = () => !!api.dirty();
    const pending = () => !!api.preview();
    const itemTab = () => selected === 'items' || selected === 'wear';
    const ownerLabel = id => characters.find(person => person.id === id)?.name ?? `已删除或不在当前分支的人物（${id}）`;
    function card(title, parent = body, className = 'amin-card amin-stack') {
        const box = make('section', '', className); if (title) box.append(make('h3', title)); parent.append(box); return box;
    }
    function register(control, kind = 'mutate', group = bodyControls) { group.push({ control, kind, base: !!control.disabled }); return control; }
    function disable(control) { control.disabled = true; const row = bodyControls.find(item => item.control === control); if (row) row.base = true; }
    function button(parent, label, action, { primary = false, danger = false, kind = 'mutate', group = bodyControls } = {}) {
        const element = make('button', label, primary ? 'amin-primary' : danger ? 'amin-danger' : ''); element.type = 'button';
        element.addEventListener('click', async () => {
            if (disposed || element.disabled) return;
            element.disabled = true;
            try { await action(); } catch (error) { say(error?.message ?? String(error), 'error'); }
            finally { updateDisabled(); }
        });
        parent.append(element); return register(element, kind, group);
    }
    const field = formControls.field;
    function ownerChoices(existing = '') {
        const choices = [['', '请选择人物'], ...characters.map(person => [person.id, person.name + (person.kind === 'pc' ? ' · 玩家角色' : '')])];
        if (existing && !characters.some(person => person.id === existing)) choices.push([existing, ownerLabel(existing)]);
        return choices;
    }
    function numeric(input, label) {
        if (!String(input.value).trim()) throw Error(`请填写${label}。`);
        const value = Number(input.value); if (!Number.isFinite(value)) throw Error(`${label}必须是有效数字。`); return value;
    }
    function updateDisabled() {
        if (disposed) return;
        const locked = busy(), unsaved = dirty(), previewing = pending();
        page.setAttribute('aria-busy', String(locked));
        for (const { control, kind, base } of [...bodyControls, ...reviewControls]) {
            const invalid = !!form && !form.valid;
            control.disabled = base || locked || (['mutate', 'top'].includes(kind) && (unsaved || previewing || invalid))
                || (kind === 'form' && (unsaved || previewing)) || (kind === 'cancel' && unsaved)
                || (kind === 'confirm' && (!previewing || unsaved)) || (kind === 'retry' && !unsaved);
        }
        for (const element of tabs.children) element.disabled = locked;
    }
    function canLeaveEditor() {
        if (form) { say('有尚未完成的编辑，请先确认操作或点击“取消编辑”。'); return false; }
        return true;
    }
    function drawTabs() {
        tabs.replaceChildren();
        for (const [id, label] of Object.entries(TABS)) {
            const tab = make('button', label); tab.type = 'button'; tab.id = instance + '-tab-' + id;
            tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', body.id); tab.setAttribute('aria-selected', String(selected === id)); tab.tabIndex = selected === id ? 0 : -1;
            const activate = next => { if (busy() || !canLeaveEditor()) return; selected = next; render(); };
            tab.addEventListener('click', () => activate(id));
            tab.addEventListener('keydown', event => {
                const ids = Object.keys(TABS), index = ids.indexOf(id); let next;
                if (event.key === 'ArrowRight') next = ids[(index + 1) % ids.length];
                else if (event.key === 'ArrowLeft') next = ids[(index + ids.length - 1) % ids.length];
                else if (event.key === 'Home') next = ids[0]; else if (event.key === 'End') next = ids.at(-1); else return;
                event.preventDefault(); activate(next); [...tabs.children].find(node => node.getAttribute('aria-selected') === 'true')?.focus();
            });
            tabs.append(tab);
        }
        body.setAttribute('aria-labelledby', instance + '-tab-' + selected);
    }
    function reflectContext() {
        const ctx = api.context?.(), id = ctx?.getCurrentChatId?.() ?? ctx?.chatId;
        context.textContent = `当前聊天${id != null ? ' · ' + id : ''} · 当前分支的背包与资源；所有数量由你登记，预览后确认才生效。`;
    }
    function summaryText(summary) {
        if (typeof summary === 'string') return summary;
        if (Array.isArray(summary)) return summary.filter(value => typeof value === 'string').join('\n');
        return '';
    }
    function drawLedgerEntry(entry, parent, { compact = false } = {}) {
        const box = card(OP_LABELS[entry.op] ?? entry.summary ?? '资源变更', parent);
        if (entry.reason) box.append(make('p', entry.reason));
        if (!compact) {
            const date = new Date(entry.at); const at = Number.isNaN(date.getTime()) ? entry.at : date.toLocaleString();
            box.append(make('p', `记录时间：${at || '未知'}（现实时间）`, 'amin-meta'));
        }
        for (const change of entry.entries ?? []) {
            const sign = Number(change.delta) > 0 ? '+' : '';
            box.append(make('p', `${ownerLabel(change.ownerId)} · ${change.name}：${change.before} → ${change.after}（${sign}${change.delta}）`, 'amin-meta'));
        }
        if (!entry.entries?.length && entry.summary) box.append(make('p', summaryText(entry.summary), 'amin-meta'));
        return box;
    }
    function drawReview() {
        review.replaceChildren(); reviewControls = [];
        if (dirty()) {
            const box = card('已生效，等待保存', review, 'amin-result amin-stack');
            box.append(make('p', '这次变更已经记入当前聊天内存。请重试保存；重试只保存现有结果，不会再次扣除、增加或转交。'));
            const status = api.status?.(); if (typeof status === 'string' && status) box.append(make('p', status, 'amin-meta'));
            button(toolbar(box), '重试保存', async () => {
                working = true; updateDisabled(); say('正在重新保存当前结果…', 'busy');
                try { await api.retrySave(); form = null; render(); say('已保存，未重复执行变更。', 'success'); }
                finally { working = false; drawReview(); updateDisabled(); }
            }, { primary: true, kind: 'retry', group: reviewControls });
        }
        const preview = api.preview();
        if (preview) {
            const box = card(preview.label || '确认背包与资源变更', review, 'amin-result amin-stack');
            const summary = summaryText(preview.summary); if (summary) box.append(make('p', summary));
            const entry = preview.state?.ledger?.at(-1); if (entry) drawLedgerEntry(entry, box, { compact: true });
            box.append(make('p', '请核对所属人物、数量和原因。确认后才写入当前分支。', 'amin-help'));
            const actions = toolbar(box);
            button(actions, '确认操作', async () => {
                working = true; updateDisabled(); say('正在保存已确认的变更…', 'busy');
                try { await api.confirm(); form = null; render(); say('变更已确认并保存。', 'success'); }
                catch (error) { if (dirty()) { form = null; render(); } throw error; }
                finally { working = false; drawReview(); updateDisabled(); }
            }, { primary: true, kind: 'confirm', group: reviewControls });
            button(actions, '取消预览', () => { api.discard(); drawReview(); updateDisabled(); say('已取消预览，编辑内容仍保留。'); }, { kind: 'cancel', group: reviewControls });
        }
        updateDisabled();
    }
    function stage(op, data) {
        if (!form?.valid) throw Error('编辑来源已变化，请取消编辑后重新打开。');
        api.check?.(form.token); api.stage(op, data, form.token); drawReview(); updateDisabled();
        say('已准备预览，请在上方核对后确认。');
    }
    function startForm(title, build) {
        if (busy() || dirty() || pending()) throw Error('请先完成当前预览或重试保存。');
        const token = api.capture(); api.check?.(token);
        form = { token, valid: true }; body.replaceChildren(); bodyControls = []; list = null;
        const box = card(title), fields = grid(box);
        build(box, fields);
        updateDisabled(); say('编辑中；所有变更都需要预览并确认。');
    }
    function finishForm(box, label, handler) {
        const actions = toolbar(box, 'amin-savebar');
        button(actions, label, handler, { primary: true });
        button(actions, '取消编辑', () => { api.discard(); form = null; render(); say('已取消编辑。'); }, { kind: 'cancel' });
    }
    function reasonField(parent) { return field(parent, '变更原因', '', { maxLength: 1000, full: true }); }
    function conditionFields(parent, value = {}) {
        const wetness = field(parent, '湿润程度（0–100）', value.wetness ?? 0, { type: 'number', min: 0, max: 100, step: 1 });
        const dirt = field(parent, '污渍程度（0–100）', value.dirt ?? 0, { type: 'number', min: 0, max: 100, step: 1 });
        const damage = field(parent, '破损程度（0–100）', value.damage ?? 0, { type: 'number', min: 0, max: 100, step: 1 });
        const notes = field(parent, '物品状态说明', value.notes ?? '', { multi: true, maxLength: 1000 });
        return () => ({ wetness: numeric(wetness, '湿润程度'), dirt: numeric(dirt, '污渍程度'), damage: numeric(damage, '破损程度'), notes: notes.value });
    }
    function editItem(item = null) {
        startForm(item ? '编辑物品' : '登记新物品', (box, fields) => {
            const name = field(fields, '物品名称', item?.name ?? '', { maxLength: 120 });
            const owner = select(fields, '所属人物', ownerChoices(item?.ownerId), item?.ownerId ?? filters.owner);
            if (item) { disable(owner); box.append(make('p', '所属人物通过“转交物品”调整，以保留双方账目。', 'amin-help')); }
            const quantity = field(fields, '数量', item?.quantity ?? 1, { type: 'number', min: 0, max: 1e9, step: 1 });
            const equipped = checkbox(fields, '已装备', item?.equipped ?? false);
            const notes = field(fields, '物品备注（可选）', item?.notes ?? '', { multi: true, maxLength: 4000 });
            const slot = select(fields, '穿戴部位', [['', '未指定（普通物品）'], ...Object.entries(WEAR_SLOTS)], item?.wear?.slot ?? '');
            const layer = select(fields, '穿戴层次', Object.entries(WEAR_LAYERS), item?.wear?.layer ?? 'outer');
            const description = field(fields, '衣物外观', item?.wear?.description ?? '', { multi: true, maxLength: 2000 });
            const condition = conditionFields(fields, item?.condition), reason = reasonField(fields);
            box.append(make('p', '指定部位的衣物逐件登记，数量为 0 或 1。同一部位和层次只能穿戴一件；换装先卸下。0 表示干燥、干净或完好，100 表示完全浸湿、严重污损或完全破损。人物卡直接读取这里的穿戴。', 'amin-help'));
            finishForm(box, '预览保存物品', () => stage('save-item', { ...(item ? { id: item.id } : {}), name: name.value, ownerId: owner.value, quantity: numeric(quantity, '数量'), equipped: equipped.checked, notes: notes.value, wear: { slot: slot.value, layer: layer.value, description: description.value }, condition: condition(), reason: reason.value }));
            name.focus();
        });
    }
    function editCondition(item) {
        startForm(`物品状态：${item.name}`, (box, fields) => {
            const condition = conditionFields(fields, item.condition), reason = reasonField(fields);
            box.append(make('p', '只更新同一件物品的湿润、污渍和破损，不改变数量、归属或穿戴部位。', 'amin-help'));
            finishForm(box, '预览物品状态', () => stage('set-condition', { id: item.id, condition: condition(), reason: reason.value }));
        });
    }
    function itemAction(item, op) {
        const title = op === 'consume-item' ? '消耗物品' : op === 'transfer-item' ? '转交物品' : op === 'equip-item' ? (item.equipped ? '卸下装备' : '装备物品') : '移除空物品记录';
        startForm(title, (box, fields) => {
            box.append(make('p', `${ownerLabel(item.ownerId)} · ${item.name} · 当前数量 ${item.quantity}`, 'amin-meta'));
            let quantity, owner;
            if (op === 'consume-item' || op === 'transfer-item') quantity = field(fields, '操作数量', 1, { type: 'number', min: 1, max: item.quantity, step: 1 });
            if (op === 'transfer-item') {
                owner = select(fields, '接收人物', ownerChoices().filter(([id]) => id !== item.ownerId));
                box.append(make('p', item.wear?.slot ? '这件衣物保留原有编号和湿污破损状态，更改持有人并卸下装备。' : '转交会同时扣除原人物的数量并增加接收人物的记录；接收的物品默认未装备。', 'amin-help'));
            }
            if (op === 'delete-item') box.append(make('p', '仅能移除数量为 0 的物品记录，已有变更账本保留。'));
            const reason = reasonField(fields);
            finishForm(box, '预览' + title, () => stage(op, { id: item.id, reason: reason.value, ...(quantity ? { quantity: numeric(quantity, '操作数量') } : {}), ...(owner ? { toOwnerId: owner.value } : {}), ...(op === 'equip-item' ? { equipped: !item.equipped } : {}) }));
        });
    }
    function editBalance(balance = null) {
        startForm(balance ? '编辑资源账户' : '登记资源账户', (box, fields) => {
            const name = field(fields, '资源名称', balance?.name ?? '', { maxLength: 120 });
            const owner = select(fields, '所属人物', ownerChoices(balance?.ownerId), balance?.ownerId ?? filters.owner);
            if (balance) { disable(owner); box.append(make('p', '所属人物通过“转交资源”调整，以保留双方账目。', 'amin-help')); }
            const amount = field(fields, '当前余额', balance?.amount ?? 0, { type: 'number', min: 0, max: 1e9, step: '0.000001' });
            const unit = field(fields, '单位（可选）', balance?.unit ?? '', { maxLength: 40 });
            const notes = field(fields, '资源备注（可选）', balance?.notes ?? '', { multi: true, maxLength: 4000 }), reason = reasonField(fields);
            box.append(make('p', '货币、弹药或其他资源按你填写的名称与单位分别记账。余额最多保留 6 位小数。', 'amin-help'));
            finishForm(box, '预览保存资源', () => stage('save-balance', { ...(balance ? { id: balance.id } : {}), name: name.value, ownerId: owner.value, amount: numeric(amount, '当前余额'), unit: unit.value, notes: notes.value, reason: reason.value }));
            name.focus();
        });
    }
    function balanceAction(balance, mode) {
        const title = mode === 'credit' ? '收入资源' : mode === 'debit' ? '支出资源' : mode === 'delete' ? '移除空资源账户' : '转交资源';
        startForm(title, (box, fields) => {
            box.append(make('p', `${ownerLabel(balance.ownerId)} · ${balance.name} · 当前余额 ${balance.amount}${balance.unit ? ' ' + balance.unit : ''}`, 'amin-meta'));
            if (mode === 'delete') {
                const reason = reasonField(fields); box.append(make('p', '仅能移除余额为 0 的资源账户，已有变更账本保留。'));
                finishForm(box, '预览移除空资源账户', () => stage('delete-balance', { id: balance.id, reason: reason.value })); return;
            }
            const amount = field(fields, '操作金额 / 数量', '', { type: 'number', min: '0.000001', max: mode === 'credit' ? 1e9 : balance.amount, step: '0.000001' });
            const owner = mode === 'transfer' ? select(fields, '接收人物', ownerChoices().filter(([id]) => id !== balance.ownerId)) : null;
            if (owner) box.append(make('p', '按相同资源名称与单位转交。双方余额会一起更新；同名账户不明确时会要求先整理账户。', 'amin-help'));
            const reason = reasonField(fields);
            finishForm(box, '预览' + title, () => {
                const value = numeric(amount, '操作金额 / 数量'); if (value <= 0) throw Error('操作金额 / 数量必须大于 0。');
                stage(owner ? 'transfer-balance' : 'adjust-balance', { id: balance.id, reason: reason.value, ...(owner ? { amount: value, toOwnerId: owner.value } : { delta: mode === 'debit' ? -value : value }) });
            });
        });
    }
    function matches(entry) {
        return (!filters.owner || entry.ownerId === filters.owner) && (!filters.query || [entry.name, entry.notes, entry.unit, ownerLabel(entry.ownerId)].filter(Boolean).join(' ').toLocaleLowerCase().includes(filters.query.toLocaleLowerCase()));
    }
    function drawEntries() {
        if (!list || !state) return;
        // Remove references to old list controls while preserving the filter inputs.
        bodyControls = bodyControls.filter(row => row.kind === 'filter' || row.kind === 'top');
        list.replaceChildren();
        if (selected === 'ledger') {
            const entries = state.ledger.filter(entry => (!filters.owner || entry.entries?.some(change => change.ownerId === filters.owner))
                && (!filters.kind || entry.entries?.some(change => change.kind === filters.kind))
                && (!filters.query || [entry.reason, entry.summary, OP_LABELS[entry.op], ...(entry.entries ?? []).map(change => change.name + ' ' + ownerLabel(change.ownerId))].join(' ').toLocaleLowerCase().includes(filters.query.toLocaleLowerCase()))).slice().reverse();
            list.append(make('p', `符合筛选的记录 ${entries.length} 条，显示最近 ${Math.min(entries.length, filters.count)} 条。`, 'amin-meta'));
            if (!entries.length) list.append(make('p', '还没有符合筛选的变更记录。确认物品或资源操作后会自动记账。', 'amin-empty'));
            for (const entry of entries.slice(0, filters.count)) drawLedgerEntry(entry, list);
        } else {
            const entries = (itemTab() ? state.items : state.balances).filter(matches).filter(entry => selected !== 'wear' || entry.wear?.slot || entry.equipped);
            if (!entries.length) list.append(make('p', itemTab() ? '没有符合筛选的物品。先在人物应用登记人物，再添加随身物品；衣物可指定穿戴部位。' : '没有符合筛选的资源账户。可登记金币、补给或其他需要记账的资源。', 'amin-empty'));
            for (const entry of entries) {
                const box = card(entry.name, list), heading = make('div', '', 'amin-section-heading');
                heading.append(make('strong', itemTab() ? `数量 ${entry.quantity}${entry.equipped ? ' · 已装备' : ''}` : `余额 ${entry.amount}${entry.unit ? ' ' + entry.unit : ''}`), make('span', ownerLabel(entry.ownerId), 'amin-meta')); box.append(heading);
                if (entry.notes) box.append(make('p', entry.notes));
                if (entry.wear?.slot) box.append(make('p', `${WEAR_SLOTS[entry.wear.slot]} · ${WEAR_LAYERS[entry.wear.layer]}${entry.wear.description ? ' · ' + entry.wear.description : ''}`, 'amin-meta'));
                if (entry.condition) {
                    box.append(make('p', `湿润 ${entry.condition.wetness}/100 · 污渍 ${entry.condition.dirt}/100 · 破损 ${entry.condition.damage}/100`, 'amin-meta'));
                    if (entry.condition.notes) box.append(make('p', entry.condition.notes));
                }
                const actions = toolbar(box);
                if (itemTab()) {
                    button(actions, '编辑物品', () => editItem(entry));
                    button(actions, '物品状态', () => editCondition(entry));
                    if (entry.quantity > 0) button(actions, entry.equipped ? '卸下装备' : '装备物品', () => itemAction(entry, 'equip-item'));
                    if (entry.quantity > 0) { button(actions, '消耗', () => itemAction(entry, 'consume-item')); button(actions, '转交物品', () => itemAction(entry, 'transfer-item')); }
                    else button(actions, '移除空记录', () => itemAction(entry, 'delete-item'), { danger: true });
                } else {
                    button(actions, '编辑资源', () => editBalance(entry)); button(actions, '收入', () => balanceAction(entry, 'credit'));
                    if (entry.amount > 0) { button(actions, '支出', () => balanceAction(entry, 'debit')); button(actions, '转交资源', () => balanceAction(entry, 'transfer')); }
                    else button(actions, '移除空账户', () => balanceAction(entry, 'delete'), { danger: true });
                }
            }
        }
        updateDisabled();
    }
    function drawBody() {
        body.replaceChildren(); bodyControls = []; list = null;
        state = api.read(); characters = api.owners();
        if (!Array.isArray(characters)) characters = characters?.characters ?? [];
        if (selected !== 'ledger') {
            const actions = toolbar(body);
            const add = button(actions, itemTab() ? '登记新物品' : '登记资源账户', () => itemTab() ? editItem() : editBalance(), { primary: true, kind: 'top' });
            if (!characters.length) { add.disabled = true; bodyControls.find(row => row.control === add).base = true; body.append(make('p', '当前分支还没有人物。先在人物应用登记人物，即可将新物品与资源归到具体人物。', 'amin-empty')); }
        }
        const filter = grid(body), refs = new Set([...state.items, ...state.balances, ...state.ledger.flatMap(entry => entry.entries ?? [])].map(entry => entry.ownerId));
        if (filters.owner) refs.add(filters.owner);
        if (selected === 'wear') body.append(make('p', '衣物与已装备物品使用背包中的同一条记录，人物卡会随穿戴和状态变化同步显示。', 'amin-help'));
        const owners = [['', '全部人物'], ...characters.map(person => [person.id, person.name]), ...[...refs].filter(id => id && !characters.some(person => person.id === id)).map(id => [id, ownerLabel(id)])];
        const owner = select(filter, '筛选所属人物', owners, filters.owner, 'filter');
        const query = field(filter, '搜索名称、人物或备注', filters.query, { kind: 'filter', maxLength: 200 });
        owner.addEventListener('change', () => { filters.owner = owner.value; drawEntries(); });
        query.addEventListener('input', () => { filters.query = query.value; drawEntries(); });
        if (selected === 'ledger') {
            const kind = select(filter, '记录类别', [['', '物品与资源'], ['item', '仅物品'], ['balance', '仅资源']], filters.kind, 'filter');
            const count = select(filter, '显示最近记录', [[50, '最近 50 条'], [100, '最近 100 条'], [200, '最近 200 条']], filters.count, 'filter');
            kind.addEventListener('change', () => { filters.kind = kind.value; drawEntries(); }); count.addEventListener('change', () => { filters.count = Number(count.value); drawEntries(); });
        }
        list = make('div', '', 'amin-stack'); body.append(list); drawEntries();
    }
    function render() {
        if (disposed) return;
        reflectContext(); drawTabs(); drawReview();
        if (!form) { try { drawBody(); } catch (error) { body.replaceChildren(make('p', '暂时无法读取背包资料，请处理下方提示后重新打开。', 'amin-empty')); bodyControls = []; say(error?.message ?? String(error), 'error'); } }
        updateDisabled();
    }
    const unsubscribe = api.subscribe(() => {
        if (disposed) return;
        reflectContext(); drawReview();
        if (form && !working && !dirty()) {
            try { api.check?.(form.token); }
            catch (error) { form.valid = false; say('编辑来源已变化，保留输入供你复制；请取消编辑后重新打开。' + (error?.message ?? ''), 'error'); }
        }
        if (!form && !working) render(); else updateDisabled();
    });
    const selectCharacter = event => {
        if (event.detail?.app !== 'inventory' || !event.detail.characterId || disposed) return;
        if (busy() || !canLeaveEditor()) return;
        filters.owner = event.detail.characterId; filters.query = ''; selected = 'wear'; render();
    };
    doc.addEventListener?.('amin:select-character', selectCharacter);
    const view = { open() { render(); }, dispose() { if (disposed) return; disposed = true; generationView.dispose(); doc.removeEventListener?.('amin:select-character', selectCharacter); unsubscribe?.(); if (ownService) api.dispose(); page.remove(); mounted.delete(target); } };
    mounted.set(target, view); render(); return view;
}
