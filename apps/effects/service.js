import { saveChatMetadata } from '../shared/chat-save.js';
import { isIndependent, legacyModule } from '../story-state/access.js';
import {actionResources,buildActionSettlement} from '../shared/action-settlement.js';
import {KEY,readStore,anchor,compile,change,splitEffect,timedEffects,contextExpiryPreview,currentPrompt} from './model.js';
import {LIBRARY_KEY,mergeLibrary,libraryStamp} from './library.js';
import {KEY as SCENE_KEY,readCurrentScene} from '../scene/model.js';
import {createOperationService,subscribeStateChanges,chatIdentity,acquireMetadataWrite} from '../shared/operations.js';
import {uuid} from '../../uuid.js';
import {managesModule,mayRead,readLinkageSettings} from '../linkage/policy.js';
import {buildDataPrompt} from '../linkage/prompt.js';
import {buildSettlement,periodicPreview,SETTLEMENT_PATHS,MANUAL_SETTLEMENT_PATHS,validatePeriodicReferences} from './settlement.js';
import {prepareState2ManualWrite} from '../state2/runtime.js';
import {promptInjectors} from '../linkage/injectors.js';
export const PROMPT_KEY='amin-os-persistent-effects';
export function createEffects(getContext){
 let pendingAction=null,actionResult=null;let busy=false,message='尚未发送提醒';const listeners=new Set(),operations=createOperationService(getContext);
 const actionScope=()=>{const c=getContext();return {metadata:c?.chatMetadata,identity:chatIdentity(c),path:JSON.stringify(anchor(c?.chat))};};
 const matchesAction=record=>{if(!record)return false;const current=actionScope();return record.scope.metadata===current.metadata&&record.scope.identity===current.identity&&record.scope.path===current.path;};
 const currentActionResult=()=>matchesAction(actionResult)?structuredClone(actionResult.plan):null;
 const notify=event=>listeners.forEach(f=>{try{f(event);}catch{}});
 let injector=null;const clear=()=>injector.clear();
 function identity(c){return String(c?.groupId??'')+' / '+String(c?.getCurrentChatId?.()??'');}
 function capture(){const c=getContext();if(!c?.chatMetadata||c.getCurrentChatId?.()==null)throw Error('请先打开一个聊天');return {meta:c.chatMetadata,id:identity(c),path:JSON.stringify(anchor(c.chat)),library:libraryStamp(readStore(c)),operation:operations.capture(SETTLEMENT_PATHS)};}
 function check(token){const c=getContext();if(!token||token.meta!==c?.chatMetadata||token.id!==identity(c)||token.path!==JSON.stringify(anchor(c.chat)))throw Error('聊天或楼层已变化，请重新打开表单');if(token.library!==libraryStamp(readStore(c)))throw Error('共享能力库已变化，请重新打开表单');operations.check(token.operation);return c;}
 function ensureAvailable(){if(busy||operations.busy())throw Error('正在保存，请稍候');if(operations.dirty())throw Error('当前聊天有已确认但尚未保存的操作，请先重试保存');}
 function forMetadata(next,c){if(c.extensionSettings?.[LIBRARY_KEY])next.skills=structuredClone(c.chatMetadata[KEY]?.skills??[]);delete next.trash;delete next.groups;return next;}
 function migrate(c){
  if(!c?.extensionSettings||typeof c.saveSettingsDebounced!=='function')return;
  const before=c.extensionSettings[LIBRARY_KEY],next=mergeLibrary(before,legacyModule(c,'effects',KEY)?.skills??[]);
  if(JSON.stringify(before)===JSON.stringify(next))return;
  c.extensionSettings[LIBRARY_KEY]=next;
  try{const pending=c.saveSettingsDebounced();pending?.catch?.(e=>{if(c.extensionSettings[LIBRARY_KEY]===next)c.extensionSettings[LIBRARY_KEY]=before;message='旧能力迁移保存失败：'+e.message;notify({error:true});});}catch(e){c.extensionSettings[LIBRARY_KEY]=before;throw e;}
 }
 function read(){const c=getContext();readStore(c);migrate(c);return readStore(c);}
 async function saveLibrary(token,update){
  ensureAvailable();const c=check(token);
  if(!c.extensionSettings||typeof c.saveSettingsDebounced!=='function')throw Error('当前酒馆缺少全局设置保存接口');
  migrate(c);const before=c.extensionSettings[LIBRARY_KEY],store=readStore(c),events=JSON.stringify(store.events),next=update(store);
  if(JSON.stringify(next.events)!==events)throw Error('能力库不能修改聊天生效记录');
  const trash=structuredClone(next.trash??before.trash??[]);
  const imported=[...new Set([...before.imported,...trash.map(e=>JSON.stringify(e.skill))])];
  const library=mergeLibrary({...before,skills:structuredClone(next.skills),groups:structuredClone(next.groups??before.groups??[]),trash,imported});busy=true;c.extensionSettings[LIBRARY_KEY]=library;
  try{await c.saveSettingsDebounced();message='能力库已保存，所有角色和聊天共享；已发动效果保持原规则';}
  catch(e){if(c.extensionSettings[LIBRARY_KEY]===library)c.extensionSettings[LIBRARY_KEY]=before;message='能力库保存失败：'+e.message;throw e;}
  finally{busy=false;notify({error:message.includes('失败')});}
 }
 async function save(token,update){
  ensureAvailable();const c=check(token);if(typeof c.saveMetadata!=='function')throw Error('当前酒馆缺少聊天保存接口');
  migrate(c);const meta=c.chatMetadata,before=meta[KEY],existed=Object.hasOwn(meta,KEY),next=forMetadata(update(readStore(c)),c),release=acquireMetadataWrite(getContext,token.operation);let saved=false,nativeRollback;busy=true;
  try{meta[KEY]=next;nativeRollback=prepareState2ManualWrite(c,[[KEY]]);await saveChatMetadata(c);saved=true;const current=getContext();if(current?.chatMetadata!==meta||identity(current)!==token.id||JSON.stringify(anchor(current.chat))!==token.path)throw Error('记录已保存到原聊天，但聊天或楼层已变化，请刷新当前页面');clear();message='已保存，下次生成时使用当前记录';}
  catch(e){if(!saved){if(isIndependent(c))nativeRollback?.();else if(meta[KEY]===next){if(existed)meta[KEY]=before;else delete meta[KEY];nativeRollback?.();}}message=saved?e.message:'保存失败：'+e.message;throw e;}
  finally{busy=false;release();notify({error:message.includes('失败')||message.includes('已变化')});}
 }
 async function commit(token,label,update){
  ensureAvailable();const c=check(token);migrate(c);
  const next=forMetadata(update(readStore(c),c),c);
  pendingAction=null;operations.stage({label,patches:[{path:[KEY],value:next}]},token.operation);
  try{const result=await operations.confirm();clear();message='生效记录已保存，下次生成使用当前游戏时间';return result;}
  catch(error){message=error.message;throw error;}
  finally{notify({error:operations.dirty()});}
 }
 const mutate=(token,op,data)=>commit(token,'更新持续效果',(store,c)=>{if(data.periodic)validatePeriodicReferences(c,data.periodic);return change(store,c.chat,op,data,{clock:readCurrentScene(c).clock});});
 const split=(token,id,parts)=>commit(token,'分割持续效果',(store,c)=>splitEffect(store,c.chat,id,parts));
 function stageSettlement(token=capture(),effectIds){ensureAvailable();pendingAction=null;const c=check(token),basis=operations.capture(MANUAL_SETTLEMENT_PATHS),plan=buildSettlement(c,{effectIds,operationId:uuid(),includeCheckpoint:true});operations.stage({label:'确认周期效果结算',patches:plan.patches,summary:{rows:plan.rows,clock:plan.clock}},basis);return {summary:plan.summary,rows:plan.rows,clock:plan.clock};}
 function stageAction(input){ensureAvailable();const c=getContext(),basis=operations.capture([...MANUAL_SETTLEMENT_PATHS,['amin_os_dice_v1'],['dynamicMapV1'],['amin_os_journal_v1']]),plan=buildActionSettlement(c,input,{operationId:uuid()});operations.stage({label:'确认行动结算：'+plan.name,patches:plan.patches,summary:{rows:plan.rows,text:plan.text}},basis);pendingAction={plan,scope:actionScope()};return plan;}
 async function confirmAction(){ensureAvailable();if(!matchesAction(pendingAction))throw Error('聊天或回复版本已变化，请重新预览行动结算');const selected=pendingAction;try{const result=await operations.confirm();actionResult=selected;pendingAction=null;clear();message='行动已结算，结果已保存';return result;}catch(error){message=error.message;throw error;}finally{notify({error:operations.dirty()});}}
 async function confirmSettlement(){ensureAvailable();try{const result=await operations.confirm();clear();message='周期结算已保存，重复预览不会再次扣除';return result;}catch(error){message=error.message;throw error;}finally{notify({error:operations.dirty()});}}
 async function retrySave(){try{const result=await operations.retrySave();if(matchesAction(pendingAction)){actionResult=pendingAction;pendingAction=null;}message=operations.status();return result;}catch(error){message=error.message;throw error;}finally{clear();notify({error:operations.dirty()});}}
 function build(type='normal'){
  let prompt=null;
  try{if(busy||operations.busy()||operations.dirty())throw Error('聊天资料尚未保存，本轮未附加持续效果提醒');const ctx=getContext();if(managesModule(ctx,'effects')){message='持续效果由统一联动条目提供';notify();return null;}let chat=ctx.chat??[];
   // Some hosts emit this event before removing the assistant reply being replaced.
   if(['regenerate','swipe'].includes(type)&&chat.length&&!chat.at(-1).is_user)chat=chat.slice(0,-1);
   prompt=compile(readStore(ctx),chat,readCurrentScene({...ctx,chat}).clock);message=prompt?`已附加 ${prompt.length} 字符持续效果提醒`:'当前没有启用且未到期的生效记录';}
  catch(e){prompt=null;message=e.message;}notify();return prompt;
 }
 function promptPreview(){
  const ctx=getContext();
  if(!managesModule(ctx,'effects'))return {text:currentPrompt(ctx),note:'独立能力提醒：下次生成按当前分支重新编译。'};
  if(!mayRead(ctx,'effects'))return {text:'',note:'统一联动已接管，但能力模块的模型读取权限关闭，本轮不发送能力资料。'};
  if(readLinkageSettings(ctx).dataSource==='external')return {text:'',note:'资料来源设为外部：Amin 不发送能力资料，请在酒馆提示词查看器检查外部注入。'};
  return {text:buildDataPrompt(ctx),note:'统一联动发送：下方是当前完整剧情资料，能力记录位于 modules.effects。此处为预览，实际发送请核对酒馆提示词查看器。'};
 }
 const ctx=getContext(),events=ctx.eventTypes??ctx.event_types??{},source=ctx.eventSource;
 injector=promptInjectors(getContext).register(PROMPT_KEY,{build,enabled:(type='normal',params={},dry=false)=>!dry&&['normal','regenerate','swipe','continue'].includes(type)&&!params?.signal?.aborted,onError:e=>{message=e.message;notify();}});
 const supported=injector.supported;
 // The shared injector clears this prompt on generation start and chat switches.
 const handlers={CHAT_CHANGED:()=>{pendingAction=null;actionResult=null;message='已切换聊天';notify();},GENERATION_ENDED:clear,GENERATION_STOPPED:clear,MESSAGE_DELETED:()=>{clear();notify();},MESSAGE_SWIPED:()=>{clear();notify();},MESSAGE_UPDATED:()=>{clear();notify();}};
 if(supported)for(const [event,fn]of Object.entries(handlers))if(events[event])source.on(events[event],fn);
 const unsubscribeOperations=operations.subscribe(()=>{if(operations.status())message=operations.status();notify({error:operations.dirty()&&!operations.busy()});});
 const unsubscribeState=subscribeStateChanges((event,metadata)=>{if(metadata===getContext()?.chatMetadata&&event.identity===chatIdentity(getContext())&&event.paths.some(path=>[KEY,SCENE_KEY].includes(path[0]))){clear();notify();}});
 return {actionResult:currentActionResult,actionResources:()=>actionResources(getContext()),stageAction,confirmAction,promptPreview,capture,check,save,saveLibrary,read,mutate,split,stageSettlement,confirmSettlement,discardSettlement:()=>{pendingAction=null;return operations.discard();},periodicPreview:()=>periodicPreview(getContext()),retrySave,dirty:operations.dirty,busy:()=>busy||operations.busy(),gameClock:()=>readCurrentScene(getContext()).clock,timedEffects:()=>{const c=getContext();return timedEffects(readStore(c),c?.chat,readCurrentScene(c).clock);},expiryPreview:afterClock=>contextExpiryPreview(getContext(),afterClock),prompt:()=>currentPrompt(getContext()),context:getContext,status:()=>operations.dirty()?message:supported?message:'当前前端缺少持续提示接口；可管理记录并复制预览',supported,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){injector.dispose();unsubscribeOperations();unsubscribeState();operations.dispose();listeners.clear();for(const [event,fn]of Object.entries(handlers))if(events[event])source?.removeListener?.(events[event],fn);}};
}

let sharedService;
export const getSharedService=()=>sharedService??= createEffects(()=>globalThis.SillyTavern?.getContext?.());
