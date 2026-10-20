const listeners=new Map();
const events=Object.fromEntries(['GENERATION_AFTER_COMMANDS','GENERATION_STOPPED','APP_INITIALIZED','CHAT_CHANGED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_UPDATED','GENERATION_ENDED','CHARACTER_MESSAGE_RENDERED'].map(x=>[x,x]));
const state=name=>JSON.stringify({版本:1,项目:{玩家:{姓名:name,生命:{当前:76,最大:100},金币:128,背包:['地图','恢复药剂']},世界:{地点:'星港 · 观测站',时间:'黄昏',天气:'微雨'}}});
const contexts=['a','b'].map((id,i)=>({id,integrity:'amin-preview-'+id,variables:{状态栏:state(i?'另一位旅人':'旅人')}}));let active=0;
const settings={dynamicMapNamespace:'amin-preview-only',world_status_hud_v1:{floorButtons:true}};
const ctx={characterId:0,characters:[{avatar:'amin-preview.png',name:'向导',data:{description:'星港的向导',extensions:{}}}],chatMetadata:contexts[0],chat:[{name:'旅人',is_user:true,mes:'我来到观测站。',extra:{}},{name:'向导',is_user:false,mes:'我们一起出发吧。',extra:{}}],name1:'旅人',name2:'向导',extensionSettings:settings,worldInfoSettings:{world_info:{globalSelect:['演示技能']}},powerUserSettings:{persona_description:'探索未知的旅人'},eventTypes:events,event_types:events,getCurrentChatId:()=>contexts[active].id,
eventSource:{on(e,f){if(!listeners.has(e))listeners.set(e,new Set());listeners.get(e).add(f);},removeListener(e,f){listeners.get(e)?.delete(f);},async emit(e,...args){for(const f of listeners.get(e)??[])await f(...args);}},
async saveMetadata(){},saveMetadataDebounced(){},saveSettingsDebounced(){},async saveChat(){},setExtensionPrompt(key,text){if(!['amin-os-persistent-effects','amin-os-information-panel'].includes(key))return;document.getElementById('preview-effects-prompt')?.replaceChildren(document.createTextNode(text));},async loadWorldInfo(){return {entries:{0:{uid:0,comment:'所有权（演示）',content:'所有权：持有者可声明目标特定层面的所有权。关系持续至主动解除或转让；当前指令变化不自动解除关系。死亡与继承按规则确认。'}}};},
async generateRaw(request){await new Promise(r=>setTimeout(r,350));
  if(request.systemPrompt?.includes('信息面板资料检索助手'))return JSON.stringify({queries:['向导','观测站']});
  if(request.systemPrompt?.includes('信息面板资料整理助手'))return JSON.stringify({fields:[{category:'身份',label:'身份说明',value:'星港的向导',status:'known',sources:[{id:'card:amin-preview.png:0',quote:'星港的向导'}]},{category:'能力',label:'星语资质',value:'能理解星辰低语',status:'invented',sources:[]},{category:'档案',label:'年龄',value:'未查到',status:'unknown',sources:[]}]});
  if(request.systemPrompt?.includes('信息面板模拟推演助手'))return JSON.stringify({summary:'模拟：新增职业可能需要配套经历。尚未应用。',proposals:[{category:'经历',label:'学习记录',value:'曾在星港学习星象学',reason:'为新增能力提供履历基础'}]});
  if(request.systemPrompt?.includes('持续效果规则编辑助手'))return '适用范围：仅对已确认目标和指定层面生效。\n持续：直到主动解除或转让。\n指令变更不解除所有权关系。\n死亡及继承：依原规则人工确认。';
  if(request.systemPrompt?.includes('作者与编剧'))return JSON.stringify(['下一幕让队伍抵达观测站，发现地图与真实地形不符；围绕是否继续前进产生分歧，结尾留下站内传来的求救信号。','安排向导隐瞒一段与观测站有关的经历，通过旧物揭示线索；暂不揭露全部真相，以队伍的信任危机推动后续。','放缓节奏，让队伍在山脚整理补给，通过共同解决小问题建立默契；以远处异常的星光为下一幕埋下伏笔。']);
  if(request.systemPrompt?.includes('回复拟稿助手'))return JSON.stringify(['“那就出发吧。”我跟上她，沿着旧路向山脊走去。','“你来过这里多少次？”我望向观测站，放慢了脚步。','我把地图展开，仔细核对通往山顶的另一条路线。']);
  if(request.systemPrompt?.includes('状态')||request.prompt?.includes('状态栏'))return state('旅人');
  const {createDemoDocument}=await import('./apps/map/src/core/demo.js');return JSON.stringify(createDemoDocument());
}};
// Native route fixtures are local simulations, never real host/API requests.
ctx.mainApi='openai';
ctx.getPresetManager=()=>({getSelectedPresetName:()=> '演示酒馆预设（模拟）'});
ctx.generateQuietPrompt=({quietPrompt})=>ctx.generateRaw({systemPrompt:quietPrompt,prompt:quietPrompt});
ctx.ConnectionManagerRequestService={getSupportedProfiles:()=>[{id:'demo-profile',name:'演示连接（模拟）',api:'openai',model:'demo',preset:'演示参数预设'}],async sendRequest(_id,messages){return {content:await ctx.generateRaw({systemPrompt:messages[0]?.content,prompt:messages.map(m=>m.content).join('\n')})};}};
globalThis.SillyTavern={getContext:()=>ctx};
// Demo chats carry an initialized Amin story state (blank modules plus the demo world state), like a chat set up in 设置 → 剧情存储.
const {emptyState,validateState,STATE_KEY}=await import('./apps/story-state/schema.js');
const storyState=status=>{const value=emptyState();value.modules.status=status==null?null:JSON.parse(status);return validateState(value);};
for(const chat of contexts)chat[STATE_KEY]=storyState(chat.variables.状态栏);
document.getElementById('preview-switch').onclick=()=>{active=1-active;ctx.chatMetadata=contexts[active];ctx.chat=ctx.chat.map(m=>({...m,extra:{}}));ctx.eventSource.emit(events.CHAT_CHANGED);};
document.getElementById('preview-group').onclick=()=>{ctx.groupId=ctx.groupId?undefined:'preview-group';ctx.groups=[{id:'preview-group',members:['amin-preview.png']}];ctx.eventSource.emit(events.CHAT_CHANGED);};
document.getElementById('preview-empty').onclick=()=>{delete ctx.chatMetadata.variables.状态栏;ctx.chatMetadata[STATE_KEY]=storyState(null);ctx.eventSource.emit(events.CHAT_CHANGED);};
document.getElementById('preview-send').onclick=async()=>{const input=document.getElementById('send_textarea'),text=input.value.trim();if(!text)return;const index=ctx.chat.length;ctx.chat.push({name:ctx.name1,is_user:true,mes:text,extra:{}});const row=document.createElement('article');row.className='mes';row.setAttribute('mesid',index);const block=document.createElement('div');block.className='mes_block';const name=document.createElement('small');name.textContent=ctx.name1;const body=document.createElement('div');body.className='mes_text';body.style.whiteSpace='pre-wrap';body.textContent=text;block.append(name,body);row.append(block);document.getElementById('chat').append(row);input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));await ctx.eventSource.emit(events.MESSAGE_SENT,index);await ctx.eventSource.emit(events.CHARACTER_MESSAGE_RENDERED,index);};
const testButton=document.createElement('button');testButton.textContent='预览本轮持续提醒';testButton.onclick=()=>ctx.eventSource.emit(events.GENERATION_AFTER_COMMANDS,'normal',{},false);const prompt=document.createElement('pre');prompt.id='preview-effects-prompt';document.body.append(testButton,prompt);
// Preview-only in-memory transport. Never installed into the actual host entry point.
const {initializeAI}=await import('./ai/service.js');
initializeAI(localStorage,settings.dynamicMapNamespace,{
 resolveConnection:async c=>({...c,enabled:true,baseUrl:'https://preview.invalid/v1',model:'demo'}),
 fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);if(options.signal.aborted)throw Error('预览已取消');const content=await ctx.generateRaw({systemPrompt:body.messages[0].content,prompt:body.messages.map(m=>m.content).join('\n')});return {ok:true,json:async()=>({choices:[{message:{content},finish_reason:'stop'}]})};}
});
await import('./index.js');
// The host announces a loaded chat with CHAT_CHANGED; chat-lifecycle only accepts a chat after it.
await ctx.eventSource.emit(events.CHAT_CHANGED,ctx.getCurrentChatId());
