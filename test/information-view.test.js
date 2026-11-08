import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from '../apps/information/view.js';
import {library,read,compile} from '../apps/information/model.js';

class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.parentElement=null;this.attributes={};this.dataset={};this.value='';this._text='';this.listeners=new Map();}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
 append(...nodes){for(const n of nodes){n.remove();n.parentElement=this;this.children.push(n);}}
 replaceChildren(...nodes){for(const n of this.children)n.parentElement=null;this.children=[];this.append(...nodes);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
 setAttribute(name,value){this.attributes[name]=String(value);}
 addEventListener(name,fn){this.listeners.set(name,fn);}
 focus(){this.focused=true;}
 querySelectorAll(selector){return [...walk(this)].filter(n=>selector==='[data-running]'&&n.dataset.running);}
}
function* walk(node){yield node;for(const child of node.children)yield* walk(child);}
const button=(root,label)=>[...walk(root)].find(n=>(n.tagName==='button'&&n.textContent===label)||(n.attributes.role==='button'&&n.attributes['aria-label']===label));
const field=(root,label)=>[...walk(root)].find(n=>n.attributes['aria-label']===label);
const click=async(root,label)=>{const b=button(root,label);assert.ok(b,'Missing button: '+label);await b.onclick();};
const type=(root,label,value)=>{const f=field(root,label);assert.ok(f,'Missing field: '+label);f.value=value;f.oninput();return f;};

test('field edits remain drafts across reopening and chat switches, and cancel never changes archived data',async()=>{
 const previousDocument=globalThis.document,previousHost=globalThis.SillyTavern;
 const handlers=new Map();
 const source={on(name,fn){if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);},removeListener(name,fn){handlers.get(name)?.delete(fn);}};
 const makeContext=id=>({chatMetadata:{},chat:[{is_user:true,mes:'hello'}],getCurrentChatId:()=>id,saveMetadata:async()=>{},eventTypes:{CHAT_CHANGED:'chat_changed'},eventSource:source});
 const first=makeContext('first'),second=makeContext('second');let ctx=first;
 globalThis.document={createElement:tag=>new Node(tag)};globalThis.SillyTavern={getContext:()=>ctx};
 const target=new Node('main'),view=mount(target);
 const changeChat=next=>{ctx=next;for(const fn of handlers.get('chat_changed')??[])fn();};
 try{
  await click(target,'新建空白面板');await click(target,'添加字段');
  type(target,'分类','身份');type(target,'字段名称','职业');const input=type(target,'字段值','守卫');
  view.open();assert.equal(field(target,'字段值'),input,'reopening must retain the live field editor');
  await click(target,'历史版本');assert.equal(field(target,'字段值').value,'守卫','tab navigation must not drop an unfinished field');
  await click(target,'取消编辑');assert.equal(button(target,'编辑 职业'),undefined,'cancelled new fields are not added');
  await click(target,'添加字段');type(target,'分类','身份');type(target,'字段名称','职业');type(target,'字段值','守卫');
  await click(target,'完成编辑');await click(target,'保存资料（不影响正文）');
  assert.equal(library(first)[0].record.fields[0].value,'守卫');
  await click(target,'编辑 职业');type(target,'字段值','未经确认的修改');await click(target,'取消编辑');
  await click(target,'保存资料（不影响正文）');assert.equal(library(first)[0].record.fields[0].value,'守卫');
  await click(target,'编辑 职业');type(target,'字段值','医师');changeChat(second);
  assert.equal(library(second).length,0,'the second chat must not receive the edit');changeChat(first);
  assert.equal(field(target,'字段值').value,'医师','switching back restores the field draft');
  await click(target,'完成编辑');await click(target,'保存资料（不影响正文）');
  assert.equal(library(first)[0].record.fields[0].value,'医师');assert.equal(compile(read(first),first.chat),'','archiving must not apply the draft to story prompts');
 }finally{view.dispose();globalThis.document=previousDocument;globalThis.SillyTavern=previousHost;}
});
