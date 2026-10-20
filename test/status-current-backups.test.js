import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { generateStatus } from '../apps/status/generator.js';
import { contextLine } from '../apps/shared/context-line.js';
import { createCurrentStoryStorage } from '../apps/state2/current-story-storage.js';
import { registerChatSavePreparation, saveChatMetadata } from '../apps/shared/chat-save.js';
import * as backups from '../apps/status/story-backups.js';
import { isIndependent, readStoryRoot, writeStoryRoot, STATE_KEY, prepareIndependentManualWrite, registerStoryManualPreparation } from '../apps/story-state/access.js';

const state = value => ({ 版本: 1, 项目: { 玩家: { 身份: value } } });
const oldKey = '状态栏_生成前备份_手动';
const fixture = () => {
  const ctx = { characterId: 0, characters: [{ avatar: 'card.png', data: { name: 'NPC' } }],
    getCurrentChatId: () => 'current-chat', chat: [{ name: 'NPC', mes: 'current prose' }],
    chatMetadata: { variables: { 状态栏: JSON.stringify(state('initial')), [oldKey]: JSON.stringify(state('old-manual')), unrelated: 'keep' },
      amin_os_story_storage_v2: { version: 2, backups: [{ stateId: 'preserve-invalid-legacy-ref', label: 'old', at: 1 }] } },
    extensionSettings: {}, saveMetadata: async () => {}, saveSettingsDebounced() {} };
  const records = new Map(), writes = [];
  const service = createCurrentStoryStorage(() => ctx, { files: { available: () => true,
    get: async key => structuredClone(records.get(key) ?? null),
    put: async (key, value, { expected }) => {
      assert.deepEqual(records.get(key) ?? null, expected);
      records.set(key, structuredClone(value));
    } } });
  const setLocalVariable = (key, value) => { writes.push(key); ctx.chatMetadata.variables[key] = value; };
  return { ctx, records, service, writes, setLocalVariable };
};
const preparation = f => registerChatSavePreparation(async ctx => {
  const captured = await f.service.capture({ saveReceipt: true });
  return f.service.consumeCaptureReceipt(captured.receipt, ctx);
});

test('repeated current-only status generation saves one bounded record without new legacy keys or graph references', async () => {
  const f = fixture(), oldWindow = globalThis.window;
  globalThis.window = { SillyTavern: { getContext: () => f.ctx } };
  let dispose = () => {};
  try {
    await f.service.enable(); dispose = preparation(f);
    const originalBackup = f.ctx.chatMetadata.variables[oldKey], legacy = structuredClone(f.ctx.chatMetadata.amin_os_story_storage_v2);
    for (let index = 1; index <= 8; index++) {
      f.ctx.generateRaw = async () => JSON.stringify(state(`updated-${index}`));
      const result = await generateStatus({ mode: 'update', includeCharacter: false, readWorldbooks: false,
        api: { baseUrl: '', timeoutMs: 5000, maxTokens: 1000 } }, undefined,
      { loadVariables: async () => ({ setLocalVariable: f.setLocalVariable }),
        archiveStory: async () => { throw Error('must not archive immutable graph'); } });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.backup, null); assert.equal(result.externalBackup, null);
    }
    assert.deepEqual(f.writes, Array(8).fill('状态栏'));
    assert.deepEqual(Object.keys(f.ctx.chatMetadata.variables).filter(key => key.startsWith('状态栏_生成前备份_')), [oldKey]);
    assert.equal(f.ctx.chatMetadata.variables[oldKey], originalBackup);
    assert.deepEqual(f.ctx.chatMetadata.amin_os_story_storage_v2, legacy);
    assert.equal(f.ctx.chatMetadata.variables.unrelated, 'keep');
    assert.equal(f.records.size, 1);
    const record = [...f.records.values()][0];
    assert.equal(record.current.state.variables.状态栏.项目.玩家.身份, 'updated-8');
    assert.equal(record.backups.length, 5);
    assert.deepEqual(record.backups.map(item => item.state.variables.状态栏.项目.玩家.身份),
      ['updated-7', 'updated-6', 'updated-5', 'updated-4', 'updated-3']);
  } finally { dispose(); globalThis.window = oldWindow; }
});

// Execute the status application's actual module body with host/UI imports
// supplied by a small harness; the browser's absolute /scripts import is not
// available to Node. No backup branch or action body is recreated here.
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.value = ''; this.classList = { add() {} }; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? '') + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); if (this.tagName === 'SELECT' && !this.value) this.value = child.value; } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute() {} addEventListener() {} focus() {} scrollIntoView() {}
  querySelectorAll() { return []; }
}
const walk = root => [root, ...root.children.flatMap(walk)];
async function application(f, runtime = { archiveStory: () => f.service.capture() }, loadVariables = async () => ({setLocalVariable:f.setLocalVariable})) {
  const document = { created: [], createElement(tag) { const element = new Element(tag); this.created.push(element); return element; } };
  const messages = [], opened = [], generationViews = [], target = new Element('main');
  const history = { sync() {}, adoptExternal() {}, list() { throw Error('current backup picker must not load floor histories'); } };
  let templateWrite;
  const sandbox = { console, URL, setInterval: () => 1, clearInterval() {},
    document, SillyTavern: { getContext: () => f.ctx },
    window: { toastr: { info: message => messages.push(message), error: message => messages.push(message) } },
    AminOS: { openApp: app => opened.push(app) },
    fetch: async () => ({ ok: true, text: async () => '<html lang="zh-CN"><head></head></html>' }),
    addEventListener() {}, removeEventListener() {},
    relocateStatus() {}, findNativeState2ModuleUrl() {}, saveChatMetadata, uuid: () => 'token',
    subscribeStateChanges() {}, chatIdentity: () => 'current-chat',
    captureContext: () => f.ctx.chatMetadata, assertContext: () => f.ctx, acquireMetadataWrite: () => () => {},
    mountWorldbookSources: () => ({ getValue: () => ({}), refresh() {}, dispose() {} }),
    sourceSettings: () => ({}), saveSourceSettings() {}, createMapLink: () => ({ element: new Element('div'), destroy() {} }),
    checkpointState() {}, compileRules: () => '', createRulesPage: () => new Element('section'),
    installUpdateEntry() {}, boundWorldbook: () => 'book', createHistory: () => history,
    historyView: () => ({ element: new Element('section'), dispose() {} }), installFloorButtons: () => ({ refresh() {} }),
    ...backups, createTemplatesPage: options => { templateWrite = options.write; return new Element('section'); },
    copyPrompt() {}, buildUpdatePrompt() {}, generateStatus() {}, hostSetLocalVariable: f.setLocalVariable,
    isIndependent, readStoryRoot, writeStoryRoot, STATE_KEY, prepareIndependentManualWrite,
    mountGeneration: (_target, options) => {const view={options,opens:0,disposed:false,open(){this.opens++;},dispose(){this.disposed=true;}};generationViews.push(view);return view;},
    mountLinkage: () => ({ open() {}, dispose() {} }), getLinkageService: () => ({ subscribe: () => () => {} }),
    managesModule: () => !!f.ctx.chatMetadata.amin_os_linkage_v1?.enabled, getState2Runtime: () => runtime, state2HistoryMode: () => ({ managed: true }), contextLine, takeAppRequest: () => undefined,
  };
  const source = readFileSync(new URL('../apps/status/index.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gmu, '').replace('export async function initialize', 'async function initialize')
    .replaceAll('import.meta.url', JSON.stringify(new URL('../apps/status/index.js', import.meta.url).href));
  vm.runInNewContext(source + '\nglobalThis.api = { initialize };', sandbox);
  const app = await sandbox.api.initialize({ mount: target, loadVariables });
  const find = label => {
    const node = document.created.find(element => element.tagName === 'BUTTON' && element.textContent === label);
    assert.ok(node, `missing action ${label}`); return node;
  };
  return { app, find, document, messages, opened, target, generationViews, get templateWrite() { return templateWrite; } };
}

test('independent status application starts and applies a template without importing a host variables module', async () => {
  const f=fixture();let imports=0;
  f.ctx.chatMetadata[STATE_KEY]={version:1,revision:1,modules:{status:state('canonical')}};
  // Initialization must skip the loader entirely in independent mode.
  const b=await application(f,{},async()=>{imports++;throw Error('host variables unavailable');});
  await b.app.open('templates');assert.equal(imports,0);
  let commits=0;const off=registerStoryManualPreparation(()=>{commits++;});
  try{await b.templateWrite(state('new-template'));}finally{off();}
  assert.equal(commits,1);
  assert.equal(JSON.parse(readStoryRoot(f.ctx,'状态栏')).项目.玩家.身份,'new-template');assert.deepEqual(f.writes,[]);
  assert.equal(f.ctx.chatMetadata.extensions?.LittleWhiteBox,undefined);
});

test('current-only manual status save archives current record and saves metadata without duplicate roots', async () => {
  const f = fixture(); await f.service.enable();
  let archives = 0;
  const a = await application(f, { archiveStory: async () => { archives++; return f.service.capture(); } });
  const before = structuredClone(f.ctx.chatMetadata), unregister = preparation(f);
  try {
    await a.find('手动另存状态').onclick();
    assert.equal(archives, 1); assert.deepEqual(f.writes, []);
    assert.deepEqual(f.ctx.chatMetadata, before);
    assert.equal(f.records.size, 1); assert.equal([...f.records.values()][0].backups.length, 0);
    assert.ok(a.document.created.some(node => /当前状态已随保存留存/.test(node.textContent)));
    assert.ok(!a.document.created.some(node => /已另存外置恢复点/.test(node.textContent)));
  } finally { unregister(); }
});

test('current-only manual status save reports archive failure without creating a fallback backup', async () => {
  const f = fixture(); await f.service.enable();
  const a = await application(f, { archiveStory: async () => { throw Error('current file save failed'); } });
  await a.find('手动另存状态').onclick();
  assert.deepEqual(f.writes, []); assert.ok(a.messages.includes('current file save failed'));
});

test('current-only restore keeps old manual status backups selectable and changes only status without new legacy keys', async () => {
  const f = fixture(); await f.service.enable(); const a = await application(f), unregister = preparation(f);
  try {
    await a.find('恢复备份').onclick();
    await a.find('恢复所选备份').onclick();
    assert.deepEqual(f.writes, ['状态栏']);
    assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.玩家.身份, 'old-manual');
    assert.equal(f.ctx.chatMetadata.variables.unrelated, 'keep');
    assert.deepEqual(Object.keys(f.ctx.chatMetadata.variables).filter(key => key.startsWith('状态栏_生成前备份_')), [oldKey]);
    assert.equal([...f.records.values()][0].backups.length, 1);
    assert.ok(a.messages.some(message => /最近整套变量备份/.test(message)));
  } finally { unregister(); }
});

test('current-only restore without old manual status backups directs to settings and explains whole-state restoration', async () => {
  const f = fixture(); delete f.ctx.chatMetadata.variables[oldKey]; await f.service.enable();
  const a = await application(f); await a.find('恢复备份').onclick();
  assert.deepEqual(a.opened, ['settings']); assert.deepEqual(f.writes, []);
  assert.ok(a.messages.some(message => /恢复整套受管变量/.test(message)));
});

test('current-only applying a status template saves the bounded record without copying a legacy variable backup', async () => {
  const f = fixture(); await f.service.enable(); const a = await application(f), unregister = preparation(f);
  try {
    await a.app.open('templates');
    await a.templateWrite(state('template'));
    assert.deepEqual(f.writes, ['状态栏']);
    assert.equal([...f.records.values()][0].current.state.variables.状态栏.项目.玩家.身份, 'template');
    assert.equal([...f.records.values()][0].backups.length, 1);
    assert.equal(f.ctx.chatMetadata.variables.unrelated, 'keep');
    assert.deepEqual(Object.keys(f.ctx.chatMetadata.variables).filter(key => key.startsWith('状态栏_生成前备份_')), [oldKey]);
  } finally { unregister(); }
});

for(const managed of [false,true])test('both status update entries open one per-HUD draft editor even when managed '+managed,async()=>{
  const f=fixture();f.ctx.chatMetadata.amin_os_linkage_v1={enabled:managed};const before=structuredClone(f.ctx.chatMetadata),b=await application(f);
  await b.app.open('state');assert.equal(b.generationViews.length,1);assert.equal(b.generationViews[0].opens,0);assert.deepEqual([...b.generationViews[0].options.modules],['status']);
  await b.find('按现有剧情更新状态').onclick();assert.equal(b.generationViews[0].opens,1);await b.find('按当前剧情更新值').onclick();assert.equal(b.generationViews[0].opens,2);
  assert.deepEqual(f.ctx.chatMetadata,before);assert.deepEqual(f.writes,[]);assert.ok(b.document.created.some(node=>/预览确认后才会保存/.test(node.textContent)));
  await b.app.open('state');assert.equal(b.generationViews[0].disposed,true);assert.equal(b.generationViews.length,2);assert.equal(b.generationViews[1].opens,0);
});
