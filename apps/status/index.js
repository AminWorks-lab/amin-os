import { relocateStatus } from './relocate.js';
import { saveChatMetadata } from '../shared/chat-save.js';
import { uuid } from '../../uuid.js';
import { subscribeStateChanges, chatIdentity, captureContext, assertContext, acquireMetadataWrite } from '../shared/operations.js';
import {mountWorldbookSources} from '../worldbook-source-ui.js';
import {sourceSettings,saveSourceSettings} from '../worldbook-sources.js';
import { createMapLink } from './map-link.js';
import { compileRules, createRulesPage } from './rules.js';
import { createHistory } from './history.js';
import { historyView, installFloorButtons } from './history-ui.js';
import { createTemplatesPage, copyPrompt } from './templates.js';
import { buildUpdatePrompt } from './state-tools.js';
import { generateStatus } from './generator.js';
import './story-state.js';
import { isIndependent, readStoryRoot, writeStoryRoot, STATE_KEY, prepareIndependentManualWrite } from '../story-state/access.js';
import { mountGeneration } from '../generation/view.js';
import { openLinkage as openLinkageApp } from '../linkage/open.js';
import { attachLinkageBadge } from '../linkage/badge.js';
import { getSharedService as getLinkageService } from '../linkage/service.js';
import { managesModule, mayWrite } from '../linkage/policy.js';
import { buildDataPrompt, buildUpdateRules } from '../linkage/prompt.js';
import { getState2Runtime } from '../state2/runtime.js';
import { contextLine } from '../shared/context-line.js';

const KEY = 'world_status_hud_v1';
const context = () => SillyTavern.getContext();
let hostSetLocalVariable;
const setLocalVariable = (key, value) => isIndependent(context()) ? writeStoryRoot(context(), key, value) : hostSetLocalVariable(key, value);
let embeddedMount, activeIdentity;
export async function initialize({mount: target, loadVariables = () => import('/scripts/variables.js')} = {}) {
  if (!isIndependent(context())) {
    hostSetLocalVariable = (await loadVariables()).setLocalVariable;
    if (typeof hostSetLocalVariable !== 'function') throw Error('当前酒馆缺少变量写入接口。');
  }
  embeddedMount=target; mount(); return {open: openEmbedded};
}
async function openEmbedded(page = selectedPage){
  identity();
  if (!embeddedMount) { notify('世界状态应用窗口尚未就绪，请重新打开 Amin OS。'); return; }
  return showHud(page,{target:embeddedMount,embedded:true});
}
let running = null;
let hudPanel = null;
let hudEpoch = 0;
let generationForm, formHome, sourceHost, sourcePicker, sourceIdentity, restorePanel;
let selectedPage = 'state';
let selectHudPage = null;
let requestUpdate = null;
let openStatusUpdate = null;
let invalidateStatusFrame = null;
const linkageEnabled = () => managesModule(context(),'status');
function statusUpdateCopyPrompt() {
  const ctx = context();
  if (isIndependent(ctx)) {
    if (!mayWrite(ctx, 'status')) throw Error('请先在“联动更新”中启用世界状态、提供资料并允许模型更新，再复制更新提示词。');
    const protocol = buildUpdateRules(ctx);
    if (!protocol.trim()) throw Error('当前没有允许执行的 Amin 更新协议，请检查联动设置。');
    return [buildDataPrompt(ctx), protocol].filter(Boolean).join('\n\n');
  }
  return buildUpdatePrompt(readCurrent()) + '\n\n' + compileRules(ctx, KEY, 'update').replaceAll('<', '＜').replaceAll('>', '＞');
}
const defaults = { theme: 'nexus', floorButtons: true, allowTypeChange: false, includePersona: false, baseUrl: '', model: '', includeGlobalBooks: true, extraBooks: '', instructions: '', maxTokens: 4096 };
const getSettings = () => {const legacy={...defaults,...context().extensionSettings[KEY]};return {...legacy,...sourceSettings(context(),'status',{legacyBindings:true,includeGlobalBooks:legacy.includeGlobalBooks,extraBooks:legacy.extraBooks})};};
function refreshSourceControls(){
 if(!sourceHost)return;let id;try{id=identity();}catch{sourcePicker?.dispose();sourcePicker=null;sourceIdentity=null;sourceHost.textContent='请打开单角色聊天后选择世界书';return;}
 if(sourcePicker&&sourceIdentity?.metadata===id.metadata&&sourceIdentity?.id===id.id&&sourceIdentity?.avatar===id.avatar){void sourcePicker.refresh();return;}
 sourcePicker?.dispose();sourceHost.replaceChildren();sourceIdentity=id;sourcePicker=mountWorldbookSources(sourceHost,{context,value:getSettings()});
}
function node(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function notify(message, error = false) { window.toastr?.[error ? 'error' : 'info'](message, '世界状态栏'); }
function identity() {
  const c = context();
  if (c.groupId || !c.characters?.[c.characterId] || c.getCurrentChatId() == null) throw Error('请打开单角色聊天。');
  return { metadata: c.chatMetadata, avatar: c.characters[c.characterId].avatar, id: c.getCurrentChatId() };
}
function checkIdentity(i) {
  const n = identity();
  if (n.metadata !== i.metadata || n.id !== i.id || n.avatar !== i.avatar) throw Error('聊天已切换，请关闭并重新打开面板。');
}
function parseState(raw) {
  if (raw == null || raw === '') return null;
  const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!d || Array.isArray(d) || typeof d.项目 !== 'object' || !d.项目 || Array.isArray(d.项目)) throw Error('状态栏结构不兼容。');
  return d;
}
const history = createHistory({ context, read: () => parseState(readStoryRoot(context(), '状态栏')),
  externalRead: async () => parseState(readStoryRoot(context(),'状态栏')) });
const floorButtons = installFloorButtons({ history, node, context, enabled: () => getSettings().floorButtons,
  openWorkbench:(target,{page,onClose,validate})=>showHud(page,{target,onClose,validate}) });
async function persistStatusChange(write) {
  const token=captureContext(context),ctx=assertContext(context,token),release=acquireMetadataWrite(context,token);
  try {
    write();
    if(isIndependent(ctx)){writeStoryRoot(ctx,'状态栏',readStoryRoot(ctx,'状态栏'));prepareIndependentManualWrite(ctx,[['variables','状态栏']]);}
    const savedToken=captureContext(context);
    history.adoptExternal();
    await saveChatMetadata(ctx,{finalCheck:()=>assertContext(context,savedToken)});
    assertContext(context,savedToken);
  }
  finally { release(); }
}
function syncHistory() {
  try {
    history.sync(); floorButtons.refresh();
  } catch (e) { console.warn('[世界状态栏] 记录同步失败', e); }
}
function createDisplaySettings() {
  const page = node('section', undefined, 'wsh-generation-page');
  const label = node('label', '在楼层工具栏显示世界状态入口'); const input = node('input'); input.type = 'checkbox'; input.checked = getSettings().floorButtons;
  input.onchange = () => { context().extensionSettings[KEY] = { ...context().extensionSettings[KEY], floorButtons: input.checked }; context().saveSettingsDebounced(); floorButtons.refresh(); };
  const historyNote = isIndependent(context())
    ? '所有应用共用当前剧情资料；切换旧楼层或 Swipe 不回退资料。'
    : '旧版楼层记录仅供只读浏览；打开聊天或翻页不会写入新的楼层记录。';
  const storageNote = isIndependent(context())
    ? '最近备份在设置 → 剧情存储中管理，旧楼层没有单独状态快照。'
    : '导入旧资料或开始空白剧情资料后，状态随当前剧情资料保存。';
  label.append(input); page.append(node('h3', '显示与记录设置'), label, node('p', '最新楼层打开当前状态工作台，旧楼层打开只读记录。' + storageNote), node('p', historyNote));
  const appearanceLink=node('button','打开设置 · 统一外观','menu_button');appearanceLink.type='button';appearanceLink.onclick=()=>globalThis.AminOS?.openApp('settings');page.append(appearanceLink);
  return page;
}
function closeHud() {
  hudEpoch++;
  hudPanel?.close();
}
async function showHud(page = selectedPage, {target = embeddedMount, onClose = () => {}, validate = () => {}, embedded = false} = {}) {
  if (typeof page !== 'string') page = selectedPage;
  closeHud();
  const epoch = hudEpoch;
  const id = identity();
  validate();
  activeIdentity=id;
  const response = await fetch(new URL('./hud.html', import.meta.url));
  if (!response.ok) throw Error('无法加载状态栏界面。');
  let html = await response.text();
  if (epoch !== hudEpoch) return;
  checkIdentity(id);
  validate();
  const dialog = node('section', undefined, 'wsh-workbench wsh-floor-window amin-ui');
  dialog.dataset.placement=embedded ? 'os' : 'floor';
  dialog.setAttribute('aria-label','世界状态 · 当前状态工作台');
  const close = node('button', '收起', 'menu_button'); close.type='button';
  const heading = node('div', undefined, 'wsh-panel-heading');
  const title=node('strong','世界状态 · 当前剧情');title.title=context().characters[context().characterId].name+' · 当前状态工作台';
  heading.append(title);
  if (!embedded) heading.append(close);
  // In the OS window the window title already names the app; the context line carries chat and scope.
  heading.hidden = embedded;
  const contextNote = node('div', contextLine(context(), '当前剧情状态', '历史快照仅供浏览'), 'wsh-workbench-note amin-context');
  attachLinkageBadge(contextNote,'status',{getContext:context});
  const tabs = node('div', undefined, 'wsh-tabs'); tabs.setAttribute('role', 'tablist');
  const stateTab = node('button', '状态栏', 'wsh-tab');
  const generateTab = node('button', '生成设置', 'wsh-tab');
  const rulesTab = node('button', '状态规则', 'wsh-tab'); rulesTab.id = 'wsh-rules-tab';
  const historyTab = node('button', '楼层记录', 'wsh-tab'); historyTab.id = 'wsh-history-tab';
  const displayTab = node('button', '设置', 'wsh-tab'); displayTab.id = 'wsh-display-tab';
  const templateTab = node('button', '模板', 'wsh-tab'); templateTab.type = 'button'; templateTab.id = 'wsh-template-tab';
  stateTab.type = generateTab.type = 'button';
  stateTab.id = 'wsh-state-tab'; generateTab.id = 'wsh-generate-tab';
  const body = node('div', undefined, 'wsh-body');
  const generationPage = node('section', undefined, 'wsh-generation-page');
  generationPage.id = 'wsh-generation-page'; generationPage.setAttribute('role', 'tabpanel');
  generationPage.setAttribute('aria-labelledby', generateTab.id);
  // Own this draft editor per HUD. Closing/moving the workbench cancels it.
  const statusGeneration = mountGeneration(generationPage, { modules:['status'], getContext:() => { checkIdentity(id); validate(); return context(); }, instruction:getSettings().updateNote || '' });
  openStatusUpdate = () => statusGeneration.open();
  if (generationForm) generationPage.append(generationForm);
  refreshSourceControls();
  const readCurrent = () => { checkIdentity(id); validate(); return parseState(readStoryRoot(context(), '状态栏')); };
  const templatePage = createTemplatesPage({ context, settingsKey: KEY, read: readCurrent,
    write: async value => {
      checkIdentity(id); validate(); if (running) throw Error('模型任务运行中，请稍后应用模板。');
      const old = readStoryRoot(context(), '状态栏');
      await persistStatusChange(()=>{
        if (!isIndependent(context()) && old !== undefined) setLocalVariable('状态栏_生成前备份_' + Date.now(), old);
        setLocalVariable('状态栏', JSON.stringify(value));
      });
    }, isRunning: () => !!running, node });
  templatePage.id = 'wsh-template-page'; templatePage.setAttribute('role', 'tabpanel'); templatePage.setAttribute('aria-labelledby', templateTab.id);
  templateTab.setAttribute('aria-controls', templatePage.id);
  const frame = node('iframe');
  let readyHtml = '', frameLoaded = false;
  frame.id = 'wsh-state-page'; frame.setAttribute('role', 'tabpanel'); frame.setAttribute('aria-labelledby', stateTab.id);
  stateTab.setAttribute('aria-controls', frame.id); generateTab.setAttribute('aria-controls', generationPage.id);
  history.sync();
  const recordsView = historyView({ history, node });
  const historyPage = recordsView.element; historyPage.id = 'wsh-history-page';
  const rulesPage = createRulesPage({ context, settingsKey: KEY, node, check: () => {checkIdentity(id);validate();}, isUnified:linkageEnabled }); rulesPage.id = 'wsh-rules-page';
  const displayPage = createDisplaySettings(); displayPage.id = 'wsh-display-page';
  const linkageApi=getLinkageService();
  function refreshLegacyControls(){
    const enabled=linkageEnabled();
    rulesPage.refreshLinkageMode?.();
    for(const message of dialog.querySelectorAll('[data-linkage-ownership]'))message.textContent=enabled?'世界状态已由统一联动接管。更新规则请到“联动更新”中管理。':'世界状态未加入统一联动，聊天中不会自动更新；可用“按当前剧情更新值”手动更新。';
    for(const button of dialog.querySelectorAll('[data-linkage-quick-update]'))button.textContent='按现有剧情更新状态';
    for(const button of dialog.querySelectorAll('[data-linkage-quick-copy]'))button.textContent=isIndependent(context())?'复制 Amin 更新提示词':enabled?'查看统一更新提示词':'复制更新提示词';
  }
  const unsubscribeLinkage=linkageApi.subscribe(refreshLegacyControls);
  for (const [tab, page] of [[historyTab, historyPage], [displayTab, displayPage], [rulesTab, rulesPage]]) { tab.type = 'button'; tab.setAttribute('aria-controls', page.id); page.setAttribute('role', 'tabpanel'); page.setAttribute('aria-labelledby', tab.id); }
  rulesTab.onclick = () => selectPage('rules');
  historyTab.onclick = () => selectPage('history'); displayTab.onclick = () => selectPage('display');
  function selectPage(value) {
    contextNote.textContent = contextLine(context(), '当前剧情状态', '历史快照仅供浏览');
    if (value === undefined) value = selectedPage;
    selectedPage = ['generate', 'templates', 'history', 'display', 'rules'].includes(value) ? value : 'state';
    if (selectedPage === 'state' && readyHtml && !frameLoaded) { frame.srcdoc = readyHtml; frameLoaded = true; }
    rulesPage.hidden = selectedPage !== 'rules';
    historyPage.hidden = selectedPage !== 'history'; displayPage.hidden = selectedPage !== 'display';
    frame.hidden = selectedPage !== 'state'; generationPage.hidden = selectedPage !== 'generate'; templatePage.hidden = selectedPage !== 'templates';
    for (const [b, name] of [[stateTab, 'state'], [generateTab, 'generate'], [templateTab, 'templates'], [historyTab, 'history'], [displayTab, 'display'], [rulesTab, 'rules']]) {
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(selectedPage === name));
      b.tabIndex = selectedPage === name ? 0 : -1;
    }
  }
  stateTab.onclick = () => selectPage('state'); generateTab.onclick = () => selectPage('generate'); templateTab.onclick = () => selectPage('templates');
  tabs.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); const pages = ['state', 'generate', 'templates', 'rules', 'history', 'display']; const i = pages.indexOf(selectedPage);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? pages.length-1 : (i + (e.key === 'ArrowRight' ? 1 : pages.length-1)) % pages.length;
    selectPage(pages[j]); [stateTab, generateTab, templateTab, rulesTab, historyTab, displayTab][j].focus();
  });
  selectHudPage = selectPage; tabs.append(stateTab, generateTab, templateTab, rulesTab, historyTab, displayTab); body.append(frame, generationPage, templatePage, historyPage, displayPage, rulesPage); selectPage(page);
  frame.title = '世界状态栏编辑器';
  // Only the bundled frame may use this variable bridge; commands are allowlisted.
  const token = uuid();
  const bridge = `<script>
  window.WSH_CARD_KEY=${JSON.stringify(encodeURIComponent(context().characters[context().characterId].avatar || 'current'))};
  const token=${JSON.stringify(token)};let seq=0;const pending=new Map();
  window.STscript=command=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('连接超时，请重新打开面板。'))},15000);pending.set(id,{resolve,reject,timer});parent.postMessage({wsh:token,id,command},'*')});
  addEventListener('message',e=>{if(e.source!==parent||e.data?.wsh!==token)return;const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.value)});
  <\/script>`;
  html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-wsh-frame data-wsh-theme="nexus">');
  html = html.replace('</head>', '<link rel="stylesheet" href="' + new URL('./themes.css', import.meta.url).href + '"></head>');
  html=html.replace('</head>','<link rel="stylesheet" href="'+new URL('../../ui-status.css',import.meta.url).href+'"><link rel="stylesheet" href="'+new URL('../../settings/appearance-frame.css',import.meta.url).href+'"><link rel="stylesheet" href="'+new URL('../../ui/standard.css',import.meta.url).href+'"><link rel="stylesheet" href="'+new URL('./workbench-frame.css',import.meta.url).href+'"></head>');
  html = html.replace('<head>', '<head>' + bridge);
  const listener = async event => {
    if (event.source !== frame.contentWindow || event.data?.wsh !== token) return;
    const { command, id: requestId } = event.data;
    try {
      checkIdentity(id);
      validate();
      let value;
      if (command === '/getvar 状态栏') value = parseState(readStoryRoot(context(), '状态栏'));
      else if (typeof command === 'string' && command.startsWith('/amin-status-relocate ')) {
        if (running) throw Error('状态栏生成中，请完成后再编辑。');
        const operation = JSON.parse(command.slice('/amin-status-relocate '.length));
        let result = relocateStatus(parseState(readStoryRoot(context(), '状态栏')), isIndependent(context()) ? {} : id.metadata.LWB_RULES_V2, operation);
        let reloadRules;
        if (result.rulesChanged) {
          reloadRules = window.LWB_StateV2?.loadRulesFromMeta;
          if (typeof reloadRules !== 'function') throw Error('无法刷新小白变量规则，修改未执行。');
        }
        checkIdentity(id); validate();
        if (running) throw Error('状态栏生成中，请完成后再编辑。');
        result = relocateStatus(parseState(readStoryRoot(context(), '状态栏')), isIndependent(context()) ? {} : id.metadata.LWB_RULES_V2, operation);
        if (result.rulesChanged && !reloadRules) throw Error('变量规则已改变，请重试。');
        await persistStatusChange(() => {
          const oldState = readStoryRoot(context(), '状态栏'), oldRules = id.metadata.LWB_RULES_V2;
          try {
            setLocalVariable('状态栏', JSON.stringify(result.state));
            if (result.rulesChanged) { id.metadata.LWB_RULES_V2 = result.rules; reloadRules(); }
          } catch (error) {
            writeStoryRoot(context(), '状态栏', oldState);
            if (oldRules === undefined) delete id.metadata.LWB_RULES_V2;
            else id.metadata.LWB_RULES_V2 = oldRules;
            if (reloadRules) reloadRules();
            throw error;
          }
        });
        value = result.state;
      }
      else if (typeof command === 'string' && command.startsWith('/setvar key=状态栏 ')) {
        if (running) throw Error('状态栏生成中，请完成后再编辑。');
        value = parseState(command.slice('/setvar key=状态栏 '.length));
        if (!value) throw Error('不能写入空状态。');
        await persistStatusChange(()=>{setLocalVariable('状态栏', JSON.stringify(value));});
      } else throw Error('不支持的状态栏命令。');
      event.source.postMessage({ wsh: token, id: requestId, value }, '*');
    } catch (e) { event.source.postMessage({ wsh: token, id: requestId, error: e.message }, '*'); }
  };
  addEventListener('message', listener);
  let closed=false;
  dialog.close=()=>{if(closed)return;closed=true;recordsView.dispose();statusGeneration.dispose();unsubscribeLinkage();removeEventListener('message',listener);frame.srcdoc='';restorePanel?.remove();restorePanel=null;if(generationForm?.parentElement===generationPage)formHome?.append(generationForm);dialog.remove();mapLink.destroy();if(hudPanel===dialog){hudPanel=null;selectHudPage=null;openStatusUpdate=null;invalidateStatusFrame=null;}onClose();};
  close.onclick = closeHud;
  const quickActions = node('div', undefined, 'wsh-actions');
  const quickStatus = node('p', '', 'wsh-quick-status'); quickStatus.setAttribute('role', 'status');
  const update = node('button', '按现有剧情更新状态', 'menu_button amin-primary'); update.type = 'button'; update.title='选择已有聊天楼层，生成建议并确认后更新当前状态值';
  update.dataset.linkageQuickUpdate='true';
  update.onclick = async () => {
    try { checkIdentity(id); validate(); await requestUpdate(); quickStatus.textContent = '请选择剧情楼层并生成草稿，预览确认后才会保存。'; }
    catch (e) { quickStatus.textContent = e.message; }
  };
  const copy = node('button', '复制更新提示词', 'menu_button'); copy.type = 'button'; copy.title=isIndependent(context()) ? '复制当前 Amin 资料、模块权限与 amin_update 更新协议' : '复制当前状态、字段路径和模型更新要求';
  copy.dataset.linkageQuickCopy='true';
  copy.onclick = async () => {
    if(!isIndependent(context()) && linkageEnabled()){try{await openLinkageApp('prompt');}catch(e){quickStatus.textContent=e.message;}return;}
    try { checkIdentity(id); const text = statusUpdateCopyPrompt(); const ok = await copyPrompt(text,{mount:dialog}); quickStatus.textContent = ok ? isIndependent(context()) ? '已复制当前 Amin 资料与允许更新模块的 amin_update 协议，可粘贴到对话。' : '已复制当前变量、路径与更新要求，可粘贴到对话。' : '请在工作台下方的文本框中手动复制。'; }
    catch (e) { quickStatus.textContent = e.message; }
  };
  // Linkage settings live in their own app; this opens it instead of keeping a second copy here.
  const linkageSettings = node('button', '打开联动设置', 'menu_button'); linkageSettings.type = 'button';
  linkageSettings.onclick = () => openLinkageApp().catch(e => { quickStatus.textContent = e.message; });
  quickActions.append(update, copy, linkageSettings);
  const mapLink=createMapLink({check:()=>{checkIdentity(id);validate();}});
  dialog.append(heading, contextNote, tabs, quickActions, quickStatus, body);
  displayPage.append(mapLink.element);
  if(embedded)target.replaceChildren();
  target.append(dialog);
  if(embedded)dialog.classList.add('amin-status-embedded');
  hudPanel = dialog; readyHtml = html;
  invalidateStatusFrame=()=>{frameLoaded=false;if(selectedPage==='state')selectPage('state');};
  selectPage(selectedPage);refreshLegacyControls();
  return {element:dialog,selectPage,dispose:()=>dialog.close()};
}
async function restoreBackup() {
  if (running) throw Error('请先等待生成结束。');
  const id = identity();
  const currentOnly = isIndependent(context());
  const backups = Object.keys(id.metadata.variables || {}).filter(k => k.startsWith('状态栏_生成前备份_')).sort().reverse();
  const candidates = new Map(backups.map(k => [k, id.metadata.variables[k]]));
  for (const row of currentOnly ? [] : history.list()) {
    if (!row.available) continue;
    if (row.external) candidates.set(`楼层记录 · 第 ${row.index + 1} 楼 · ${row.name}`, { floor: row.index });
    else if (row.state) candidates.set(`楼层记录 · 第 ${row.index + 1} 楼 · ${row.name}`, JSON.stringify(row.state));
  }
  if (!candidates.size) {
    if (currentOnly) {
      notify('最近备份请在设置 → 剧情存储中恢复；该操作会恢复整套受管变量。当前聊天没有既有状态栏手工备份。');
      globalThis.AminOS?.openApp('settings');
      return;
    }
    throw Error('当前聊天没有备份或楼层记录。');
  }
  restorePanel?.remove();
  const d = node('section', undefined, 'wsh-restore amin-card'); restorePanel=d;
  d.setAttribute('aria-label','恢复状态栏备份');
  d.close=()=>{d.remove();if(restorePanel===d)restorePanel=null;};
  const title = node('h3', '恢复状态栏备份');
  const select = node('select', undefined, 'text_pole');
  [...candidates.keys()].forEach(k => { const o = node('option', k); o.value = k; select.append(o); });
  const restore = node('button', '恢复所选备份', 'menu_button');
  const cancel = node('button', '取消', 'menu_button');
  const result = node('p');
  restore.onclick = async () => {
    try {
      checkIdentity(id);
      if (isIndependent(context()) !== currentOnly) throw Error('剧情存储模式已变化，请重新选择恢复项。');
      if (running) throw Error('生成正在运行，请稍后恢复。');
      const choice = candidates.get(select.value);
      let restored;
      if (typeof choice === 'object' && choice?.floor !== undefined) restored = (await history.readFloor(choice.floor)).state;
      else restored = parseState(choice);
      checkIdentity(id);
      if (!restored) throw Error('备份为空。');
      const current = readStoryRoot(context(), '状态栏');
      if (JSON.stringify(parseState(current)) === JSON.stringify(restored)) { result.textContent = '所选状态与当前状态相同，无需恢复。'; return; }
      await persistStatusChange(()=>{
        if (!isIndependent(context()) && current !== undefined) setLocalVariable('状态栏_生成前备份_' + Date.now(), current);
        setLocalVariable('状态栏', JSON.stringify(restored));
      });d.close(); notify(isIndependent(context()) ? '已恢复所选状态栏；最近整套剧情备份在设置 → 剧情存储中管理。'
        : '已恢复，恢复前的状态也已备份。');
    } catch (e) { result.textContent = e.message; }
  };
  cancel.onclick = () => d.close();
  d.append(title, node('p', currentOnly
    ? '这里仅恢复既有状态栏手工备份，不改变其他资料。最近整套剧情备份请在设置 → 剧情存储中恢复。'
    : '恢复会用所选完整状态覆盖当前值，并先备份当前状态。楼层记录只在点击恢复后才应用；不会回退聊天正文。'), select, restore, cancel, result); generationForm.append(d); d.scrollIntoView({block:'nearest'}); select.focus({preventScroll:true});
}
function mount() {
  if (generationForm) return;
  // Keep the shared form detached while the floor workbench is closed.
  formHome = node('div');
  generationForm = node('div', undefined, 'wsh-generation-form');
  generationForm.append(node('h3', '按设定生成状态栏'), node('p', '读取当前角色卡与关联世界书，生成后可切回“状态栏”查看。'));
  const fields = {};
  function field(key, label, type = 'text') {
    const wrap = node('label', label);
    const input = node(type === 'textarea' ? 'textarea' : 'input', undefined, 'text_pole');
    if (type !== 'textarea') input.type = type;
    fields[key] = input; wrap.append(input); generationForm.append(wrap); return input;
  }
  const settings = getSettings();
  const sharedSettings=document.createElement('button');sharedSettings.type='button';sharedSettings.textContent='AI 设置 · 全局 API 与预设';sharedSettings.onclick=()=>globalThis.AminOS?.openApp('ai');generationForm.append(sharedSettings);
  sourceHost=node('div');generationForm.append(sourceHost);refreshSourceControls();
  field('includePersona', '读取用户设定描述（Persona）', 'checkbox');
  generationForm.append(node('p','默认不读取用户设定。勾选后每次读取当前用户名称与Persona描述，独立于角色资料和世界书；没有描述时提示补充。','wsh-note'));
  generationForm.append(node('p','按现有剧情更新请使用上方独立草稿面板：选择楼层、检查建议并确认保存。此流程保留已有类型；添加字段或改类型请使用状态栏编辑器。'));
  field('instructions', '状态栏要求', 'textarea').placeholder = '例如：仅显示玩家、世界、队伍；不要数值化感情。';
  Object.entries(settings).forEach(([k,v]) => { if (fields[k]) fields[k].type === 'checkbox' ? fields[k].checked = v : fields[k].value = v; });
  const report = node('p', '准备就绪。', 'wsh-report'); report.setAttribute('role', 'status');
  function save() {
    const s = {};
    for (const [k,input] of Object.entries(fields)) {
      s[k] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    }
    if(!sourcePicker)throw Error('请先打开单角色聊天');const sources=sourcePicker.getValue();saveSourceSettings(context(),'status',sources);
    context().extensionSettings[KEY] = { ...context().extensionSettings[KEY], ...s }; context().saveSettingsDebounced(); return {...s,...sources};
  }
  const actions = node('div', undefined, 'wsh-actions');
  function action(label, fn) {
    const b = node('button', label, 'menu_button'); b.type = 'button';if(['保存配置','生成／补充'].includes(label))b.classList.add('amin-primary');
    b.onclick = async () => { try { await fn(); } catch (e) { report.textContent = e.message; notify(e.message, true); } }; actions.append(b); return b;
  }
  const saveButton = action('保存配置', () => { save(); report.textContent = '状态栏配置已保存；模型与预设在 AI 设置中管理。'; });
  async function generate(mode) {
    if(mode==='update'){if(running)throw Error('请先完成当前状态栏生成。');if(selectHudPage)selectHudPage('generate');else await openEmbedded('generate');openStatusUpdate?.();report.textContent='请选择已有剧情楼层并生成草稿，预览确认后才会保存。';return;}
    if (running) throw Error('生成任务已经运行。');
    if (mode === 'replace' && !confirm(isIndependent(context())
      ? '重新生成将替换当前状态栏全部项目；最近整套剧情备份在设置 → 剧情存储中管理。继续？'
      : '重新生成将替换当前状态栏全部项目，操作前会备份。继续？')) return;
    const s = save(); identity();
    running = new AbortController(); report.textContent = '正在读取设定并请求模型…';
    generateButton.disabled = replaceButton.disabled = saveButton.disabled = true;
    try {
      const result = await generateStatus({ api: { timeoutMs: 120000, maxTokens: s.maxTokens }, mode,
        includePersona:s.includePersona===true,includeCharacter:s.includeCharacter,readWorldbooks:s.readWorldbooks,selectedBooks:s.selectedBooks,legacyBindings:true,includeGlobalBooks:s.includeGlobalBooks,extraBooks:s.extraBooks,
        allowTypeChange:s.allowTypeChange===true, updateNote: s.updateNote || '', instructions: s.instructions || '根据世界观设计简洁实用的状态栏。', statusRules: compileRules(context(), KEY, mode === 'update' ? 'update' : 'generate') }, running.signal);
      report.textContent = result.ok ? (result.changed ? '操作完成，可打开状态栏查看。' : '没有需要修改的内容。') +
        ' 读取世界书：' + (result.books?.join('、') || '无') : result.message || '已有任务运行中。';
      return result;
    } finally { syncHistory(); running = null; generateButton.disabled = replaceButton.disabled = saveButton.disabled = false; }
  }
  requestUpdate = () => generate('update');
  action('按当前剧情更新值', requestUpdate);
  const generateButton = action('生成／补充', () => generate('fill'));
  const replaceButton = action('重新生成整套', () => generate('replace'));
  action('取消生成', () => { running?.abort(); report.textContent = '已请求取消，等待底层调用返回；结果不会写入。'; });
  action('查看状态栏', () => selectHudPage ? selectHudPage('state') : openEmbedded('state'));
  action('手动另存状态', async () => {
    if (running) throw Error('模型任务运行中，请稍后另存。');
    const id = identity(), current = readStoryRoot(context(), '状态栏');
    if (!parseState(current)) throw Error('当前没有可另存的状态栏。');
    if (isIndependent(context())) {
      const runtime = getState2Runtime();
      if (typeof runtime?.saveBackup !== 'function') throw Error('当前剧情备份服务尚未就绪。');
      await runtime.saveBackup('手动另存状态');
      checkIdentity(id);
      report.textContent = '已保存当前剧情备份，可在设置 → 剧情存储中恢复。';
    } else {
      await persistStatusChange(() => setLocalVariable('状态栏_生成前备份_' + Date.now(),current));
      report.textContent = '已另存变量备份；可在“恢复备份”中选择。';
    }
  });
  action('恢复备份', restoreBackup);
  const linkageOwnership=node('p','','wsh-note');linkageOwnership.dataset.linkageOwnership='true';generationForm.append(linkageOwnership);
  generationForm.append(actions, report, node('p', '独立接口使用 Chat Completions 格式，需要允许浏览器跨域。生成与编辑共用当前聊天的状态栏资料。', 'wsh-note'));
  formHome.append(generationForm);

  syncHistory();
  const ctx = context(); const events = ctx.eventTypes || ctx.event_types || {};
  subscribeStateChanges((change,metadata) => {
    if(change.phase!=='applied'||metadata!==context()?.chatMetadata||change.identity!==chatIdentity(context())||!change.paths.some(path=>path[0]===STATE_KEY||path[0]==='variables'&&path[1]==='状态栏'))return;
    running?.abort();if(hudPanel&&selectedPage==='generate')invalidateStatusFrame?.();else closeHud();
    history.adoptExternal();floorButtons.refresh();
  });
  for (const name of ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'GENERATION_ENDED', 'CHARACTER_MESSAGE_RENDERED']) { if (events[name]) ctx.eventSource?.on(events[name], syncHistory); }
  setInterval(() => {
    if(hudPanel){try{checkIdentity(activeIdentity);}catch{running?.abort();closeHud();}}
    syncHistory();
  }, 750);
  if(events.CHAT_CHANGED)ctx.eventSource?.on(events.CHAT_CHANGED,()=>{running?.abort();closeHud();refreshSourceControls();});
}
