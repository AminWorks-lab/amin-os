import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkageService } from '../apps/linkage/service.js';
import { KEY, emptyLinkageState } from '../apps/linkage/policy.js';
import { summarizeChanges, headlineText, rejectionCategory, rawUpdateText } from '../apps/linkage/turns.js';
import { renderTurnRow } from '../apps/linkage/floor-turns.js';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';
import { STATE_KEY, emptyState, validateState } from '../apps/story-state/schema.js';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
import { adapter as inventory } from '../apps/linkage/adapters/inventory.js';
import { adapter as status } from '../apps/linkage/adapters/status.js';
import { emptyState as emptyInventory } from '../apps/inventory/model.js';
import { collapseTabs } from '../ui/tabs.js';

const change = (module, action, target, data) => ({ module, action, target, data, reason: '正文中已发生' });
const tagged = changes => '正文。<amin_update>' + JSON.stringify({ version: 1, changes }) + '</amin_update>';
const aliases = { 艾琳: 'alice', 博恩: 'bourne' };
const person = name => change('characters', 'create-character', '@new:' + aliases[name], { name, kind: 'npc', stats: [], notes: '' });

function fixture({ modules = ['characters', 'inventory', 'status'], backups, notices = [] } = {}) {
    let sequence = 0;
    const ctx = { characterId: 1, getCurrentChatId: () => 'turn-chat', extensionSettings: {}, chat: [{ is_user: true, name: 'user', mes: '起点' }],
        chatMetadata: { [KEY]: { ...emptyLinkageState(), enabled: true, mode: 'auto', modules: Object.fromEntries(['characters', 'inventory', 'status'].map(id => [id, modules.includes(id) ? { enabled: true, read: true, write: true } : { enabled: true, read: true, write: false }])) } },
        async saveMetadata() {} };
    const state = emptyState({ updatedAt: '2026-10-10T00:00:00.000Z' });
    state.modules.characters = { version: 1, characters: [] }; state.modules.inventory = emptyInventory(); state.modules.status = { 版本: 1, 项目: { 玩家: { 生命: 76 } } };
    ctx.chatMetadata[STATE_KEY] = validateState(state);
    const get = () => ctx, memory = new Map();
    const runtime = createStoryStateRuntime(get, { backups: { available: () => false, status: () => ({ available: false }), savePrevious: async () => {} } });
    const api = createLinkageService(get, { adapters: [characters, inventory, status], createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
        backups: backups ?? { available: () => false }, hintStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) },
        notifyRegenerate: text => notices.push(text) });
    async function reply(changes) {
        assert.equal(api.captureGeneration('normal'), true);
        ctx.chat.push({ is_user: false, mes: typeof changes === 'string' ? changes : tagged(changes), swipe_id: 0 });
        await api.collectReply(ctx.chat.length - 1);
        ctx.chat.push({ is_user: true, mes: '继续' });
    }
    return { ctx, api, runtime, reply, notices, memory, dispose() { api.dispose(); runtime.destroy(); } };
}

test('an automatic batch records a floor summary whose undo restores the state from before the batch', async () => {
    const f = fixture();
    try {
        await f.reply([person('艾琳'), change('status', 'set', '玩家.生命', { value: 60 })]);
        assert.equal(f.ctx.chatMetadata[STATE_KEY].modules.characters.characters.length, 1);
        const turn = f.api.turnFor(1, 0);
        assert.ok(turn, 'turn recorded for floor 2');
        assert.equal(headlineText(turn), '本轮更新：+1 人物 · 生命 76→60');
        assert.equal(turn.items.length, 2); assert.equal(turn.undoable, true); assert.equal(turn.stale, false);
        const target = f.api.undoTarget(turn.id);
        assert.equal(target.snapshot.modules.characters.characters.length, 0, 'the snapshot holds the state before the batch');
        assert.equal(target.snapshot.modules.status.项目.玩家.生命, 76);
        assert.equal(f.api.turnFor(1, 1), null, 'another candidate of the floor has no summary');
        f.api.markUndone(turn.id);
        assert.equal(f.api.turnFor(1, 0).undone, true); assert.equal(f.api.turnFor(1, 0).undoable, false);
    } finally { f.dispose(); }
});

test('only the newest unchanged turn can be undone; later updates send the user to saves', async () => {
    const f = fixture();
    try {
        await f.reply([person('艾琳')]);
        const first = f.api.turnFor(1, 0);
        await f.reply([person('博恩')]);
        const older = f.api.turnFor(1, 0), newest = f.api.turnFor(3, 0);
        assert.equal(older.latest, false); assert.equal(older.stale, true); assert.equal(older.undoable, false);
        assert.throws(() => f.api.undoTarget(first.id), /之后已有新的更新/);
        assert.equal(newest.undoable, true);
        // A manual edit after the batch also makes it stale.
        const state = validateState(f.ctx.chatMetadata[STATE_KEY]);
        f.ctx.chatMetadata[STATE_KEY] = validateState({ ...state, revision: state.revision + 1 });
        assert.equal(f.api.turnFor(3, 0).stale, true);
    } finally { f.dispose(); }
});

test('a ring backup taken before the batch is the undo target when external storage is available', async () => {
    const saved = [];
    const backups = { available: () => true, async savePrevious(_ctx, state, options) { saved.push({ revision: state.revision, label: options.label }); return { saved: true, id: `r${state.revision}-x` }; } };
    const f = fixture({ backups });
    try {
        await f.reply([person('艾琳')]);
        assert.deepEqual(saved, [{ revision: 0, label: '第 2 楼更新前' }]);
        assert.deepEqual(f.api.undoTarget(f.api.turnFor(1, 0).id), { id: 'r0-x' });
    } finally { f.dispose(); }
});

test('rejected batches are kept (newest first, at most 10) with floor, item and category', async () => {
    const f = fixture({ modules: ['characters', 'status'] });
    try {
        await f.reply('<amin_update>{broken</amin_update>');
        let [record] = f.api.rejections();
        assert.equal(record.category, 'format'); assert.equal(record.index, 1); assert.equal(record.raw, '{broken'); assert.equal(record.item, null);
        await f.reply([person('艾琳'), change('inventory', 'create-item', '@new:potion', { name: '药剂', ownerId: '@new:alice', quantity: 1, equipped: false, notes: '' })]);
        [record] = f.api.rejections();
        assert.equal(record.category, 'permission', record.reason); assert.equal(record.index, 3);
        assert.deepEqual({ index: record.item.index, module: record.item.module, action: record.item.action }, { index: 1, module: 'inventory', action: 'create-item' });
        assert.equal(f.ctx.chatMetadata[STATE_KEY].modules.characters.characters.length, 0, 'a rejected batch changes nothing');
        await f.reply([change('status', 'set', '玩家.生命', { value: '很多' })]);
        assert.equal(f.api.rejections()[0].category, 'validation'); assert.equal(f.api.rejections()[0].item.module, 'status');
        for (let i = 0; i < 12; i++) assert.throws(() => f.api.stage('{"version":2}'));
        assert.equal(f.api.rejections().length, 10); assert.equal(f.api.rejections()[0].manual, true);
        f.api.clearRejections(); assert.equal(f.api.rejections().length, 0);
    } finally { f.dispose(); }
});

test('regenerating a reply that already applied updates notices once per chat', async () => {
    const f = fixture();
    try {
        await f.reply([person('艾琳')]);
        f.ctx.chat.pop(); // The AI reply is the tail again.
        assert.equal(f.api.captureGeneration('swipe'), true);
        assert.deepEqual(f.notices, ['上一版回复的更新不会自动撤回，可在楼层小结中撤回。']);
        f.api.captureGeneration('regenerate'); f.api.captureGeneration('swipe');
        assert.equal(f.notices.length, 1);
        const keys = [...f.memory.keys()];
        assert.equal(keys.length, 1); assert.match(keys[0], /^amin-os-regenerate-hint-v1:[0-9a-f]{32}$/u, 'the storage key names the chat');
        const later = createLinkageService(() => f.ctx, { adapters: [characters, inventory, status], hintStorage: { getItem: key => f.memory.get(key) ?? null, setItem: (key, value) => f.memory.set(key, value) }, notifyRegenerate: text => f.notices.push(text) });
        try { later.captureGeneration('regenerate'); assert.equal(f.notices.length, 1, 'a reload does not repeat the notice for the same chat'); } finally { later.dispose(); }
    } finally { f.dispose(); }
});

test('change summaries use plain words and categories cover the four groups', () => {
    const summary = summarizeChanges([
        { module: 'characters', action: 'create-character' }, { module: 'inventory', action: 'delete-item' },
        { module: 'scene', action: 'advance-time', data: { minutes: 30 } }, { module: 'scene', action: 'advance-time', data: { minutes: 120 } },
        { module: 'status', action: 'set' }, { module: 'journal', action: 'set_fact' },
            { module: 'status', action: 'set' },
    ], ['新人物', '丢弃物品', '', '', '世界状态 玩家.生命：76 → 60', '记下事实', '世界状态 玩家.体力 · 当前：{"当前":5,"最大":9} → {"当前":3,"最大":9}']);
    assert.equal(summary.items.at(-1), '世界状态 玩家.体力：5 → 3');
    assert.deepEqual(summary.headline, ['+1 人物', '−1 物品', '档案', '时间 +30 分钟', '时间 +2 小时', '生命 76→60', '体力 5→3']);
    assert.match(headlineText({ headline: ['a', 'b', 'c', 'd', 'e'] }), /等 5 项$/);
    assert.equal(rejectionCategory(Error('本次操作没有修改 背包 的权限。')), 'permission');
    assert.equal(rejectionCategory(Error('这批更新会产生新的无效引用：a → b')), 'reference');
    assert.equal(rejectionCategory(Object.assign(Error('x'), { linkageCategory: 'format' })), 'format');
    assert.equal(rejectionCategory(Error('数量必须为正数')), 'validation');
    assert.equal(rawUpdateText('前文<amin_update> {"version":1} </amin_update>后文'), '{"version":1}');
});

class Node {
    constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null; this.attributes = {}; this.dataset = {}; this.listeners = {}; this._text = ''; this.hidden = false; this.disabled = false; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove?.(); node.parentNode = this; this.children.push(node); } }
    after(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
    get previousElementSibling() { const list = this.parentNode?.children ?? []; return list[list.indexOf(this) - 1] ?? null; }
    get isConnected() { return true; }
    contains(node) { for (let item = node; item; item = item.parentNode) if (item === this) return true; return false; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener() {}
    click() { for (const fn of this.listeners.click ?? []) fn({ target: this }); }
    focus() { this.ownerDocument.activeElement = this; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const press = (root, label) => walk(root).find(node => node.tagName === 'BUTTON' && node.textContent === label).click();
const makeDoc = () => { const doc = { createElement: tag => new Node(tag, doc), addEventListener() {}, removeEventListener() {} }; return doc; };

test('tab strips keep the chosen tabs and move the rest into a keyboard menu', async () => {
    const doc = makeDoc(), page = new Node('div', doc), list = new Node('div', doc); page.append(list);
    let selected = '任务', refreshed = 0;
    const draw = () => { list.replaceChildren(); for (const name of ['任务', '线索', '伏笔', '编年史', '事实与记忆', '自动整理', '前作参考']) { const tab = new Node('button', doc); tab.textContent = name; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(selected === name)); tab.addEventListener('click', () => { selected = name; draw(); overflow.update(); }); list.append(tab); } };
    draw();
    const overflow = collapseTabs(list, { keep: ['任务', '线索', '伏笔', '事实与记忆', '编年史'], actions: [{ label: '重新读取', run: () => refreshed++ }] });
    const hidden = () => list.children.filter(tab => tab.dataset.tabOverflow === 'true').map(tab => tab.textContent);
    assert.deepEqual(hidden(), ['自动整理', '前作参考']);
    const toggle = walk(list).find(node => node.className === 'amin-more-toggle');
    assert.equal(list.children.at(-1).className, 'amin-more'); assert.equal(toggle.getAttribute('aria-haspopup'), 'menu');
    toggle.click();
    const menu = page.children.find(node => node.className === 'amin-more-menu');
    assert.equal(menu.hidden, false); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(menu.children.filter(node => node.getAttribute('role') === 'menuitem').map(node => node.textContent), ['自动整理', '前作参考', '重新读取']);
    menu.children.find(node => node.textContent === '前作参考').click();
    assert.equal(selected, '前作参考'); assert.equal(menu.hidden, true);
    assert.deepEqual(hidden(), ['自动整理'], 'the selected overflow tab shows in the strip');
    toggle.click(); menu.children.find(node => node.textContent === '重新读取').click(); assert.equal(refreshed, 1);
    overflow.dispose();
});

test('the floor row offers undo for the newest turn and the saves page otherwise', () => {
    const doc = makeDoc(), row = new Node('div', doc), calls = [];
    const turn = { id: 't1', headline: ['+1 人物', '时间 +30 分钟'], items: ['新增人物「艾琳」', '场景与时间：等待'], undoable: true, stale: false, undone: false };
    const handlers = { onUndo: () => calls.push('undo'), onConfirm: () => calls.push('confirm'), onCancel: () => calls.push('cancel'), onOpenSaves: () => calls.push('saves') };
    renderTurnRow(row, turn, { document: doc, state: {}, ...handlers });
    assert.match(row.textContent, /本轮更新：\+1 人物 · 时间 \+30 分钟/); assert.match(row.textContent, /新增人物「艾琳」/);
    press(row, '撤回本轮'); assert.deepEqual(calls, ['undo']);
    renderTurnRow(row, turn, { document: doc, state: { preview: '撤回会把 2 个应用的资料恢复到这一轮更新前' }, ...handlers });
    press(row, '确认撤回'); assert.deepEqual(calls, ['undo', 'confirm']);
    renderTurnRow(row, { ...turn, undoable: false, stale: true }, { document: doc, state: {}, ...handlers });
    press(row, '已有更新，前往存档恢复'); assert.deepEqual(calls.at(-1), 'saves');
    renderTurnRow(row, { ...turn, undoable: false, undone: true }, { document: doc, state: {}, ...handlers });
    assert.match(row.textContent, /已撤回本轮更新/);
});
