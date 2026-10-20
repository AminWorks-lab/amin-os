import {readRenderedMessage} from './tts/rendered-text.js';
import {mountFloorControl} from '../settings/floor-layout.js';
import {observeChatFloors} from './floor-scheduler.js';
import {messageVersion,persistAudioMessageId,audioMessageSource} from './floor-message.js';
import {floorLoading} from './lazy-view.js';
import {views} from './views.js';
import {STORY_APPS,renderStoryGate} from './shared/story-readiness.js';

export function installExtraFloorButtons(id){
 const getContext=()=>globalThis.SillyTavern?.getContext?.(),mounted=new Map(),owned=new Set();
 const apps={scene:{title:'场景与时间',icon:'◷ '},journal:{title:'剧情档案',icon:'▤ '},dice:{title:'骰子',icon:'⚄ '},organizations:{title:'势力概览',icon:'◎ '},tts:{title:'语音朗读',icon:'▷ '},effects:{title:'能力面板',icon:'✦ '},information:{title:'信息面板',icon:'▤ '},worldbooks:{title:'世界书管理',icon:'▥ '}};
 Object.assign(apps,{characters:{title:'人物卡',icon:'♙ '},inventory:{title:'背包与账本',icon:'▣ '},relationships:{title:'人物关系',icon:'♧ '},saves:{title:'跨应用存档',icon:'▤ '}});
 const app=apps[id];if(!app)throw Error('未知楼层应用：'+id);const titleText=app.title,loadView=views[id];
 const key=ctx=>JSON.stringify([ctx?.getCurrentChatId?.()??ctx?.chatId,ctx?.characterId,ctx?.groupId]);
 const node=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e;};
 function attach(element){
  if(mounted.has(element))return mounted.get(element).dispose;
  const ctx=getContext(),index=Number(element.getAttribute('mesid')),message=ctx?.chat?.[index],chatKey=key(ctx),revision=messageVersion(message),metadata=ctx?.chatMetadata;
  if(!message||message.is_system)return;
  const host=node('div','amin-extra-floor'),button=node('button','',app.icon+titleText);button.type='button';button.setAttribute('aria-expanded','false');button.title='打开当前聊天的'+titleText;
  let view=null,windowElement=null,epoch=0;
  const dock=mountFloorControl(element,id,host,button);
  function close(){epoch++;view?.dispose();view=null;windowElement?.remove();windowElement=null;button.setAttribute('aria-expanded','false');dock.setOpen(false);}
  button.onclick=()=>{
   if(windowElement){close();return;}
   windowElement=node('section','amin-reply-floor-window amin-extra-floor-window');windowElement.setAttribute('aria-label','第 '+(index+1)+' 楼'+titleText);
   const bar=node('header','amin-reply-floor-header'),title=node('strong','',titleText+' · 第 '+(index+1)+' 楼'),collapse=node('button','','收起');collapse.type='button';collapse.onclick=close;bar.append(title,collapse);
   const body=node('div','amin-reply-floor-body amin-ui');windowElement.append(bar);
   if(STORY_APPS.includes(id)){const gate=node('div','amin-story-gate amin-ui');gate.setAttribute('role','status');try{renderStoryGate(gate,getContext(),document);}catch{gate.hidden=true;}windowElement.append(gate);}
   windowElement.append(body);host.append(windowElement);
   if(id!=='tts')body.append(node('p','amin-reply-floor-note','显示当前聊天的数据，操作与 OS 内应用共享；此入口不是历史楼层快照。'));
   const run=++epoch;
   const start=()=>{
    const loading=floorLoading(body);let loaded=false;
    (async()=>{
     const {mount:mountApp}=await loadView();loaded=true;
     if(run!==epoch)return null;
     let options;
     if(id==='tts'){
      await persistAudioMessageId(ctx,message);
      const source=await audioMessageSource(chatKey,message);
      const current=getContext();if(run!==epoch||!element.isConnected||current?.chatMetadata!==metadata||key(current)!==chatKey||current?.chat?.[index]!==message||messageVersion(message)!==revision)return null;
      options={readMessage:()=>readRenderedMessage(element),source};
     }
     loading.done();
     return mountApp(body,options);
    })().then(value=>{loading.done();if(run!==epoch){value?.dispose?.();return;}view=value;},error=>{if(run!==epoch)return;if(loaded){loading.done();body.append(node('p','',error.message));}else loading.fail(error,start);});
   };
   start();
   button.setAttribute('aria-expanded','true');dock.setOpen(true);
  };
  const dispose=()=>{close();dock.dispose();mounted.delete(element);};mounted.set(element,{dispose,index,message,chatKey,metadata,revision});return dispose;
 }
 const surface=globalThis.__TAURITAVERN__?.api?.chatSurface,managed=surface?.isManagedOwnershipRequired?.()===true;
 if(managed)surface.registerParticipant({id:'amin-os/'+id+'-floor',protocolVersion:surface.protocolVersion,didMount:({element})=>{owned.add(element);attach(element);return ()=>{owned.delete(element);mounted.get(element)?.dispose();};}});
 function refresh(elements){const ctx=getContext();for(const [element,item]of mounted)if(!element.isConnected||item.chatKey!==key(ctx)||item.metadata!==ctx?.chatMetadata||ctx?.chat?.[item.index]!==item.message||Number(element.getAttribute('mesid'))!==item.index||(id==='tts'&&messageVersion(item.message)!==item.revision))item.dispose();for(const element of managed?owned:elements)attach(element);}
 const subscription=observeChatFloors(refresh,{getContext});return {refresh:subscription.refresh,dispose(){subscription.dispose();for(const item of [...mounted.values()])item.dispose();}};
}
