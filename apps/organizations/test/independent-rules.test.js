import test from 'node:test';
import assert from 'node:assert/strict';
import {followPrompt} from '../ai.js';
import {mount} from '../view.js';
import {harness,sample} from './fixtures.js';
import {STATE_KEY} from '../../story-state/access.js';
import {emptyState} from '../../story-state/schema.js';
import {KEY,MODULES,emptyLinkageState} from '../../linkage/policy.js';
import {buildUpdateRules} from '../../linkage/prompt.js';

function independentFixture(writable='organizations'){
 const f=harness();
 f.ctx.chatMetadata[STATE_KEY]={...emptyState(),modules:{...emptyState().modules,organizations:{version:1,doc:sample(),locks:['organizations.a.name'],assessment:null}}};
 f.ctx.chatMetadata[KEY]={...emptyLinkageState(),enabled:true,modules:Object.fromEntries(Object.keys(MODULES).map(id=>[id,{enabled:id===writable,read:id===writable,write:id===writable&&id!=='dice'}]))};
 f.ctx.extensionSettings.amin_os_organizations_settings_v1={'character:a.png':{updateEnabled:true,updateRules:'人口不明不得猜测'}};
 return f;
}

test('independent copied rules use the real unified protocol and current permissions regardless of legacy follow switch',()=>{
 const f=independentFixture(),before=structuredClone(f.ctx.chatMetadata);
 try{
  const actual=followPrompt(f.ctx);
  assert.equal(actual,buildUpdateRules(f.ctx));
  assert.match(actual,/<amin_update>/);assert.match(actual,/module:organizations/);
  assert.match(actual,/人口不明不得猜测/);
  assert.doesNotMatch(actual,/xbgetvar_yaml_idx|LWB_STATE_ERRORS|小白X变量管理2\.0联动/);
  assert.deepEqual(f.ctx.chatMetadata,before);
  f.ctx.chatMetadata[KEY].modules.organizations.write=false;
  const disabled=followPrompt(f.ctx);
  assert.match(disabled,/没有允许更新的模块/);assert.doesNotMatch(disabled,/<amin_update>/);
  assert.doesNotMatch(disabled,/xbgetvar|<state>/);
 }finally{f.api.dispose();}
});

test('copy reflects the actual other-module permissions instead of enabling organizations implicitly',()=>{
 const f=independentFixture('status');
 try{
  const actual=followPrompt(f.ctx);
  assert.equal(actual,buildUpdateRules(f.ctx));assert.match(actual,/module:status/);
  assert.doesNotMatch(actual,/module:organizations|人口不明不得猜测/);
 }finally{f.api.dispose();}
});

class Node{
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.dataset={};this.style={};this._text='';this.classList={add(){}};}
 get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
 set textContent(v){this._text=String(v);this.children=[];}
 get isConnected(){return true;}
 append(...nodes){for(const node of nodes){node.remove();node.parent=this;this.children.push(node);}}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
 replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
 setAttribute(key,value){this.attributes[key]=String(value);}
 getAttribute(key){return this.attributes[key]??null;}
 querySelectorAll(selector){return walk(this).slice(1).filter(n=>selector.startsWith('[')?n.getAttribute(selector.slice(1,-1).split('=')[0])===selector.match(/="([^"]+)"/)?.[1]:n.tagName===selector.toUpperCase());}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
 focus(){}
}
const walk=root=>[root,...root.children.flatMap(walk)];
const find=(root,label,tag='button')=>walk(root).find(n=>n.tagName===tag.toUpperCase()&&(n.textContent===label||n.getAttribute('aria-label')===label));

for(const independent of [true,false])test(`real organization settings copy unified rules without worldbook writes (${independent?'independent':'not yet migrated'})`,async()=>{
 const f=independent?independentFixture():harness(),documentBefore=globalThis.document,navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),copied=[];
 globalThis.document={createElement:tag=>new Node(tag)};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>copied.push(text)}}});
 const root=new Node('main');let view;
 try{
  view=await mount(root,{api:f.api,sourceOptions:{loadWorldInfo:async()=>({selected_world_info:[],world_info:{}})}});
  const settings=find(root,'生成与规则');assert.ok(settings);await settings.onclick();
   assert.ok(find(root,'剧情更新协议','summary'));assert.match(root.textContent,/插件直接提供统一 amin_update/);
   assert.equal(find(root,'同步已保存规则到世界书'),undefined);
   assert.equal(find(root,'启用日常剧情变量更新（保存后需同步世界书）','input'),undefined);
   assert.equal(find(root,'复制已保存的更新提示词'),undefined);
   await find(root,'复制当前统一更新规则').onclick();
   assert.deepEqual(copied,[followPrompt(f.ctx)]);assert.doesNotMatch(copied[0],/xbgetvar|LWB_STATE_ERRORS|每行state格式/);
   if(independent)assert.equal(copied[0],buildUpdateRules(f.ctx));
 }finally{
  view?.dispose();f.api.dispose();globalThis.document=documentBefore;
  if(navigatorDescriptor)Object.defineProperty(globalThis,'navigator',navigatorDescriptor);else delete globalThis.navigator;
 }
});
