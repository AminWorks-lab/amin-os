// Isolated Chromium integration checks. No real chat, credentials, or model calls.
// Run: node scripts/roadmap-browser-smoke.mjs (AMIN_BROWSER / AMIN_ROADMAP_ARTIFACTS optional).
// Host APIs/worldbook storage are isolated; all Amin OS services and writes are real.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = process.env.AMIN_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.AMIN_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const artifacts = process.env.AMIN_ROADMAP_ARTIFACTS || path.resolve(root, '../roadmap-browser-smoke');
for (const id of ['characters', 'inventory', 'relationships', 'saves']) if (!fs.existsSync(path.join(root, 'apps', id, 'view.js'))) throw Error('Missing app view: ' + id);
if (!fs.existsSync(executable)) throw Error('Set AMIN_BROWSER to a Chromium executable.');
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, 'profile-'));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>html,body{margin:0;min-width:0;background:#10191e;color:#e0e9e5;font:14px/1.6 system-ui,sans-serif}*{box-sizing:border-box}main{width:100%;max-width:1000px;padding:12px;margin:auto}.mes{margin-bottom:16px;min-width:0}.mes_block,.mes_text{min-width:0}.mes_text{padding:8px;overflow-wrap:anywhere}#send_textarea{display:block;width:100%;min-height:90px}#send_form{margin-top:18px}[hidden]{display:none!important}</style></head><body><main><h1>Amin OS · 隔离模拟宿主</h1><div id="chat"></div><form id="send_form" onsubmit="return false"><label for="send_textarea">行动草稿</label><textarea id="send_textarea"></textarea><button type="button" id="send_but">模拟发送</button></form></main></body></html>`;
const routes = {
    '/scripts/variables.js': `export function setLocalVariable(key,value){const c=globalThis.SillyTavern.getContext();c.chatMetadata.variables??={};c.chatMetadata.variables[key]=value;c.saveMetadataDebounced?.();}`,
    '/scripts/world-info.js': `export const selected_world_info=[];export const world_info={};export const world_names=['linkage-fixture'];export const worldInfoCache=new Map();export function createWorldInfoEntry(name,data){let uid=0;while(data.entries[uid])uid++;const entry={uid,key:[],keysecondary:[],comment:'',content:'',constant:false,disable:false,position:0,order:100};data.entries[uid]=entry;return entry;}export async function loadWorldInfo(name){return await(await fetch('/api/worldinfo/get',{method:'POST',body:JSON.stringify({name})})).json();}`,
    '/scripts/bookmarks.js': `export async function branchChat(index){return window.fixtureBranch(index);}`,
    '/scripts/utils.js': `export function uuidv4(){return crypto.randomUUID();}`,
};
let worldbook = { entries: { 0: { uid: 0, comment: '受保护的原条目', content: 'KEEP ORIGINAL CONTENT', constant: false, disable: true, position: 4, order: 123 } } };
const worldbookWrites = [];
const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
    if (url.pathname.startsWith('/api/worldinfo/')) {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw || '{}');
        if (body.name !== 'linkage-fixture') { response.statusCode = 403; response.end(); return; }
        if (url.pathname.endsWith('/edit')) { worldbook = structuredClone(body.data); worldbookWrites.push(structuredClone(body)); }
        response.setHeader('content-type', 'application/json; charset=utf-8'); response.end(JSON.stringify(worldbook)); return;
    }
    if (url.pathname.startsWith('/api/')) { response.statusCode = 403; response.end('Real API calls are forbidden in this fixture'); return; }
    if (url.pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return; }
    if (routes[url.pathname]) { response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.end(routes[url.pathname]); return; }
    if (process.env.AMIN_SCROLL_BASELINE && url.pathname === '/apps/linkage/view.js') { response.setHeader('content-type','text/javascript');response.end(fs.readFileSync(process.env.AMIN_SCROLL_BASELINE));return; }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { response.statusCode = 403; response.end(); return; }
    try { response.setHeader('content-type', ({ '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' })[path.extname(file)] ?? 'text/javascript; charset=utf-8'); response.end(fs.readFileSync(file)); }
    catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], consoleErrors = [], checks = [], layouts = [], layoutIssues = [], functionalIssues = [], pending = new Map();
let socket, sequence = 0, evaluate, send;

async function fixture() {
    const listeners = new Map();
    window.ctx = { characterId: 0, characters: [{ name: '模拟向导', avatar: 'rp-fixture.png', data: { description: '隔离测试' } }], currentChat: 'rp-fixture', name1: '艾琳', name2: '向导',
        chat: [{ name: '艾琳', is_user: true, mes: '阿莉丝穿着旅行外套，与艾琳同行来到龙门市城门。', swipe_id: 0, extra: {} }, { name: '向导', is_user: false, mes: '山路通往青云宗，官道通往白沙镇。', swipe_id: 0, extra: {} }],
        chatMetadata: { integrity: 'isolated-roadmap', world_info: 'linkage-fixture', protected: 'preserve', variables: { protected: 'keep', 状态栏: JSON.stringify({ 版本: 1, 项目: { 玩家: { 攻击修正: 2, 侦查: 65, 生命: { 当前: 8, 最大: 10 } }, 世界: { 地点: '龙门市' } } }) } },
        extensionSettings: { dynamicMapNamespace: 'rp-isolated-fixture', world_status_hud_v1: { floorButtons: true } }, saved: 0,
        getCurrentChatId() { return this.currentChat; }, async saveMetadata() { this.saved++; }, saveMetadataDebounced() { this.saved++; }, async saveChat() {}, saveSettingsDebounced() {}, setExtensionPrompt() {},
        eventTypes: Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'GENERATION_ENDED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_STOPPED', 'CHARACTER_MESSAGE_RENDERED', 'WORLDINFO_UPDATED', 'WORLDINFO_ENTRIES_LOADED', 'WORLD_INFO_ACTIVATED'].map(id => [id, id])),
        eventSource: { on(id, fn) { if (!listeners.has(id)) listeners.set(id, new Set()); listeners.get(id).add(fn); }, removeListener(id, fn) { listeners.get(id)?.delete(fn); }, off(id, fn) { listeners.get(id)?.delete(fn); }, async emit(id, ...args) { for (const fn of [...listeners.get(id) ?? []]) await fn(...args); } },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) };
    window.SillyTavern = { getContext: () => ctx }; window.toastr = { info() {}, error() {}, success() {} }; window.confirm = () => true;
    const characters = await import('/apps/characters/model.js');
    ctx.chatMetadata[characters.KEY] = characters.appendSnapshot(characters.emptyStore(), ctx.chat, { version: 1, characters: [
        { id: 'pc-a', name: '艾琳', kind: 'pc', notes: '远行者', stats: [{ id: 'hp', label: '生命', binding: '玩家.生命', component: 'current', check: 'd20' }, { id: 'attack', label: '攻击修正', binding: '玩家.攻击修正', component: 'value', check: 'd20' }, { id: 'spot', label: '侦查', binding: '玩家.侦查', component: 'value', check: 'coc' }] },
        { id: 'npc-b', name: '守卫', kind: 'npc', notes: '城门守卫', stats: [] } ] }, { id: 'seed-characters' });
    const scene = await import('/apps/scene/model.js');
    ctx.chatMetadata[scene.KEY] = scene.appendEvent(scene.emptyStore(), ctx.chat, { ...scene.transition(scene.emptyState(), 'set-time', { clock: { year: 2026, month: 9, day: 23, hour: 8, minute: 0, calendarLabel: '调查日历' }, reason: '模拟起始时间' }), op: 'set-time' }, { eventId: 'seed-clock', at: new Date().toISOString() });
    const linkage = await import('/apps/linkage/policy.js');
    ctx.chatMetadata[linkage.KEY] = { ...linkage.emptyLinkageState(), enabled:true, modules:{characters:{enabled:true,read:true,write:false},journal:{enabled:true,read:true,write:false}} };
    const journal = await import('/apps/journal/model.js');
    ctx.chatMetadata[journal.KEY] = journal.change(journal.empty(), ctx.chat, 'create', { id: 'task-browser', kind: 'task', title: '浏览器任务验证', body: '确认行动奖励', goal: '验证明确配置', progress: 20, status: 'active', reward: '说明文本不能自动发放奖励', characterIds: ['pc-a'] });
    const { createDemoDocument } = await import('/apps/map/src/core/demo.js');
    const map = createDemoDocument(); map.maps.world.metadata.rules = { segmentDistance: 1, unit: '公里', methods: [{ id: 'walk', name: '步行', speed: 4 }] };
    for (const edge of map.maps.world.edges) edge.distance = 1;
    ctx.chatMetadata.dynamicMapV1 = { updatedAt: Date.now(), document: map };
    window.paint = () => document.getElementById('chat').replaceChildren(...ctx.chat.map((message, index) => { const row = document.createElement('article'); row.className = 'mes'; row.setAttribute('mesid', index); const block = document.createElement('div'); block.className = 'mes_block'; const text = document.createElement('p'); text.className = 'mes_text'; text.textContent = `${index + 1} · ${message.name}：${message.mes}`; block.append(text); row.append(block); return row; })); paint();
    window.visible = el => !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    window.pane = id => document.querySelector('.amin-app-pane[data-app="' + id + '"]');
    window.clickButton = async (id, label) => { const button = [...pane(id).querySelectorAll('button')].find(el => visible(el) && (el.textContent.trim() === label || el.getAttribute('aria-label') === label)); if (!button) throw Error('Missing ' + id + ' button: ' + label); if (button.disabled) throw Error('Disabled ' + id + ' button: ' + label); button.click(); await new Promise(resolve => setTimeout(resolve, 50)); };
    await import('/index.js'); await ctx.eventSource.emit('CHAT_CHANGED',ctx.currentChat);
    return true;
}
async function waitFor(expression, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(45); }
    throw Error('Timed out: ' + label + '; runtime errors: ' + errors.join('\n'));
}
const click = (id, label) => evaluate(`await clickButton(${JSON.stringify(id)},${JSON.stringify(label)})`);
const fill = (id, label, value) => evaluate(`fillField(${JSON.stringify(id)},${JSON.stringify(label)},${JSON.stringify(value)})`);
async function app(id) { await evaluate(`await AminOS.openApp(${JSON.stringify(id)})`); await waitFor(`!!pane(${JSON.stringify(id)})?.querySelector('.amin-app-page,.amin-dice,.amin-map')`, id + ' mount'); }
const expand = (id, label) => evaluate(`(()=>{const summary=[...pane(${JSON.stringify(id)}).querySelectorAll('summary')].find(el=>el.textContent.trim().startsWith(${JSON.stringify(label)}));if(!summary)throw Error('Missing details: '+${JSON.stringify(label)});summary.parentElement.open=true;})()`);
const setChecked = (id, label, checked) => evaluate(`(()=>{const input=findField(${JSON.stringify(id)},${JSON.stringify(label)});if(input.disabled)throw Error('Disabled checkbox: '+${JSON.stringify(label)});if(input.checked!==${checked})input.click();})()`);
const notice = id => evaluate(`pane(${JSON.stringify(id)}).innerText`);
const hp = () => evaluate('JSON.parse(ctx.chatMetadata.variables.状态栏).项目.玩家.生命.当前');
const readInventory = () => evaluate("(await import('/apps/inventory/model.js')).readInventory(ctx)");

async function helpers() {
    window.findField = (id, label) => {
        const field = [...pane(id).querySelectorAll('input,textarea,select')].find(el => visible(el) && (el.getAttribute('aria-label') === label || [...(el.labels ?? [])].some(wrap => {
            const copy = wrap.cloneNode(true); for (const control of copy.querySelectorAll('input,select,textarea,small')) control.remove();
            return copy.textContent.trim() === label;
        })));
        if (!field) throw Error('Missing ' + id + ' field: ' + label + '\n' + pane(id).innerText.slice(0,5000)); return field;
    };
    window.fillField = (id, label, value) => {
        const field = findField(id, label); if (field.disabled) throw Error('Disabled field: ' + label);
        field.value = value; if (field.value !== String(value)) throw Error('Unsupported value for ' + label + ': ' + value + '; available: ' + [...field.options ?? []].map(o => o.value));
        field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); return field.value;
    };
    window.fixtureBranches = 0;
    window.fixtureBranch = async index => {
        window.fixtureOriginalContext = ctx; window.fixtureOriginalMetadata = structuredClone(ctx.chatMetadata);
        window.ctx = { ...ctx, currentChat: 'linkage-fixture-branch-' + (++fixtureBranches), chat: structuredClone(ctx.chat.slice(0, index + 1)), chatMetadata: structuredClone(ctx.chatMetadata) };
        paint(); await ctx.eventSource.emit('CHAT_CHANGED'); return ctx.currentChat;
    };
}

async function recordLayout(id, width, label, focus = '') {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await waitFor(`document.querySelector('.amin-drawer').getBoundingClientRect().width<=${width}+1`, 'drawer resize ' + width);
    await delay(110); await evaluate(`pane(${JSON.stringify(id)}).scrollTo(0,0)`);
    if (focus) await evaluate(`pane(${JSON.stringify(id)}).querySelector(${JSON.stringify(focus)})?.scrollIntoView({block:'start'})`);
    const layout = await evaluate(`(()=>{const p=pane(${JSON.stringify(id)}),rect=p.getBoundingClientRect(),controls=[...p.querySelectorAll('button,input,select,textarea,summary')].filter(visible).map(el=>{const r=(el.matches('input[type=checkbox],input[type=radio]')?el.closest('label'):el)?.getBoundingClientRect();return {label:el.getAttribute('aria-label')||el.textContent.trim().slice(0,50)||el.type,height:r?.height??0,width:r?.width??0}});return {width:innerWidth,documentScroll:document.documentElement.scrollWidth,paneClient:p.clientWidth,paneScroll:p.scrollWidth,left:rect.left,right:rect.right,controls,small:controls.filter(c=>c.height<43.9)};})()`);
    layouts.push({ app: id, label, ...layout });
    if (layout.documentScroll > width + 1 || layout.paneScroll > layout.paneClient + 1 || layout.left < -1 || layout.right > width + 1) layoutIssues.push({ label, reason: 'horizontal overflow', layout });
    if (width < 600 && layout.small.length) layoutIssues.push({ label, reason: 'touch controls under 44px', controls: layout.small });
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(artifacts, label + '.png'), Buffer.from(image.data, 'base64'));
}
async function layoutsAt(id, label, focus = '') { for (const width of [1280, 390]) await recordLayout(id, width, label + '-' + width, focus); }
async function failIfNotice(id, expected) { assert.ok((await notice(id)).includes(expected), id + ': expected ' + expected + '\n' + await notice(id)); }

try {
    const portFile = path.join(profile, 'DevToolsActivePort'); for (let n = 0; n < 100 && !fs.existsSync(portFile); n++) await delay(100);
    if (!fs.existsSync(portFile)) throw Error('Edge debugger failed to start.');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0], pages = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(7000) })).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Debugger socket timeout')), 7000); socket.onopen = () => { clearTimeout(timer); resolve(); }; socket.onerror = event => { clearTimeout(timer); reject(event.error || Error('Debugger socket failed')); }; });
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id) { const job = pending.get(message.id); pending.delete(message.id); clearTimeout(job?.timer); message.error ? job?.reject(Error(JSON.stringify(message.error))) : job?.resolve(message.result); }
        else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
        else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '));
    };
    send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Debugger timeout: ' + method + ' ' + String(params.expression ?? '').slice(0,120))); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    evaluate = async expression => { const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true }); if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result.value; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' }); await waitFor('document.readyState==="complete"', 'fixture HTML');
    await evaluate('(' + fixture.toString() + ')()'); await evaluate('(' + helpers.toString() + ')()');
    await waitFor('!!globalThis.AminOS&&document.querySelectorAll(".amin-extra-floor").length>=8', 'all app registration');



    await app('characters');
    assert.ok((await notice('characters')).includes('人物关联总览'));
    await layoutsAt('characters','character-overview');
    checks.push('character overview renders with selected character');
    await app('effects'); await click('effects','行动结算');
    await fill('effects','行动模板','healing'); await click('effects','填入模板到当前草稿');
    assert.equal(await evaluate("findField('effects','行动名称').value"),'治疗');
    await fill('effects','目标属性','0');
    await fill('effects','目标增减（治疗填正数，伤害填负数）','1');
    await layoutsAt('effects','action-form');
    const beforeHp=await hp(); await click('effects','预览行动结算');
    assert.equal(await hp(),beforeHp);
    await layoutsAt('effects','action-preview');
    await click('effects','确认行动结算'); assert.equal(await hp(),beforeHp+1);
    checks.push('action preview no mutation; confirmed heal applies once');
    await click('effects','返回行动结算');
    await expand('effects','关联任务与奖励');
    await fill('effects','关联任务','task-browser'); await fill('effects','任务结算状态','completed');
    await setChecked('effects','确认发放本次配置的任务奖励',true); await click('effects','添加奖励项');
    const rewardIndex = await evaluate("[...findField('effects','奖励 1 的资源').options].find(o=>o.textContent.includes('攻击修正')).value");
    await fill('effects','奖励 1 的资源',rewardIndex); await fill('effects','奖励 1 的数量','2');
    await layoutsAt('effects','task-reward-form','details');
    const stateBeforeReward=await evaluate('JSON.stringify(ctx.chatMetadata.variables)');
    await click('effects','预览行动结算');
    assert.equal(await evaluate('JSON.stringify(ctx.chatMetadata.variables)'),stateBeforeReward);
    await layoutsAt('effects','task-reward-preview');
    await click('effects','确认行动结算');
    assert.equal(await evaluate('JSON.parse(ctx.chatMetadata.variables.状态栏).项目.玩家.攻击修正'),4);
    assert.ok((await notice('effects')).includes('行动已结算'));
    assert.equal(await evaluate("(await import('/apps/journal/model.js')).currentEntries(ctx.chatMetadata.amin_os_journal_v1,ctx.chat).find(t=>t.id==='task-browser')?.status"),'completed');
    await click('effects','返回行动结算'); await expand('effects','关联任务与奖励'); await fill('effects','关联任务','task-browser');
    assert.equal(await evaluate("findField('effects','确认发放本次配置的任务奖励').disabled"),true);
    checks.push('healing template fills draft; task reward preview does not write; confirm completes task and applies explicit reward once; claimed reward disabled');
    await app('journal');
    for(const label of ['任务','线索']) {
      await click('journal',label); await click('journal','新增'+label);
      await layoutsAt('journal',label==='任务'?'task-form':'clue-form');
      await click('journal','取消编辑');
    }
    checks.push('task and clue editors render');
    await app('status');
    await evaluate("[...pane('status').querySelectorAll('button')].find(b=>b.textContent==='联动更新').click()");
    await waitFor("!!pane('status').querySelector('.amin-linkage')",'linkage page');
    await evaluate("pane('status').querySelectorAll('.amin-linkage details').forEach(d=>d.open=true)");
    await setChecked('status','启用条目级资料筛选',true);
    const firstEntry=await evaluate("[...findField('status','固定资料条目').options].find(o=>o.value)?.value");
    assert.ok(firstEntry,'visible read-enabled entry catalog');
    await fill('status','固定资料条目',firstEntry); await click('status','固定选中条目');
    assert.ok((await notice('status')).includes('已固定 1 项'));
    await layoutsAt('status','entry-selection-pinned-draft','input[aria-label="启用条目级资料筛选"]');
    await click('status','保存联动设置');
    await evaluate("pane('status').querySelectorAll('.amin-linkage details').forEach(d=>d.open=true)");
    assert.equal(await evaluate("findField('status','启用条目级资料筛选').checked"),true);
    await fill('status','固定资料条目',firstEntry); await click('status','取消固定选中条目');
    assert.ok((await notice('status')).includes('尚未固定单独条目'));
    await click('status','保存联动设置');
    await evaluate("pane('status').querySelectorAll('.amin-linkage details').forEach(d=>d.open=true)");
    await layoutsAt('status','linkage-budget-diagnostics','.amin-linkage');
    checks.push('entry selection pin/unpin controls persist; report and controls fit desktop and 390px');
    checks.push('linkage budget and update diagnostics render');
    await evaluate(`AminOS.openApp('settings')`); await waitFor(`!!pane('settings')?.querySelector('nav')`,'settings mount'); await click('settings','剧情存储');
    await click('settings','开始测量'); await click('settings','停止测量');
    await layoutsAt('settings','storage-performance');
    checks.push('storage index controls and performance start stop render');
    await app('relationships');
    await send('Emulation.setDeviceMetricsOverride', { width:390, height:900, deviceScaleFactor:1, mobile:true });
    await waitFor("!![...pane('relationships').querySelectorAll('button')].find(b=>b.textContent==='展开关系图')", 'mobile list first');
    await layoutsAt('relationships','relationship-list');
    await evaluate(`(async()=>{
      const {renderRelationshipGraph}=await import('/apps/relationships/graph.js');
      const people=Array.from({length:32},(_,i)=>({id:'p'+i,name:'人物'+i,kind:'npc'}));
      const edges=people.slice(1).map((p,i)=>({id:'e'+i,fromId:'p0',toId:p.id,type:'长关系说明'.repeat(15)+i}));
      const result=renderRelationshipGraph(document,people,edges);
      pane('relationships').querySelector('.amin-relationships').replaceChildren(result.element);
      const picker=result.element.querySelector('select');picker.value='3';picker.dispatchEvent(new Event('change'));
      if(!result.element.querySelector('[data-selected="true"]'))throw Error('selection not highlighted');
    })()`);
    await layoutsAt('relationships','relationship-dense-graph');
    await evaluate(`(async()=>{
      const {renderRelationshipGraph}=await import('/apps/relationships/graph.js');
      const people=Array.from({length:12},(_,i)=>({id:'p'+i,name:'人物'+i,kind:i?'npc':'pc'}));
      const edges=[{id:'a',fromId:'p0',toId:'p2',type:'信任'}, {id:'b',fromId:'p0',toId:'p4',type:'长期合作的同伴'}, {id:'c',fromId:'p3',toId:'p5',type:'师徒'}];
      window.renderFocused=layout=>{const result=renderRelationshipGraph(document,people,edges,{layout,focusId:'p0'});pane('relationships').querySelector('.amin-relationships').replaceChildren(result.element);if(result.graph.nodes.length!==12||!result.element.querySelector('[data-emphasis="muted"]'))throw Error('focus removed context');};
      renderFocused('map');
    })()`);
    await layoutsAt('relationships','relationship-focused-map');
    await evaluate("renderFocused('ring')");
    await layoutsAt('relationships','relationship-focused-ring');
    await evaluate("renderFocused('network')");
    await layoutsAt('relationships','relationship-focused-network');
    await evaluate(`(()=>{const root=pane('relationships'),node=root.querySelector('[data-person-id="p0"]'),before=node.getAttribute('transform'),rect=node.getBoundingClientRect();const fire=(type,x,y)=>node.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:19,clientX:x,clientY:y,button:0}));node.setPointerCapture=()=>{};fire('pointerdown',rect.x+24,rect.y+24);fire('pointermove',rect.x+54,rect.y+54);fire('pointerup',rect.x+54,rect.y+54);if(node.getAttribute('transform')===before)throw Error('network drag did not move');})()`);

    checks.push('mobile list first; dense graph scrolls without overflow and selected relation detail wraps');
    assert.deepEqual(errors,[]); assert.deepEqual(consoleErrors,[]);
    assert.deepEqual(layoutIssues,[]);
    fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,checks,layouts,layoutIssues,runtimeErrors:errors,consoleErrors},null,2));
    console.log('PASS '+checks.length+' checks / '+layouts.length+' layouts');
    await send('Browser.close').catch(()=>{});
} catch (error) {
    let ui = null; try { ui = await evaluate("[...document.querySelectorAll('.amin-app-pane')].filter(visible).map(p=>({app:p.dataset.app,text:p.innerText.slice(0,80000)}))"); } catch {}
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ passed: false, error: String(error), checks, layouts, layoutIssues, functionalIssues, runtimeErrors: errors, consoleErrors, worldbookWrites: worldbookWrites.length, ui }, null, 2));
    try { const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(artifacts, 'failure.png'), Buffer.from(screenshot.data, 'base64')); } catch {}
    throw error;
} finally { socket?.close(); child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
