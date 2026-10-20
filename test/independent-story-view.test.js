import test from 'node:test';
import assert from 'node:assert/strict';
import { mountStoryStorage } from '../settings/story-storage-view.js';
import { registerOperationPatchExpansion } from '../apps/shared/operations.js';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.hidden = false; this.disabled = false; this.value = ''; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  click() { this.clicks = (this.clicks ?? 0) + 1; this.onclick?.(); }
}
const all = node => node.children.flatMap(child => [child, ...all(child)]);
const button = (target, label) => {
  const node = all(target).find(item => item.tagName === 'BUTTON' && item.textContent === label);
  assert.ok(node, `missing button ${label}`); return node;
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const previousDocument = globalThis.document, previousHost = globalThis.SillyTavern;
  globalThis.document = { createElement: tag => new Element(tag), body: new Element('body') };
  let ctx = { chatId: 'a', chatMetadata: { integrity: 'a', oldVariables: 'preserve' }, chat: [{ mes: 'original' }] };
  globalThis.SillyTavern = { getContext: () => ctx };
  const unregister = registerOperationPatchExpansion(patches => patches, null, () => { throw Error('native guard blocked'); });
  const calls = { legacy: [], imports: [], applies: [], empty: 0, reset: 0, lists: 0, backups: [], exports: 0, legacyExports: 0 };
  const plan = Object.freeze({ proof: 'opaque' });
  let enabled = false;
  const value = () => ({ plan, valid: true, source: 'app', summary: '2 项人物资料',
    modules: [{ key: 'characters', label: '人物', count: 2 }, { key: 'scene', label: '场景', count: 1 }], errors: [] });
  const runtime = {
    ready: () => enabled,
    status: () => ({ independent: enabled, enabled, available: true, backupCount: enabled ? 2 : 0, requiresImport: !enabled }),
    previewLegacy: async source => { calls.legacy.push(source); return value(); },
    previewImport: async raw => { calls.imports.push(raw); return value(); },
    applyPreview: async input => { calls.applies.push(input); enabled = true; return { message: '预览已应用。' }; },
    initializeEmpty: async () => { calls.empty++; enabled = true; return { message: '空白资料已建立。' }; },
    reset: async () => { calls.reset++; return { message: '已备份清空。' }; },
    listBackups: async () => { calls.lists++; return [{ id: 'a-backup', at: 1710000000000, label: 'First' }, { id: 'b-backup', at: 1710000001000, label: 'Second' }]; },
    previewBackup: async id => { calls.backups.push(id); return value(); },
    exportState: async () => { calls.exports++; return { version: 1 }; },
    exportLegacySource: async () => { calls.legacyExports++; return { source: 'legacy', data: { oldVariables: 'preserve' } }; },
    ...overrides,
  };
  const target = new Element('main'), messages = [];
  const view = mountStoryStorage(target, (text, state) => messages.push([text, state]), () => runtime);
  return { target, messages, calls, runtime, plan, get ctx() { return ctx; },
    switchChat() { ctx = { chatId: 'b', chatMetadata: { integrity: 'b' }, chat: [{ mes: 'other' }] }; },
    dispose() { view.dispose(); unregister(); globalThis.document = previousDocument; globalThis.SillyTavern = previousHost; }, view };
}

test('independent UI offers a current-state workflow without native floor recovery controls or automatic migration', async () => {
  const f = fixture();
  try {
    await tick(); assert.match(f.target.textContent, /Amin 剧情存储/);
    assert.doesNotMatch(f.target.textContent, /重试恢复当前分支|用原聊天校验 Swipe 标识|小白变量恢复未完成/);
    assert.match(f.target.textContent, /默认 10 份/);
    assert.equal(f.calls.empty, 0); assert.equal(f.calls.reset, 0); assert.deepEqual(f.calls.legacy, []);
  } finally { f.dispose(); }
});

test('legacy preview uses the selected source, remains read-only and applies only the opaque plan after confirmation', async () => {
  const f = fixture();
  try {
    await tick(); const source = all(f.target).find(node => node.tagName === 'SELECT'); source.value = 'native';
    button(f.target, '预览导入旧资料').click(); await tick();
    assert.deepEqual(f.calls.legacy, [{ source: 'native' }]); assert.deepEqual(f.calls.applies, []);
    assert.match(f.target.textContent, /人物：2 项/); assert.match(f.target.textContent, /场景：1 项/);
    button(f.target, '确认应用预览').click(); await tick();
    assert.deepEqual(f.calls.applies, [f.plan]);
    assert.ok(f.messages.some(([text, state]) => text === '预览已应用。' && state !== 'error'));
    assert.equal(button(f.target, '确认应用预览').disabled, true);
  } finally { f.dispose(); }
});

test('invalid module and reference errors are visible and block confirmation', async () => {
  const f = fixture({ previewLegacy: async () => ({ plan: {}, valid: false, modules: [
    { key: 'characters', label: '人物', count: 2, error: '重复人物 ID', unmatchedReferences: ['missing-person'] },
  ], errors: [{ module: 'scene', code: 'reference', message: '场景引用未匹配' }] }) });
  try {
    await tick(); button(f.target, '预览导入旧资料').click(); await tick();
    assert.match(f.target.textContent, /重复人物 ID/); assert.match(f.target.textContent, /missing-person/); assert.match(f.target.textContent, /场景引用未匹配/);
    assert.equal(button(f.target, '确认应用预览').disabled, true);
    button(f.target, '确认应用预览').click(); await tick(); assert.deepEqual(f.calls.applies, []);
  } finally { f.dispose(); }
});

test('empty initialization and later reset each require only their explicit action and bypass legacy preparation', async () => {
  const f = fixture();
  try {
    await tick(); const before = structuredClone(f.ctx);
    button(f.target, '开始空白剧情资料').click(); await tick();
    assert.equal(f.calls.empty, 1); assert.equal(f.calls.reset, 0); assert.deepEqual(f.calls.legacy, []);
    button(f.target, '备份并清空当前资料').click(); await tick(); assert.equal(f.calls.reset, 1);
    assert.deepEqual(f.ctx, before); assert.ok(!f.messages.some(([, state]) => state === 'error'));
  } finally { f.dispose(); }
});

test('JSON backup import passes raw input to validation and waits for preview confirmation', async () => {
  const f = fixture();
  try {
    await tick(); button(f.target, '预览导入剧情备份').click();
    const input = all(f.target).find(node => node.tagName === 'INPUT' && node.type === 'file');
    assert.equal(input.clicks, 1); input.files = [{ text: async () => '{"version":1,"state":{}}' }]; input.onchange(); await tick();
    assert.deepEqual(f.calls.imports, ['{"version":1,"state":{}}']); assert.deepEqual(f.calls.applies, []);
    button(f.target, '确认应用预览').click(); await tick(); assert.deepEqual(f.calls.applies, [f.plan]);
  } finally { f.dispose(); }
});

test('backup inspection and preview never restore automatically', async () => {
  const f = fixture();
  try {
    await tick(); button(f.target, '开始空白剧情资料').click(); await tick();
    button(f.target, '查看最近备份').click(); await tick(); assert.equal(f.calls.lists, 1);
    const select = all(f.target).find(node => node.tagName === 'SELECT' && node.children.some(option => /First/.test(option.textContent)));
    select.value = 'b-backup'; button(f.target, '预览所选备份').click(); await tick();
    assert.deepEqual(f.calls.backups, ['b-backup']); assert.deepEqual(f.calls.applies, []);
    button(f.target, '确认应用预览').click(); await tick(); assert.deepEqual(f.calls.applies, [f.plan]);
  } finally { f.dispose(); }
});

test('switching chats invalidates an already displayed import preview', async () => {
  const f = fixture();
  try {
    await tick(); button(f.target, '预览导入旧资料').click(); await tick(); f.switchChat();
    button(f.target, '确认应用预览').click(); await tick(); assert.deepEqual(f.calls.applies, []);
    assert.ok(f.messages.some(([, state]) => state === 'error'));
  } finally { f.dispose(); }
});

test('switching chats during backup file loading stops before source validation', async () => {
  let resolve; const f = fixture();
  try {
    await tick(); button(f.target, '预览导入剧情备份').click();
    const input = all(f.target).find(node => node.tagName === 'INPUT' && node.type === 'file');
    input.files = [{ text: () => new Promise(done => { resolve = done; }) }]; input.onchange();
    f.switchChat(); resolve('{}'); await tick(); assert.deepEqual(f.calls.imports, []); assert.deepEqual(f.calls.applies, []);
  } finally { f.dispose(); }
});

test('busy preview disables other actions and does not dispatch a second mutation', async () => {
  let resolve; const f = fixture({ previewLegacy: () => new Promise(done => { resolve = done; }) });
  try {
    await tick(); button(f.target, '预览导入旧资料').click();
    assert.equal(button(f.target, '开始空白剧情资料').disabled, true);
    button(f.target, '开始空白剧情资料').click(); assert.equal(f.calls.empty, 0);
    resolve({ plan: f.plan, valid: true, modules: [], errors: [] }); await tick();
  } finally { f.dispose(); }
});

test('failed reset is reported as an error and cannot appear successful', async () => {
  const f = fixture({ reset: async () => { throw Error('backup write failure'); } });
  try {
    await tick(); button(f.target, '开始空白剧情资料').click(); await tick();
    button(f.target, '备份并清空当前资料').click(); await tick();
    assert.ok(f.messages.some(([text, state]) => text === 'backup write failure' && state === 'error'));
    assert.ok(!f.messages.some(([text, state]) => /已备份清空/.test(text) && state !== 'error'));
  } finally { f.dispose(); }
});

test('disposing the view cancels a delayed preview without applying it', async () => {
  let resolve; const f = fixture({ previewLegacy: () => new Promise(done => { resolve = done; }) });
  try {
    await tick(); button(f.target, '预览导入旧资料').click(); f.view.dispose();
    resolve({ plan: f.plan, valid: true, modules: [], errors: [] }); await tick(); assert.deepEqual(f.calls.applies, []);
  } finally { f.dispose(); }
});

test('missing external backup storage does not disable local initialization or import previews', async () => {
  const f = fixture({ status: () => ({ independent: false, enabled: false, available: false, requiresImport: true }) });
  try {
    await tick();
    for (const label of ['开始空白剧情资料', '预览导入旧资料', '预览导入剧情备份']) {
      assert.equal(button(f.target, label).disabled, false, `${label} must remain available without Tauri store`);
    }
    assert.equal(button(f.target, '查看最近备份').disabled, true);
    button(f.target, '开始空白剧情资料').click(); await tick(); assert.equal(f.calls.empty, 1);
  } finally { f.dispose(); }
});

test('enabled local state can reset and export without external backup storage', async () => {
  const f = fixture({ status: () => ({ independent: true, enabled: true, available: true, backupAvailable: false, backupCount: 0 }) });
  try {
    await tick();
    assert.equal(button(f.target, '清空当前资料重新生成').disabled, false);
    assert.equal(button(f.target, '导出当前剧情备份').disabled, false);
    assert.equal(button(f.target, '查看最近备份').disabled, true);
    assert.equal(button(f.target, '预览所选备份').disabled, true);
    assert.match(f.target.textContent, /外部备份存储不可用/);
    button(f.target, '清空当前资料重新生成').click(); await tick(); assert.equal(f.calls.reset, 1);
    assert.ok(f.messages.some(([text]) => /本次未新增最近备份/.test(text)));
  } finally { f.dispose(); }
});

test('exporting archived old source only downloads it and does not save or apply any state', async () => {
  const f = fixture({ status: () => ({ enabled: false, available: true, backupAvailable: false }) });
  try {
    await tick(); const before = structuredClone(f.ctx);
    assert.equal(button(f.target, '导出旧资料原件').disabled, false);
    button(f.target, '导出旧资料原件').click(); await tick();
    assert.equal(f.calls.legacyExports, 1); assert.equal(f.calls.exports, 0);
    assert.equal(f.calls.empty, 0); assert.equal(f.calls.reset, 0); assert.deepEqual(f.calls.applies, []);
    assert.deepEqual(f.ctx, before);
    assert.ok(f.messages.some(([text, state]) => /旧资料原件已下载/.test(text) && state !== 'error'));
  } finally { f.dispose(); }
});
