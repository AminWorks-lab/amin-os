import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTravel } from '../apps/scene/travel-view.js';
import { mount as mountScene } from '../apps/scene/view.js';

class Node {
    constructor(tag) {
        this.tagName = tag; this.children = []; this.parentElement = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map();
        this.value = ''; this.checked = false; this.disabled = false; this.className = ''; this._text = '';
        this.classList = { add: (...names) => { const values = new Set(this.className.split(/\s+/).filter(Boolean)); names.forEach(name => values.add(name)); this.className = [...values].join(' '); } };
    }
    set textContent(value) { this._text = String(value ?? ''); for (const child of this.children) child.parentElement = null; this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...children) { for (const child of children) { if (child == null) continue; child.remove?.(); child.parentElement = this; this.children.push(child); } }
    prepend(...children) { for (const child of [...children].reverse()) { child.remove?.(); child.parentElement = this; this.children.unshift(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(listener); }
    querySelector(selector) { return [...walk(this)].find(item => selector === '[aria-selected="true"]' && item.attributes['aria-selected'] === 'true'); }
    focus() { this.focused = true; }
}
function* walk(root) { yield root; for (const child of root.children) yield* walk(child); }
const find = (root, predicate) => [...walk(root)].find(predicate);
const button = (root, label) => find(root, item => item.tagName === 'button' && item.textContent === label);
const field = (root, label) => find(root, item => ['input', 'select', 'textarea'].includes(item.tagName) && item.attributes['aria-label'] === label);
const labelledField = (root, label) => { const wrapper = find(root, item => item.tagName === 'label' && item.children.some(child => child.tagName === 'span' && child.textContent === label)); return wrapper?.children.find(child => ['input', 'select', 'textarea'].includes(child.tagName)); };
async function fire(element, type, event = {}) {
    assert.ok(element, `missing element for ${type}`); let result;
    for (const listener of element.listeners.get(type) ?? []) result = listener({ preventDefault() {}, ...event });
    return result;
}
const click = (root, label) => fire(button(root, label), 'click');
const input = (root, label, value) => { const element = field(root, label); element.value = value; return fire(element, 'input'); };

const clock = (minute = 0) => ({ year: 2026, month: 9, day: 23, hour: 10, minute, calendarLabel: '王国历' });
function travelFixture({ known = true, failConfirm = true } = {}) {
    const listeners = new Set(), metadata = {}; let pending = null, dirty = false, busy = false;
    const calls = { stage: [], confirm: 0, retry: 0, discard: 0, unsubscribed: 0 };
    const options = methodId => ({
        mapId: 'map_1', mapName: '北境', fromNodeId: 'town', fromName: '城镇', methodId: methodId ?? 'walk', clock: clock(),
        methods: [{ id: 'walk', name: '步行', speed: 5 }, { id: 'horse', name: '骑马', speed: 15 }],
        routes: [{ edgeId: 'road', nodeId: 'forest', name: '森林营地', routeName: '北方小路', description: '一处已发现的营地', accessible: true, reason: '',
            minutes: known ? (methodId === 'horse' ? 5 : 15) : null,
            methods: [{ id: 'walk', name: '步行', speed: 5, minutes: known ? 15 : null, accessible: true, reason: '' }, { id: 'horse', name: '骑马', speed: 15, minutes: known ? 5 : null, accessible: true, reason: '' }],
            scenes: [{ id: 'camp', name: '森林营地夜宿' }],
        }, { edgeId: 'oneway', nodeId: 'tower', name: '高塔', routeName: '单向索道', accessible: false, reason: '单向道路不能从当前方向出发', minutes: 3, methods: [], scenes: [] }],
    });
    const notify = () => { for (const listener of [...listeners]) listener(); };
    const service = {
        context: () => ({ chatMetadata: metadata }), capture: () => ({ identity: 'chat', metadata, path: '[]' }), destinations: options,
        stage(data) { calls.stage.push(structuredClone(data)); pending = { label: '确认旅行', summary: { from: '城镇', to: '森林营地', routeName: '北方小路', methodName: data.methodId === 'horse' ? '骑马' : '步行', minutes: data.minutes === undefined ? 15 : Number(data.minutes), timeSource: data.minutes === undefined ? '道路距离与速度计算，向上取整到分钟' : '用户填写', beforeTime: clock(), afterTime: clock(15), sceneName: '森林营地夜宿', dueEffects: [{ id: 'poison', name: '中毒', target: '调查员', scope: '身体' }] } }; notify(); return pending; },
        preview: () => structuredClone(pending),
        async confirm() { calls.confirm++; pending = null; dirty = true; notify(); if (failConfirm) throw Error('断网'); dirty = false; },
        async retrySave() { calls.retry++; dirty = false; notify(); }, discard() { calls.discard++; pending = null; notify(); },
        status: () => '', busy: () => busy, dirty: () => dirty,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); calls.unsubscribed++; }; },
    };
    return { service, calls };
}

test('travel view selects a reachable card, previews arrival/scene/expiry and retries save without travelling twice', async () => {
    const previous = globalThis.document; globalThis.document = { createElement: tag => new Node(tag) };
    const target = new Node('main'), fixture = travelFixture(), view = mountTravel(target, { service: fixture.service, periods: () => [{ name: '上午', startMinute: 0 }] });
    try {
        assert.match(target.textContent, /城镇/); assert.match(target.textContent, /高塔：单向道路不能/);
        await click(target, '选择目的地');
        assert.equal(field(target, '通行方式与速度').value, 'walk');
        assert.match(target.textContent, /预计耗时：15 分钟/);
        await click(target, '预览旅行');
        assert.equal(fixture.calls.stage.length, 1); assert.equal(fixture.calls.stage[0].minutes, undefined, 'known duration should use the map calculation');
        assert.match(target.textContent, /城镇 → 森林营地/); assert.match(target.textContent, /抵达后进入场景：森林营地夜宿/);
        assert.match(target.textContent, /中毒 · 调查员 · 身体/); assert.match(target.textContent, /不再附加剧情提醒/); assert.match(target.textContent, /不调用模型/);
        const confirm = button(target, '确认旅行一次'), first = fire(confirm, 'click'), second = fire(confirm, 'click');
        await Promise.allSettled([first, second]);
        assert.equal(fixture.calls.confirm, 1, 'rapid repeated clicks must only confirm one travel');
        assert.equal(fixture.calls.stage.length, 1); assert.match(target.textContent, /不会再次移动、推进时间或切换场景/);
        await click(target, '重试保存');
        assert.equal(fixture.calls.retry, 1); assert.equal(fixture.calls.stage.length, 1); assert.equal(fixture.calls.confirm, 1);
    } finally { view.dispose(); assert.equal(fixture.calls.unsubscribed, 1); globalThis.document = previous; }
});

test('unknown route duration stays editable and is sent explicitly', async () => {
    const previous = globalThis.document; globalThis.document = { createElement: tag => new Node(tag) };
    const target = new Node('main'), fixture = travelFixture({ known: false, failConfirm: false }), view = mountTravel(target, { service: fixture.service });
    try {
        await click(target, '选择目的地'); assert.ok(field(target, '本次旅行耗时（分钟）'));
        await input(target, '本次旅行耗时（分钟）', '27'); await click(target, '预览旅行');
        assert.equal(fixture.calls.stage[0].minutes, '27'); assert.match(target.textContent, /27 分钟/);
    } finally { view.dispose(); globalThis.document = previous; }
});

function sceneFixture() {
    const listeners = new Set(), metadata = {}, state = { version: 1, clock: clock(), periods: [{ name: '上午', startMinute: 0 }], scenes: {}, activeSceneId: null, settings: { enabled: true, includeInContext: false } };
    let pending = null; const service = {
        context: () => ({ chat: [], chatMetadata: metadata }), capture: () => ({ identity: 'chat', metadata, path: '[]', basis: 'scene' }), read: () => structuredClone(state),
        stage(op, data) {
            if (op === 'advance-time') pending = { op, reason: data.reason, details: { beforeTime: structuredClone(state.clock), afterTime: clock(10) }, state: { ...structuredClone(state), clock: clock(10) } };
            if (op === 'set-time') pending = { op, reason: data.reason, details: { beforeTime: structuredClone(state.clock), afterTime: data.clock }, state: { ...structuredClone(state), clock: data.clock } };
            service.staged.push(op); for (const listener of listeners) listener();
        },
        staged: [], preview: () => structuredClone(pending), confirm: async () => { if (pending) state.clock = pending.state.clock; pending = null; for (const listener of listeners) listener(); }, discard: () => { pending = null; }, retrySave: async () => {}, mapReferences: () => [], history: () => [], sync() {},
        status: () => '', busy: () => false, dirty: () => false, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    }; return service;
}
function unavailableTravel() {
    const listeners = new Set(); return { capture() { throw Error('请先在地图应用保存当前聊天地图。'); }, destinations() { throw Error('unreachable'); }, preview: () => null, confirm: async () => {}, retrySave: async () => {}, discard() {}, status: () => '', busy: () => false, dirty: () => false, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

test('scene clock keeps all editor tabs and shows ordinary advance expiry without model prompting', async () => {
    const previousDocument = globalThis.document, previousCrypto = globalThis.crypto;
    globalThis.document = { createElement: tag => new Node(tag) };
    if (!globalThis.crypto) globalThis.crypto = { getRandomValues(bytes) { bytes.fill(7); return bytes; } };
    const target = new Node('main'), service = sceneFixture(); let checkedAfter;
    const view = mountScene(target, { service, travelService: unavailableTravel(), expiryPreview(_ctx, after) { checkedAfter = after; return { newlyExpired: [{ name: '照明术', target: '队伍', scope: '光照' }] }; } });
    try {
        for (const label of ['时钟', '场景', '旅行', '记录', '设置']) assert.ok(button(target, label), `missing scene tab ${label}`);
        await click(target, '10 分钟'); assert.deepEqual(checkedAfter, clock(10));
        assert.deepEqual(service.staged, ['advance-time'], 'quick advance runs without a separate confirmation');
        assert.match(target.textContent, /已推进 · 10 分钟/); assert.doesNotMatch(target.textContent, /待确认/);
        assert.match(target.textContent, /照明术 · 队伍 · 光照/); assert.match(target.textContent, /不再附加剧情提醒/); assert.match(target.textContent, /不调用模型/);
        await click(target, '撤销'); assert.deepEqual(service.staged, ['advance-time', 'set-time']); assert.deepEqual(service.read().clock, clock());
        assert.doesNotMatch(target.textContent, /已推进 · 10 分钟/);
        await click(target, '场景'); assert.ok(labelledField(target, '场景名称'), 'existing full scene editor remains available');
        await click(target, '旅行'); assert.match(target.textContent, /请先在地图应用保存当前聊天地图/);
    } finally { view.dispose(); assert.equal(target.children.length, 0); globalThis.document = previousDocument; if (!previousCrypto) delete globalThis.crypto; }
});
