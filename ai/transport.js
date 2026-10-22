import {parseRequestBody,buildRequestBody} from './request-body.js';
import { waitForSignal } from './signal.js';
const targetQueues=new Map();
const defaults={requestBody:'',stream:false,queueMode:'serial',enabled:false,baseUrl:'',model:'',maxTokens:4096,timeoutSeconds:120,rememberKey:false,apiKey:'',structuredOutput:false};
export function endpointFor(baseUrl){
 let url;try{url=new URL(baseUrl.trim());}catch{throw new Error('请输入完整的 API 地址，例如 https://api.example.com/v1');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('API 地址只允许 http/https，不要在地址内填写密钥、参数或账号密码');
 let pathname=url.pathname.replace(/\/+$/,'');if(!pathname.endsWith('/chat/completions'))pathname=(pathname||'/v1')+'/chat/completions';url.pathname=pathname;return url.href;
}
export function validateApiSettings(value){
 const c={...defaults,...value};
 const extra=parseRequestBody(c.requestBody);c.requestBody=Object.keys(extra).length?JSON.stringify(extra,null,2):'';
 if(typeof c.stream!=='boolean'||!['serial','parallel'].includes(c.queueMode))throw Error('运行策略无效');
 if(typeof c.enabled!=='boolean'||typeof c.rememberKey!=='boolean'||typeof c.structuredOutput!=='boolean'||typeof c.baseUrl!=='string'||typeof c.model!=='string'||typeof c.apiKey!=='string')throw new Error('API 配置格式无效');
 if(!Number.isInteger(c.maxTokens)||c.maxTokens<1||c.maxTokens>131072)throw new Error('输出长度需为 1–131072 的整数');
 if(!Number.isFinite(c.timeoutSeconds)||c.timeoutSeconds<10||c.timeoutSeconds>600)throw new Error('超时时间需为 10–600 秒');
 c.baseUrl=c.baseUrl.trim();c.model=c.model.trim();c.apiKey=c.apiKey.trim();
 if(c.enabled){endpointFor(c.baseUrl);if(!c.model)throw new Error('请填写模型名称');}
 return c;
}
/** All API settings are browser-local. Keys are session-only unless explicitly remembered. */
export function createApiSettings(storage,namespace){
 const key=`dynamic-map.api:${namespace}`,secretKey=`${key}:secret`;let value={...defaults};
 try{const raw=JSON.parse(storage.getItem(key)||'{}');value=validateApiSettings({...raw,apiKey:raw.rememberKey?storage.getItem(secretKey)||'':''});}catch{}
 return {snapshot:()=>({...value}),save(config){const next=validateApiSettings(config),{apiKey,...publicFields}=next;
  if(next.rememberKey&&apiKey)storage.setItem(secretKey,apiKey);else storage.removeItem(secretKey);
  storage.setItem(key,JSON.stringify(publicFields));value=next;return {...value};
 }};
}
/**
 * Channels whose endpoint rejected response_format. A channel is its endpoint plus model;
 * once recorded, structured requests to it are sent without the field.
 */
export function createStructuredSupport(storage,namespace){
 const key=`amin-os.ai-structured-unsupported:${namespace}`;let ids=new Set();
 try{const saved=JSON.parse(storage?.getItem(key)||'[]');if(Array.isArray(saved))ids=new Set(saved.filter(id=>typeof id==='string'));}catch{}
 const save=()=>{try{storage?.setItem(key,JSON.stringify([...ids]));}catch{}};
 return {unsupported:id=>ids.has(id),mark(id){ids.add(id);save();},reset(){ids.clear();save();},list:()=>[...ids]};
}
export const structuredChannel=config=>`${endpointFor(config.baseUrl)}|${config.model}`;
const sessionStructured=createStructuredSupport(null,'session');
const mentionsResponseFormat=async response=>{try{return /response_format/i.test(await response.text());}catch{return false;}};
async function generateTextInternal(ctx,config,request,{fetchImpl=globalThis.fetch,signal,structured=sessionStructured}={}){
 const c=validateApiSettings(config);
 if(!c.enabled){if(typeof ctx?.generateRaw!=='function')throw new Error('请配置酒馆模型，或在设置中启用独立 API');const {messages,schema,...hostRequest}=request;if(messages)hostRequest.prompt=messages.filter((_,i)=>i>0).map(m=>`[${m.role}]\n${m.content}`).join('\n\n');return ctx.generateRaw(hostRequest);}
 const controller=new AbortController(),abort=()=>controller.abort();
 if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,c.timeoutSeconds*1000);
 try{
  const headers={'Content-Type':'application/json'};if(c.apiKey)headers.Authorization=`Bearer ${c.apiKey}`;
  const channel=structuredChannel(c),post=body=>fetchImpl(endpointFor(c.baseUrl),{method:'POST',headers,credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal,body:JSON.stringify(body)});
  const {schema,...plain}=request,wantsSchema=!!(schema&&c.structuredOutput&&!structured.unsupported(channel));
  let body=buildRequestBody(c,wantsSchema?request:plain),response=await post(body);
  // An endpoint without json_schema support answers 400 naming response_format: drop it, retry once and remember.
  if(!response.ok&&response.status===400&&wantsSchema&&Object.hasOwn(body,'response_format')&&await mentionsResponseFormat(response)){structured.mark(channel);body=buildRequestBody(c,plain);response=await post(body);}
  if(!response.ok)throw new Error(`独立 API 请求失败（HTTP ${response.status}），请检查地址、密钥、模型名称及额度`);
  if(body.stream&&response.headers?.get('content-type')?.includes('text/event-stream'))return await readStream(response,controller.signal);
  let data;try{data=await response.json();}catch{throw new Error('API 返回的不是有效 JSON 响应');}
  const choice=data?.choices?.[0];if(choice?.finish_reason==='length')throw new Error('模型输出被截断，请增加输出长度后重新生成');
  const content=choice?.message?.content;
  const text=typeof content==='string'?content:Array.isArray(content)?content.filter(x=>x.type==='text'&&typeof x.text==='string').map(x=>x.text).join(''):'';
  if(!text.trim())throw new Error('API 未返回文本，请确认使用兼容 Chat Completions 的模型');return text;
 }catch(error){
  if(controller.signal.aborted)throw new Error(signal?.aborted?'已取消生成，未应用结果':'独立 API 请求超时，请稍后重试或增加超时时间');
  if(error instanceof TypeError)throw Object.assign(new Error('无法连接独立 API，请检查网络、地址以及服务是否允许浏览器跨域请求'),{code:'AI_NETWORK'});throw error;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

// Mobile WebViews (TauriTavern on Android/iOS) suspend network requests while the
// app is in the background, so a request in flight fails as a network error.
// That is not a bad address or CORS: once the page is visible again the same
// request is sent once more. Nothing has been applied when it fails.
let backgroundCount=0;
const pageDocument=()=>globalThis.document;
try{pageDocument()?.addEventListener?.('visibilitychange',()=>{if(pageDocument().visibilityState==='hidden')backgroundCount++;});}catch{}
export const pageVisibility={
 count:()=>backgroundCount+(pageDocument()?.visibilityState==='hidden'?1:0),
 whenVisible(signal){const doc=pageDocument();if(!doc||doc.visibilityState!=='hidden')return Promise.resolve();
  return new Promise((resolve,reject)=>{const done=()=>{if(doc.visibilityState==='hidden')return;cleanup();resolve();},stop=()=>{cleanup();reject(signal.reason);},cleanup=()=>{doc.removeEventListener('visibilitychange',done);signal?.removeEventListener('abort',stop);};
   doc.addEventListener('visibilitychange',done);signal?.addEventListener('abort',stop,{once:true});});},
};
const BACKGROUND_MESSAGE='TT 酒馆切到后台时，系统暂停了网络连接，本次生成中断，未应用任何结果。回到前台后已自动重试一次，仍未成功；请让应用保持在前台直到生成完成，再重新生成。';
async function withBackgroundRetry(run,signal,visibility){
 const seen=visibility.count();
 try{return await run();}
 catch(error){
  if(error?.code!=='AI_NETWORK'||signal.aborted||visibility.count()===seen)throw error;
  await visibility.whenVisible(signal);
  try{return await run();}
  catch(retry){if(retry?.code==='AI_NETWORK')throw Object.assign(new Error(BACKGROUND_MESSAGE),{code:'AI_BACKGROUND'});throw retry;}
 }
}
export async function generateText(ctx,config,request,options={}){
 const c=validateApiSettings(config),controller=new AbortController();
 const abort=()=>controller.abort(options.signal.reason);
 if(options.signal?.aborted)abort();options.signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(new Error('模型等待超时，已停止等待；未应用生成结果')),c.timeoutSeconds*1000);
 try{const run=()=>{if(controller.signal.aborted)throw controller.signal.reason;return withBackgroundRetry(()=>generateTextInternal(ctx,c,request,{...options,signal:controller.signal}),controller.signal,options.visibility??pageVisibility);};let task;if(options.targetKey&&c.queueMode==='serial'){const previous=targetQueues.get(options.targetKey)??Promise.resolve();task=previous.catch(()=>{}).then(run);const tracked=task.then(()=>{},()=>{}).finally(()=>{if(targetQueues.get(options.targetKey)===tracked)targetQueues.delete(options.targetKey);});targetQueues.set(options.targetKey,tracked);}else task=Promise.resolve().then(run);task.catch(()=>{});return await waitForSignal(()=>task,controller.signal);}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}

const profileInstances=new WeakMap();
export function createApiProfiles(storage,namespace){let instances=profileInstances.get(storage);if(!instances){instances=new Map();profileInstances.set(storage,instances);}if(instances.has(namespace))return instances.get(namespace);const key='dynamic-map.api-profiles:'+namespace;let state={profiles:[],bindings:{}};const secrets=new Map();try{const saved=JSON.parse(storage.getItem(key));if(saved&&Array.isArray(saved.profiles)&&saved.bindings)state=saved;}catch{}
 const api={list:()=>state.profiles.map(p=>({id:p.id,name:p.name})),binding:mode=>state.bindings[mode]??'',bind(mode,id){state.bindings[mode]=id;storage.setItem(key,JSON.stringify(state));},save(id,name,config){const valid=validateApiSettings(config);const {apiKey,...fields}=valid;secrets.set(id,apiKey);const record={id,name,...fields};if(valid.rememberKey)record.apiKey=apiKey;state.profiles=state.profiles.filter(p=>p.id!==id);state.profiles.push(record);storage.setItem(key,JSON.stringify(state));},resolve(mode,fallback){const p=state.profiles.find(p=>p.id===state.bindings[mode]);return p?validateApiSettings({...p,apiKey:secrets.get(p.id)??p.apiKey??''}):fallback;},get(id){const p=state.profiles.find(p=>p.id===id);return p?validateApiSettings({...p,apiKey:secrets.get(id)??p.apiKey??''}):null;},remove(id){state.profiles=state.profiles.filter(p=>p.id!==id);secrets.delete(id);for(const mode of Object.keys(state.bindings))if(state.bindings[mode]===id)delete state.bindings[mode];storage.setItem(key,JSON.stringify(state));}};instances.set(namespace,api);return api;
}

async function readStream(response,signal){
 if(!response.body)throw Error('API 未返回流式内容');const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',text='',finished=false;
 const abort=()=>void reader.cancel();signal.addEventListener('abort',abort,{once:true});
 const event=block=>{const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data)return;if(data==='[DONE]'){finished=true;return;}const value=JSON.parse(data);if(value.error)throw Error('流式 API 返回错误');const choice=value.choices?.[0];if(choice?.finish_reason==='length')throw Error('模型输出被截断，请增加输出长度');if(choice?.finish_reason==='stop')finished=true;const delta=choice?.delta?.content;if(typeof delta==='string')text+=delta;};
 try{while(true){const chunk=await reader.read();if(signal.aborted)throw Error('生成已取消');buffer+=decoder.decode(chunk.value??new Uint8Array(),{stream:!chunk.done}).replace(/\r\n/g,'\n');let split;while((split=buffer.indexOf('\n\n'))>=0){event(buffer.slice(0,split));buffer=buffer.slice(split+2);}if(chunk.done){if(buffer.trim())event(buffer);break;}if(finished)break;}if(!finished)throw Error('模型流式响应中断，未应用结果');if(!text.trim())throw Error('API 未返回文本');return text;}finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
