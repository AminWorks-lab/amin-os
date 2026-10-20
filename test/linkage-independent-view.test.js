import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../apps/linkage/view.js';

class Node {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  async dispatch(type) { for (const fn of this.listeners.get(type) ?? []) await fn({ target: this }); }
  click() { return this.dispatch('click'); }
  querySelectorAll(selector) { return walk(this).slice(1).filter(node => selector === '[data-linkage-lock]' ? node.dataset.linkageLock : selector === '[data-linkage-invalid]' ? node.dataset.linkageInvalid : node.tagName === selector.toUpperCase()); }
  focus() {} select() {}
}
const walk = root => [root, ...root.children.flatMap(walk)];
const find = (root, label, tag = 'button') => walk(root).find(node => node.tagName === tag.toUpperCase() && (node.textContent === label || node.getAttribute('aria-label') === label));
async function click(root, label) { const node = find(root, label); assert.ok(node, `missing ${label}`); assert.equal(node.disabled, false); await node.dispatch('click'); }
async function input(root, label, value, tag = 'textarea') { const node = find(root, label, tag); assert.ok(node); node.value = value; await node.dispatch(tag === 'select' ? 'change' : 'input'); }
function fixture({ useShell = false, independentViaApi = false, worldbookContent = '旧规则前文\n{{amin_os_linkage}}\n旧规则后文' } = {}) {
  const calls = [], listeners = new Set();
  let settings = { version: 1, enabled: true, mode: 'review', dataSource: 'amin', modules: { characters: { enabled: true, read: true, write: true } }, extraRules: '' };
  let pending = null, suggestions = [];
  const notify = () => listeners.forEach(fn => fn());
  const api = {
    settings: () => structuredClone(settings), modules: () => [{ id: 'characters', label: '人物', available: true, ...settings.modules.characters }],
    saveSettings: async value => { settings = structuredClone(value); calls.push(['settings', value.mode]); notify(); },
    ...(independentViaApi ? { isIndependent: () => true } : {}),
    nativeState2Status: () => ({ ...(independentViaApi ? {} : {mode: 'independent'}), independent: true, enabled: true, ready: true, available: false, message: 'Amin 当前资料已启用。' }),
    prompt: () => '<amin_update>typed update format</amin_update>' + settings.extraRules, dataPrompt: () => '',
    busy: () => false, dirty: () => false, preview: () => pending, status: () => 'Amin ready',
    stage: async raw => { calls.push(['stage', raw]); pending = { changes: [], valid: true }; notify(); },
    stageSuggestion: async id => { calls.push(['suggestion', id]); pending = { changes: [], valid: true }; notify(); },
    confirm: async () => { calls.push('confirm'); pending = null; notify(); }, discard: () => { pending = null; notify(); },
    suggestions: () => suggestions,
    references: () => ({ entities: [], links: [], unresolved: [] }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    migrateState2: async () => { calls.push('old-migrate'); throw Error('must not migrate'); },
    retryState2Restore: async () => { calls.push('old-restore'); throw Error('must not restore'); },
    inspectStoryReferences: async () => { calls.push('old-inspect'); throw Error('must not inspect graph'); },
    repairStoryReferences: async () => { calls.push('old-repair'); throw Error('must not repair graph'); },
  };
  const document = { createElement: tag => new Node(tag, document) }, root = new Node('main', document);
  const view = mount(root, { api, document, getContext: () => ({}),
    clipboard: {writeText: async value => calls.push(['copy', value])},
    worldbook: {inspect: async () => {calls.push('inspect');return {name:'旧世界书',exists:true,valid:true,message:'已发现旧条目',content:worldbookContent};},
      install: async () => {calls.push('install');throw Error('Inspection must not rewrite worldbook');}},
    ...(useShell ? {} : { openStorySettings: () => { calls.push('story-settings'); } }) });
  return { root, view, api, calls, document, settings: () => settings,
    suggest() { suggestions = [{ id: 'suggestion', source: { index: 1 }, text: '<amin_update>{}</amin_update>' }]; notify(); } };
}

test('independent linkage renders typed current-state workflow and excludes all native recovery paths', async () => {
  const f = fixture();
  try {
    assert.match(f.root.textContent, /当前剧情资料 · Amin 独立存储/);
    assert.match(f.root.textContent, /<amin_update>/);
    assert.doesNotMatch(f.root.textContent, /小白变量|<state>|旧版|历史 Amin 更新/);
    assert.equal(find(f.root, '安装／更新统一条目').hidden, true);
    assert.equal(find(f.root, '安装／更新统一条目').disabled, true);
    assert.ok(find(f.root, '刷新更新规则预览'));
    assert.ok(find(f.root, '复制更新规则'));
    for (const label of ['初始化／迁移剧情变量', '重试恢复当前分支', '检查剧情存档引用', '确认采用这些楼层的原有存档']) assert.equal(find(f.root, label), undefined);
    await click(f.root, '打开存档与历史 → 剧情存储'); assert.deepEqual(f.calls, ['story-settings']);
  } finally { f.view.dispose(); }
});

for (const independentViaApi of [false, true]) test(`independent prompt preview copies only actual plugin rules after inspecting old state wrappers (${independentViaApi ? 'api flag' : 'status mode'})`, async () => {
  const original = '<state>旧版前文：执行旧变量</state>\n{{amin_os_linkage}}\n<state>旧版后文：恢复变量</state>';
  const f = fixture({independentViaApi,worldbookContent:original});
  try {
    const preview = () => find(f.root, '更新规则预览内容', 'textarea').value;
    assert.equal(preview(), f.api.prompt());
    assert.ok(find(f.root, '用户补充要求', 'textarea'));
    await click(f.root, '检查绑定世界书');
    assert.equal(find(f.root, '安装／更新统一条目').hidden, true);
    assert.equal(find(f.root, '检查绑定世界书').disabled, false);
    assert.equal(preview(), f.api.prompt());
    assert.doesNotMatch(preview(), /<state>|旧版前文|旧版后文/);
    assert.match(f.root.textContent, /插件直接提供/);
    assert.match(f.root.textContent, /检查绑定世界书仅检查旧条目/);
    assert.doesNotMatch(f.root.textContent, /已合并上次检查|检查绑定世界书后会合并/);
    await click(f.root, '复制更新规则');
    assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'copy'), [['copy', f.api.prompt()]]);
    await input(f.root, '用户补充要求', '\n传闻不得作为已确认事实。');
    assert.doesNotMatch(preview(), /传闻不得/);
    await click(f.root, '保存联动设置');
    await click(f.root, '检查绑定世界书');
    await click(f.root, '刷新更新规则预览');
    await click(f.root, '复制更新规则');
    assert.equal(preview(), f.api.prompt());
    assert.match(preview(), /传闻不得作为已确认事实/);
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'copy').at(-1)[1], f.api.prompt());
    assert.equal(f.calls.includes('install'), false);
    assert.equal(original, '<state>旧版前文：执行旧变量</state>\n{{amin_os_linkage}}\n<state>旧版后文：恢复变量</state>');
  } finally {f.view.dispose();}
});

test('review and auto update mode remain editable drafts until saved', async () => {
  const f = fixture();
  try {
    assert.equal(find(f.root, '模型更新方式', 'select').value, 'review');
    await input(f.root, '模型更新方式', 'auto', 'select'); assert.equal(f.settings().mode, 'review');
    await click(f.root, '保存联动设置'); assert.equal(f.settings().mode, 'auto');
    assert.ok(f.calls.some(value => Array.isArray(value) && value[0] === 'settings' && value[1] === 'auto'));
    await input(f.root, '模型更新方式', 'review', 'select'); await click(f.root, '保存联动设置'); assert.equal(f.settings().mode, 'review');
  } finally { f.view.dispose(); }
});

test('new update suggestions and manual import are normal Amin updates with explicit confirmation', async () => {
  const f = fixture();
  try {
    f.suggest(); assert.match(f.root.textContent, /Amin 剧情更新建议/); assert.doesNotMatch(f.root.textContent, /旧版|小白|<state>/);
    await click(f.root, '校验并预览这组更新'); assert.equal(f.calls.includes('confirm'), false);
    assert.match(f.root.textContent, /Amin 剧情更新待确认/);
    await click(f.root, '确认整组更新一次'); assert.equal(f.calls.filter(value => value === 'confirm').length, 1);
    assert.ok(find(f.root, '手动校验 Amin 剧情更新', 'summary'));
    await input(f.root, '待校验的统一更新内容', '<amin_update>{"operations":[]}</amin_update>');
    await click(f.root, '校验并预览粘贴内容'); assert.equal(f.calls.filter(value => value === 'confirm').length, 1);
    assert.ok(f.calls.some(value => Array.isArray(value) && value[0] === 'stage'));
  } finally { f.view.dispose(); }
});

test('external source describes user-supplied macros rather than a native variable dependency', async () => {
  const f = fixture();
  try {
    assert.match(f.root.textContent, /自定义宏/);
    await input(f.root, '资料发送来源', 'external', 'select'); await click(f.root, '保存联动设置');
    assert.equal(f.settings().dataSource, 'external'); assert.doesNotMatch(f.root.textContent, /小白变量宏|变量 2\.0/);
  } finally { f.view.dispose(); }
});

test('story storage shortcut opens 剧情存储 inside 存档与历史 through the shell', async () => {
  const f = fixture({ useShell: true }), original = globalThis.AminOS;
  try {
    globalThis.AminOS = { async openApp(id) { assert.equal(id, 'story'); f.calls.push('story-app'); } };
    await click(f.root, '打开存档与历史 → 剧情存储'); assert.deepEqual(f.calls, ['story-app']);
  } finally { globalThis.AminOS = original; f.view.dispose(); }
});
