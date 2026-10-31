import {collectWorldbooks,freshWorldbook} from '../../../worldbook-sources.js';
import {liveCard} from '../../../cardprofile/live.js';
/** Pure injected adapter. Production readMapSources always fetches fresh saved worldbook bodies. */
export async function collectMapSources(ctx,wi,options={}){
 const guard=options.guard??(()=>{});guard();
 if(ctx.groupId!=null&&ctx.groupId!=='')throw Error('请在单角色聊天中生成地图，群聊暂不支持角色素材读取');
 const character=liveCard(ctx,ctx.characters?.[ctx.characterId]);if(!character)throw Error('请先打开角色卡的聊天');
 const cd=character.data??{},card={};if(options.includeCharacter!==false)for(const [key,label]of [['name','名称'],['description','描述'],['personality','性格'],['scenario','场景'],['first_mes','开场白'],['mes_example','对话示例'],['creator_notes','作者备注']])card[label]=cd[key]??character[key]??'';
 // Character text is independent from explicit worldbook selection.
 const books=await collectWorldbooks(ctx,{legacyBindings:true,...options,includeCharacter:false},{...options,check:guard,loadWorldInfo:async()=>wi,readBook:options.readBook??(name=>wi.loadWorldInfo(name)),includeKeys:true});
 const source={角色卡:card,世界书:books.map(b=>({名称:b.name,条目:b.entries.map(e=>({标题:e.title,关键词:e.keys??[],内容:e.content}))}))};
 return {source,books:source.世界书.map(b=>b.名称),characters:JSON.stringify(source).length};
}
export async function readMapSources(ctx,options={}){
 const wi=options.readWorldbooks===false?{}:await (options.loadWorldInfo??(()=>import('/scripts/world-info.js')))();
 return collectMapSources(ctx,wi,{...options,readBook:options.readBook??(name=>freshWorldbook(ctx,name,{...options,check:options.guard}))});
}
