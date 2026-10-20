import {chatIdentity} from '../stylewriter/model.js';
import {mountFloorControl} from '../../settings/floor-layout.js';
import {observeChatFloors} from '../floor-scheduler.js';
import {floorLoading} from '../lazy-view.js';
import {views} from '../views.js';

export function floorContext(ctx,index,message){
 if(!Number.isInteger(index)||index<0||ctx.chat?.[index]!==message)throw Error('楼层内容已变化，请重新打开此窗口。');
 return {...ctx,chat:ctx.chat.slice(0,index+1),replyFloorIndex:index,replyLiveChatLength:ctx.chat.length};
}
export function installReplyFloorButtons({rewriteOptions}={}){
 const getContext=()=>globalThis.SillyTavern?.getContext?.(),mounted=new Map(),owned=new Set();let serial=0,disposed=false;
 const key=ctx=>chatIdentity(ctx??{});
 const node=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e;};
 function attach(element){
  if(mounted.has(element))return mounted.get(element).dispose;
  const ctx=getContext(),index=Number(element.getAttribute('mesid')),message=ctx?.chat?.[index],chatKey=key(ctx);
  if(!message||message.is_system)return;
  const host=node('div','amin-reply-floor'),button=node('button','','✧ 回复选项');button.type='button';button.setAttribute('aria-expanded','false');button.title='参考至这一楼生成候选或扩写草稿，仅填入当前输入框';
  let view=null,windowElement=null,epoch=0;
  const dock=mountFloorControl(element,'reply',host,button);
  function close(){epoch++;view?.dispose();view=null;windowElement?.remove();windowElement=null;button.setAttribute('aria-expanded','false');dock.setOpen(false);}
  button.onclick=()=>{
   if(windowElement){close();return;}
   windowElement=node('section','amin-reply-floor-window');windowElement.setAttribute('aria-label','第 '+(index+1)+' 楼回复选项');
   const bar=node('header','amin-reply-floor-header'),title=node('strong','','回复选项 · 第 '+(index+1)+' 楼'),collapse=node('button','','收起');collapse.type='button';collapse.setAttribute('aria-label','收起第 '+(index+1)+' 楼回复选项');collapse.onclick=close;bar.append(title,collapse);
   const body=node('div','amin-reply-floor-body amin-ui');windowElement.append(bar,body);host.append(windowElement);
   body.append(node('p','amin-reply-floor-note amin-meta','参考范围：截至这一楼。候选填入当前输入框，由你发送；发送后清空。'));
   const run=++epoch;
   const start=()=>{
    const loading=floorLoading(body);
    views.reply().then(({mount})=>{
     loading.done();if(run!==epoch)return;
     try{view=mount(body,{rewriteOptions,instanceId:'amin-floor-reply-'+(++serial),headingText:'下一句怎么说',contextProvider:current=>{if(key(current)!==chatKey)throw Error('聊天已切换，请重新打开窗口。');return floorContext(current,index,message);}});if(!view)body.append(node('p','','请等待聊天输入框加载后重新打开。'));}
     catch(error){view?.dispose();view=null;body.append(node('p','',error.message));}
    },error=>{if(run===epoch)loading.fail(error,start);});
   };
   start();
   button.setAttribute('aria-expanded','true');dock.setOpen(true);
  };
  const dispose=()=>{close();dock.dispose();mounted.delete(element);};mounted.set(element,{dispose,index,message,chatKey});return dispose;
 }
 const surface=globalThis.__TAURITAVERN__?.api?.chatSurface,managed=surface?.isManagedOwnershipRequired?.()===true;
 if(managed)surface.registerParticipant({id:'amin-os/reply-floor',protocolVersion:surface.protocolVersion,didMount:({element})=>{if(disposed)return;owned.add(element);attach(element);return ()=>{owned.delete(element);mounted.get(element)?.dispose();};}});
 const scheduler=observeChatFloors(elements=>{if(disposed)return;const ctx=getContext();for(const [element,item]of mounted)if(!element.isConnected||item.chatKey!==key(ctx)||ctx?.chat?.[item.index]!==item.message||Number(element.getAttribute('mesid'))!==item.index)item.dispose();for(const element of managed?owned:elements)attach(element);},{document,getContext});
 return {refresh:()=>scheduler.refresh(),dispose(){if(disposed)return;disposed=true;scheduler.dispose();for(const item of [...mounted.values()])item.dispose();owned.clear();}};
}
