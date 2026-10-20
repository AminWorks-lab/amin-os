import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../apps/saves/view.js';
import { createSavesService } from '../apps/saves/service.js';

class Node {
    constructor(tag, ownerDocument = null) {
        this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.children = []; this.parent = null;
        this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this.className = ''; this._text = '';
        this.value = ''; this.hidden = false; this.disabled = false; this.readOnly = false; this.checked = false;
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); for (const child of this.children) child.parent = null; this.children = []; }
    append(...nodes) { for (const child of nodes) { child.remove(); child.parent = this; this.children.push(child); } }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    async dispatch(type, event = {}) {
        const value = { type, target: this, preventDefault() {}, ...event };
        for (const callback of [...(this.listeners.get(type) ?? [])]) await callback(value);
    }
    focus() { this.focused = true; }
    select() { this.selected = true; }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const visible = node => !node.hidden && (!node.parent || visible(node.parent));
const byButton = (root, label) => walk(root).find(node => visible(node) && node.tagName === 'BUTTON' && node.textContent === label);
const allButtons = (root, label) => walk(root).filter(node => visible(node) && node.tagName === 'BUTTON' && (!label || node.textContent === label));
const byField = (root, label) => walk(root).find(node => visible(node) && node.getAttribute('aria-label') === label);
async function click(root, label, index = 0) {
    const button = allButtons(root, label)[index]; assert.ok(button, `missing button: ${label} #${index}`); assert.equal(button.disabled, false, `${label} is disabled`);
    await button.dispatch('click');
}
async function type(root, label, value) {
    const input = byField(root, label); assert.ok(input, 'missing field: ' + label); input.value = value; await input.dispatch('input'); return input;
}

const snapshot = (id = 'save-a', name = '进入古堡前') => ({
    format: 'amin-os-save', version: 1, id, name, note: '调查前的状态', createdAt: '2026-09-23T01:02:03.000Z',
    source: { identity: 'chat-a', floor: 3, candidate: 1 },
    modules: { characters: { version: 1 }, scene: { version: 1 }, informationLibrary: null },
});
const clone = value => structuredClone(value);

function fakeService() {
    const ctx = { getCurrentChatId: () => 'chat-a', chatMetadata: {}, chat: [{ mes: '一' }, { mes: '二' }, { mes: '三', swipe_id: 1 }] };
    let store = { version: 1, saves: [snapshot()], backups: [] }, pending = null, dirty = null, message = '准备就绪', fail = false;
    let serial = 1, createApplies = 0, restoreApplies = 0, retryCalls = 0, copied = '';
    const listeners = new Set(), emit = () => { for (const listener of [...listeners]) listener(); };
    const find = id => [...store.saves, ...store.backups].find(item => item.id === id);
    const setPending = (label, summary, apply) => { pending = { operationId: 'op-' + serial++, label, summary, patches: [{ path: ['amin_os_saves_v1'], value: {} }], apply }; message = '请核对预览，确认后更新当前聊天。'; emit(); return preview(); };
    const preview = () => pending ? clone({ operationId: pending.operationId, label: pending.label, summary: pending.summary, patches: pending.patches }) : null;
    const inspectImport = raw => {
        let value; try { value = JSON.parse(raw); } catch { throw Error('导入文件不是有效 JSON。'); }
        if (value?.format !== 'amin-os-save' || value?.version !== 1 || !value.id || !value.name || !value.modules) throw Error('存档版本或类型不兼容。');
        return clone(value);
    };
    const api = {
        context: () => ctx,
        read: () => clone(store),
        preview,
        status: () => message,
        busy: () => false,
        dirty: () => !!dirty,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        stageSave({ name, note = '' }) {
            if (!String(name).trim()) throw Error('存档名称无效或过长。');
            const saved = snapshot('save-' + serial, String(name).trim()); saved.note = note;
            return setPending('建立当前剧情存档', { kind: 'save', name: saved.name, snapshot: saved, changes: [], warnings: [] }, () => { store.saves.push(saved); createApplies++; });
        },
        stageRestore(id) {
            const saved = find(id); if (!saved) throw Error('存档已不存在。');
            const backup = snapshot('backup-' + serial, '恢复前 · ' + saved.name); backup.createdAt = '2026-09-23T02:03:04.000Z';
            return setPending('将存档应用到当前楼层', {
                kind: 'restore', name: saved.name, backup: { id: backup.id, name: backup.name, createdAt: backup.createdAt },
                changes: [
                    { module: 'scene', label: '场景与时间', before: '黄昏 · 门厅', after: '清晨 · 古堡外', details: [{ path: 'clock.minute', before: '50', after: '10' }], omitted: 0 },
                    { module: 'characters', label: '角色档案', before: '3 人', after: '3 人', details: [{ path: 'characters.char-1.stats.hp', before: '生命 8', after: '生命 12' }], omitted: 2 },
                ], warnings: ['来源为其他聊天时也不会导入原聊天消息。'],
            }, () => { store.backups.push(backup); store.backups = store.backups.slice(-5); restoreApplies++; });
        },
        stageDelete(id) {
            const saved = find(id); if (!saved) throw Error('存档已不存在。');
            return setPending('删除存档', { kind: 'delete', name: saved.name, changes: [], warnings: [] }, () => {
                store.saves = store.saves.filter(item => item.id !== id); store.backups = store.backups.filter(item => item.id !== id);
            });
        },
        inspectImport,
        stageImport(raw) {
            const saved = inspectImport(raw);
            return setPending('导入存档到当前聊天', { kind: 'import', name: saved.name, snapshot: saved, changes: [], warnings: ['导入后需另行恢复。'] }, () => { store.saves.push(clone(saved)); });
        },
        exportSave(id) { const saved = find(id); if (!saved) throw Error('存档已不存在。'); return JSON.stringify(saved, null, 2); },
        discard() { pending = null; message = '已取消预览。'; emit(); },
        async confirm() {
            if (!pending) throw Error('没有待确认的操作。');
            const operation = pending; pending = null; operation.apply(); dirty = operation; emit();
            if (fail) { fail = false; message = '操作已更新当前聊天，但保存失败：disk unavailable。请重试保存，不会重复执行操作。'; emit(); throw Error(message); }
            dirty = null; message = '已保存。'; emit();
        },
        async retrySave() { if (!dirty) return; retryCalls++; dirty = null; message = '已重新保存，没有重复执行操作。'; emit(); },
        failNext() { fail = true; },
        stats: () => ({ createApplies, restoreApplies, retryCalls, listenerCount: listeners.size, copied }),
        setCopied(value) { copied = value; },
    };
    return { api, ctx, get store() { return store; } };
}

function fixture() {
    const service = fakeService(), clipboard = { async writeText(value) { service.api.setCopied(value); } };
    const doc = { createElement: tag => new Node(tag, doc), defaultView: { navigator: { clipboard } } };
    const root = new Node('main', doc), view = mount(root, { api: service.api, document: doc });
    return { ...service, doc, root, view };
}

test('save list exposes scope, source floor, version, modules, tab semantics and disposes cleanly', () => {
    const f = fixture();
    assert.equal(mount(f.root, { api: f.api, document: f.doc }), f.view, 'mount stays idempotent');
    assert.match(f.root.textContent, /chat-a · 1 个命名存档/);
    assert.match(f.root.textContent, /第 3 楼 · 第 2 个候选 · 格式 v1/);
    assert.match(f.root.textContent, /角色档案 v1、场景与时间 v1/);
    assert.doesNotMatch(f.root.textContent, /模块（3）|信息资料库/);
    const tabNodes = allButtons(f.root).filter(node => node.getAttribute('role') === 'tab');
    assert.equal(tabNodes.length, 2); assert.equal(tabNodes[0].getAttribute('aria-selected'), 'true');
    assert.ok(allButtons(f.root).every(button => button.type === 'button'));
    assert.equal(f.api.stats().listenerCount, 1); f.view.dispose(); assert.equal(f.root.children.length, 0); assert.equal(f.api.stats().listenerCount, 0);
});

test('create and restore remain previews until explicit confirmation and restore shows safety semantics per module', async () => {
    const f = fixture(), originalChat = JSON.stringify(f.ctx.chat);
    await type(f.root, '存档名称', '进入地下室前'); await type(f.root, '备注（可选）', '保留钥匙状态');
    await click(f.root, '预览创建存档'); assert.equal(f.store.saves.length, 1); assert.match(f.root.textContent, /待确认 · 建立当前剧情存档/);
    await click(f.root, '确认创建存档'); assert.equal(f.store.saves.length, 2); assert.equal(f.api.stats().createApplies, 1);
    await click(f.root, '预览恢复'); assert.equal(f.store.backups.length, 0); assert.equal(f.api.stats().restoreApplies, 0);
    assert.match(f.root.textContent, /确认时创建的安全备份/); assert.match(f.root.textContent, /此备份尚未写入/); assert.match(f.root.textContent, /最近 10 份/);
    assert.match(f.root.textContent, /聊天消息、回复候选和正文不会回退或删除/); assert.match(f.root.textContent, /从此处新开分支/);
    assert.match(f.root.textContent, /场景与时间/); assert.match(f.root.textContent, /当前：黄昏 · 门厅/); assert.match(f.root.textContent, /应用后：清晨 · 古堡外/);
    assert.match(f.root.textContent, /数量摘要相同，但模块内容有变化/); assert.match(f.root.textContent, /characters\.char-1\.stats\.hp/);
    assert.match(f.root.textContent, /当前值：生命 8/); assert.match(f.root.textContent, /应用后：生命 12/); assert.match(f.root.textContent, /另有 2 条未显示/);
    assert.doesNotMatch(f.root.textContent, /此模块没有变化/);
    await click(f.root, '确认恢复到当前楼层'); assert.equal(f.store.backups.length, 1); assert.equal(f.api.stats().restoreApplies, 1);
    assert.equal(JSON.stringify(f.ctx.chat), originalChat, 'restoring app state never mutates chat messages'); f.view.dispose();
});

test('delete is explicit and changes neither the list nor current state before confirmation', async () => {
    const f = fixture(); await click(f.root, '删除存档');
    assert.equal(f.store.saves.length, 1); assert.match(f.root.textContent, /当前应用状态和聊天消息不会改变/);
    await click(f.root, '确认删除存档'); assert.equal(f.store.saves.length, 0); f.view.dispose();
});

test('export and import expose JSON, reject invalid input, validate without mutation, then import once', async () => {
    const f = fixture(); await click(f.root, '导出 JSON');
    const output = byField(f.root, '存档 JSON'); assert.ok(output?.readOnly); assert.match(output.value, /"format": "amin-os-save"/);
    await click(f.root, '复制导出 JSON'); assert.equal(f.api.stats().copied, output.value);
    await type(f.root, '粘贴存档 JSON', '{broken'); await click(f.root, '验证 JSON');
    assert.match(f.root.textContent, /导入文件不是有效 JSON/); assert.equal(f.store.saves.length, 1);
    const imported = snapshot('external-save', '外部存档'); imported.source = { identity: 'chat-other', floor: 8, candidate: 0 };
    await type(f.root, '粘贴存档 JSON', JSON.stringify(imported)); await click(f.root, '验证 JSON');
    assert.match(f.root.textContent, /验证通过 · 外部存档/); assert.match(f.root.textContent, /第 8 楼 · 第 1 个候选 · 格式 v1/); assert.equal(f.store.saves.length, 1);
    await click(f.root, '预览收纳到当前聊天'); assert.equal(f.store.saves.length, 1); assert.match(f.root.textContent, /不会立即恢复/);
    await click(f.root, '确认导入存档'); assert.equal(f.store.saves.length, 2); assert.equal(f.store.saves.at(-1).id, 'external-save'); f.view.dispose();
});

test('failed persistence exposes retry and retry does not repeat the confirmed action', async () => {
    const f = fixture(); await type(f.root, '存档名称', '保存失败测试'); await click(f.root, '预览创建存档');
    f.api.failNext(); await click(f.root, '确认创建存档');
    assert.equal(f.store.saves.length, 2); assert.equal(f.api.stats().createApplies, 1); assert.match(f.root.textContent, /保存尚未完成/); assert.match(f.root.textContent, /重试不会再次恢复、导入或删除/);
    await click(f.root, '重试保存'); assert.equal(f.store.saves.length, 2); assert.equal(f.api.stats().createApplies, 1); assert.equal(f.api.stats().retryCalls, 1);
    assert.match(f.root.textContent, /已重新保存/); f.view.dispose();
});

test('real checkpoint view records current floor, stages retention changes and exposes branch confirmation separately', async () => {
    let seq=0;
    const ctx={chatId:'view-chat',getCurrentChatId(){return this.chatId;},chat:[{name:'角色',mes:'当前剧情',swipe_id:0}],chatMetadata:{},async saveMetadata(){}};
    const api=createSavesService(()=>ctx,{autoCheckpoints:false,createId:()=>`view-${++seq}`});
    const doc={createElement:tag=>new Node(tag,doc)},root=new Node('main',doc),view=mount(root,{api,document:doc});
    await click(root,'楼层检查点');assert.match(root.textContent,/旧历史不会补造检查点/);
    await click(root,'立即记录当前楼层');assert.equal(api.read().checkpoints.length,1);assert.match(root.textContent,/第 1 楼 · 候选 1/);
    await click(root,'从此处新开分支');assert.equal(api.preview().summary.kind,'branch');assert.ok(byButton(root,'确认新建并恢复分支'));
    assert.match(root.textContent,/原聊天仍保留/);await click(root,'取消预览');
    const enabled=byField(root,'启用自动楼层检查点');enabled.checked=false;await enabled.dispatch('change');
    await type(root,'自动检查点保留数量','4');await click(root,'预览检查点设置');assert.equal(api.read().checkpointSettings.enabled,true);
    await click(root,'确认检查点设置');assert.deepEqual(api.read().checkpointSettings,{enabled:false,limit:4});
    const record=api.read().checkpoints[0];ctx.chat[0].swipe_id=1;view.refresh();
    const branch=byButton(root,'从此处新开分支');assert.equal(branch.disabled,true);assert.match(branch.title,/候选/);assert.ok(byButton(root,'预览恢复'));
    assert.equal(api.read().checkpoints[0].id,record.id);view.dispose();api.dispose();
});
