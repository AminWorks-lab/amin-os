// Isolated Chromium integration checks. No real chat, credentials, or model calls.
// Run: node scripts/rp-browser-smoke.mjs (AMIN_BROWSER / AMIN_RP_ARTIFACTS optional).
// Set AMIN_FLOOR_ONLY=1 for toolbar interactions or AMIN_TILE_ONLY=1 for tile grid/colors.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {checkFloorToolbar} from './floor-toolbar-browser-checks.mjs';
import {checkTileGrid,tileFixtureSeed} from './tile-grid-browser-checks.mjs';

const root = process.env.AMIN_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.AMIN_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const artifacts = process.env.AMIN_RP_ARTIFACTS || path.resolve(root, '../rp-browser-smoke');
for (const id of ['characters', 'inventory', 'relationships', 'saves']) if (!fs.existsSync(path.join(root, 'apps', id, 'view.js'))) throw Error('Missing app view: ' + id);
if (!fs.existsSync(executable)) throw Error('Set AMIN_BROWSER to a Chromium executable.');
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, 'profile-'));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>html,body{margin:0;min-width:0;background:#10191e;color:#e0e9e5;font:14px/1.6 system-ui,sans-serif}*{box-sizing:border-box}main{width:100%;max-width:1000px;padding:12px;margin:auto}.mes{margin-bottom:16px;min-width:0}.mes_block,.mes_text{min-width:0}.mes_text{padding:8px}#send_textarea{display:block;width:100%;min-height:90px}#send_form{margin-top:18px}[hidden]{display:none!important}</style></head><body><main><h1>Amin OS · 隔离模拟宿主</h1><div id="chat"></div><form id="send_form" onsubmit="return false"><label for="send_textarea">行动草稿</label><textarea id="send_textarea"></textarea><button type="button" id="send_but">模拟发送</button></form></main></body></html>`;
const routes = {
    '/scripts/variables.js': `export function setLocalVariable(key,value){const c=globalThis.SillyTavern.getContext();c.chatMetadata.variables??={};c.chatMetadata.variables[key]=value;c.saveMetadataDebounced?.();}`,
    '/scripts/world-info.js': `export const selected_world_info=[];export const world_info={};export const world_names=[];export function loadWorldInfo(){throw Error('No external worldbooks in fixture');}`,
    '/scripts/utils.js': `export function uuidv4(){return crypto.randomUUID();}`,
};
const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return; }
    if (routes[url.pathname]) { response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.end(routes[url.pathname]); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { response.statusCode = 403; response.end(); return; }
    try { response.setHeader('content-type', ({ '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' })[path.extname(file)] ?? 'text/javascript; charset=utf-8'); response.end(fs.readFileSync(file)); }
    catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], checks = [], layouts = [], pending = new Map();
let socket, sequence = 0, evaluate, send;

async function fixture() {
    const listeners = new Map();
    window.ctx = { characterId: 0, characters: [{ name: '模拟向导', avatar: 'rp-fixture.png', data: { description: '隔离测试' } }], currentChat: 'rp-fixture', name1: '艾琳', name2: '向导',
        chat: [{ name: '艾琳', is_user: true, mes: '来到龙门市城门。', swipe_id: 0, extra: {} }, { name: '向导', is_user: false, mes: '山路通往青云宗，官道通往白沙镇。', swipe_id: 0, extra: {} }],
        chatMetadata: { protected: 'preserve', variables: { protected: 'keep', 状态栏: JSON.stringify({ 版本: 1, 项目: { 玩家: { 攻击修正: 2, 侦查: 65, 生命: { 当前: 8, 最大: 10 } }, 世界: { 地点: '龙门市' } } }) } },
        extensionSettings: { dynamicMapNamespace: 'rp-isolated-fixture', world_status_hud_v1: { floorButtons: true } }, saved: 0,
        getCurrentChatId() { return this.currentChat; }, async saveMetadata() { this.saved++; }, saveMetadataDebounced() { this.saved++; }, async saveChat() {}, saveSettingsDebounced() {}, setExtensionPrompt() {},
        eventTypes: Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'GENERATION_ENDED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_STOPPED', 'CHARACTER_MESSAGE_RENDERED'].map(id => [id, id])),
        eventSource: { on(id, fn) { if (!listeners.has(id)) listeners.set(id, new Set()); listeners.get(id).add(fn); }, removeListener(id, fn) { listeners.get(id)?.delete(fn); }, off(id, fn) { listeners.get(id)?.delete(fn); }, async emit(id, ...args) { for (const fn of [...listeners.get(id) ?? []]) await fn(...args); } },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) };
    window.SillyTavern = { getContext: () => ctx }; window.toastr = { info() {}, error() {}, success() {} }; window.confirm = () => true;
    const characters = await import('/apps/characters/model.js');
    ctx.chatMetadata[characters.KEY] = characters.appendSnapshot(characters.emptyStore(), ctx.chat, { version: 1, characters: [
        { id: 'pc-a', name: '艾琳', kind: 'pc', notes: '远行者', stats: [{ id: 'attack', label: '攻击修正', binding: '玩家.攻击修正', component: 'value', check: 'd20' }, { id: 'spot', label: '侦查', binding: '玩家.侦查', component: 'value', check: 'coc' }] },
        { id: 'npc-b', name: '守卫', kind: 'npc', notes: '城门守卫', stats: [] } ] }, { id: 'seed-characters' });
    const scene = await import('/apps/scene/model.js');
    ctx.chatMetadata[scene.KEY] = scene.appendEvent(scene.emptyStore(), ctx.chat, { ...scene.transition(scene.emptyState(), 'set-time', { clock: { year: 2026, month: 9, day: 23, hour: 8, minute: 0, calendarLabel: '调查日历' }, reason: '模拟起始时间' }), op: 'set-time' }, { eventId: 'seed-clock', at: new Date().toISOString() });
    const { createDemoDocument } = await import('/apps/map/src/core/demo.js');
    const map = createDemoDocument(); map.maps.world.metadata.rules = { segmentDistance: 1, unit: '公里', methods: [{ id: 'walk', name: '步行', speed: 4 }] };
    for (const edge of map.maps.world.edges) edge.distance = 1;
    ctx.chatMetadata.dynamicMapV1 = { updatedAt: Date.now(), document: map };
    const library = await import('/apps/effects/library.js'); ctx.extensionSettings[library.LIBRARY_KEY] = { ...library.emptyLibrary(), skills: [{ id: 'shield', name: '护盾', book: '自定义能力', entryId: 'shield', custom: true, original: '获得护盾，持续时间由使用者确认。', reminder: '护盾仍在保护使用者，直到其明确时限结束。', ui: { group: '防护', targetMode: 'direct', icon: '◇', size: 'medium', tone: 'soft', scope: '身体', condition: '持续到游戏时间到期', command: '获得保护' } }] };
    window.paint = () => document.getElementById('chat').replaceChildren(...ctx.chat.map((message, index) => { const row = document.createElement('article'); row.className = 'mes'; row.setAttribute('mesid', index); const block = document.createElement('div'); block.className = 'mes_block'; const text = document.createElement('p'); text.className = 'mes_text'; text.textContent = `${index + 1} · ${message.name}：${message.mes}`; block.append(text); row.append(block); return row; })); paint();
    window.visible = el => !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    window.pane = id => document.querySelector('.amin-app-pane[data-app="' + id + '"]');
    window.clickButton = async (id, label) => { const button = [...pane(id).querySelectorAll('button')].find(el => visible(el) && (el.textContent.trim() === label || el.getAttribute('aria-label') === label)); if (!button) throw Error('Missing ' + id + ' button: ' + label); if (button.disabled) throw Error('Disabled ' + id + ' button: ' + label); button.click(); await new Promise(resolve => setTimeout(resolve, 50)); };
    window.fillField = (id, label, value) => { const parent = pane(id), field = [...parent.querySelectorAll('input,textarea,select')].find(el => visible(el) && (el.getAttribute('aria-label') === label || el.labels?.[0]?.firstElementChild?.textContent === label)); if (!field) throw Error('Missing ' + id + ' field: ' + label + ' | Pane: ' + parent.innerText.slice(0, 1800)); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); return field.value; };
    if(window.tileFixtureSeed)(await import('/tile-layout.js')).saveTiles(localStorage,window.tileFixtureSeed);
    await import('/index.js');
    return true;
}
async function waitFor(expression, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(45); }
    throw Error('Timed out: ' + label + '; runtime errors: ' + errors.join('\n'));
}
const click = (id, label) => evaluate(`clickButton(${JSON.stringify(id)},${JSON.stringify(label)})`);
const fill = (id, label, value) => evaluate(`fillField(${JSON.stringify(id)},${JSON.stringify(label)},${JSON.stringify(value)})`);
async function app(id) { await evaluate(`AminOS.openApp(${JSON.stringify(id)})`); await waitFor(`!!pane(${JSON.stringify(id)})?.querySelector('.amin-app-page,.amin-dice,.amin-map')`, id + ' mount'); }
async function recordLayout(id, width, label) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await waitFor(`document.querySelector('.amin-drawer').getBoundingClientRect().width<=${width}+1`, 'drawer resize at '+width).catch(async error=>{throw Error(error.message+' '+await evaluate("JSON.stringify({width:innerWidth,client:document.documentElement.clientWidth,vv:visualViewport.width,scale:visualViewport.scale,drawer:document.querySelector('.amin-drawer').style.cssText})"));});
    await delay(110); await evaluate(`pane(${JSON.stringify(id)}).scrollTo(0,0)`);
    if (label.includes('-editor-')) await evaluate(`pane(${JSON.stringify(id)}).querySelector(${JSON.stringify(id === 'relationships' ? '.amin-relationship-editor' : '.amin-card')}).scrollIntoView({block:'start'})`);
    if (label.includes('-graph-')) await evaluate(`pane(${JSON.stringify(id)}).querySelector('.amin-relationships-graph-scroll').scrollIntoView({block:'start'})`);
    const layout = await evaluate(`(()=>{const p=pane(${JSON.stringify(id)}),rect=p.getBoundingClientRect(),controls=[...p.querySelectorAll('button,input,select,textarea')].filter(visible).map(el=>{const r=(el.matches('input[type=checkbox],input[type=radio]')?el.closest('label'):el)?.getBoundingClientRect();return {label:el.getAttribute('aria-label')||el.textContent.trim().slice(0,35)||el.type,height:r?.height??0}});return {width:innerWidth,documentScroll:document.documentElement.scrollWidth,paneClient:p.clientWidth,paneScroll:p.scrollWidth,left:rect.left,right:rect.right,controls,small:controls.filter(c=>c.height<43.9)};})()`);
    layouts.push({ app: id, label, ...layout });
    assert.ok(layout.documentScroll <= width + 1, label + ' document overflow: ' + JSON.stringify(layout));
    assert.ok(layout.paneScroll <= layout.paneClient + 1, label + ' pane overflow: ' + JSON.stringify(layout));
    assert.ok(layout.left >= -1 && layout.right <= width + 1, label + ' pane outside screen');
    if (width < 600) assert.deepEqual(layout.small, [], label + ' touch controls under 44px');
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(artifacts, label + '.png'), Buffer.from(image.data, 'base64'));
}
try {
    const portFile = path.join(profile, 'DevToolsActivePort'); for (let n = 0; n < 100 && !fs.existsSync(portFile); n++) await delay(100);
    if (!fs.existsSync(portFile)) throw Error('Edge debugger failed to start.');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0], pages = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(7000) })).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Debugger socket timeout')), 7000); socket.onopen = () => { clearTimeout(timer); resolve(); }; socket.onerror = event => { clearTimeout(timer); reject(event.error || Error('Debugger socket failed')); }; });
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id) { const job = pending.get(message.id); pending.delete(message.id); clearTimeout(job?.timer); message.error ? job?.reject(Error(JSON.stringify(message.error))) : job?.resolve(message.result); } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text); };
    send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Debugger timeout: ' + method + ' ' + String(params.expression ?? '').slice(0, 120))); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    evaluate = async expression => { const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true }); if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result.value; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' }); await waitFor('document.readyState==="complete"', 'fixture HTML'); if(process.env.AMIN_TILE_ONLY==='1')await evaluate('window.tileFixtureSeed='+JSON.stringify(tileFixtureSeed));await evaluate('(' + fixture.toString() + ')()');
    await waitFor('!!globalThis.AminOS&&document.querySelectorAll(".amin-extra-floor").length>=8', 'all app registration');
    console.log('Fixture ready; checking real app interactions.');
    if(process.env.AMIN_TILE_ONLY==='1') {
        await checkTileGrid({send,evaluate,waitFor,delay,artifacts,checks});
    } else if(process.env.AMIN_FLOOR_ONLY==='1') {
        await checkFloorToolbar({send,evaluate,waitFor,delay,artifacts,checks});
    } else {

    await app('characters'); await click('characters', '新增人物卡'); await fill('characters', '人物名称', '浏览器新增 NPC'); await fill('characters', '人物类型', 'npc'); await fill('characters', '人物备注', '可安全删除的模拟记录'); await click('characters', '保存人物卡');
    assert.equal(await evaluate("(await import('/apps/characters/model.js')).readCharacters(ctx).characters.length"), 3);
    await click('characters', '编辑人物卡'); await fill('characters', '人物名称', '浏览器已编辑 NPC'); await click('characters', '保存人物卡'); await click('characters', '删除人物卡'); await click('characters', '确认删除人物');
    assert.equal(await evaluate("(await import('/apps/characters/model.js')).readCharacters(ctx).characters.length"), 2);
    await fill('characters', '当前人物', 'pc-a'); await click('characters', '修改 攻击修正'); await fill('characters', '新的数值', '4'); await click('characters', '预览数值变更'); assert.equal(await evaluate('JSON.parse(ctx.chatMetadata.variables.状态栏).项目.玩家.攻击修正'), 2); await click('characters', '确认更新世界状态');
    assert.equal(await evaluate('JSON.parse(ctx.chatMetadata.variables.状态栏).项目.玩家.攻击修正'), 4);
    await click('characters', '检定 攻击修正'); await click('characters', '执行本地检定'); await click('characters', '追加固定结果到草稿'); assert.ok(await evaluate("document.getElementById('send_textarea').value.includes('艾琳')")); assert.equal(await evaluate('ctx.chat.length'), 2); await click('characters', '返回人物卡');
    checks.push('Characters: create/edit/delete, canonical status value preview+confirm, local fixed dice append without sending');

    await evaluate("AminOS.openApp('status')"); await waitFor("!!document.querySelector('.wsh-workbench iframe')?.contentDocument?.getElementById('mode')", 'status iframe');
    assert.equal(await evaluate("ctx.chatMetadata.world_status_hud_history_v1.records[ctx.chat.at(-1).extra.wsh_message_id+':0'].state.项目.玩家.攻击修正"), 4);
    for (const width of [1280, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
        await evaluate("AminOS.openApp('status')");
        await waitFor("!!pane('status').querySelector('iframe')?.contentDocument?.getElementById('mode')", 'embedded status ready');
        assert.equal(await evaluate("!document.querySelector('.amin-drawer').hidden&&!pane('status').hidden&&!!pane('status').querySelector('.amin-status-embedded')"), true, 'OS entry stays inside the OS at '+width);
        assert.equal(await evaluate("document.querySelectorAll('.wsh-floor-host .wsh-workbench').length"), 0);
        await recordLayout('status', width, 'status-os-'+width);
        await evaluate("document.querySelector('.amin-launcher').click();document.querySelector('.amin-launcher').click()");
        await waitFor("!!pane('status').querySelector('iframe')?.contentDocument?.getElementById('mode')", 'launcher reopens embedded status');
        assert.equal(await evaluate("!document.querySelector('.amin-drawer').hidden&&!pane('status').hidden"), true);
        await evaluate('AminOS.close();AminOS.open()');
        await waitFor("!!pane('status').querySelector('.amin-status-embedded')", 'API reopens embedded status');
        await evaluate("AminOS.close();document.querySelector('[mesid=\"1\"] .wsh-floor-button').click()");
        await waitFor("!!document.querySelector('[mesid=\"1\"] .wsh-workbench iframe')?.contentDocument?.getElementById('mode')", 'floor entry opens floor editor');
        assert.equal(await evaluate("document.querySelector('.amin-drawer').hidden"), true, 'floor entry does not open OS');
        await evaluate("AminOS.openApp('status')");
        await waitFor("!!pane('status').querySelector('.amin-status-embedded')", 'return from floor to OS');
        assert.equal(await evaluate("document.querySelector('[mesid=\"1\"] .wsh-floor-button').getAttribute('aria-expanded')"), 'false');
        await evaluate("pane('status').querySelector('#wsh-display-tab').click();pane('status').querySelector('#wsh-display-page input[type=checkbox]').click()");
        await evaluate("AminOS.openApp('status')");
        assert.equal(await evaluate("!document.querySelector('.amin-drawer').hidden&&!!pane('status').querySelector('.amin-status-embedded')"), true, 'OS works with floor buttons hidden: '+await evaluate("JSON.stringify({hidden:document.querySelector('.amin-drawer').hidden,pane:pane('status').innerHTML,notice:document.querySelector('.amin-notice').textContent})"));
        await evaluate("pane('status').querySelector('#wsh-display-page input[type=checkbox]').click();pane('status').querySelector('#wsh-state-tab').click()");
        await evaluate("Promise.all([AminOS.openApp('status'),AminOS.openApp('dice')])");
        assert.equal(await evaluate("!document.querySelector('.amin-drawer').hidden&&!pane('dice').hidden"), true, 'status load does not close another application');
        assert.ok(await evaluate("document.querySelectorAll('.wsh-workbench').length<=1"), 'no duplicate editor after concurrent app switch');
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    checks.push('World status has OS and floor entries; OS launcher/API resume stays embedded, floor controls stay independent, hidden floor buttons do not disable OS, desktop/mobile layouts pass');
    checks.push('Character status update is adopted by current world-status history before reopening the actual status iframe');

    await app('inventory'); await click('inventory', '登记新物品'); await fill('inventory', '物品名称', '治疗药剂'); await fill('inventory', '所属人物', 'pc-a'); await fill('inventory', '数量', '3'); await fill('inventory', '变更原因', '旅途补给'); await click('inventory', '预览保存物品'); assert.equal(await evaluate('ctx.chatMetadata.amin_os_inventory_v1'), undefined); await click('inventory', '确认操作');
    await click('inventory', '消耗'); await fill('inventory', '操作数量', '1'); await fill('inventory', '变更原因', '治疗伤势'); await click('inventory', '预览消耗物品'); await click('inventory', '确认操作');
    assert.equal(await evaluate("(await import('/apps/inventory/model.js')).readInventory(ctx).items[0].quantity"), 2);
    await click('inventory', '资源与货币'); await click('inventory', '登记资源账户'); await fill('inventory', '资源名称', '金币'); await fill('inventory', '所属人物', 'pc-a'); await fill('inventory', '当前余额', '20'); await fill('inventory', '单位（可选）', '枚'); await fill('inventory', '变更原因', '初始余额'); await click('inventory', '预览保存资源'); await click('inventory', '确认操作'); await click('inventory', '物品');
    checks.push('Inventory: item and resource creation require preview+confirm; consumption updates quantity and ledger');

    await app('relationships'); await click('relationships', '新增人物关系'); await fill('relationships', '关系类型', '信任'); await fill('relationships', '关系标签（可选）', '并肩调查'); await fill('relationships', '强度（可选）', '0'); await fill('relationships', '关系备注（可选）', '用户确认的有向关系'); await click('relationships', '预览保存关系'); assert.equal(await evaluate('ctx.chatMetadata.amin_os_relationships_v1'), undefined); await click('relationships', '确认应用一次');
    assert.equal(await evaluate("(await import('/apps/relationships/model.js')).readRelationships(ctx).relationships.length"), 1);
    await evaluate("pane('relationships').querySelector('.amin-relationship-person').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    assert.equal(await evaluate("pane('relationships').querySelector('[aria-label=\"聚焦人物\"]').value"), 'pc-a');
    checks.push('Relationships: directed graph and keyboard focus, accessible relation list, explicit zero strength, preview+confirm');

    await app('effects'); await fill('effects', '选择能力', 'shield'); await click('effects', '发动所选能力'); await fill('effects', '计时方式', 'set'); await fill('effects', '持续时长', '5');
    await evaluate("pane('effects').querySelector('.amin-ability-check').open=true"); await fill('effects', '检定人物', 'pc-a'); await fill('effects', '绑定属性 / 技能', 'attack'); await click('effects', '预览检定'); await click('effects', '确认本地掷骰'); await click('effects', '追加固定结果到草稿');
    await evaluate("const check=pane('effects').querySelector('.amin-ability-check .amin-check input');check.checked=true;check.dispatchEvent(new Event('change',{bubbles:true}))"); await click('effects', '确认检定后的效果');
    assert.equal(await evaluate("(await import('/apps/effects/model.js')).activeEffects((await import('/apps/effects/model.js')).readStore(ctx),ctx.chat).length"), 1);
    checks.push('Ability check: character binding -> preview -> fixed local roll -> append -> separate explicit timed effect confirmation');

    await app('scene'); await click('scene', '旅行'); await click('scene', '选择目的地'); await click('scene', '预览旅行'); assert.equal(await evaluate('ctx.chatMetadata.dynamicMapV1.document.maps.world.currentLocation'), 'longmen_city');
    assert.ok(await evaluate("pane('scene').textContent.includes('护盾')")); await click('scene', '确认旅行一次');
    assert.equal(await evaluate('ctx.chatMetadata.dynamicMapV1.document.maps.world.currentLocation'), 'qingyun_sect');
    assert.equal(await evaluate("(await import('/apps/scene/model.js')).readCurrentScene(ctx).clock.minute"), 15);
    assert.equal(await evaluate("(await import('/apps/effects/model.js')).contextExpiryPreview(ctx,(await import('/apps/scene/model.js')).readCurrentScene(ctx).clock).newlyExpired.length"), 0);
    await app('effects'); await click('effects', '生效中'); assert.ok(await evaluate("pane('effects').textContent.includes('已到期')"));
    checks.push('Travel: actual map envelope route preview, 15-minute confirmed map/time/scene update, 5-minute effect expiry shown');

    await app('saves'); await fill('saves', '存档名称', '浏览器出发后存档'); await fill('saves', '备注（可选）', '含人物、背包、关系、地图、时钟、限时效果与固定骰点'); await click('saves', '创建存档');
    assert.equal(await evaluate('ctx.chatMetadata.amin_os_saves_v1.saves.length'), 1);
    await app('inventory'); await click('inventory', '消耗'); await fill('inventory', '操作数量', '1'); await fill('inventory', '变更原因', '存档后变更'); await click('inventory', '预览消耗物品'); await click('inventory', '确认操作');
    await app('saves'); await click('saves', '预览恢复'); assert.equal(await evaluate("(await import('/apps/inventory/model.js')).readInventory(ctx).items[0].quantity"), 1); await click('saves', '确认恢复到当前楼层');
    assert.equal(await evaluate("(await import('/apps/inventory/model.js')).readInventory(ctx).items[0].quantity"), 2); assert.equal(await evaluate('ctx.chatMetadata.amin_os_saves_v1.backups.length'), 1); assert.equal(await evaluate('ctx.chat.length'), 2); assert.equal(await evaluate('ctx.chatMetadata.protected'), 'preserve'); assert.equal(await evaluate('ctx.chatMetadata.variables.protected'), 'keep');
    await click('saves', '导出 JSON'); assert.ok(await evaluate("pane('saves').querySelector('[aria-label=\"存档 JSON\"]').value.includes('amin-os-save')")); await click('saves', '剧情存档');
    checks.push('Saves: named multi-app snapshot -> later item change -> preview/restore with pre-restore backup, JSON export, chat and unrelated data preserved');

    for (const id of ['characters', 'inventory', 'relationships', 'saves']) {
        await app(id);
        for (const width of [1280, 320, 390, 430]) await recordLayout(id, width, id + '-' + width);
    }
    await app('characters'); await click('characters', '新增人物卡'); for (const width of [320, 390, 430]) await recordLayout('characters', width, 'characters-editor-' + width); await click('characters', '取消编辑');
    await app('relationships'); await recordLayout('relationships', 320, 'relationships-graph-320'); await click('relationships', '新增人物关系'); for (const width of [320, 390, 430]) await recordLayout('relationships', width, 'relationships-editor-' + width); await click('relationships', '取消编辑');
    checks.push('New four app overview layouts at 1280/320/390/430 and character/relation forms at 320/390/430: no document or pane horizontal overflow; mobile controls >=44px');

    await evaluate('AminOS.close()');
    for (const [id, title] of [['characters', '人物卡'], ['inventory', '背包与账本'], ['relationships', '人物关系'], ['saves', '跨应用存档']]) {
        for (let cycle = 0; cycle < 2; cycle++) {
            await evaluate(`(()=>{const button=[...document.querySelector('[mesid="1"]').querySelectorAll('button')].find(el=>el.title==='打开当前聊天的'+${JSON.stringify(title)});if(!button)throw Error('No floor button '+${JSON.stringify(id)});button.click();})()`);
            await waitFor(`!!document.querySelector('[mesid="1"] .amin-extra-floor-window .amin-${id}')`, id + ' floor open');
            assert.equal(await evaluate(`document.querySelectorAll('[mesid="1"] .amin-extra-floor-window .amin-${id}').length`), 1);
            assert.ok(await evaluate("[...document.querySelectorAll('[mesid=\"1\"] .amin-extra-floor-window')].some(el=>el.textContent.includes('不是历史楼层快照'))"));
            await evaluate("document.querySelector('[mesid=\"1\"] .amin-extra-floor-window .amin-reply-floor-header button').click()");
            assert.equal(await evaluate("document.querySelectorAll('[mesid=\"1\"] .amin-extra-floor-window').length"), 0);
        }
    }
    checks.push('Each new app floor window opens/closes/reopens exactly once and labels current-chat scope honestly');
    await evaluate("AminOS.close();ctx.chat=[];ctx.chatMetadata={variables:{}};ctx.currentChat='empty-status-fixture';document.getElementById('chat').replaceChildren();ctx.eventSource.emit('CHAT_CHANGED')");
    await evaluate("AminOS.openApp('status')");
    await waitFor("!!pane('status').querySelector('iframe')?.contentDocument?.getElementById('mode')", 'empty chat status');
    await evaluate("window.emptyStatusPanel=pane('status').querySelector('.wsh-workbench');ctx.chat.push({is_user:true,name:'艾琳',mes:'第一条消息',extra:{}});document.getElementById('chat').innerHTML='<div class=mes mesid=0><div class=mes_block><div class=mes_text>第一条消息</div><div class=mes_buttons></div></div></div>';ctx.eventSource.emit('MESSAGE_SENT',0)");
    await waitFor("!!document.querySelector('[mesid=\"0\"] .wsh-floor-button')", 'first message floor mounted');
    await evaluate("ctx.eventSource.emit('CHARACTER_MESSAGE_RENDERED',0)");
    assert.equal(await evaluate("!document.querySelector('.amin-drawer').hidden&&pane('status').contains(emptyStatusPanel)&&emptyStatusPanel.isConnected"), true, 'first message retains the existing OS workbench');
    assert.equal(await evaluate("document.querySelectorAll('.wsh-floor-host .wsh-workbench').length"), 0);
    checks.push('Empty chat opens inside OS and first message/render retains the same workbench without floor migration');
    }
    assert.deepEqual(errors, [], 'uncaught browser runtime errors');
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ passed: true, environment: 'Headless Edge with isolated mock SillyTavern host; emulated viewport, no real host/model/phone', checks, layouts, runtimeErrors: errors }, null, 2));
    console.log('PASS RP browser smoke: ' + checks.join('; ') + '.'); console.log('Artifacts: ' + artifacts);
    await send('Browser.close').catch(() => {});
} catch (error) {
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ passed: false, error: String(error), checks, layouts, runtimeErrors: errors }, null, 2));
    throw error;
} finally { socket?.close(); child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
