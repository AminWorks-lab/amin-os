import { uuid } from '../uuid.js';
import {parseRequestBody} from './request-body.js';
import {fetchModels} from './models.js';
import {getAI,AI_APPS} from './service.js';
import {renderPresetEditor} from './preset-editor.js';
import {globalContextLine} from '../apps/shared/context-line.js';

const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
const input=(value='',type='text')=>{const e=el('input');e.type=type;e.value=value;return e;};
const field=(parent,label,control)=>{const wrap=el('label',null,'amin-field');if(control.type==='checkbox')wrap.classList.add('amin-check');wrap.append(el('span',label),control);parent.append(wrap);return control;};
const select=(items,value)=>{const e=el('select');for(const p of items){const o=el('option',p.name);o.value=p.id;e.append(o);}e.value=value;return e;};
const button=(text,fn)=>{const e=el('button',text);e.type='button';if(['保存全局默认设置','保存预设'].includes(text))e.classList.add('amin-primary');e.onclick=fn;return e;};
const card=(parent,title,description)=>{const e=el('section',null,'amin-card amin-stack');e.append(el('h3',title,'amin-section-heading'));if(description)e.append(el('p',description,'amin-meta'));parent.append(e);return e;};
const grid=parent=>{const e=el('div',null,'amin-form-grid');parent.append(e);return e;};
const toolbar=(parent,...actions)=>{const e=el('div',null,'amin-toolbar');e.append(...actions);parent.append(e);return e;};

export function mount(target){
 const ai=getAI();target.classList.add('amin-ai','amin-app-page');
 let active='api',modelController,unsubscribe,selectedProfile=ai.profiles.binding('shared')||'',feedback='',feedbackState='';
 function draw(){
  modelController?.abort();unsubscribe?.();
  target.replaceChildren();
  const heading=el('header',null,'amin-context');heading.append(el('p',globalContextLine('模型连接、应用渠道与生成预设','保存后下一次生成生效')));target.append(heading);
  const tabs=el('nav',null,'amin-tabs');tabs.setAttribute('aria-label','AI 设置分类');target.append(tabs);
  const notice=el('p',feedback,'amin-result');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');notice.dataset.state=feedbackState;notice.hidden=!feedback;target.append(notice);
  const report=(text,state='success')=>{feedback=text;feedbackState=state;notice.textContent=text;notice.dataset.state=state;notice.hidden=!text;};
  const safe=(fn,message='已保存；使用此配置的应用将在下次生成时生效。')=>{try{fn();report(message);}catch(e){report(e.message,'error');}};
  const api=el('section',null,'amin-stack'),config=ai.settings.snapshot();target.append(api);
  const saved=ai.profiles.list();if(!saved.some(p=>p.id===selectedProfile))selectedProfile='';
  const profileCard=card(api,'API 配置库','选择配置会立即设为全局默认。新配置可供多个应用共用。'),profileGrid=grid(profileCard);
  const pick=field(profileGrid,'已保存的 API 设置',select([{id:'',name:'当前设置 / 未选择配置'},...saved],selectedProfile));
  const name=field(profileGrid,'配置名称',input(saved.find(p=>p.id===selectedProfile)?.name||'我的 API'));
  const connection=card(api,'模型连接','读取酒馆配置，或填写独立接口地址和模型。'),connectionGrid=grid(connection);
  const mode=field(connectionGrid,'连接方式',select([{id:'host',name:'读取酒馆配置后直连'},{id:'custom',name:'手动配置直连接口'}],config.enabled?'custom':'host'));
  mode.parentElement.classList.add('amin-span-full');
  const address=field(connectionGrid,'API 地址',input(config.baseUrl,'url')),model=field(connectionGrid,'模型名称',input(config.model)),key=field(connectionGrid,'API 密钥',input(config.apiKey,'password'));key.autocomplete='off';key.spellcheck=false;address.placeholder='https://api.example.com/v1';
  const remember=field(connectionGrid,'记住密钥（仅本浏览器）',input('','checkbox'));remember.checked=config.rememberKey;
  const updateMode=()=>{address.disabled=model.disabled=key.disabled=remember.disabled=mode.value==='host';};mode.onchange=updateMode;updateMode();
  const modelGrid=grid(connection),modelList=field(modelGrid,'可用模型',select([{id:'',name:'请先拉取模型列表'}],''));modelList.disabled=true;
  const execution=card(api,'生成与任务','进行中的任务保留启动时的配置。'),executionGrid=grid(execution);
  const tokens=field(executionGrid,'最大输出 tokens',input(config.maxTokens,'number')),timeout=field(executionGrid,'等待上限（秒，含排队）',input(config.timeoutSeconds,'number'));
  const queue=field(executionGrid,'此渠道的任务策略',select([{id:'serial',name:'依次排队'},{id:'parallel',name:'允许并行'}],config.queueMode));
  const stream=field(executionGrid,'独立 API 流式接收（完整后应用）',input('','checkbox'));stream.checked=config.stream;
  const advanced=el('details',null,'amin-card');advanced.append(el('summary','高级 · 自定义请求参数'));
  const advancedBody=el('div',null,'amin-stack'),requestBody=el('textarea');requestBody.rows=10;requestBody.spellcheck=false;requestBody.style.fontFamily='monospace';requestBody.value=config.requestBody||'';requestBody.placeholder='{\n  "temperature": 0.8,\n  "top_p": 0.95\n}';field(advancedBody,'requestBody（JSON 对象）',requestBody);
  advancedBody.append(el('p','留空使用默认请求体。按顶层字段覆盖，嵌套对象整体替换；null 删除字段。例如用 max_tokens: null 配合 max_completion_tokens。model、messages 和 stream 也可覆盖；覆盖 messages 会替换应用提示词，可能影响输出格式。可在“任务记录”查看实际请求。不要在这里填写 API 密钥或请求头；此处随配置明文保存。','amin-meta'));
  toolbar(advancedBody,button('检查并格式化 JSON',()=>{try{requestBody.value=JSON.stringify(parseRequestBody(requestBody.value),null,2);report('JSON 格式正确，请保存后应用。');}catch(e){report(e.message,'error');}}));advanced.append(advancedBody);api.append(advanced);
  const read=()=>({requestBody:requestBody.value,enabled:mode.value==='custom',baseUrl:address.value,model:model.value,apiKey:key.value,rememberKey:remember.checked,maxTokens:Number(tokens.value),timeoutSeconds:Number(timeout.value),queueMode:queue.value,stream:stream.checked});
  let resolvedConnection;
  const invalidateModels=()=>{modelController?.abort();resolvedConnection=undefined;modelList.replaceChildren();const placeholder=el('option','请重新拉取模型列表');placeholder.value='';modelList.append(placeholder);modelList.disabled=true;};
  for(const control of [address,key])control.addEventListener('input',invalidateModels);
  mode.addEventListener('change',invalidateModels);
  const fetchButton=button('拉取模型列表',async()=>{
   invalidateModels();const controller=new AbortController();modelController=controller;fetchButton.disabled=true;report('正在拉取模型列表…','busy');
   try{const result=await fetchModels(read(),{signal:controller.signal});if(controller!==modelController||controller.signal.aborted)return;resolvedConnection=result.connection;modelList.replaceChildren();const placeholder=el('option',result.models.length?'请选择模型':'接口未返回模型，可手动填写');placeholder.value='';modelList.append(placeholder);for(const id of result.models){const option=el('option',id);option.value=id;modelList.append(option);}modelList.value=result.models.includes(model.value)?model.value:'';modelList.disabled=!result.models.length;report(`已读取 ${result.models.length} 个模型。选择后保存生效；也可以手动填写。`);}
   catch(e){if(controller===modelController&&!controller.signal.aborted)report(e.message,'error');}
   finally{if(controller===modelController)fetchButton.disabled=false;}
  });
  modelList.onchange=()=>{if(!modelList.value)return;if(mode.value==='host'&&resolvedConnection){mode.value='custom';address.value=resolvedConnection.baseUrl;key.value=resolvedConnection.apiKey;remember.checked=false;updateMode();report('已复制酒馆连接供此配置使用，密钥默认仅本次会话保存。请保存配置。');}model.value=modelList.value;};
  toolbar(connection,fetchButton);
  connection.append(el('p','独立接口需允许浏览器跨域请求。密钥默认只保留在当前页面会话中。读取酒馆配置支持 OpenAI、自定义兼容接口与 OpenRouter；只读取地址、模型及允许读取的密钥。密钥不可读取时，请选择手动配置并填写。','amin-meta'));
  const redraw=(message)=>{feedback=message;feedbackState='success';draw();};
  pick.onchange=()=>{try{if(!pick.value){selectedProfile='';ai.profiles.bind('shared','');redraw('已取消配置绑定，保留当前全局设置。');return;}const value=ai.profiles.get(pick.value);if(!value)throw Error('配置不存在');ai.settings.save(value);selectedProfile=pick.value;ai.profiles.bind('shared',selectedProfile);redraw('已设为全局默认配置。');}catch(e){report(e.message,'error');}};
  const saveProfile=copy=>{const label=name.value.trim();if(!label)throw Error('请输入配置名称');const value=read(),id=copy||!selectedProfile?uuid():selectedProfile;ai.profiles.save(id,label,value);ai.settings.save(value);ai.profiles.bind('shared',id);selectedProfile=id;redraw(copy?'新配置已保存并设为全局默认。':'配置已更新。');};
  const profileAction=fn=>{try{fn();}catch(e){report(e.message,'error');}};
  const update=button('更新所选配置',()=>profileAction(()=>saveProfile(false))),remove=button('删除所选配置',()=>profileAction(()=>{ai.profiles.remove(selectedProfile);selectedProfile='';redraw('配置已删除，关联应用恢复跟随全局默认。');}));update.disabled=remove.disabled=!selectedProfile;
  toolbar(profileCard,button('保存为新配置',()=>profileAction(()=>saveProfile(true))),update,remove);
  toolbar(api,button('保存全局默认设置',()=>safe(()=>ai.settings.save(read()))),button('清除共享密钥',()=>safe(()=>{key.value='';remember.checked=false;ai.settings.save({...ai.settings.snapshot(),apiKey:'',rememberKey:false});},'共享密钥已清除。')));
  const legacy=el('details',null,'amin-card');legacy.append(el('summary','迁移旧配置'));const legacyBody=el('div',null,'amin-stack');legacyBody.append(el('p','导入后请在配置库选择并应用；原设置保留。原状态栏会话密钥需重新填写。','amin-meta'));toolbar(legacyBody,button('导入原地图 / 状态栏配置',()=>profileAction(()=>{ai.importLegacy();redraw('旧配置已导入，请在配置库选择并应用。');})));legacy.append(legacyBody);api.append(legacy);
  const channels=el('section',null,'amin-stack');target.append(channels);
  const channelCard=card(channels,'应用生成渠道','为各应用选择 Amin 独立接口，或使用酒馆当前配置与已保存的连接配置。修改后点击对应应用的保存按钮。');
  const routeInfo=el('p',null,'amin-meta'),channelGrid=el('div',null,'amin-stack');channelCard.append(routeInfo,channelGrid);
  const channelNotice=el('p',null,'amin-result');channelNotice.setAttribute('role','status');channelNotice.hidden=true;
  const routeDrafts=new Map(AI_APPS.map(app=>[app.id,{...(ai.route?.(app.id)??{mode:'amin',profileId:''}),channel:ai.channel(app.id)}]));
  const renderChannels=()=>{
   const host=ai.hostRoutes?.()??{quietAvailable:false,profileAvailable:false,profiles:[]};
   channelGrid.replaceChildren();routeInfo.textContent='酒馆当前配置通过静默生成（Quiet）组装上下文和预设；指定酒馆连接配置使用其接口、模型和采样参数。'+(host.error?' '+host.error+'。':'');
   for(const app of AI_APPS){
    const draft=routeDrafts.get(app.id),row=card(channelGrid,app.name),form=grid(row);
    const route=field(form,'生成方式',select([{id:'amin',name:'Amin 独立接口 / 共享异步预设'},{id:'tavern-current',name:'酒馆当前配置 · 完整预设'},{id:'tavern-profile',name:'指定酒馆连接配置 · 采样参数'}],draft.mode));route.parentElement.classList.add('amin-span-full');
    for(const option of route.options){if(option.value==='tavern-current')option.disabled=!host.quietAvailable;if(option.value==='tavern-profile')option.disabled=!host.profileAvailable;}
    const control=field(form,'Amin API 配置',select([{id:'',name:'跟随全局默认'},...saved],draft.channel));
    const hostProfiles=[{id:'',name:'请选择酒馆连接配置'},...(host.profiles??[]).map(p=>({id:p.id,name:p.name+(p.model?' · '+p.model:'')}))];
    if(draft.profileId&&!hostProfiles.some(p=>p.id===draft.profileId))hostProfiles.push({id:draft.profileId,name:'原连接配置已不可用'});
    const profile=field(form,'酒馆连接配置',select(hostProfiles,draft.profileId)),hint=el('p',null,'amin-meta');row.append(hint);
    const reflect=()=>{control.parentElement.hidden=route.value!=='amin';profile.parentElement.hidden=route.value!=='tavern-profile';hint.textContent=route.value==='amin'?'使用所选 API 配置和“异步预设”中的消息块。':route.value==='tavern-current'?'使用当前模型，按酒馆 Quiet 触发规则组装上下文和提示词预设。修改酒馆当前连接后，下次生成随之变化。':'使用所选连接配置的接口、模型及采样参数，保留 Amin 异步预设与任务提示词；酒馆当前连接保持不变。';};
    route.onchange=()=>{draft.mode=route.value;reflect();};profile.onchange=()=>draft.profileId=profile.value;control.onchange=()=>draft.channel=control.value;
    const save=button('保存应用渠道',()=>{channelNotice.hidden=false;try{if(draft.mode==='tavern-profile'&&!draft.profileId)throw Error('请先为'+app.name+'选择酒馆连接配置');ai.setRoute(app.id,{mode:draft.mode,profileId:draft.profileId});ai.setChannel(app.id,draft.channel);channelNotice.dataset.state='success';channelNotice.textContent=app.name+'生成渠道已保存，下次生成生效。';}catch(e){channelNotice.dataset.state='error';channelNotice.textContent=e.message;}});save.className='amin-primary';toolbar(row,save);reflect();
   }
  };
  toolbar(channelCard,button('刷新酒馆配置列表',()=>{try{renderChannels();channelNotice.hidden=false;channelNotice.dataset.state='success';channelNotice.textContent='已刷新酒馆配置列表，未保存的选择已保留。';}catch(e){channelNotice.hidden=false;channelNotice.dataset.state='error';channelNotice.textContent=e.message;}}));
  renderChannels();channelCard.append(channelNotice,el('p','Amin 配置可供多个应用使用。更新它会影响绑定的应用；删除后恢复跟随全局默认。未选择记住的密钥需在重新打开页面后填写。','amin-meta'));
  const voice=card(channels,'语音接口','语音朗读使用专用接口，在语音应用中配置 MiMo、火山引擎或本地服务。');toolbar(voice,button('打开语音设置',()=>globalThis.AminOS?.openApp('tts')));
  const preset=el('section',null,'amin-stack');target.append(preset);
  const help='全局异步生成预设：按顺序组合消息，可编辑、启停和排序。各应用提供角色卡、世界书与可用聊天资料；地图额外提供当前地图。“本次要求”必须启用。输出协议始终附加。';
  const library={...ai.presets,save(p){if(!p.blocks.some(b=>b.type==='request'&&b.enabled))throw Error('请保留并启用“本次要求”块');ai.presets.save(p);}};
  renderPresetEditor(preset,library,ai.selected(),id=>ai.select(id),{el,input,field,select,button,uid:()=>uuid(),help});
  const runtime=el('section',null,'amin-stack');target.append(runtime);
  const refresh=()=>{
   runtime.replaceChildren();const tasks=card(runtime,'任务记录','显示当前页面的最近任务。'),records=ai.tasks();
   if(!records.length)tasks.append(el('p','暂无任务。从任一应用发起生成后，进度会显示在这里。','amin-empty'));
   for(const t of [...records].reverse()){const row=el('div',null,'amin-card amin-inline'),copy=el('div',null,'amin-stack');copy.append(el('strong',t.app),el('span',`${t.channel} · ${t.state}`,'amin-meta'));row.append(copy);if(t.state==='等待模型 / 排队中')row.append(button('取消任务',()=>ai.cancel(t.id)));tasks.append(row);}
   const previews=card(runtime,'实际提示词','包含自定义请求参数的覆盖结果，仅在当前页面保留。'),requests=ai.previews();
   if(!requests.length)previews.append(el('p','暂无请求预览。首次生成后可展开查看。','amin-empty'));
   for(const p of requests){const d=el('details',null,'amin-card');d.append(el('summary',`${p.app} · 最近一次请求`),el('pre',p.text));previews.append(d);}
  };
  const panels={api,channels,preset,runtime},labels={api:'API 连接',channels:'应用渠道',preset:'异步预设',runtime:'任务记录'};
  const show=()=>{for(const [id,panel]of Object.entries(panels))panel.hidden=id!==active;for(const b of tabs.children)b.setAttribute('aria-pressed',String(b.dataset.page===active));notice.hidden=active!=='api'||!feedback;};
  for(const id of Object.keys(panels)){const b=button(labels[id],()=>{active=id;show();});b.dataset.page=id;tabs.append(b);}
  show();refresh();unsubscribe=ai.subscribe(refresh);
 }
 draw();return {open(){},dispose(){modelController?.abort();unsubscribe?.();target.replaceChildren();}};
}
