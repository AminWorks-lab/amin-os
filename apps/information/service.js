import { saveChatMetadata } from '../shared/chat-save.js';
import {KEY,read,path,compile,LIBRARY_KEY,library,archive,snapshotInformation} from './model.js';
import {isIndependent} from '../story-state/access.js';
import {acquireMetadataWrite,captureContext,subscribeStateChanges,metadataWriteStatus} from '../shared/operations.js';
import {managesModule} from '../linkage/policy.js';
import {prepareState2ManualWrite} from '../state2/runtime.js';
import {promptInjectors} from '../linkage/injectors.js';
export const PROMPT_KEY='amin-os-information-panel';
export function createInformation(context){
 let busy=false,disposed=false,message='尚未注入剧情提醒';const listeners=new Set();const notify=()=>{for(const fn of listeners)try{fn();}catch{}};
 const identity=c=>JSON.stringify([c?.groupId??null,c?.characters?.[c.characterId]?.avatar??null,c?.getCurrentChatId?.()]);
 const basis=(c,key)=>isIndependent(c)&&key===KEY?JSON.stringify([true,snapshotInformation(c)]):JSON.stringify([Object.hasOwn(c.chatMetadata,key),c.chatMetadata[key]]);
 function capture(){if(disposed)throw Error('信息面板服务已关闭');const c=context();if(!c?.chatMetadata||c.getCurrentChatId?.()==null)throw Error('请先打开一个聊天');return {meta:c.chatMetadata,identity:identity(c),path:JSON.stringify(path(c.chat)),revision:c.chatMetadata[KEY],basis:basis(c,KEY),libraryBasis:basis(c,LIBRARY_KEY)};}
 function check(t){if(disposed)throw Error('信息面板服务已关闭');const c=context();if(!t||t.meta!==c?.chatMetadata||t.identity!==identity(c)||t.path!==JSON.stringify(path(c.chat))||t.revision!==c.chatMetadata[KEY]||t.basis!==basis(c,KEY)||t.libraryBasis!==basis(c,LIBRARY_KEY))throw Error('聊天、楼层或面板记录已变化，请重新打开面板后操作');return c;}
 let injector=null;const clear=()=>injector.clear();
 async function write(token,prepare,{archiveOnly=false}={}){
  if(busy)throw Error('正在保存，请稍候');const c=check(token);if(typeof c.saveMetadata!=='function')throw Error('当前前端缺少聊天保存接口');
  const release=acquireMetadataWrite(context,captureContext(context,[[KEY],[LIBRARY_KEY]]));let changes=[],nativeRollback,saved=false;busy=true;
  try{
   changes=prepare(c).map(([key,value])=>({key,value,old:c.chatMetadata[key],existed:Object.hasOwn(c.chatMetadata,key),applied:basis({...c,chatMetadata:{...c.chatMetadata,[key]:value}},key)}));
   for(const change of changes)c.chatMetadata[change.key]=change.value;
   nativeRollback=prepareState2ManualWrite(c,changes.map(change=>[change.key]));
   clear();await saveChatMetadata(c);saved=true;
   const current=context(),expected=new Map([[KEY,token.basis],[LIBRARY_KEY,token.libraryBasis]]);for(const change of changes)expected.set(change.key,change.applied);
   if(current?.chatMetadata!==c.chatMetadata||identity(current)!==token.identity||JSON.stringify(path(current?.chat))!==token.path||[...expected].some(([key,value])=>basis(c,key)!==value))throw Error('保存期间聊天、楼层或面板资料已变化，请返回原聊天检查已保存资料');
   // The caller may continue the same generation/apply flow after archiving its
   // own draft. Other tokens retain their old library basis and become stale.
   if(archiveOnly)token.libraryBasis=basis(c,LIBRARY_KEY);
   message=archiveOnly?'资料已收纳，不影响正文':'已保存，后续剧情采用已确认的设定';
  }catch(e){
   if(!saved){
    const allOwned=changes.every(change=>basis(c,change.key)===change.applied);
    if(isIndependent(c)){
     nativeRollback?.();
     for(const change of changes)if(change.key!==KEY&&basis(c,change.key)===change.applied){if(change.existed)c.chatMetadata[change.key]=change.old;else delete c.chatMetadata[change.key];}
    }
    else {
     for(const change of changes)if(basis(c,change.key)===change.applied){if(change.existed)c.chatMetadata[change.key]=change.old;else delete c.chatMetadata[change.key];}
     if(allOwned)nativeRollback?.();
    }
   }
   message=(saved?'保存已完成，但需要重新核对：':'保存失败：')+e.message;throw e;
  }finally{busy=false;release();notify();}
 }
 async function save(token,update,updateLibrary){return write(token,c=>{const next=update(read(c));return [[KEY,next],...(updateLibrary?[[LIBRARY_KEY,updateLibrary(library(c),next)]]:[])];});}
 async function saveRecord(token,record,search){return write(token,c=>[[LIBRARY_KEY,archive(library(c),record,search)]],{archiveOnly:true});}
 const enabled=(type='normal',params={},dry=false)=>!(dry||params?.signal?.aborted||!['normal','continue','regenerate','swipe'].includes(type)||managesModule(context(),'information'));
 function build(type='normal'){let text=null;try{const shared=metadataWriteStatus(context);if(busy||shared.busy||shared.dirty)throw Error('当前聊天资料正在保存或等待重试，本轮未注入');const c=context();let chat=c.chat??[];if(['regenerate','swipe'].includes(type)&&chat.length&&!chat.at(-1).is_user)chat=chat.slice(0,-1);text=compile(read(c),chat);message=text?'已附加当前信息面板设定':'没有需要附加的已确认设定';}catch(e){text=null;message=e.message;}notify();return text;}
 const c=context(),events=c?.eventTypes??c?.event_types??{},source=c?.eventSource;
 injector=promptInjectors(context).register(PROMPT_KEY,{build,enabled,onError:e=>{message=e.message;notify();}});
 const supported=injector.supported;
 // The shared injector clears this prompt on generation start and chat switches.
 const handlers={GENERATION_ENDED:clear,GENERATION_STOPPED:clear,CHAT_CHANGED:()=>{message='已切换聊天';notify();},MESSAGE_DELETED:clear,MESSAGE_UPDATED:clear,MESSAGE_SWIPED:clear};
 if(supported)for(const [key,fn]of Object.entries(handlers))if(events[key])source.on(events[key],fn);
 const unsubscribe=subscribeStateChanges((detail,metadata)=>{if(disposed||detail.phase!=='applied'||metadata!==context()?.chatMetadata||!detail.paths.some(item=>[KEY,LIBRARY_KEY].includes(item[0])))return;clear();message='面板或资料库已从其他应用更新，请重新核对尚未应用的草稿';notify();});
 return {context,capture,check,save,saveRecord,library:()=>library(context()),read:()=>read(context()),status:()=>supported?message:'当前前端缺少自动提示接口，可编辑面板并查看提示预览',subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){if(disposed)return;disposed=true;injector.dispose();unsubscribe();listeners.clear();for(const [key,fn]of Object.entries(handlers))if(events[key]){if(source?.removeListener)source.removeListener(events[key],fn);else source?.off?.(events[key],fn);}}};
}

let sharedService;
export const getSharedService=()=>sharedService??= createInformation(()=>globalThis.SillyTavern?.getContext?.());
