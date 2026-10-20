import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../apps/inventory/view.js';
import { createInventoryService } from '../apps/inventory/service.js';
import { KEY as INVENTORY_KEY } from '../apps/inventory/model.js';
import { KEY as CHARACTERS_KEY, appendSnapshot, emptyStore } from '../apps/characters/model.js';

class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    dispatch(type, event = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, target: this, preventDefault() {}, ...event }); }
    focus() { this.focused = true; }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const visible = node => !node.hidden && (!node.parent || visible(node.parent));
const find = (root, label, tag = 'button') => walk(root).find(node => visible(node) && node.tagName === tag.toUpperCase() && (node.textContent === label || node.getAttribute('aria-label') === label));
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
async function click(root, label) { const node = find(root, label); assert.ok(node, 'missing button: ' + label); assert.equal(node.disabled, false, 'disabled button: ' + label); node.dispatch('click'); await flush(); return node; }
function edit(root, label, value, tag = 'input') { const node = find(root, label, tag); assert.ok(node, 'missing field: ' + label); node.value = String(value); node.dispatch(tag === 'select' ? 'change' : 'input'); return node; }
const note = root => walk(root).find(node => node.className === 'amin-notice')?.textContent;
const people = [{ id: 'alice', name: '旅人', kind: 'pc', notes: '', stats: [] }, { id: 'bob', name: '向导', kind: 'npc', notes: '', stats: [] }];

function fixture({ characters = people } = {}) {
    let fail = false, saves = 0;
    let ctx = { characterId: 1, getCurrentChatId: () => 'inventory-chat-a', chatMetadata: { unrelated: { preserved: true } }, chat: [{ name: '旅人', is_user: true, mes: '出发', swipe_id: 0 }], saveMetadata: async () => { saves++; if (fail) throw Error('disk unavailable'); } };
    ctx.chatMetadata[CHARACTERS_KEY] = appendSnapshot(emptyStore(), ctx.chat, { version: 1, characters });
    const api = createInventoryService(() => ctx), doc = { createElement: tag => new Element(tag) }, root = new Element('div');
    const options = { service: api, document: doc }, view = mount(root, options);
    return {
        api, root, view, options, ctx: () => ctx, saves: () => saves, fail(value) { fail = value; },
        async seed(op, data) { api.stage(op, data); await api.confirm(); view.open(); },
        switch() { ctx = { ...ctx, getCurrentChatId: () => 'inventory-chat-b', chatMetadata: {}, chat: [] }; api.sync(); },
        people(characters) { ctx.chatMetadata[CHARACTERS_KEY] = appendSnapshot(ctx.chatMetadata[CHARACTERS_KEY], ctx.chat, { version: 1, characters }); api.sync(); },
        dispose() { view.dispose(); api.dispose(); },
    };
}
const potion = { name: '治疗药水', ownerId: 'alice', quantity: 5, equipped: false, notes: '玻璃瓶', reason: '出发前补给' };
const coin = { name: '金币', ownerId: 'alice', amount: 100.5, unit: '枚', notes: '冒险资金', reason: '登记旅费' };

test('inventory mount is idempotent, uses accessible controls, and disposes its surface', () => {
    const f = fixture(); assert.equal(mount(f.root, f.options), f.view); assert.equal(f.root.children.length, 1);
    assert.match(f.root.textContent, /inventory-chat-a · 当前分支/);
    assert.equal(find(f.root, '物品').getAttribute('role'), 'tab');
    assert.ok(walk(f.root).filter(node => node.tagName === 'BUTTON').every(node => node.type === 'button'));
    find(f.root, '物品').dispatch('keydown', { key: 'End' }); assert.equal(find(f.root, '变更账本').getAttribute('aria-selected'), 'true');
    f.view.dispose(); f.view.dispose(); assert.equal(f.root.children.length, 0); f.api.dispose();
});

test('item registration stays a draft until preview and a single confirmation', async () => {
    const f = fixture();
    await click(f.root, '登记新物品'); edit(f.root, '物品名称', potion.name); edit(f.root, '所属人物', 'alice', 'select'); edit(f.root, '数量', 5); edit(f.root, '物品备注（可选）', potion.notes, 'textarea'); edit(f.root, '变更原因', potion.reason);
    assert.equal(f.ctx().chatMetadata[INVENTORY_KEY], undefined); await click(f.root, '预览保存物品');
    assert.equal(f.ctx().chatMetadata[INVENTORY_KEY], undefined); assert.match(f.root.textContent, /旅人.*治疗药水.*0 → 5/);
    assert.equal(find(f.root, '数量', 'input').disabled, true);
    const confirm = await click(f.root, '确认操作'); confirm.dispatch('click'); await flush();
    assert.equal(f.api.read().items[0].quantity, 5); assert.equal(f.api.read().ledger.length, 1); assert.equal(f.saves(), 1);
    assert.equal(f.ctx().chatMetadata.unrelated.preserved, true); f.dispose();
});

test('preview cancellation retains draft and requires another preview; tabs preserve unfinished input', async () => {
    const f = fixture(); await click(f.root, '登记新物品'); edit(f.root, '物品名称', '旧钥匙'); edit(f.root, '所属人物', 'alice', 'select'); edit(f.root, '变更原因', '拾取');
    await click(f.root, '资源与货币'); assert.match(note(f.root), /尚未完成/); assert.equal(find(f.root, '物品名称', 'input').value, '旧钥匙');
    await click(f.root, '预览保存物品'); await click(f.root, '取消预览'); assert.equal(f.api.preview(), null); assert.equal(find(f.root, '物品名称', 'input').value, '旧钥匙');
    assert.equal(find(f.root, '物品名称', 'input').disabled, false); assert.equal(f.api.read().items.length, 0);
    await click(f.root, '取消编辑'); await click(f.root, '资源与货币'); assert.ok(find(f.root, '登记资源账户')); f.dispose();
});

test('save failure consumes once and retry only persists the already reduced amount', async () => {
    const f = fixture(); await f.seed('save-item', potion); const seedSaves = f.saves();
    await click(f.root, '消耗'); edit(f.root, '操作数量', 2); edit(f.root, '变更原因', '战后治疗'); await click(f.root, '预览消耗物品');
    f.fail(true); await click(f.root, '确认操作');
    assert.equal(f.api.read().items[0].quantity, 3); assert.equal(f.api.read().ledger.length, 2); assert.equal(f.api.dirty(), true); assert.match(note(f.root), /disk unavailable/);
    assert.ok(find(f.root, '重试保存')); assert.equal(find(f.root, '登记新物品').disabled, true); assert.equal(find(f.root, '消耗').disabled, true); assert.equal(find(f.root, '确认操作'), undefined);
    f.fail(false); await click(f.root, '重试保存'); assert.equal(f.api.read().items[0].quantity, 3); assert.equal(f.api.read().ledger.length, 2); assert.equal(f.api.dirty(), false); assert.equal(f.saves(), seedSaves + 2);
    assert.match(note(f.root), /未重复/); f.dispose();
});

test('item transfer previews both owners, applies both quantities, and receives unequipped items', async () => {
    const f = fixture(); await f.seed('save-item', { ...potion, equipped: true });
    await click(f.root, '转交物品'); edit(f.root, '接收人物', 'bob', 'select'); edit(f.root, '操作数量', 2); edit(f.root, '变更原因', '交给向导'); await click(f.root, '预览转交物品');
    assert.match(f.root.textContent, /旅人.*5 → 3/); assert.match(f.root.textContent, /向导.*0 → 2/); assert.equal(f.api.read().items.length, 1);
    await click(f.root, '确认操作'); const state = f.api.read(); assert.equal(state.items.find(item => item.ownerId === 'alice').quantity, 3); assert.equal(state.items.find(item => item.ownerId === 'bob').quantity, 2); assert.equal(state.items.find(item => item.ownerId === 'bob').equipped, false);
    assert.equal(state.ledger.at(-1).entries.length, 2); f.dispose();
});

test('resource credit, debit and transfer use explicit decimal amounts and one ledger operation each', async () => {
    const f = fixture(); await f.seed('save-balance', coin); await click(f.root, '资源与货币');
    await click(f.root, '收入'); edit(f.root, '操作金额 / 数量', 10.25); edit(f.root, '变更原因', '领取报酬'); await click(f.root, '预览收入资源'); assert.equal(f.api.read().balances[0].amount, 100.5); await click(f.root, '确认操作'); assert.equal(f.api.read().balances[0].amount, 110.75);
    await click(f.root, '支出'); edit(f.root, '操作金额 / 数量', 0.75); edit(f.root, '变更原因', '购买补给'); await click(f.root, '预览支出资源'); await click(f.root, '确认操作'); assert.equal(f.api.read().balances[0].amount, 110);
    await click(f.root, '转交资源'); edit(f.root, '接收人物', 'bob', 'select'); edit(f.root, '操作金额 / 数量', 10); edit(f.root, '变更原因', '支付向导'); await click(f.root, '预览转交资源'); await click(f.root, '确认操作');
    assert.deepEqual(f.api.read().balances.map(balance => [balance.ownerId, balance.amount]), [['alice', 100], ['bob', 10]]); assert.equal(f.api.read().ledger.length, 4);
    await click(f.root, '变更账本'); edit(f.root, '筛选所属人物', 'bob', 'select'); assert.match(f.root.textContent, /支付向导/); assert.doesNotMatch(f.root.textContent, /领取报酬/); f.dispose();
});

test('deleted owners keep visible assets and can transfer them to an existing character', async () => {
    const f = fixture(); await f.seed('save-item', potion); f.people([people[1]]); f.view.open();
    assert.match(f.root.textContent, /已删除或不在当前分支的人物（alice）/); assert.match(f.root.textContent, /治疗药水/);
    await click(f.root, '编辑物品'); assert.equal(find(f.root, '所属人物', 'select').value, 'alice'); assert.equal(find(f.root, '所属人物', 'select').disabled, true); await click(f.root, '取消编辑');
    await click(f.root, '转交物品'); edit(f.root, '接收人物', 'bob', 'select'); edit(f.root, '操作数量', 5); edit(f.root, '变更原因', '回收遗留物资'); await click(f.root, '预览转交物品'); await click(f.root, '确认操作');
    assert.equal(f.api.read().items.find(item => item.ownerId === 'alice').quantity, 0); assert.equal(f.api.read().items.find(item => item.ownerId === 'bob').quantity, 5); f.dispose();
});

test('source changes preserve form text for copying and block stale writes', async () => {
    const f = fixture(); await click(f.root, '登记新物品'); edit(f.root, '物品名称', '未保存的地图'); edit(f.root, '所属人物', 'alice', 'select'); edit(f.root, '变更原因', '发现');
    f.ctx().chat[0].mes = '改写出发'; f.api.sync();
    assert.equal(find(f.root, '物品名称', 'input').value, '未保存的地图'); assert.equal(find(f.root, '预览保存物品').disabled, true); assert.match(note(f.root), /来源已变化/); assert.equal(f.ctx().chatMetadata[INVENTORY_KEY], undefined);
    await click(f.root, '取消编辑'); f.dispose();
});

test('switching chat cancels pending preview and retains a clearly invalid old editor', async () => {
    const f = fixture(); await click(f.root, '登记新物品'); edit(f.root, '物品名称', '旧聊天物资'); edit(f.root, '所属人物', 'alice', 'select'); edit(f.root, '变更原因', '登记'); await click(f.root, '预览保存物品');
    const old = f.ctx(); f.switch(); assert.equal(f.api.preview(), null); assert.equal(find(f.root, '确认操作'), undefined); assert.equal(find(f.root, '预览保存物品').disabled, true); assert.match(note(f.root), /来源已变化/);
    assert.equal(old.chatMetadata[INVENTORY_KEY], undefined); assert.equal(f.ctx().chatMetadata[INVENTORY_KEY], undefined); await click(f.root, '取消编辑'); assert.match(f.root.textContent, /inventory-chat-b/); f.dispose();
});

test('empty state guides character creation, and filtering retains the active input node', async () => {
    const empty = fixture({ characters: [] }); assert.equal(find(empty.root, '登记新物品').disabled, true); assert.match(empty.root.textContent, /先在人物卡登记人物/); assert.ok(find(empty.root, '打开人物卡')); assert.equal(find(empty.root, '搜索名称、人物或备注', 'input'), undefined); empty.dispose();
    const blank = fixture(); assert.equal(find(blank.root, '搜索名称、人物或备注', 'input'), undefined); assert.match(blank.root.textContent, /还没有物品/); blank.dispose();
    const f = fixture(); await f.seed('save-item', potion); await f.seed('save-item', { ...potion, name: '火把', ownerId: 'bob', notes: '照明' });
    const query = edit(f.root, '搜索名称、人物或备注', '玻璃'); assert.match(f.root.textContent, /治疗药水/); assert.doesNotMatch(f.root.textContent, /火把/); assert.equal(find(f.root, '搜索名称、人物或备注', 'input'), query);
    edit(f.root, '搜索名称、人物或备注', ''); edit(f.root, '筛选所属人物', 'bob', 'select'); assert.match(f.root.textContent, /火把/); assert.doesNotMatch(f.root.textContent, /治疗药水/); f.dispose();
});

test('invalid amounts keep the editor intact and equipment changes also require preview', async () => {
    const f = fixture(); await f.seed('save-item', potion); await click(f.root, '消耗'); edit(f.root, '操作数量', 9); edit(f.root, '变更原因', '治疗'); await click(f.root, '预览消耗物品');
    assert.match(note(f.root), /数量不足/); assert.equal(find(f.root, '操作数量', 'input').value, '9'); assert.equal(f.api.read().items[0].quantity, 5); await click(f.root, '取消编辑');
    await click(f.root, '装备物品'); edit(f.root, '变更原因', '放进腰带'); await click(f.root, '预览装备物品'); assert.equal(f.api.read().items[0].equipped, false); await click(f.root, '确认操作'); assert.equal(f.api.read().items[0].equipped, true); f.dispose();
});

test('zero records can be explicitly removed while ledger history remains', async () => {
    const f = fixture(); await f.seed('save-item', { ...potion, quantity: 0 }); assert.equal(find(f.root, '装备物品'), undefined); await click(f.root, '移除空记录'); edit(f.root, '变更原因', '清理空背包'); await click(f.root, '预览移除空物品记录'); await click(f.root, '确认操作');
    assert.equal(f.api.read().items.length, 0); assert.equal(f.api.read().ledger.length, 2);
    await f.seed('save-balance', { ...coin, amount: 0 }); await click(f.root, '资源与货币'); await click(f.root, '移除空账户'); edit(f.root, '变更原因', '结束旅费账户'); await click(f.root, '预览移除空资源账户'); await click(f.root, '确认操作');
    assert.equal(f.api.read().balances.length, 0); assert.equal(f.api.read().ledger.length, 4); f.dispose();
});
