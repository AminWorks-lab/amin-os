import {liveEntry} from '../cardprofile/live.js';
export function bookCatalog(ctx,config){
 const wi=config.world_info??config,books=new Map();
 const add=(name,source,data)=>{if(typeof name!=='string'||!name.trim())return;const b=books.get(name)??{name,sources:[],data};if(!b.sources.includes(source))b.sources.push(source);books.set(name,b);};
 for(const name of config.selected_world_info??wi.globalSelect??[])add(name,'全局启用');
 add(ctx.chatMetadata?.world_info,'当前聊天');add(ctx.powerUserSettings?.persona_description_lorebook,'人格绑定');
 const group=(ctx.groups??[]).find(g=>String(g.id)===String(ctx.groupId));
 const characters=group?(ctx.characters??[]).filter(c=>group.members?.includes(c.avatar)):[ctx.characters?.[ctx.characterId]].filter(Boolean);
 for(const c of characters){const primary=c.data?.extensions?.world;add(primary,'角色绑定');const file=(c.avatar??'').replace(/\.[^.]+$/,'');for(const name of wi.charLore?.find(x=>x.name===file)?.extraBooks??[])add(name,'角色附加');if(!primary&&c.data?.character_book?.entries)add('内嵌世界书：'+c.name,'角色内嵌',c.data.character_book);}
 return [...books.values()];
}
export async function readBook(ctx,book){
 const data=book.data??await ctx.loadWorldInfo?.(book.name);
 if(!data?.entries)throw Error(`无法读取世界书「${book.name}」`);
 return Object.entries(data.entries).filter(([,e])=>e.disable!==true&&e.enabled!==false&&typeof e.content==='string'&&e.content.trim()).map(([id,e])=>({book:book.name,id:String(e.uid??e.id??id),title:e.comment??e.name??'',content:liveEntry(ctx,book.name,e.uid??e.id??id,e.content)}));
}
