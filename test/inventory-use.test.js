import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, emptyState, transition, readInventory, validateState, useDescription } from '../apps/inventory/model.js';
import { GADGET_TEMPLATES } from '../apps/inventory/gadgets.js';
import { adapter as inventory } from '../apps/linkage/adapters/inventory.js';
import { KEY as CHARACTERS_KEY, buildRestore as restoreCharacters } from '../apps/characters/model.js';
import { mount } from '../apps/inventory/view.js';
import { createInventoryService } from '../apps/inventory/service.js';

const at = '2026-10-25T03:00:00.000Z';
let serial = 0;
const createId = () => `use_test_${++serial}`;
const context = () => ({ ownerIds: ['alice', 'bob'], at, createId });
const step = (state, op, data) => transition(state, op, data, context()).state;
const gadget = (use, overrides = {}) => ({ name: '道具', ownerId: 'alice', quantity: 1, equipped: false, notes: '', use, reason: '获得', ...overrides });

test('use-item pays by mode: one piece, one charge, or nothing for reusable gadgets', () => {
    let state = step(emptyState(), 'save-item', gadget({ mode: 'consume', effect: '吃下记住内容' }, { name: '记忆面包', quantity: 3 }));
    state = step(state, 'save-item', gadget({ mode: 'charges', charges: 2, effect: '改变世界' }, { name: '如果电话亭' }));
    state = step(state, 'save-item', gadget({ mode: 'reusable', effect: '连通目的地' }, { name: '任意门' }));
    const [bread, booth, door] = state.items.map(item => item.id);
    state = step(state, 'use-item', { id: bread, quantity: 2, reason: '背单词' });
    state = step(state, 'use-item', { id: booth, reason: '如果没有考试' });
    state = step(state, 'use-item', { id: door, reason: '去学校' });
    assert.deepEqual(state.items.map(item => [item.quantity, item.use.charges]), [[1, undefined], [1, 1], [1, undefined]]);
    assert.deepEqual(state.ledger.slice(-3).map(entry => entry.op), ['use-item', 'use-item', 'use-item']);
    assert.match(state.ledger.at(-2).summary, /剩余次数 2 → 1/);
    state = step(state, 'use-item', { id: booth, reason: '恢复原状' });
    assert.throws(() => step(state, 'use-item', { id: booth, reason: '再来一次' }), /使用次数已用完/);
    validateState(state);
});

test('items without a use config are used up like consumables, and invalid configs are rejected', () => {
    let state = step(emptyState(), 'save-item', { name: '苹果', ownerId: 'alice', quantity: 1, equipped: false, notes: '', reason: '摘取' });
    state = step(state, 'use-item', { id: state.items[0].id, reason: '吃掉' });
    assert.equal(state.items[0].quantity, 0);
    assert.throws(() => step(state, 'use-item', { id: state.items[0].id, reason: '再吃' }), /数量为 0/);
    assert.throws(() => step(emptyState(), 'save-item', gadget({ mode: 'charges', effect: '' })), /剩余次数/);
    assert.throws(() => step(emptyState(), 'save-item', gadget({ mode: 'reusable', charges: 2 })), /只有“按剩余次数”/);
    assert.throws(() => step(emptyState(), 'save-item', gadget({ mode: 'magic' })), /消耗方式无效/);
    // Clearing the config turns a gadget back into a plain item.
    let cleared = step(emptyState(), 'save-item', gadget({ mode: 'reusable', effect: 'x' }));
    cleared = step(cleared, 'save-item', { ...gadget(null), id: cleared.items[0].id });
    assert.equal(Object.hasOwn(cleared.items[0], 'use'), false);
});

test('the action description names user, target, effect and the cost after use', () => {
    const text = useDescription({ name: '缩小灯', quantity: 1, use: { mode: 'charges', charges: 4, effect: '照到的东西会缩小' } }, { user: '大雄', target: '胖虎', intent: '让他没法抢漫画', count: 1 });
    assert.match(text, /【使用道具】大雄对胖虎使用了「缩小灯」：让他没法抢漫画/);
    assert.match(text, /道具效果：照到的东西会缩小/); assert.match(text, /剩余 4 次/);
    assert.match(useDescription({ name: '苹果', quantity: 0 }), /消耗 1 件，剩余 0 件/);
});

test('every gadget template is a valid item', () => {
    let state = emptyState();
    for (const template of GADGET_TEMPLATES) state = step(state, 'save-item', { ...template, ownerId: 'alice', equipped: false, notes: '', reason: '模板' });
    assert.equal(state.items.length, GADGET_TEMPLATES.length);
});

function linkageContext() {
    const ctx = { chatId: 'use-chat', characterId: 0, characters: [{ avatar: 'test.png' }], chat: [{ name: 'GM', is_user: false, mes: '开始', swipe_id: 0 }], chatMetadata: {}, saveMetadata: async () => {} };
    ctx.chatMetadata[CHARACTERS_KEY] = restoreCharacters(ctx, { version: 1, characters: ['alice', 'bob'].map(id => ({ id, name: id, kind: 'pc', notes: '', stats: [] })) }, { id: createId(), at });
    return ctx;
}
const applyTo = (ctx, change) => { const result = inventory.apply(ctx, { reason: '剧情发生', ...change }, { operationId: createId(), now: at }); for (const patch of result.patches) ctx.chatMetadata[patch.path[0]] = patch.value; return result; };

test('linkage creates gadgets, records story uses and recharges by partial use updates', () => {
    const ctx = linkageContext();
    applyTo(ctx, { module: 'inventory', action: 'create-item', target: 'stopwatch', data: { name: '暂停手表', ownerId: 'alice', quantity: 1, use: { mode: 'charges', charges: 2, effect: '暂停时间' } } });
    applyTo(ctx, { module: 'inventory', action: 'use-item', target: 'stopwatch', data: {} });
    assert.equal(readInventory(ctx).items[0].use.charges, 1);
    applyTo(ctx, { module: 'inventory', action: 'update-item', target: 'stopwatch', data: { use: { charges: 5 } } });
    assert.deepEqual(readInventory(ctx).items[0].use, { mode: 'charges', effect: '暂停时间', charges: 5 });
    applyTo(ctx, { module: 'inventory', action: 'update-item', target: 'stopwatch', data: { use: { mode: 'reusable' } } });
    assert.deepEqual(readInventory(ctx).items[0].use, { mode: 'reusable', effect: '暂停时间' });
    assert.ok(inventory.spec.actions.some(action => action.name === 'use-item' && !action.advanced));
    assert.ok(ctx.chatMetadata[KEY]);
});

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
    dispatchEvent(event) { (this.events ??= []).push(event.type); }
    focus() {}
}
const walk = root => [root, ...root.children.flatMap(walk)];
const visible = node => !node.hidden && (!node.parent || visible(node.parent));
const find = (root, label, tag = 'button') => walk(root).find(node => visible(node) && node.tagName === tag.toUpperCase() && (node.textContent === label || node.getAttribute('aria-label') === label));
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
async function click(root, label) { const node = find(root, label); assert.ok(node, 'missing button: ' + label); assert.equal(node.disabled, false, 'disabled button: ' + label); node.dispatch('click'); await flush(); return node; }
function edit(root, label, value, tag = 'input') { const node = find(root, label, tag); assert.ok(node, 'missing field: ' + label); node.value = String(value); node.dispatch(tag === 'select' ? 'change' : 'input'); return node; }
const note = root => walk(root).find(node => node.className === 'amin-notice')?.textContent;

test('the inventory view registers a template gadget, uses it once and appends the action to the chat draft', async () => {
    const ctx = linkageContext(), api = createInventoryService(() => ctx), draft = new Element('textarea'); draft.value = '我推开房门。';
    const doc = { createElement: tag => new Element(tag), querySelector: selector => selector === '#send_textarea' ? draft : null, defaultView: { Event: class { constructor(type) { this.type = type; } } } };
    const root = new Element('div'), view = mount(root, { service: api, document: doc });
    await click(root, '从道具模板添加');
    const templateCard = walk(root).find(node => node.tagName === 'SECTION' && node.children[0]?.textContent === '如果电话亭');
    await click(templateCard, '用这个模板');
    assert.equal(find(root, '物品名称', 'input').value, '如果电话亭');
    assert.equal(find(root, '道具用法', 'select').value, 'charges');
    assert.equal(find(root, '剩余使用次数', 'input').parent.hidden, false);
    edit(root, '所属人物', 'alice', 'select');
    await click(root, '预览保存物品'); await click(root, '确认操作');
    assert.deepEqual(api.read().items[0].use.charges, 3);
    await click(root, '使用'); edit(root, '使用对象（可选）', '整个世界'); edit(root, '怎么用 / 想达成什么（可选）', '如果世界上没有作业', 'textarea');
    await click(root, '预览使用');
    assert.match(root.textContent, /确认后追加到聊天输入框/); assert.equal(draft.value, '我推开房门。');
    await click(root, '确认操作');
    assert.equal(api.read().items[0].use.charges, 2); assert.equal(api.read().ledger.at(-1).reason, '如果世界上没有作业');
    assert.match(draft.value, /^我推开房门。\n【使用道具】alice对整个世界使用了「如果电话亭」：如果世界上没有作业/);
    assert.match(draft.value, /剩余 2 次/); assert.deepEqual(draft.events, ['input']);
    assert.match(note(root), /已追加到聊天输入框/);
    view.dispose(); api.dispose();
});
