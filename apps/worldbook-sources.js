import {bookCatalog} from './effects/books.js';
import {liveEntry,liveNotes,NOTES_BOOK} from './cardprofile/live.js';
const unique=values=>[...new Set(values.filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim()))];
export function selectedBookNames(config){return unique(Array.isArray(config.selectedBooks)?config.selectedBooks:Array.isArray(config.extraBooks)?config.extraBooks:String(config.books??config.extraBooks??'').split(/\r?\n/));}
export function resolvedBookNames(config,books){const selected=selectedBookNames(config);if(!Array.isArray(config.selectedBooks)&&config.legacyBindings){for(const b of books)if(b.sources.includes('当前聊天')||((config.includeGlobalBooks??config.includeGlobal)&&b.sources.includes('全局启用')))selected.push(b.name);}return unique(selected);}
export async function worldbookChoices(ctx,{loadWorldInfo=()=>import('/scripts/world-info.js'),check=()=>{}}={}){
 check();const wi=await loadWorldInfo();check();const settings=wi.world_info??ctx.worldInfoSettings?.world_info??{};
 const globals=wi.selected_world_info??settings.globalSelect;if(!Array.isArray(globals))throw Error('宿主未提供当前启用的世界书列表，未用全库替代');
 const books=bookCatalog(ctx,{selected_world_info:globals,world_info:settings}),grouped=ctx.groupId!=null&&ctx.groupId!=='';
 return books.map(b=>({...b,automatic:!grouped&&b.sources.some(s=>['角色绑定','角色附加','角色内嵌'].includes(s))}));
}
export async function freshWorldbook(ctx,name,{fetcher=fetch,check=()=>{},signal}={}){
 check();if(typeof ctx.getRequestHeaders!=='function')throw Error('宿主缺少世界书请求接口，无法重新读取');
 const response=await fetcher('/api/worldinfo/get',{method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify({name}),cache:'no-store',signal});check();
 if(!response.ok)throw Error('无法重新读取世界书：'+name);const book=await response.json();check();return book;
}
export async function collectWorldbooks(ctx,config,options={}){
 if(config.readWorldbooks===false)return [];
 const check=options.check??(()=>{}),books=await worldbookChoices(ctx,options),selected=resolvedBookNames(config,books),missing=selected.filter(name=>!books.some(b=>b.name===name));
 if(missing.length)throw Error('所选世界书当前未启用，请在生成设置中取消勾选或先启用：'+missing.join('、'));
 const wanted=books.filter(b=>selected.includes(b.name)||(config.includeCharacter&&b.automatic)),result=[];
 if(config.legacyBindings){const priority=b=>b.sources.includes('角色绑定')?0:b.sources.includes('角色附加')?1:b.sources.includes('当前聊天')?2:b.data?4:3;wanted.sort((a,b)=>priority(a)-priority(b));}
 for(const b of wanted){check();options.onProgress?.('读取世界书 '+(result.length+1)+'/'+wanted.length+'：'+b.name);const book=b.data??await (options.readBook??((name)=>freshWorldbook(ctx,name,options)))(b.name);check();
  if(!book?.entries||typeof book.entries!=='object')throw Error('世界书读取失败：'+b.name);
  result.push({name:config.legacyBindings?(b.data?.name||b.name):b.name,entries:Object.values(book.entries).filter(e=>e&&!e.disable&&e.enabled!==false&&typeof e.content==='string').map(e=>({title:e.comment??e.name??'',content:liveEntry(ctx,b.name,e.uid??e.id,e.content),...(options.includeKeys?{keys:e.key??e.keys??[]}:{})}))});
 }
 const notes=liveNotes(ctx);if(notes.length)result.push({name:NOTES_BOOK,entries:notes.map(n=>({title:n.title,content:n.content,...(options.includeKeys?{keys:[]}:{})}))});
 return result;
}
export const sourceRole=ctx=>ctx.groupId!=null&&ctx.groupId!==''?'group:'+ctx.groupId:'character:'+(ctx.characters?.[ctx.characterId]?.avatar??'');
// Book selections include chat bindings, so they must never be shared across chats.
const sourceChat=ctx=>{const id=ctx.getCurrentChatId?.();return (typeof id==='string'&&id)||(typeof id==='number'&&Number.isFinite(id))?'chat:'+id:null;};
export function sourceSettings(ctx,app,legacy={}){
 const saved=ctx.extensionSettings?.amin_os_worldbook_sources_v1?.[app]?.[sourceRole(ctx)]??{},chat=sourceChat(ctx);
 return {includeCharacter:true,readWorldbooks:true,...legacy,...(typeof saved.includeCharacter==='boolean'?{includeCharacter:saved.includeCharacter}:{}),...(typeof saved.readWorldbooks==='boolean'?{readWorldbooks:saved.readWorldbooks}:{}),selectedBooks:structuredClone(chat?saved.selectedBooksByChat?.[chat]??null:null)};
}
export function saveSourceSettings(ctx,app,value){
 if(!ctx.extensionSettings)throw Error('宿主设置尚未就绪');const all=ctx.extensionSettings.amin_os_worldbook_sources_v1??={};all[app]??={};const role=all[app][sourceRole(ctx)]??={},chat=sourceChat(ctx);
 role.includeCharacter=value.includeCharacter!==false;role.readWorldbooks=value.readWorldbooks!==false;
 if(chat){role.selectedBooksByChat??={};role.selectedBooksByChat[chat]=Array.isArray(value.selectedBooks)?unique(value.selectedBooks):null;}
 ctx.saveSettingsDebounced?.();
}
