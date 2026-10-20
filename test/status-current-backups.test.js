import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { generateStatus } from '../apps/status/generator.js';
import { contextLine } from '../apps/shared/context-line.js';
import { saveChatMetadata } from '../apps/shared/chat-save.js';
import { isIndependent, readStoryRoot, writeStoryRoot, STATE_KEY, prepareIndependentManualWrite, registerStoryManualPreparation } from '../apps/story-state/access.js';

const state = value => ({ 版本: 1, 项目: { 玩家: { 身份: value } } });
const oldKey = '状态栏_生成前备份_手动';
const fixture = () => {
  const ctx = { characterId: 0, characters: [{ avatar: 'card.png', data: { name: 'NPC' } }],
    getCurrentChatId: () => 'current-chat', chat: [{ name: 'NPC', mes: 'current prose' }],
    chatMetadata: { variables: { 状态栏: JSON.stringify(state('initial')), [oldKey]: JSON.stringify(state('old-manual')), unrelated: 'keep' } },
    extensionSettings: {}, saveMetadata: async () => {}, saveSettingsDebounced() {} };
  const writes = [];
  const setLocalVariable = (key, value) => { writes.push(key); ctx.chatMetadata.variables[key] = value; };
  return { ctx, writes, setLocalVariable };
};

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
async function application(f, runtime = {}, loadVariables = async () => ({setLocalVariable:f.setLocalVariable})) {
  const document = { created: [], createElement(tag) { const element = new Element(tag); this.created.push(element); return element; } };
  const messages = [], opened = [], generationViews = [], target = new Element('main');
  const history = { sync() {}, adoptExternal() {}, list() { return []; } };
  let templateWrite;
  const sandbox = { console, URL, setInterval: () => 1, clearInterval() {},
    document, SillyTavern: { getContext: () => f.ctx },
    window: { toastr: { info: message => messages.push(message), error: message => messages.push(message) } },
    AminOS: { openApp: app => opened.push(app) },
    fetch: async () => ({ ok: true, text: async () => '<html lang="zh-CN"><head></head></html>' }),
    addEventListener() {}, removeEventListener() {},
    relocateStatus() {}, saveChatMetadata, uuid: () => 'token',
    subscribeStateChanges() {}, chatIdentity: () => 'current-chat',
    captureContext: () => f.ctx.chatMetadata, assertContext: () => f.ctx, acquireMetadataWrite: () => () => {},
    mountWorldbookSources: () => ({ getValue: () => ({}), refresh() {}, dispose() {} }),
    sourceSettings: () => ({}), saveSourceSettings() {}, createMapLink: () => ({ element: new Element('div'), destroy() {} }),
    compileRules: () => '', createRulesPage: () => new Element('section'),
    installUpdateEntry() {}, boundWorldbook: () => 'book', createHistory: () => history,
    historyView: () => ({ element: new Element('section'), dispose() {} }), installFloorButtons: () => ({ refresh() {} }),
    createTemplatesPage: options => { templateWrite = options.write; return new Element('section'); },
    copyPrompt() {}, buildUpdatePrompt() {}, generateStatus() {}, hostSetLocalVariable: f.setLocalVariable,
    isIndependent, readStoryRoot, writeStoryRoot, STATE_KEY, prepareIndependentManualWrite,
    mountGeneration: (_target, options) => {const view={options,opens:0,disposed:false,open(){this.opens++;},dispose(){this.disposed=true;}};generationViews.push(view);return view;},
    attachLinkageBadge: () => null, collapseTabs: () => ({ update() {}, dispose() {} }), openLinkageApp: async () => {}, getLinkageService: () => ({ subscribe: () => () => {} }),
    managesModule: () => !!f.ctx.chatMetadata.amin_os_linkage_v1?.enabled, getState2Runtime: () => runtime, contextLine,
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

test('independent manual status save stores one whole-story backup without host variable writes', async () => {
  const f = fixture(); f.ctx.chatMetadata[STATE_KEY] = { version: 1, revision: 1, modules: { status: state('canonical') } };
  const labels = [], before = structuredClone(f.ctx.chatMetadata);
  const a = await application(f, { saveBackup: async label => { labels.push(label); return { saved: true }; } });
  await a.find('手动另存状态').onclick();
  assert.deepEqual(labels, ['手动另存状态']); assert.deepEqual(f.writes, []);
  assert.deepEqual(f.ctx.chatMetadata, before);
});

test('restoring an old manual status variable backup in an unmigrated chat keeps the old variable', async () => {
  const f = fixture(), a = await application(f);
  await a.find('恢复备份').onclick();
  await a.find('恢复所选备份').onclick();
  assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.玩家.身份, 'old-manual');
  assert.equal(f.ctx.chatMetadata.variables[oldKey], JSON.stringify(state('old-manual')));
  assert.equal(f.ctx.chatMetadata.variables.unrelated, 'keep');
});

for(const managed of [false,true])test('both status update entries open one per-HUD draft editor even when managed '+managed,async()=>{
  const f=fixture();f.ctx.chatMetadata.amin_os_linkage_v1={enabled:managed};const before=structuredClone(f.ctx.chatMetadata),b=await application(f);
  await b.app.open('state');assert.equal(b.generationViews.length,1);assert.equal(b.generationViews[0].opens,0);assert.deepEqual([...b.generationViews[0].options.modules],['status']);
  await b.find('按现有剧情更新状态').onclick();assert.equal(b.generationViews[0].opens,1);await b.find('按当前剧情更新值').onclick();assert.equal(b.generationViews[0].opens,2);
  assert.deepEqual(f.ctx.chatMetadata,before);assert.deepEqual(f.writes,[]);assert.ok(b.document.created.some(node=>/预览确认后才会保存/.test(node.textContent)));
  await b.app.open('state');assert.equal(b.generationViews[0].disposed,true);assert.equal(b.generationViews.length,2);assert.equal(b.generationViews[1].opens,0);
});
