import {effectsDefaults,validateEffects} from '../desktop-effects-model.js';
// The only colour source for every surface: themeVariables() turns a palette into --amin-*
// tokens; status (--wsh-*) and map (--dm-*) variables are CSS aliases of these (theme-tokens.css).
// danger/success/warning are semantic colours for errors, valid states and highlights.
export const PALETTES = {
 win10light:{name:'Windows 10 浅色',bg:'#f3f3f3',card:'#ffffff',control:'#e8e8e8',text:'#202020',muted:'#595959',line:'#b6b6b6',accent:'#0078d4',ink:'#ffffff',danger:'#c42b1c',success:'#0f7b0f',warning:'#9d5d00',scheme:'light'},
 win10:{name:'Windows 10 深色',bg:'#202020',card:'#2b2b2b',control:'#383838',text:'#ffffff',muted:'#c2c2c2',line:'#626262',accent:'#0078d4',ink:'#ffffff',danger:'#ff99a4',success:'#6ccb5f',warning:'#fce100',scheme:'dark'},
 mint:{name:'薄荷夜色',bg:'#12191d',card:'#1b252b',control:'#202d33',text:'#edf3ef',muted:'#a2b2b7',line:'#adc7be38',accent:'#b9dfce',ink:'#19382d',danger:'#f1aaaa',success:'#9fd8b4',warning:'#efc98c',scheme:'dark'},
 midnight:{name:'深海蓝',bg:'#141928',card:'#202a40',control:'#28344b',text:'#e5ebff',muted:'#a8b7da',line:'#56689580',accent:'#b4c6ff',ink:'#202c48',danger:'#ffaaaa',success:'#9fd8c0',warning:'#efc98c',scheme:'dark'},
 paper:{name:'旅人纸页',bg:'#f1e5ce',card:'#fbf3e2',control:'#e8d8ba',text:'#493824',muted:'#766046',line:'#baa37b90',accent:'#775029',ink:'#fff8e9',danger:'#a3392d',success:'#4f6b2a',warning:'#8a571a',scheme:'light'},
 rose:{name:'樱花物语',bg:'#fff6f8',card:'#fffcfd',control:'#f7e6ed',text:'#4e3042',muted:'#805a70',line:'#dcb6c7aa',accent:'#a63967',ink:'#ffffff',danger:'#b82e4d',success:'#3f7a4f',warning:'#976018',scheme:'light'},
 violet:{name:'夜色紫晶',bg:'#171529',card:'#242039',control:'#322b4d',text:'#efeafb',muted:'#b6acd0',line:'#51466eaa',accent:'#c5a9ff',ink:'#251737',danger:'#ffabba',success:'#a8dcc0',warning:'#edc5eb',scheme:'dark'},
 mono:{name:'极简墨白',bg:'#f4f5f6',card:'#ffffff',control:'#e9ecef',text:'#202b37',muted:'#586674',line:'#c7cdd4',accent:'#304d66',ink:'#ffffff',danger:'#b93640',success:'#2f6f4a',warning:'#8a5a12',scheme:'light'},
};
export const APP_NAMES={characters:'人物卡',inventory:'背包与账本',relationships:'人物关系',saves:'跨应用存档',scene:'场景与时间',journal:'剧情档案',dice:'骰子',tts:'语音朗读',worldbooks:'世界书管理',information:'信息面板',effects:'能力面板',map:'地图',status:'世界状态',organizations:'势力概览',reply:'回复选项',ai:'AI 设置'};
export const FLOOR_BUTTON_ORDER=Object.freeze(['map','status','characters','inventory','relationships','saves','dice','scene','journal','organizations','reply','effects','information','worldbooks','tts']);
const knownFloorButtons=value=>[...new Set((Array.isArray(value)?value:[]).filter(id=>FLOOR_BUTTON_ORDER.includes(id)))];
// Apps kept directly on the latest floor; everything else starts in “更多”.
export const FLOOR_PRIMARY_BUTTONS=Object.freeze(['map','status','characters','reply']);
export const defaultMoreButtons=()=>FLOOR_BUTTON_ORDER.filter(id=>!FLOOR_PRIMARY_BUTTONS.includes(id));
// Before 0.18.2 the default was an empty list and edits were not recorded. An empty
// list without the edit flag is therefore the untouched old default and upgrades.
function floorMoreButtons(floor){const list=knownFloorButtons(floor?.moreButtons),customized=floor?.moreButtonsCustomized===true||list.length>0;return {moreButtons:customized?list:defaultMoreButtons(),moreButtonsCustomized:customized};}
export const normalizeFloorButtonOrder=value=>[...new Set([...knownFloorButtons(value),...FLOOR_BUTTON_ORDER])];
// A settings draft can stay mounted while the message toolbar is rearranged.
export function mergeFloorToolbarDraft(draft,current,editedFields=[]){
 const next=structuredClone(draft),edited=new Set(editedFields);
 for(const key of ['buttonOrder','moreButtons','toolbarAlignment'])if(!edited.has(key))next.floor[key]=structuredClone(current.floor[key]);if(!edited.has('moreButtons'))next.floor.moreButtonsCustomized=current.floor.moreButtonsCustomized;
 return next;
}
export const defaults=()=>({global:{theme:'mint',fontSize:13,radius:14,density:'comfortable',opacity:100,blur:12},window:{width:448,height:720},desktop:{style:'classic',windowTheme:'auto',effects:effectsDefaults()},apps:{},floor:{width:900,desktopHeight:65,mobileHeight:55,alignment:'left',toolbarAlignment:'left',buttonOrder:[...FLOOR_BUTTON_ORDER],moreButtons:defaultMoreButtons(),moreButtonsCustomized:false,latestOnly:true,sizeMode:'fixed',buttons:{characters:true,inventory:true,relationships:true,saves:true,map:true,status:true,dice:true,scene:true,journal:true,organizations:true,reply:true,effects:true,information:true,worldbooks:true,tts:true},overrides:{}}});
const clone=x=>structuredClone(x);
function number(value,min,max){if(!Number.isFinite(value)||value<min||value>max)throw Error(`数值需在 ${min}–${max} 之间`);return value;}
function appearance(value){if(!PALETTES[value.theme])throw Error('主题无效');if(!['comfortable','compact'].includes(value.density))throw Error('间距无效');return {theme:value.theme,fontSize:number(value.fontSize,11,20),radius:number(value.radius,0,24),density:value.density,opacity:number(value.opacity,70,100),blur:number(value.blur,0,24)};}
export function validate(value){const d=defaults();const desktopStyle=value.desktop?.style??'classic';if(!['classic','win10'].includes(desktopStyle))throw Error('主页风格无效');const windowTheme=value.desktop?.windowTheme??'auto';if(!['auto','current','win10','win10light'].includes(windowTheme))throw Error('窗口主题无效');const result={desktop:{style:desktopStyle,windowTheme,effects:validateEffects(value.desktop?.effects)},global:appearance({...d.global,...value.global}),window:{width:number(value.window?.width??448,340,800),height:number(value.window?.height??720,400,1000)},floor:{width:number(value.floor?.width??900,320,1400),desktopHeight:number(value.floor?.desktopHeight??65,30,90),mobileHeight:number(value.floor?.mobileHeight??55,30,85)},apps:{}};result.floor.alignment=value.floor?.alignment??'left';result.floor.sizeMode=value.floor?.sizeMode??'fixed';result.floor.toolbarAlignment=value.floor?.toolbarAlignment??result.floor.alignment;result.floor.buttonOrder=normalizeFloorButtonOrder(value.floor?.buttonOrder);Object.assign(result.floor,floorMoreButtons(value.floor));result.floor.latestOnly=value.floor?.latestOnly!==false;if(!['left','center','right'].includes(result.floor.toolbarAlignment)||!['left','center','right'].includes(result.floor.alignment)||!['fixed','auto'].includes(result.floor.sizeMode))throw Error('楼层窗口布局无效');result.floor.buttons={};for(const id of ['characters','inventory','relationships','saves','map','status','dice','scene','journal','organizations','reply','effects','information','worldbooks','tts'])result.floor.buttons[id]=value.floor?.buttons?.[id]!==false;result.floor.overrides={};for(const id of ['characters','inventory','relationships','saves','map','status','dice','scene','journal','organizations','reply','effects','information','worldbooks','tts'])if(value.floor?.overrides?.[id]){const f=value.floor.overrides[id];result.floor.overrides[id]={width:number(f.width,320,1400),desktopHeight:number(f.desktopHeight,30,90),mobileHeight:number(f.mobileHeight,30,85)};}for(const id of Object.keys(APP_NAMES))if(value.apps?.[id])result.apps[id]=appearance({...result.global,...value.apps[id]});return result;}
export function resolveFloor(state,id){return {...state.floor,...state.floor.overrides?.[id]};}
export function createAppearance(getContext){
 const key='amin_os_appearance_v1';let value;try{value=validate(getContext()?.extensionSettings?.[key]??defaults());}catch{value=defaults();}
 const listeners=new Set();
 return {snapshot:()=>clone(value),resolve:id=>clone(value.apps[id]??(['win10','win10light'].includes(value.desktop.windowTheme)?{...value.global,theme:value.desktop.windowTheme,radius:0}:value.desktop.style==='win10'&&value.desktop.windowTheme==='auto'?{...value.global,theme:value.global.theme==='win10light'?'win10light':'win10',radius:0}:value.global)),save(next){const checked=validate(next),ctx=getContext();if(!ctx?.extensionSettings)throw Error('酒馆设置尚未就绪');ctx.extensionSettings[key]=clone(checked);ctx.saveSettingsDebounced?.();value=checked;for(const f of listeners)f();},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
}
let shared;
export const getAppearance=()=>shared;
export function initializeAppearance(getContext){return shared??=createAppearance(getContext);}
export function themeVariables(config){const p=PALETTES[config.theme];return {
 '--amin-accent-text':config.theme.startsWith('win10')?p.text:p.accent,'--amin-bg':p.bg,'--amin-card':p.card,'--amin-control':p.control,'--amin-text':p.text,'--amin-muted':p.muted,'--amin-line':p.line,'--amin-accent':p.accent,'--amin-ink':p.ink,
 '--amin-font':config.fontSize+'px','--amin-radius':config.radius+'px','--amin-gap':config.density==='compact'?'8px':'14px','--amin-opacity':config.opacity+'%','--amin-blur':config.blur+'px',
 '--amin-danger':p.danger,'--amin-success':p.success,'--amin-warning':p.warning,'--amin-scheme':p.scheme,
 };
}
export function installAppearance(document){
 const ai=getAppearance(),frames=new WeakSet(),view=document.defaultView??globalThis;
 // The status iframe is narrower than the page; touch sizing follows the host window, not the frame width.
 const touch=()=>Boolean(view.matchMedia?.('(max-width:640px),(pointer:coarse)').matches);
 function style(element,id){if(!element)return;const config=ai.resolve(id);element.dataset.aminSurface=id||'os';element.dataset.aminTheme=config.theme;element.dataset.aminDensity=config.density;element.style.colorScheme=PALETTES[config.theme].scheme;for(const [name,value]of Object.entries(themeVariables(config)))element.style.setProperty(name,value);}
 function apply(){
  const os=document.getElementById('amin-os');style(os);if(os)os.dataset.desktopStyle=ai.snapshot().desktop.style;
  for(const e of document.querySelectorAll('#amin-os .amin-app-pane, .amin-writing-page'))style(e,e.dataset.app==='settings'?'':e.dataset.app);
  for(const e of document.querySelectorAll('.dynamic-map-panel'))style(e,'map');
  const floor=ai.snapshot().floor;
  for(const e of document.querySelectorAll('.amin-floor')){style(e,'');e.dataset.alignment=floor.alignment;e.dataset.toolbarAlignment=floor.toolbarAlignment;e.dataset.sizeMode=floor.sizeMode;}
  for(const e of document.querySelectorAll('.dm-message-map,.wsh-floor-host,.amin-reply-floor,.amin-extra-floor')){const id=e.dataset.floorApp??(e.matches('.dm-message-map')?'map':e.matches('.amin-reply-floor')?'reply':'status');style(e,id);const f=resolveFloor(ai.snapshot(),id);e.style.setProperty('--amin-floor-width',f.width+'px');e.style.setProperty('--amin-floor-desktop',f.desktopHeight+'dvh');e.style.setProperty('--amin-floor-mobile',f.mobileHeight+'dvh');}
  for(const e of document.querySelectorAll('.amin-status-embedded,.wsh-workbench'))style(e,'status');
  for(const frame of document.querySelectorAll('#amin-os .wsh-dialog iframe, .wsh-workbench iframe')){
   const paint=()=>{try{const root=frame.contentDocument?.documentElement;if(root){root.removeAttribute('data-wsh-style');root.setAttribute('data-wsh-glass','off');style(root,'status');root.dataset.aminTouch=String(touch());}}catch{}};
   if(!frames.has(frame)){frames.add(frame);frame.addEventListener('load',paint);}paint();
  }
 }
 const selector='.amin-floor,.dm-message-map,.dynamic-map-panel,.amin-app-pane,.amin-writing-page,.wsh-floor-host,.amin-reply-floor,.amin-extra-floor,.wsh-dialog,.wsh-workbench,iframe';
 let queued=false;const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;apply();});}};
 const observer=new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches(selector)||n.querySelector(selector)))))schedule();});
 observer.observe(document.body,{childList:true,subtree:true});ai.subscribe(apply);view.addEventListener?.('resize',schedule);apply();return {apply};
}
