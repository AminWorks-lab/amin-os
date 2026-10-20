import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeAI} from '../ai/service.js';
import {mount as mountAI} from '../ai/view.js';
import {initializeAppearance} from '../settings/appearance.js';
import {mount as mountAppearance} from '../settings/view.js';
import {mount as mountTTS} from '../apps/tts/view.js';
import {audioLibrary} from '../apps/tts/library.js';
import {getPlayer} from '../apps/tts/service.js';

// Exercise draft ownership and click handlers without network or a Tavern host.
class Element {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.className='';this.dataset={};this.style={};this.attributes={};this.value='';this.hidden=false;this.listeners=new Map();this._text='';this.classList={add:(...names)=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),...names])].join(' ');}};}
 get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
 set textContent(value){this._text=String(value);this.children=[];}
 get options(){return this.children.filter(node=>node.tagName==='OPTION');}
 append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const node of this.children)node.parentElement=null;this.children=[];this._text='';this.append(...nodes);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn);}
 querySelectorAll(selector){return descendants(this).filter(node=>selector==='input[type=checkbox]'&&node.tagName==='INPUT'&&node.type==='checkbox');}
}
function descendants(root){return root.children.flatMap(node=>[node,...descendants(node)]);}
function control(root,label){const wrap=descendants(root).find(node=>node.tagName==='LABEL'&&node.children[0]?.textContent===label);assert.ok(wrap,'missing field '+label);return wrap.children.find(node=>['INPUT','SELECT','TEXTAREA'].includes(node.tagName));}
function click(root,label){const node=descendants(root).find(node=>node.tagName==='BUTTON'&&node.textContent===label);assert.ok(node,'missing button '+label);return node.onclick();}
function edit(control,value,event='input'){control.value=value;control['on'+event]?.();for(const fn of control.listeners.get(event)??[])fn();}
const documentStub={createElement:tag=>new Element(tag)};
const context={extensionSettings:{},saveSettingsDebounced(){}};
const storage=new Map();
const ai=initializeAI({getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},'settings-view-test',{});
const appearance=initializeAppearance(()=>context);

test('AI form drafts survive reopening, tab switches and background task refreshes',()=>{
 globalThis.document=documentStub;globalThis.SillyTavern={getContext:()=>context};
 const target=new Element('div'),view=mountAI(target),address=control(target,'API 地址'),key=control(target,'API 密钥'),body=control(target,'requestBody（JSON 对象）');
 edit(address,'https://example.invalid/v1');edit(key,'session-draft-secret');edit(body,'{"temperature":0.25}');
 click(target,'任务记录');ai.select(ai.selected());view.open();click(target,'API 连接');
 assert.equal(control(target,'API 地址'),address);assert.equal(address.value,'https://example.invalid/v1');assert.equal(key.value,'session-draft-secret');assert.equal(body.value,'{"temperature":0.25}');
 assert.notEqual(ai.settings.snapshot().baseUrl,address.value);assert.ok(![...storage.values()].some(value=>value.includes('session-draft-secret')));
 assert.match(target.textContent,/暂无任务/);assert.match(target.textContent,/暂无请求预览/);view.dispose();
});

test('saving a new API profile retains a visible success notice after redraw',()=>{
 globalThis.document=documentStub;
 const target=new Element('div'),view=mountAI(target);edit(control(target,'配置名称'),'测试配置');click(target,'保存为新配置');
 const notice=descendants(target).find(node=>node.attributes.role==='status'&&node.textContent==='新配置已保存并设为全局默认。');
 assert.ok(notice);assert.equal(notice.hidden,false);assert.equal(control(target,'配置名称').value,'测试配置');view.dispose();
});

test('native per-app channel requires an explicit profile and preserves pending selection on refresh',()=>{
 globalThis.document=documentStub;globalThis.SillyTavern={getContext:()=>context};
 context.generateQuietPrompt=async()=>{throw Error('view settings must not generate');};
 let profiles=[{id:'host-one',name:'酒馆配置',model:'test-model',preset:'test-preset'}];
 context.ConnectionManagerRequestService={getSupportedProfiles:()=>profiles,sendRequest:async()=>{throw Error('view settings must not send');}};
 const target=new Element('div'),view=mountAI(target);
 click(target,'应用渠道');edit(control(target,'生成方式'),'tavern-current','change');assert.equal(ai.route('map').mode,'amin');
 click(target,'保存应用渠道');assert.equal(ai.route('map').mode,'tavern-current');
 edit(control(target,'生成方式'),'tavern-profile','change');click(target,'保存应用渠道');assert.equal(ai.route('map').mode,'tavern-current');assert.match(target.textContent,/请先为地图选择酒馆连接配置/);
 edit(control(target,'酒馆连接配置'),'host-one','change');click(target,'刷新酒馆配置列表');assert.equal(control(target,'酒馆连接配置').value,'host-one');assert.equal(control(target,'生成方式').value,'tavern-profile');
 click(target,'保存应用渠道');assert.deepEqual(ai.route('map'),{mode:'tavern-profile',profileId:'host-one'});
 profiles=[];click(target,'刷新酒馆配置列表');assert.match(target.textContent,/原连接配置已不可用/);click(target,'保存应用渠道');assert.match(target.textContent,/所选酒馆连接配置已删除/);
 assert.deepEqual(ai.route('map'),{mode:'tavern-profile',profileId:'host-one'});view.dispose();
});

test('appearance drafts survive tabs and global reset preserves staged effects',()=>{
 globalThis.document=documentStub;
 const target=new Element('div'),view=mountAppearance(target),original=appearance.snapshot();
 edit(control(target,'字号（11–20）'),'17');click(target,'背景与动效');edit(control(target,'背景遮罩深浅 %（0–90）'),'37');
 const opened=[],previous=globalThis.AminOS;globalThis.AminOS={openApp:id=>{opened.push(id);return Promise.resolve();}};
 try{click(target,'剧情存储 ↗');assert.deepEqual(opened,['story'],'the old 剧情存储 tab opens 存档与历史 → 剧情存储');}finally{globalThis.AminOS=previous;}
 assert.ok(descendants(target).some(node=>node.tagName==='BUTTON'&&node.textContent==='保存并应用'),'the settings page stays where it was');
 click(target,'整体外观');view.open();assert.equal(Number(control(target,'字号（11–20）').value),17);assert.deepEqual(appearance.snapshot(),original);
 click(target,'恢复本页默认');assert.deepEqual(appearance.snapshot(),original);click(target,'保存并应用');
 assert.equal(appearance.snapshot().global.fontSize,original.global.fontSize);assert.equal(appearance.snapshot().desktop.effects.shade,37);
 edit(control(target,'字号（11–20）'),'18');click(target,'保存并应用');assert.equal(appearance.snapshot().global.fontSize,18);view.dispose();
});

test('TTS tabs and provider changes preserve local endpoint and credential drafts',async()=>{
 globalThis.document=documentStub;globalThis.SillyTavern={getContext:()=>context};globalThis.Audio=class{pause(){}removeAttribute(){}load(){}play(){return Promise.resolve();}};
 context.extensionSettings.aminTTS={provider:'mimo',url:'http://127.0.0.1:9884'};
 const target=new Element('div'),view=mountTTS(target),provider=control(target,'语音引擎'),url=control(target,'语音服务地址'),key=control(target,'MiMo API Key');
 edit(url,'http://localhost:9884');edit(key,'tts-draft-secret');edit(provider,'azuma','change');assert.equal(url.value,'http://127.0.0.1:9883');
 edit(url,'http://localhost:9883');edit(provider,'mimo','change');assert.equal(url.value,'http://localhost:9884');edit(provider,'azuma','change');assert.equal(url.value,'http://localhost:9883');
 click(target,'声音设置');click(target,'音频库');view.open();assert.equal(key.value,'tts-draft-secret');assert.equal(context.extensionSettings.aminTTS.url,'http://127.0.0.1:9884');
 await new Promise(resolve=>setImmediate(resolve));assert.match(target.textContent,/尚无已生成语音/);view.dispose();
});

test('OS audio history replays the original source while floor libraries and controls stay scoped',async()=>{
 globalThis.document=documentStub;globalThis.SillyTavern={getContext:()=>context};
 const legacy={id:'old-audio',source:'legacy-chat:tts:0',sectionNumber:2,type:'narration',text:'旧楼层录音',provider:'azuma',speed:1,volume:1,updatedAt:1000,blob:new Blob([new Uint8Array(80)],{type:'audio/wav'})};
 const originalList=audioLibrary.list,originalAll=audioLibrary.listAll;let allCalls=0;
 audioLibrary.list=async()=>[];audioLibrary.listAll=async()=>{allCalls++;return [legacy];};
 const target=new Element('div'),floor=new Element('div'),view=mountTTS(target),floorView=mountTTS(floor,{source:'different-floor',readMessage:()=>''});
 try{
  await new Promise(resolve=>setImmediate(resolve));const all=control(target,'全部本机历史');assert.equal(all.checked,false);assert.equal(allCalls,0);assert.ok(!floor.textContent.includes('全部本机历史'));
  all.checked=true;all.onchange();await new Promise(resolve=>setImmediate(resolve));assert.equal(allCalls,1);assert.match(target.textContent,/legacy-chat:tts:0/);assert.match(target.textContent,/保存时间/);
  assert.ok(!descendants(target).some(node=>node.tagName==='BUTTON'&&node.textContent==='重新生成'));
  click(target,'重听');await new Promise(resolve=>setImmediate(resolve));assert.equal(getPlayer().snapshot().source,legacy.source);assert.equal(getPlayer().snapshot().phase,'playing');
  const pause=descendants(target).find(node=>node.tagName==='BUTTON'&&node.textContent==='暂停'),floorPause=descendants(floor).find(node=>node.tagName==='BUTTON'&&node.textContent==='暂停');assert.equal(pause.disabled,false);assert.equal(floorPause.disabled,true);
  click(floor,'停止');assert.equal(getPlayer().snapshot().phase,'playing');click(target,'停止');assert.equal(getPlayer().snapshot().phase,'idle');assert.equal(legacy.source,'legacy-chat:tts:0');
 }finally{view.dispose();floorView.dispose();audioLibrary.list=originalList;audioLibrary.listAll=originalAll;getPlayer().stop();}
});
