import {summarizeTiles} from './tile-live.js';
import {subscribeStateChanges} from './apps/shared/operations.js';
import {readStoryRoot} from './apps/story-state/access.js';
import {readStore as readEffects,activeEffects} from './apps/effects/model.js';
import {currentEntries} from './apps/journal/model.js';

export const LIVE_TILE_INTERVAL=500;
const attempt=read=>{try{return read();}catch{return null;}};
function readWorld(ctx){
 const raw=readStoryRoot(ctx,'状态栏');if(raw===undefined||raw===null||raw==='')return null;
 return typeof raw==='string'?JSON.parse(raw):raw;
}
/** Read the current chat through the background services already loaded at startup. */
export function collectLiveSnapshot(ctx,services={}){
 if(!ctx?.chatMetadata||ctx.getCurrentChatId?.()==null)return {chat:false};
 const scene=attempt(()=>services.scene?.read());
 const journal=attempt(()=>services.journal?.read());
 const effects=attempt(()=>readEffects(ctx));
 return {
  chat:true,
  world:attempt(()=>readWorld(ctx)),
  characters:attempt(()=>services.characters?.read().characters)??null,
  scene:scene?{clock:scene.clock,periods:scene.periods,sceneName:scene.scenes?.[scene.activeSceneId]?.name??''}:null,
  effects:effects?.events?.length?attempt(()=>activeEffects(effects,ctx.chat)):null,
  journal:journal?.events?.length?attempt(()=>currentEntries(journal,ctx.chat)):null,
  inventory:attempt(()=>services.inventory?.read())??null,
  relationships:attempt(()=>services.relationships?.read())??null,
 };
}
/**
 * Publishes tile summaries on chat changes and data saves, at most once per interval.
 * `services` maps app ids to promises of their background services.
 */
export function createLiveTileFeed({getContext,services={},apply,enabled=()=>true,subscribeSettings,interval=LIVE_TILE_INTERVAL,now=()=>Date.now(),schedule=setTimeout}){
 const ready={},removers=[];let timer=null,last=-Infinity,disposed=false;
 function publish(){
  timer=null;if(disposed)return;last=now();
  let summaries={};
  if(enabled())try{summaries=summarizeTiles(collectLiveSnapshot(getContext(),ready));}catch{summaries={};}
  apply(summaries);
 }
 function refresh(){if(disposed||timer!==null)return;timer=schedule(publish,Math.max(0,last+interval-now()));}
 for(const [id,promise]of Object.entries(services))Promise.resolve(promise).then(result=>{
  const service=result&&'value' in result?result.value:result;if(disposed||!service)return;
  ready[id]=service;if(typeof service.subscribe==='function')try{removers.push(service.subscribe(refresh));}catch{/* Saves and chat changes still refresh. */}
  refresh();
 },()=>{});
 removers.push(subscribeStateChanges(detail=>{if(['applied','saved'].includes(detail?.phase))refresh();}));
 const ctx=getContext(),events=ctx?.eventTypes??ctx?.event_types??{};
 if(events.CHAT_CHANGED&&ctx?.eventSource?.on){const changed=()=>refresh();ctx.eventSource.on(events.CHAT_CHANGED,changed);removers.push(()=>ctx.eventSource.removeListener?.(events.CHAT_CHANGED,changed));}
 if(subscribeSettings)removers.push(subscribeSettings(refresh));
 refresh();
 return {refresh,dispose(){disposed=true;clearTimeout(timer);for(const remove of removers)try{remove?.();}catch{}}};
}
