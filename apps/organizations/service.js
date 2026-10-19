import { saveChatMetadata } from '../shared/chat-save.js';
import {ROOT,read,empty,clone,equal,validate,diff,enforceLocks} from './model.js';
import {checkpointState} from '../status/state-checkpoint.js';
import {createHistory} from '../status/history.js';
import {subscribeStateChanges,chatIdentity as operationIdentity,acquireMetadataWrite} from '../shared/operations.js';
import {getState2Runtime,state2HistoryMode} from '../state2/runtime.js';
import './story-state.js';
import { isIndependent, readStoryRoot, writeStoryRoot, legacyModule, STATE_KEY, prepareIndependentManualWrite } from '../story-state/access.js';
export const META='amin_os_organizations_v1',SETTINGS='amin_os_organizations_settings_v1';
export const defaults=()=>({includeCharacter:true,includeChat:true,readWorldbooks:true,selectedBooks:null,books:'',detail:'标准',scope:'',allowInference:false,allowNew:false,groups:['organizations','alliances','regions'],generationRules:'',updateRules:'',assessmentRules:'',generationEnabled:true,updateEnabled:true,assessmentEnabled:true,follow:false});
export function roleIdentity(ctx){const group=ctx?.groupId;return group!=null&&group!==''?'group:'+String(group):'character:'+String(ctx?.characters?.[ctx?.characterId]?.avatar??'');}
export function chatIdentity(ctx){
 const id=ctx?.getCurrentChatId?.();if(id==null||id===''||!ctx.chatMetadata)throw Error('请先打开聊天');
 return JSON.stringify([roleIdentity(ctx),id]);
}
export function createStore({context,setVariable,saveMetadata=ctx=>saveChatMetadata(ctx),poll=false,nativeState=()=>state2HistoryMode(context())}){
 let disposed=false,busy=false,epoch=0,pending=null,lastError='',lastIdentity='',lastMetadata=null,accepted=null,lastLocks=[],controller=null,requestToken=null;
 const listeners=new Set();
 const notify=()=>{for(const fn of listeners)fn();};
 // Readers must never write: an applied-state listener that re-materializes the removed legacy
 // root would change a path the shared operation is about to verify after saving (STALE_BASIS).
 const view=()=>{const c=context();chatIdentity(c);return c.chatMetadata[META]??legacyModule(c,'organizations',META)??{locks:[],assessment:null,backups:[]};};
 const meta=()=>{const c=context();chatIdentity(c);return c.chatMetadata[META]??=view();};
 const readDoc=()=>read(readStoryRoot(context(),ROOT));
 const floor=c=>JSON.stringify((c.chat??[]).map(m=>[m.extra?.amin_org_message_id??null,m.swipe_id??0,m.mes??'']));
 const scope=()=>{const c=context();return {identity:chatIdentity(c),metadata:c.chatMetadata,floor:floor(c),epoch};};
 const checkScope=t=>{const s=scope();if(disposed||s.identity!==t.identity||s.metadata!==t.metadata||s.floor!==t.floor||t.epoch!==epoch)throw Error('聊天或楼层已变化，操作已取消');};
 const invalidate=()=>{epoch++;pending=null;controller?.abort();controller=null;requestToken=null;};
 const requireReady=()=>{const native=nativeState();if(native?.managed&&!native.ready)throw Error('正在恢复当前聊天的楼层变量，请等待恢复完成。');return native;};
 function compatible(){const c=context(),l=c.chatMetadata?.extensions?.LittleWhiteBox;if(isIndependent(c)||c.extensionSettings?.LittleWhiteBox?.variablesMode==='1.0')return;for(const k of ['stateCkptV2','stateLogV2'])if(l?.[k]&&(l[k].version??1)!==1)throw Error('小白X记录格式不兼容，未写入');}
 function writeDoc(doc,{checkpoint=true}={}){
  const c=context();requireReady();compatible();const value=validate(doc);if(isIndependent(c))writeStoryRoot(c,ROOT,JSON.stringify(value));else setVariable(ROOT,JSON.stringify(value));
  if(!equal(readDoc(),value))throw Error('变量写入后校验失败');
  if(checkpoint)checkpointState(c);accepted=clone(value);
 }
 const history=createHistory({context,historyKey:'amin_os_organizations_history_v1',messageKey:'amin_org_message_id',allowGroups:true,
  nativeState,
  externalRead:async index=>{
   const runtime=getState2Runtime();
   if(typeof runtime?.readStoryFloor!=='function')throw Error('外置楼层读取尚未就绪。');
   if(isIndependent(context()))return {doc:readDoc(),assessment:clone(view().assessment)};
   const snapshot=await runtime.readStoryFloor(index);
   return {doc:read(snapshot.variables?.[ROOT]),assessment:null};
  },
  read:()=>({doc:readDoc(),assessment:clone(view().assessment)}),
  write:value=>{writeDoc(value?.doc??empty(),{checkpoint:false});meta().assessment=clone(value?.assessment??null);},
  beforeRestore:()=>{invalidate();accepted=null;},warn:message=>{lastError=message;notify();},changed:()=>notify()});
 function sync(){
  if(disposed||busy)return;
  try{
   const id=chatIdentity(context());
   if(id!==lastIdentity||context().chatMetadata!==lastMetadata){invalidate();lastIdentity=id;lastMetadata=context().chatMetadata;accepted=null;lastLocks=[];lastError='';}
   if(requestToken){try{checkScope(requestToken);}catch{controller?.abort();controller=null;requestToken=null;}}
   const native=nativeState();
   if(native?.managed&&!native.ready)return;
   // Legacy history restores earlier values; native history only records replayed variables.
   history.sync();
   const next=readDoc(),locks=view().locks??[];
   if(!native?.managed&&!isIndependent(context())&&accepted){try{enforceLocks(accepted,next,lastLocks);}catch(e){writeDoc(accepted);lastError='外部变量修改触及锁定字段，已恢复：'+e.message;history.sync();notify();return;}}
   if(!equal(accepted,next)){accepted=clone(next);notify();}
   lastLocks=clone(locks);
  }catch(e){if(lastError!==e.message){lastError=e.message;notify();}}
 }
 function capture(){sync();requireReady();const t={...scope(),doc:readDoc(),locks:clone(view().locks??[])};return t;}
 function check(t){requireReady();checkScope(t);if(!equal(t.doc,readDoc())||!equal(t.locks,view().locks??[]))throw Error('资料或锁定设置已变化，请重新生成/预览');}
 async function persist(c){try{if(isIndependent(c)){writeStoryRoot(c,ROOT,JSON.stringify(readDoc()));prepareIndependentManualWrite(c,[['variables',ROOT],[META]]);}await saveMetadata(c);}catch{throw Error('已写入内存，但聊天保存失败；请保持本聊天并重试保存，不要重复应用');}}
 const api={
  context,read:readDoc,history:()=>history.list(),readHistory:index=>history.readFloor(index),error:()=>lastError,clearError:()=>{lastError='';},
  subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},sync,capture,check,
  pending:()=>pending?{kind:pending.kind,changes:clone(pending.changes),doc:clone(pending.doc),assessment:clone(pending.assessment)}:null,
  stage(doc,t=capture(),{manual=false}={}){check(t);const checked=validate(doc);if(!manual)enforceLocks(t.doc,checked,t.locks);pending={kind:'data',doc:checked,t,manual,changes:diff(t.doc,checked)};notify();},
  stageAssessment(value,t){check(t);pending={kind:'assessment',assessment:clone(value),t,changes:[]};notify();},
  discard(){pending=null;notify();},
  async confirm(){
   if(!pending)throw Error('没有待确认结果');if(busy)throw Error('正在保存');
   const p=pending;check(p.t);compatible();const release=acquireMetadataWrite(context);busy=true;
   try{
    const c=context(),m=meta();
    if(p.kind==='data'){
     if(!p.manual)enforceLocks(p.t.doc,p.doc,p.t.locks);
     m.backups??=[];m.backups.push({doc:clone(p.t.doc),at:Date.now()});m.backups=m.backups.slice(-5);
     writeDoc(p.doc);m.locks=(m.locks??[]).filter(path=>{const[g,id,k]=path.split('.');return p.doc[g]?.[id]&&Object.hasOwn(p.doc[g][id],k);});
    }else m.assessment={...p.assessment,basis:clone(p.t.doc),at:Date.now(),floor:p.t.floor};
    pending=null; // consume before awaiting persistence; never apply twice
    history.sync({persist:false});await persist(c);checkScope(p.t);
   }finally{release();busy=false;sync();notify();}
  },
  assessment(){const a=view().assessment;return a?{...clone(a),stale:!equal(a.basis,readDoc())||a.floor!==floor(context())}:null;},
  locks:()=>clone(view().locks??[]),
  async setLocks(locks){if(busy)throw Error('正在保存');requireReady();const c=context(),d=readDoc();for(const path of locks){const [g,id,k,...rest]=path.split('.');if(rest.length||!d[g]?.[id]||!Object.hasOwn(d[g][id],k))throw Error('锁定路径不存在');}const release=acquireMetadataWrite(context);busy=true;try{requireReady();invalidate();meta().locks=[...new Set(locks)];lastLocks=clone(meta().locks);await persist(c);notify();}finally{release();busy=false;}},
  config(){const c=context();chatIdentity(c);const role=roleIdentity(c);return {...defaults(),...clone(c.extensionSettings?.[SETTINGS]?.[role]??{})};},
  async saveConfig(value){const c=context();chatIdentity(c);const role=roleIdentity(c);c.extensionSettings[SETTINGS]??={};c.extensionSettings[SETTINGS][role]={...defaults(),...clone(value)};await c.saveSettingsDebounced?.();notify();},
  beginRequest(){if(controller||busy)throw Error('已有请求或保存正在进行');const t=capture();requestToken=t;controller=new AbortController();const own=controller;return {token:t,signal:own.signal,check:()=>{if(own.signal.aborted)throw Error('任务已取消');check(t);},finish:()=>{if(controller===own){controller=null;requestToken=null;}}};},
  cancel(){controller?.abort();controller=null;requestToken=null;notify();},
  busy:()=>busy||!!controller,
  async retrySave(){const c=context();chatIdentity(c);const release=acquireMetadataWrite(context);try{await persist(c);lastError='';notify();}finally{release();}},
  dispose(){disposed=true;invalidate();clearInterval(timer);offExternal();history.dispose();for(const [name,fn]of subscriptions)source?.removeListener?.(name,fn);listeners.clear();},
 };
 const c=context(),source=c?.eventSource,events=c?.eventTypes??c?.event_types??{},subscriptions=[];
 for(const name of ['CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','GENERATION_ENDED'])if(events[name]&&source?.on){const fn=()=>{if(name==='CHAT_CHANGED'){invalidate();accepted=null;}sync();};subscriptions.push([events[name],fn]);source.on(events[name],fn);}
 const offExternal=subscribeStateChanges((change,metadata)=>{
  if(disposed||change.phase!=='applied'||metadata!==context()?.chatMetadata||change.identity!==operationIdentity(context())||!change.paths.some(path=>path[0]===STATE_KEY||path[0]===META||path[0]==='variables'&&path[1]===ROOT))return;
  const native=nativeState();
  if(native?.managed&&!native.ready){invalidate();accepted=null;lastLocks=[];notify();return;}
  invalidate();accepted=clone(readDoc());lastLocks=clone(view().locks??[]);
  lastIdentity=chatIdentity(context());lastMetadata=context().chatMetadata;
  history.adoptExternal();lastError='已应用跨应用状态，原预览已取消。';notify();
 });
 const timer=poll?setInterval(sync,700):null;sync();return api;
}
let shared;
export async function getStore(){
 if(shared)return shared;
 const ctx=globalThis.SillyTavern?.getContext?.();
 const vars=isIndependent(ctx)?{setLocalVariable:(key,value)=>writeStoryRoot(globalThis.SillyTavern.getContext(),key,value)}:await import('/scripts/variables.js');
 if(typeof vars.setLocalVariable!=='function')throw Error('宿主缺少聊天变量写入接口');
 return shared??=createStore({context:()=>globalThis.SillyTavern?.getContext?.(),setVariable:vars.setLocalVariable,poll:true});
}
