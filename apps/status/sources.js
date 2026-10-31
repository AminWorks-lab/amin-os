import {collectWorldbooks} from '../worldbook-sources.js';
import {liveCard} from '../cardprofile/live.js';
export function readStatusPersona(ctx){return {名称:typeof ctx.name1==='string'&&ctx.name1.trim()?ctx.name1:'用户',描述:typeof ctx.powerUserSettings?.persona_description==='string'?ctx.powerUserSettings.persona_description:''};}
export function requireStatusPersona(ctx){const persona=readStatusPersona(ctx);if(!persona.描述.trim())throw Error('当前用户尚未设置Persona描述，请填写用户设定或取消“读取用户设定描述”。');return persona;}
export async function collectStatusSources(ctx,config={},options={}){
 const persona=config.includePersona===true?requireStatusPersona(ctx):null;
 const c=liveCard(ctx,ctx.characters?.[ctx.characterId]),d=c?.data??{},card={};
 if(config.includeCharacter!==false)for(const [key,label]of [['name','名称'],['description','描述'],['personality','性格'],['scenario','场景'],['first_mes','开场白'],['mes_example','对话示例']])card[label]=d[key]??c?.[key]??'';
 // Character text is collected above; book bodies depend only on book selection.
 const books=await collectWorldbooks(ctx,{legacyBindings:true,...config,includeCharacter:false},{...options,includeKeys:true});
 return {...(persona?{用户设定:persona}:{}),角色卡:card,世界书:books.map(b=>({名称:b.name,条目:b.entries.map(e=>({标题:e.title,关键词:e.keys??[],内容:e.content}))}))};
}
