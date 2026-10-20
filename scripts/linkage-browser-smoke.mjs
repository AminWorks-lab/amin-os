// Isolated Chromium integration checks. No real chat, credentials, or model calls.
// Run: node scripts/linkage-browser-smoke.mjs (AMIN_BROWSER / AMIN_LINKAGE_ARTIFACTS optional).
// Host APIs/worldbook storage are isolated; all Amin OS services and writes are real.
// AMIN_LINKAGE_HOST_ONLY=1 runs only the short host-event/preview-stability regression.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = process.env.AMIN_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.AMIN_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const artifacts = process.env.AMIN_LINKAGE_ARTIFACTS || path.resolve(root, '../linkage-browser-smoke');
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
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { response.statusCode = 403; response.end(); return; }
    try { response.setHeader('content-type', ({ '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' })[path.extname(file)] ?? 'text/javascript; charset=utf-8'); response.end(fs.readFileSync(file)); }
    catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], consoleErrors = [], checks = [], layouts = [], layoutIssues = [], functionalIssues = [], pending = new Map();
const hostOnly = process.env.AMIN_LINKAGE_HOST_ONLY === '1';
let socket, sequence = 0, evaluate, send;

async function fixture() {
    const listeners = new Map();
    window.ctx = { characterId: 0, characters: [{ name: '模拟向导', avatar: 'rp-fixture.png', data: { description: '隔离测试' } }], currentChat: 'rp-fixture', name1: '艾琳', name2: '向导',
        chat: [{ name: '艾琳', is_user: true, mes: '来到龙门市城门。', swipe_id: 0, extra: {} }, { name: '向导', is_user: false, mes: '山路通往青云宗，官道通往白沙镇。', swipe_id: 0, extra: {} }],
        chatMetadata: { world_info: 'linkage-fixture', protected: 'preserve', variables: { protected: 'keep', 状态栏: JSON.stringify({ 版本: 1, 项目: { 玩家: { 攻击修正: 2, 侦查: 65, 生命: { 当前: 8, 最大: 10 } }, 世界: { 地点: '龙门市' } } }) } },
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
    const { createDemoDocument } = await import('/apps/map/src/core/demo.js');
    const map = createDemoDocument(); map.maps.world.metadata.rules = { segmentDistance: 1, unit: '公里', methods: [{ id: 'walk', name: '步行', speed: 4 }] };
    for (const edge of map.maps.world.edges) edge.distance = 1;
    ctx.chatMetadata.dynamicMapV1 = { updatedAt: Date.now(), document: map };
    const library = await import('/apps/effects/library.js'); ctx.extensionSettings[library.LIBRARY_KEY] = { ...library.emptyLibrary(), skills: [{ id: 'shield', name: '护盾', book: '自定义能力', entryId: 'shield', custom: true, original: '获得护盾，持续时间由使用者确认。', reminder: '护盾仍在保护使用者，直到其明确时限结束。', ui: { group: '防护', targetMode: 'direct', icon: '◇', size: 'medium', tone: 'soft', scope: '身体', condition: '持续到游戏时间到期', command: '获得保护' } }] };
    window.paint = () => document.getElementById('chat').replaceChildren(...ctx.chat.map((message, index) => { const row = document.createElement('article'); row.className = 'mes'; row.setAttribute('mesid', index); const block = document.createElement('div'); block.className = 'mes_block'; const text = document.createElement('p'); text.className = 'mes_text'; text.textContent = `${index + 1} · ${message.name}：${message.mes}`; block.append(text); row.append(block); return row; })); paint();
    window.visible = el => !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    window.pane = id => document.querySelector('.amin-app-pane[data-app="' + id + '"]');
    window.clickButton = async (id, label) => { const button = [...pane(id).querySelectorAll('button')].find(el => visible(el) && (el.textContent.trim() === label || el.getAttribute('aria-label') === label)); if (!button) throw Error('Missing ' + id + ' button: ' + label); if (button.disabled) throw Error('Disabled ' + id + ' button: ' + label); button.click(); await new Promise(resolve => setTimeout(resolve, 50)); };
    await import('/index.js');
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
const notice = id => evaluate(`pane(${JSON.stringify(id)}).innerText.slice(0,9000)`);
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
async function layoutsAt(id, label, focus = '') { for (const width of [1280, 320, 390]) await recordLayout(id, width, label + '-' + width, focus); }
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
    console.log('Fixture ready; testing real linked application writes.');

    if (!hostOnly) {
    await app('characters'); await fill('characters', '当前人物', 'pc-a'); await click('characters', '编辑人物卡');
    await fill('characters', '发型', '束起的短发'); await fill('characters', '外貌特征', '左眉有旧疤'); await click('characters', '保存人物卡');
    assert.equal(await evaluate("(await import('/apps/characters/model.js')).readCharacters(ctx).characters.find(p=>p.id==='pc-a').appearance.hairstyle"), '束起的短发');
    await app('inventory'); await click('inventory', '登记新物品'); await fill('inventory', '物品名称', '蓝色旅行外套'); await fill('inventory', '所属人物', 'pc-a');
    await fill('inventory', '数量', '1'); await setChecked('inventory', '已装备', true); await fill('inventory', '穿戴部位', 'torso'); await fill('inventory', '穿戴层次', 'outer');
    await fill('inventory', '衣物外观', '铜扣与宽翻领'); await fill('inventory', '变更原因', '出发前穿上');
    await layoutsAt('inventory', 'inventory-wear-editor'); await click('inventory', '预览保存物品'); assert.equal((await readInventory()).items.length, 0); await click('inventory', '确认操作');
    const coatId = (await readInventory()).items[0].id;
    await click('inventory', '物品状态'); await fill('inventory', '湿润程度（0–100）', '20'); await fill('inventory', '物品状态说明', '袖口潮湿'); await fill('inventory', '变更原因', '雨中赶路');
    await click('inventory', '预览物品状态'); assert.equal((await readInventory()).items[0].condition.wetness, 0); await click('inventory', '确认操作');
    await app('characters'); await failIfNotice('characters', '蓝色旅行外套'); await failIfNotice('characters', '湿润 20/100'); await layoutsAt('characters', 'character-appearance');
    await click('characters', '资产与穿戴'); await waitFor("!pane('inventory').hidden&&pane('inventory').querySelector('[aria-label=\"筛选所属人物\"]')?.value==='pc-a'", 'stable character link to wear');
    checks.push('Real appearance/item UI writes: one canonical equipped item, condition preview before confirm, character appearance reflects same item ID and stable-ID app link');
    console.log('PASS appearance / inventory.');

    await app('relationships'); await click('relationships', '新增人物关系'); await fill('relationships', '关系类型', '信任'); await fill('relationships', '强度（可选）', '0'); await click('relationships', '预览保存关系'); await click('relationships', '确认应用一次');
    const relationshipId = await evaluate("(await import('/apps/relationships/model.js')).readRelationships(ctx).relationships[0].id");
    await expand('relationships', '关系阈值与提醒记录'); await click('relationships', '新增阈值规则'); await fill('relationships', '阈值所属关系', relationshipId); await fill('relationships', '阈值数值', '5'); await fill('relationships', '阈值提醒内容', '可以进一步调查信任变化');
    await layoutsAt('relationships', 'relationship-threshold-editor'); await click('relationships', '预览保存阈值'); await click('relationships', '确认应用一次');
    await click('relationships', '编辑关系'); await fill('relationships', '强度（可选）', '6'); await fill('relationships', '本次调整依据（可选）', '共同完成城门调查'); await click('relationships', '预览保存关系'); await click('relationships', '确认应用一次');
    await failIfNotice('relationships', '可以进一步调查信任变化'); await layoutsAt('relationships', 'relationship-threshold-alert');
    checks.push('Relationship and threshold UI writes: explicit zero strength, previewed rule, crossing from 0 to 6 emits threshold reminder without fabricating an event');
    console.log('PASS relationships.');

    await app('journal'); await click('journal', '事实与记忆'); await click('journal', '新增事实'); await fill('journal', '事实标题', '城门夜间封闭'); await fill('journal', '事实内容', '守卫确认城门在午夜关闭。'); await fill('journal', '来源说明', '本次城门调查'); await click('journal', '保存事实');
    const factId = await evaluate("(await import('/apps/journal/model.js')).currentEntries((await import('/apps/journal/model.js')).readStore(ctx),ctx.chat).find(e=>e.kind==='fact').id");
    await click('journal', '新增人物记忆'); await fill('journal', '人物', 'pc-a'); await fill('journal', '关联事实', factId); await fill('journal', '认知状态', 'rumor'); await fill('journal', '可信程度（0–100）', '70'); await fill('journal', '人物理解或传闻内容（可选）', '听说午夜之后不能进入'); await fill('journal', '从谁得知', 'npc-b');
    await layoutsAt('journal', 'journal-memory-editor'); await click('journal', '保存人物记忆');
    assert.equal(await evaluate("(await import('/apps/journal/model.js')).memoryEntries(ctx,{characterId:'pc-a'})[0].confidence"), 70);
    await layoutsAt('journal', 'journal-facts-memory');
    await app('characters'); await click('characters', '人物记忆'); await waitFor("!pane('journal').hidden&&pane('journal').querySelector('[aria-label=\"筛选人物记忆\"]')?.value==='pc-a'", 'character memory link');
    checks.push('Journal fact and character knowledge UI: stable fact/person/source IDs, rumor confidence, source floor binding, person card links to its memory filter');
    console.log('PASS facts / memory.');

    await app('scene'); await click('scene', '日程'); await fill('scene', '人物卡', 'npc-b'); await fill('scene', '日程名称', '上午城门执勤'); await fill('scene', '开始时间', '08:00'); await fill('scene', '结束时间', '12:00'); await fill('scene', '预计地点', JSON.stringify(['world','longmen_city']));
    await layoutsAt('scene', 'scene-npc-schedule-editor'); await click('scene', '预览保存日程'); assert.equal(await evaluate("(await import('/apps/scene/model.js')).readCurrentScene(ctx).schedules.length"), 0); await click('scene', '确认应用一次');
    assert.equal(await evaluate("(await import('/apps/scene/model.js')).readCurrentScene(ctx).schedules[0].characterId"), 'npc-b');
    await failIfNotice('scene', '尚未确认为剧情事实'); assert.equal(await evaluate('ctx.chatMetadata.dynamicMapV1.document.maps.world.currentLocation'), 'longmen_city');
    await layoutsAt('scene', 'scene-npc-schedule');
    checks.push('NPC schedule UI: stable person and discovered-map IDs, preview before save, expected position visible without moving map or asserting actual presence');
    console.log('PASS NPC schedule.');

    await app('effects'); await click('effects', '生效中'); await click('effects', '建立生效记录'); await fill('effects', '技能', 'shield'); await fill('effects', '持有者', '艾琳'); await fill('effects', '作用层面', '雨中寒冷');
    await fill('effects', '持续或解除条件', '直到进入温暖住所'); await expand('effects', '叠加与周期规则'); await fill('effects', '状态叠加方式', 'independent'); await fill('effects', '状态类型编号', 'cold'); await fill('effects', '周期结算规则', 'set'); await fill('effects', '每隔多少游戏分钟结算', '10'); await fill('effects', '周期操作对象', JSON.stringify(['pc-a','hp'])); await fill('effects', '每周期增减量（负数为消耗）', '-2');
    await layoutsAt('effects', 'effects-periodic-editor'); await click('effects', '确认保存'); await failIfNotice('effects', '周期结算');
    await app('scene'); await click('scene', '时钟'); await fill('scene', '推进量', '20'); await fill('scene', '原因', '雨中等待守卫'); await click('scene', '推进时间'); assert.equal(await hp(), 8);
    await app('effects'); await click('effects', '周期结算'); await click('effects', '预览全部周期结算'); assert.equal(await hp(), 8); await layoutsAt('effects', 'effects-periodic-preview'); await click('effects', '确认结算'); assert.equal(await hp(), 4);
    if (await evaluate("(await import('/apps/effects/service.js')).getSharedService().dirty()")) {
        functionalIssues.push({ feature: 'effect settlement persistence', notice: await notice('effects') });
        await click('effects', '重试保存');
    }
    assert.equal(await evaluate("(await import('/apps/effects/service.js')).getSharedService().dirty()"), false, 'effect settlement persistence/retry: ' + await notice('effects'));
    assert.ok(await evaluate("![...pane('effects').querySelectorAll('button')].some(b=>b.textContent==='预览全部周期结算'&&!b.disabled)"), 'settled cycles cannot be charged twice');
    checks.push('Periodic effects UI: configured real character HP binding, 20-minute scene advance, explicit two-cycle preview, one atomic settlement from HP 8 to 4, no repeat debit');
    console.log('PASS effects settlement.');

    await app('saves'); await click('saves', '楼层检查点'); await fill('saves', '自动检查点保留数量', '3'); await click('saves', '预览检查点设置'); await click('saves', '确认检查点设置'); await click('saves', '立即记录当前楼层');
    assert.equal(await evaluate('ctx.chatMetadata.amin_os_saves_v1.checkpointSettings.limit'), 3);
    const checkpoint = await evaluate('ctx.chatMetadata.amin_os_saves_v1.checkpoints.at(-1)');
    assert.ok(checkpoint.modules.characters&&checkpoint.modules.inventory&&checkpoint.modules.journal&&checkpoint.modules.scene&&checkpoint.modules.effects);
    await layoutsAt('saves', 'saves-floor-checkpoints');
    checks.push('Checkpoint UI: previewed per-chat retention setting, real current-floor capture includes character, item, memory, schedule and effects modules');
    console.log('PASS checkpoints.');

    await evaluate("AminOS.openApp('status')"); await waitFor("!!pane('status')?.querySelector('#wsh-linkage-tab')", 'linkage tab'); await click('status', '联动更新');
    await setChecked('status', '启用统一联动更新', true); await fill('status', '额外联动规则', '仅更新正文已经明确发生的变化。'); await click('status', '保存联动设置');
    await setChecked('status', '场景、时间与日程 · 提供资料给模型', false);
    assert.equal(await evaluate("findField('status','场景、时间与日程 · 允许模型更新').checked"), false); await click('status', '保存联动设置');
    assert.equal(await evaluate("(await import('/apps/linkage/service.js')).getSharedService().prompt().includes('\"scene\": {')"), false, 'disabled read removes scene data from unified prompt');
    await setChecked('status', '场景、时间与日程 · 允许模型更新', true);
    assert.equal(await evaluate("findField('status','场景、时间与日程 · 提供资料给模型').checked"), true); await click('status', '保存联动设置');
    assert.equal(await evaluate("findField('status','固定骰点 · 允许模型更新').disabled"), true, 'dice result permission remains read-only');
    await expand('status', '统一世界书条目与预览'); await click('status', '安装／更新统一条目');
    assert.equal(worldbookWrites.length, 1); assert.equal(worldbook.entries[0].content, 'KEEP ORIGINAL CONTENT'); assert.equal(Object.values(worldbook.entries).filter(e=>e.amin_os_linkage_owner==='amin-os/linkage-v1').length, 1);
    await click('status', '检查绑定世界书'); await click('status', '安装／更新统一条目'); assert.equal(worldbookWrites.length, 1, 'reinstall is idempotent');
    const prompt = await evaluate("findField('status','统一条目预览内容').value"); assert.ok(prompt.includes('仅更新正文已经明确发生的变化。')); assert.ok(prompt.includes('pc-a')&&prompt.includes(coatId));
    await layoutsAt('status', 'linkage-settings-worldbook');
    await recordLayout('status',320,'linkage-worldbook-template-320','.amin-linkage > details:has([aria-label="统一条目预览内容"])');
    await expand('status', '手动导入更新建议');
    const batch = { version: 1, changes: [
        { module: 'status', action: 'set', target: '玩家.生命', data: { component: 'current', value: 10 }, reason: '治疗完成' },
        { module: 'inventory', action: 'set-condition', target: coatId, data: { condition: { wetness: 35 } }, reason: '雨水浸湿外套' },
        { module: 'characters', action: 'set-appearance', target: 'pc-a', data: { hairstyle: '雨中打湿的短发' }, reason: '雨中赶路' }
    ] };
    await fill('status', '待校验的统一更新内容', JSON.stringify(batch,null,2)); await click('status', '校验并预览粘贴内容');
    await failIfNotice('status', '确认整组更新一次'); assert.equal(await hp(), 4); assert.equal((await readInventory()).items[0].condition.wetness, 20);
    await layoutsAt('status', 'linkage-cross-app-batch-preview');
    await expand('status', '查看更新前后的完整资料'); await recordLayout('status', 320, 'linkage-batch-expanded-details-320', '.amin-linkage-change details');
    await click('status', '确认整组更新一次');
    if (await evaluate("(await import('/apps/linkage/service.js')).getSharedService().dirty()")) {
        functionalIssues.push({ feature: 'cross-app batch persistence', notice: await notice('status') });
        await click('status', '重试保存整组更新');
    }
    assert.equal(await evaluate("(await import('/apps/linkage/service.js')).getSharedService().dirty()"), false, 'cross-app batch persistence/retry');
    assert.equal(await hp(), 10); assert.equal((await readInventory()).items[0].condition.wetness, 35); assert.equal(await evaluate("(await import('/apps/characters/model.js')).readCharacters(ctx).characters.find(p=>p.id==='pc-a').appearance.hairstyle"), '雨中打湿的短发');
    assert.equal(await evaluate("!document.querySelector('.amin-drawer').hidden&&!pane('status').hidden"), true, 'confirm leaves OS workbench open');
    await app('characters'); await failIfNotice('characters', '湿润 35/100'); await failIfNotice('characters', '雨中打湿的短发');
    checks.push('Unified worldbook UI: single inert template installed via mock host storage, original entry protected, repeat install idempotent; actual three-module preview/confirm atomically updates status HP, canonical item condition and character appearance');
    console.log('PASS unified worldbook / cross-app batch.');

    await evaluate("AminOS.openApp('status')"); await click('status', '联动更新'); await expand('status', '跨应用引用检查');
    if (await evaluate("!!pane('status').querySelector('[aria-label=\"关联来源条目\"]')")) {
        await fill('status', '关联来源条目', 'characters:pc-a'); await fill('status', '关联目标条目', 'inventory:' + coatId); await fill('status', '关联说明', '旅途中一直穿着的外套'); await click('status', '保存新关联');
        await failIfNotice('status', '旅途中一直穿着的外套'); await layoutsAt('status', 'linkage-manual-reference','.amin-linkage > details:has([aria-label="关联来源条目"])');
        assert.equal(await evaluate("(await import('/apps/linkage/service.js')).getSharedService().settings().links.length"), 1);
        checks.push('Manual cross-app reference saved through real UI between existing person/item stable IDs');
    } else throw Error('Manual reference editor missing: actual saveLinks service required');

    // Host branch creation is mocked; checkpoint validation/restoration is the actual service.
    await app('saves'); await click('saves', '楼层检查点'); await click('saves', '立即记录当前楼层'); await delay(500);
    const branchCheckpointName = await evaluate('ctx.chatMetadata.amin_os_saves_v1.checkpoints.find(saved=>saved.source.floor===2).name');
    await evaluate("ctx.chat.push({name:'向导',is_user:false,mes:'来到下一处场景。',swipe_id:0,extra:{}});paint();ctx.eventSource.emit('MESSAGE_RECEIVED',2)"); await delay(500);
    await evaluate(`await (async()=>{const card=[...pane('saves').querySelectorAll('.amin-card')].find(card=>card.querySelector('h3')?.textContent===${JSON.stringify(branchCheckpointName)});const button=[...card?.querySelectorAll('button')??[]].find(button=>button.textContent==='从此处新开分支');if(!button||button.disabled)throw Error('Missing available old-floor branch button');button.click();await new Promise(resolve=>setTimeout(resolve,50));})()`);
    assert.equal(await evaluate('fixtureBranches'), 0); await click('saves', '确认新建并恢复分支');
    await waitFor('fixtureBranches===1', 'native host branch bridge'); assert.equal(await evaluate('ctx.chat.length'), 2); assert.equal(await evaluate('fixtureOriginalContext.chat.length'), 3);
    assert.equal(await evaluate('JSON.stringify(fixtureOriginalContext.chatMetadata)===JSON.stringify(fixtureOriginalMetadata)'), true, 'source chat metadata protected');
    assert.equal(await hp(), 10); assert.equal(await evaluate('ctx.chatMetadata.protected'), 'preserve'); assert.equal(await evaluate('ctx.chatMetadata.variables.protected'), 'keep');
    checks.push('Checkpoint new-branch UI: mock native branch API called once, actual restore keeps two-message checkpoint state, source three-message chat and unrelated metadata preserved');
    } else {
        await evaluate("await AminOS.openApp('status')"); await waitFor("!!pane('status')?.querySelector('#wsh-linkage-tab')", 'linkage tab'); await click('status', '联动更新');
        await setChecked('status', '启用统一联动更新', true); await click('status', '保存联动设置');
        await expand('status', '统一世界书条目与预览'); await click('status', '安装／更新统一条目');
    }

    // Exercise the actual host event integration without calling a model or mocking
    // Amin OS business logic. The fixture supplies only the host's generation events.
    await evaluate("await AminOS.openApp('status')"); await click('status', '联动更新');
    const liveEntry = { ...Object.values(worldbook.entries).find(entry => entry.amin_os_linkage_owner === 'amin-os/linkage-v1'), world: 'linkage-fixture' };
    await evaluate('window.fixtureOwnedEntry=' + JSON.stringify(liveEntry));
    await evaluate("await ctx.eventSource.emit('GENERATION_AFTER_COMMANDS','normal',{},false)");
    await evaluate("window.fixtureScan={characterLore:[structuredClone(fixtureOwnedEntry),{uid:101,world:'linkage-fixture',world_status_hud_owner:'world-status-hud/variable-update-v1',content:'old owned status update'}],globalLore:[structuredClone(fixtureOwnedEntry),{uid:102,world:'linkage-fixture',content:'hand written protected entry'}]};await ctx.eventSource.emit('WORLDINFO_ENTRIES_LOADED',fixtureScan)");
    assert.equal(await evaluate("[...fixtureScan.characterLore,...fixtureScan.globalLore].filter(e=>e.amin_os_linkage_owner&&!e.disable).length"), 1, 'one expanded entry across overlapping worldbook bindings');
    assert.equal(await evaluate("fixtureScan.characterLore[1].disable"), true, 'old Amin status update suppressed only during managed scan');
    assert.equal(await evaluate("fixtureScan.globalLore[1].content"), 'hand written protected entry');
    assert.ok(await evaluate("fixtureScan.characterLore[0].content.includes('pc-a')&&!fixtureScan.characterLore[0].content.includes('{{amin_os_linkage}}')"));
    assert.equal(Object.values(worldbook.entries).find(entry => entry.amin_os_linkage_owner).content, '{{amin_os_linkage}}', 'scan expansion never persists character data in shared book');
    await evaluate("await ctx.eventSource.emit('WORLD_INFO_ACTIVATED',structuredClone([...fixtureScan.characterLore,...fixtureScan.globalLore].filter(e=>!e.disable)))");
    const hostInitialHP = await hp(), hostTargetHP = hostInitialHP - 1;
    const receivedBatch = { version: 1, changes: [{ module: 'status', action: 'set', target: '玩家.生命', data: { component: 'current', value: hostTargetHP }, reason: '新的剧情已明确轻微擦伤' }] };
    await evaluate('ctx.chat.push({name:"向导",is_user:false,mes:' + JSON.stringify('经过城门时受到轻微擦伤。\n<amin_update>' + JSON.stringify(receivedBatch) + '</amin_update>') + ',swipe_id:0,extra:{},gen_finished:new Date().toISOString()});paint();await ctx.eventSource.emit("MESSAGE_RECEIVED",ctx.chat.length-1,"normal");await ctx.eventSource.emit("GENERATION_ENDED")');
    await waitFor("await (async()=> (await import('/apps/linkage/service.js')).getSharedService().suggestions().length===1)()", 'actual host update suggestion');
    assert.equal(await hp(), hostInitialHP, 'received story updates remain suggestions until confirmed'); await click('status', '校验并预览这组更新');
    const hostPreviewBasis = await evaluate('structuredClone(ctx.chatMetadata)');
    if (hostOnly) await delay(900); else await layoutsAt('status', 'linkage-host-reply-preview');
    const hostConfirmBasis = await evaluate('structuredClone(ctx.chatMetadata)');
    const changedPaths = (left, right, path = []) => {
        if (JSON.stringify(left) === JSON.stringify(right)) return [];
        if (left && right && typeof left === 'object' && typeof right === 'object') return [...new Set([...Object.keys(left),...Object.keys(right)])].flatMap(key=>changedPaths(left[key],right[key],[...path,key]));
        return [{ path, before: left, after: right }];
    };
    const hostChanges = changedPaths(hostPreviewBasis,hostConfirmBasis);
    fs.writeFileSync(path.join(artifacts,'host-basis-diagnostics.json'),JSON.stringify({changedPaths:hostChanges,preview:hostPreviewBasis,confirm:hostConfirmBasis},null,2));
    console.log('Host preview metadata changed paths: '+hostChanges.map(change=>change.path.join('.')).join(', '));
    await click('status', '确认整组更新一次'); assert.equal(await hp(), hostTargetHP);
    assert.equal(await evaluate("(await import('/apps/linkage/service.js')).getSharedService().dirty()"), false);
    checks.push('Actual host integration with simulated host events: runtime expansion once, managed legacy entry suppression, preserved manual entry/inert worldbook, complete reply captured as suggestion, real UI preview and save');

    assert.deepEqual(errors, [], 'uncaught browser runtime errors'); assert.deepEqual(consoleErrors, [], 'browser console errors'); assert.deepEqual(layoutIssues, [], 'responsive / touch target issues'); assert.deepEqual(functionalIssues, [], 'operations needed unexpected save recovery');
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ passed: true, environment: 'Real headless Edge; isolated mock SillyTavern host/branch/worldbook APIs; real Amin OS business services; emulated viewports, no real chat/model/phone', checks, layouts, layoutIssues, functionalIssues, runtimeErrors: errors, consoleErrors, worldbookWrites: worldbookWrites.length }, null, 2));
    console.log('PASS linkage browser smoke: ' + checks.join('; ') + '.'); console.log('Artifacts: ' + artifacts);
    await send('Browser.close').catch(() => {});
} catch (error) {
    let ui = null; try { ui = await evaluate("[...document.querySelectorAll('.amin-app-pane')].filter(visible).map(p=>({app:p.dataset.app,text:p.innerText.slice(0,14000)}))"); } catch {}
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ passed: false, error: String(error), checks, layouts, layoutIssues, functionalIssues, runtimeErrors: errors, consoleErrors, worldbookWrites: worldbookWrites.length, ui }, null, 2));
    try { const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(artifacts, 'failure.png'), Buffer.from(screenshot.data, 'base64')); } catch {}
    throw error;
} finally { socket?.close(); child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
