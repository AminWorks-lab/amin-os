import {bookCatalog,readBook} from '../effects/books.js';
import {hostWorldSettings} from '../reply/world-context.js';
import {liveCard,liveNotes} from '../cardprofile/live.js';
export const catalog=async ctx=>bookCatalog(ctx,await hostWorldSettings(ctx));
export async function localSources(ctx,{books=[],includeCard=true,includeChat=true,check=()=>{}}={}){
 const docs=[];check();
 if(books.length||includeCard){
  const available=await catalog(ctx);check();const selected=new Map();
  for(const name of books){const book=available.find(b=>b.name===name);if(!book)throw Error(`世界书「${name}」已停用或解绑，请刷新来源`);selected.set(book.name,book);}
  if(includeCard)for(const book of available)if(book.sources.some(s=>['角色绑定','角色附加','角色内嵌'].includes(s)))selected.set(book.name,book);
  for(const book of selected.values()){const entries=await readBook(ctx,book);check();for(const e of entries)docs.push({id:'book:'+JSON.stringify([book.name,e.id]),title:book.name+' / '+(e.title||'条目 '+e.id),text:e.content});}
 }

 if(includeCard){const group=(ctx.groups??[]).find(g=>String(g.id)===String(ctx.groupId));const chars=group?(ctx.characters??[]).filter(c=>group.members?.includes(c.avatar)):[ctx.characters?.[ctx.characterId]].filter(Boolean);
  for(const c0 of chars){const c=liveCard(ctx,c0),d=c.data??c;docs.push({id:'card:'+c.avatar,title:'角色卡 · '+c.name,text:JSON.stringify({name:c.name,description:d.description??c.description,personality:d.personality??c.personality,scenario:d.scenario??c.scenario,mes_example:d.mes_example??c.mes_example})});}
 }
 if(includeCard)for(const [i,n]of liveNotes(ctx).entries())docs.push({id:'note:'+i,title:n.title,text:n.content});
 if(includeChat)for(const [i,m]of (ctx.chat??[]).entries())if(m.mes&&!m.is_system)docs.push({id:'chat:'+i,title:`聊天第 ${i+1} 楼 · ${m.name??''}`,text:m.mes});
 return docs;
}
export function retrieve(docs,queries,{limit=90000,world=false}={}){
 const terms=[...new Set(queries.map(x=>String(x).trim().toLowerCase()).filter(Boolean))];const chunks=[];
 for(const d of docs){let n=0;for(let start=0;start<d.text.length;start+=4800){const text=d.text.slice(start,start+5000),lower=(d.title+' '+text).toLowerCase();const score=terms.reduce((s,q)=>s+(lower.includes(q)?q===terms[0]?8:1:0),0);chunks.push({...d,id:d.id+':'+n,title:d.title+(d.text.length>5000?' · 片段 '+(n+1):''),text,score});n++;if(start+5000>=d.text.length)break;}}
 chunks.sort((a,b)=>b.score-a.score);const relevant=world?chunks:chunks.filter(d=>d.score>0);let chars=0;const sources=[];
 for(const d of relevant){if(chars+d.text.length>limit)continue;chars+=d.text.length;sources.push(d);}
 return {sources,report:{total:docs.length,chunks:chunks.length,matched:relevant.length,included:sources.length,omitted:relevant.length-sources.length,characters:chars}};
}
export function searchEndpoint(value,origin='http://localhost'){
 const url=new URL(value||'https://api.tavily.com/search',origin);
 if(url.username||url.password||url.hash||url.search||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.origin!==new URL(origin).origin)throw Error('搜索地址需为 HTTPS、同源地址或本地代理，不能包含账号或查询参数');return url.href;
}
export async function webSearch({query,key,endpoint,signal,fetcher=fetch,origin=globalThis.location?.origin??'http://localhost'}){
 if(!key?.trim())throw Error('请先在检索设置填写 Tavily 搜索 API Key');
 const url=searchEndpoint(endpoint,origin),controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,30000);
 try{const res=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key.trim()},body:JSON.stringify({query,max_results:8,search_depth:'basic',include_answer:false,include_raw_content:false}),signal:controller.signal,credentials:'omit',redirect:'error'});
  if(!res.ok)throw Error(`联网搜索失败（HTTP ${res.status}），请检查搜索额度、密钥和地址`);const data=await res.json();if(!Array.isArray(data.results))throw Error('搜索服务返回格式不兼容，需要 Tavily Search 格式');
  return data.results.filter(r=>typeof r.content==='string'&&r.content.trim()).map((r,i)=>{let link='';try{const u=new URL(r.url);if(['https:','http:'].includes(u.protocol))link=u.href;}catch{}return {id:'web:'+i,title:r.title||'网页搜索摘要',url:link,text:r.content};});
 }catch(e){if(controller.signal.aborted)throw Error(signal?.aborted?'已取消联网搜索':'联网搜索超时');if(e instanceof TypeError)throw Error('无法连接搜索服务；请检查网络或浏览器跨域限制，可填写兼容的同源代理地址');throw e;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
