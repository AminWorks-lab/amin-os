import {audioLibrary} from './library.js';
import {EMOTIONS,speedMax} from './emotions.js';
import {launchTarget,waitForService,dispatchLaunch} from './launcher.js';
import {isCloud,BASE_VOICE} from './cloud.js';
import {getPlayer,scopedPlayer,settings,saveSettings,health} from './service.js';
import {previewSections,profiles} from './dialogue.js';
import {contextLine} from '../shared/context-line.js';

export function mount(target,{readMessage=null,source='app'}={}){
 const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
 const field=(parent,title,control)=>{const label=el('label',null,'amin-field');if(control.type==='checkbox')label.classList.add('amin-check');label.append(el('span',title),control);parent.append(label);return control;};
 const input=(parent,title,value,type='number',min,max,step)=>{const control=el('input');control.type=type;control.value=value;if(min!==undefined){control.min=min;control.max=max;control.step=step;}return field(parent,title,control);};
 const select=(parent,title,items,value)=>{const control=el('select');for(const [id,name]of items){const option=el('option',name);option.value=id;control.append(option);}control.value=value;return field(parent,title,control);};
 const card=(parent,title,description)=>{const box=el('section',null,'amin-card amin-stack');box.append(el('h3',title,'amin-section-heading'));if(description)box.append(el('p',description,'amin-meta'));parent.append(box);return box;};
 const grid=parent=>{const e=el('div',null,'amin-form-grid');parent.append(e);return e;};
 const button=(parent,title,fn)=>{const b=el('button',title);b.type='button';b.onclick=fn;parent.append(b);return b;};
 const root=el('div',null,'amin-page amin-app-page amin-tts'),heading=el('header',null,'amin-context');heading.append(el('p',contextLine(globalThis.SillyTavern?.getContext?.(),readMessage?'本层正文':'自由文本','对话与旁白分别调整，生成后可保存')));root.append(heading);
 const nav=el('nav',null,'amin-tabs');nav.setAttribute('aria-label','语音应用分类');root.append(nav);
 const status=el('p',null,'amin-result');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.append(status);
 const report=(text,state='success')=>{status.textContent=text;status.dataset.state=state;};
 const playback=el('div',null,'amin-toolbar'),listening=el('section',null,'amin-stack'),detail=el('section',null,'amin-stack'),saved=el('section',null,'amin-stack');root.append(playback,listening,detail,saved);
 const panels={listen:listening,settings:detail,saved},labels={listen:'朗读与分段',settings:'声音设置',saved:'音频库'};let active='listen';
 const show=()=>{for(const [id,panel]of Object.entries(panels))panel.hidden=id!==active;for(const b of nav.children)b.setAttribute('aria-pressed',String(b.dataset.page===active));};
 for(const [id,label]of Object.entries(labels)){const b=button(nav,label,()=>{active=id;show();});b.dataset.page=id;}show();
 const cfg=settings(),sharedPlayer=getPlayer(),player=scopedPlayer(sharedPlayer,source),textCard=card(listening,readMessage?'本层朗读正文':'朗读文本',readMessage?'只读取本层正则处理后的正文。编辑过的原消息会在生成前重新读取。':'填写文本后可在下方纠正段落分类。');
 const canBrowseAll=source==='app'&&!readMessage;let historySource=null;
 const playbackPlayer=()=>historySource?scopedPlayer(sharedPlayer,historySource):player;
 const text=el('textarea');text.rows=6;text.placeholder='输入需要朗读的文本…';let rendered=readMessage?.()??null;text.value=rendered??'她轻轻敲门，说：“晚上好，今天过得怎么样？”';field(textCard,'正文',text);
 const range=select(textCard,'朗读范围',[['all','全部（原文顺序）'],['dialogue','仅对话'],['narration','仅旁白／其他正文']],cfg.range);
 const bar=el('div',null,'amin-toolbar');textCard.append(bar);
 const connection=card(detail,'语音引擎','选择云端合成或已部署的本地服务。'),connectionGrid=grid(connection);
 const provider=select(connectionGrid,'语音引擎',[['mimo-direct','MiMo · 插件内合成'],['volcengine','火山引擎 · 插件内合成'],['azuma','本地 Bert-VITS2 东雪莲'],['mimo','MiMo → 本地 DXL1（需外部服务）']],cfg.provider);provider.parentElement.classList.add('amin-span-full');
 const url=input(connectionGrid,'语音服务地址',cfg.url,'url'),seed=input(connectionGrid,'种子',cfg.seed,'number',0,4294967295,1),fields={},p=profiles(cfg);
 const remote=input(connectionGrid,'连接远程电脑（安卓使用）','','checkbox');remote.checked=cfg.remote===true;const remoteKey=input(connectionGrid,'远程访问密钥（不是 MiMo API Key）',cfg.remoteKey??'','password');remoteKey.autocomplete='off';
 const cloudFields=card(detail,'云端凭据','凭据随酒馆设置保存。云端合成无需启动本地服务；火山使用语音控制台的 App ID / Access Token。'),cloudGrid=grid(cloudFields),creds=cfg.cloud??{};
 const mimoKey=input(cloudGrid,'MiMo API Key',creds.mimoKey??'','password'),volcAppId=input(cloudGrid,'火山 App ID',creds.volcAppId??'','text'),volcToken=input(cloudGrid,'火山 Access Token',creds.volcToken??'','password'),speaker=input(cloudGrid,'火山音色 ID',creds.speaker??'zh_female_vv_uranus_bigtts','text'),resource=input(cloudGrid,'火山资源 ID',creds.resource??'seed-tts-2.0','text');for(const f of [mimoKey,volcToken])f.autocomplete='off';
 const ratio=select(connectionGrid,'DXL1 索引比例',[[.5,'0.5'],[.75,'0.75']],cfg.ratio);
 const voiceCard=card(detail,'基础声线','MiMo 用文字设计声线；火山用音色 ID 选择声线。云端合成会发送朗读正文。'),voicePrompt=el('textarea');voicePrompt.rows=4;voicePrompt.maxLength=2000;voicePrompt.value=cfg.voicePrompt||BASE_VOICE;voicePrompt.placeholder='留空使用默认成年女性声线';field(voiceCard,'MiMo 基础声线描述',voicePrompt);
 const profileCards=el('div',null,'amin-form-grid');detail.append(profileCards);
 for(const [type,title]of [['dialogue','对话'],['narration','旁白／其他正文']]){
  const box=card(profileCards,title),form=grid(box);
  fields[type]={speed:input(form,'语速',p[type].speed,'number',.7,speedMax(cfg.provider),.05),volume:input(form,'音量（0～200%）',Math.round(p[type].volume*100),'number',0,200,1),pauseMs:input(form,'段后停顿（毫秒）',p[type].pauseMs,'number',0,5000,50)};
  const emotionBox=el('div',null,'amin-field amin-span-full'),emotion=el('textarea');emotion.rows=2;emotion.maxLength=1000;emotion.placeholder='例如：温柔、稍慢、像安慰朋友一样';emotion.value=p[type].emotion;fields[type].emotion=emotion;
  const presets=select(emotionBox,'MiMo 情绪预设',[['','自定义情绪'],...EMOTIONS.map(([name])=>[name,name])],EMOTIONS.some(([name])=>name===emotion.value)?emotion.value:'');for(let i=1;i<presets.options.length;i++)presets.options[i].title=EMOTIONS[i-1][1];
  presets.onchange=()=>{if(presets.value)emotion.value=presets.value;};emotion.oninput=()=>{presets.value=EMOTIONS.some(([name])=>name===emotion.value)?emotion.value:'';};field(emotionBox,'MiMo 情绪描述',emotion);form.append(emotionBox);fields[type].emotionBox=emotionBox;
  fields[type].volcEmotion=input(form,'火山情绪代码（可留空，如 happy）',p[type].volcEmotion??'','text');fields[type].volcEmotion.parentElement.classList.add('amin-span-full');
 }
 detail.append(el('p','MiMo 语速范围 0.7～2.0 倍，其他引擎 0.7～1.3。对话与旁白分别保存；情绪效果取决于所选引擎和音色支持。','amin-meta'));
 const quotesCard=card(detail,'对话识别','引号内视为对话，其余为旁白。不完整的引号保留为旁白，可在“朗读与分段”中手动纠正。'),quotes=el('textarea');quotes.rows=4;quotes.value=cfg.quotes;field(quotesCard,'对话引号规则（每行一对）',quotes);
 const collect=()=>({...cfg,provider:provider.value,remote:remote.checked,remoteKey:remoteKey.value.trim(),cloud:{mimoKey:mimoKey.value.trim(),volcAppId:volcAppId.value.trim(),volcToken:volcToken.value.trim(),speaker:speaker.value.trim(),resource:resource.value.trim()},ratio:Number(ratio.value),voicePrompt:voicePrompt.value,url:url.value,seed:Number(seed.value),range:range.value,quotes:quotes.value,profiles:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,{speed:Number(v.speed.value),volume:Number(v.volume.value)/100,pauseMs:Number(v.pauseMs.value),emotion:v.emotion.value,volcEmotion:v.volcEmotion.value}]))});
 let sections=[],signature='';const preview=card(listening,'段落预览','勾选要生成的段落；分类可手动修改，播放顺序与原文一致。'),selection=el('div',null,'amin-toolbar'),rows=el('div',null,'amin-stack');preview.append(selection,rows);
 function analyze(){
  const next=text.value+'\0'+quotes.value;if(next===signature)return;sections=previewSections(text.value,quotes.value);signature=next;rows.replaceChildren();
  for(const section of sections){if(!section.text.trim())continue;const row=el('div',null,'amin-card amin-stack'),controls=grid(row),enabled=input(controls,'第 '+(section.id+1)+' 段 · 启用','','checkbox');enabled.checked=section.enabled;enabled.onchange=()=>section.enabled=enabled.checked;const type=select(controls,'段落分类',[['dialogue','对话'],['narration','旁白／其他正文']],section.type);type.onchange=()=>section.type=type.value;row.append(el('p',section.text));rows.append(row);}
  if(!rows.children.length)rows.append(el('p','暂无可朗读段落。请先输入正文。','amin-empty'));
 }
 text.onchange=quotes.onchange=()=>{try{analyze();}catch(e){report(e.message,'error');}};
 const settingsBar=el('div',null,'amin-toolbar');detail.append(settingsBar);
 button(settingsBar,'保存设置',()=>{try{saveSettings(collect());analyze();report('设置已保存');}catch(e){report(e.message,'error');}}).className='amin-primary';
 const check=button(settingsBar,'检查配置',async()=>{check.disabled=true;report('正在检查配置…','busy');try{const config=collect();await health(config);report(isCloud(config)?'必填配置完整；点击生成并朗读验证实际合成（可能产生费用）':config.provider==='mimo'?'已连接 MiMo → DXL1':'东雪莲服务已连接');}catch(e){report(e.message,'error');}finally{check.disabled=false;}});
 let launchController=null;const localBar=el('div',null,'amin-toolbar');connection.append(localBar);
 const launch=button(localBar,'启动本地服务',async()=>{try{
  const config=collect();launchTarget(config);launchController?.abort();launchController=new AbortController();const signal=launchController.signal;
  // Keep launching in the click gesture; credentials never enter the URI.
  dispatchLaunch(config);launch.disabled=true;report('已请求启动，请允许系统打开启动器，正在等待连接…','busy');
  const h=await waitForService(config,{signal});report(config.provider==='mimo'&&!h.key_configured?'DXL1 服务已启动；点击“打开本地配置页”填写 MiMo 密钥。':'本地服务已连接，可以播放');
 }catch(e){if(e.name!=='AbortError')report(e.message,'error');}finally{launch.disabled=false;}});
 button(localBar,'打开本地配置页',()=>{try{window.open(launchTarget(collect()).base,'_blank','noopener,noreferrer');}catch(e){report(e.message,'error');}});
 for(const [name,on]of [['全部启用',true],['全部取消',false]])button(selection,name,()=>{for(const section of sections)section.enabled=on;for(const checkbox of rows.querySelectorAll('input[type=checkbox]'))checkbox.checked=on;});
 const generateSpeech=generateOnly=>{try{if(readMessage){const latest=readMessage();if(latest!==rendered){rendered=latest;text.value=latest;}}const config=collect();saveSettings(config);analyze();historySource=null;Promise.resolve(player.play(sections.map(s=>({...s})),config,{generateOnly})).catch(e=>report(e.message,'error'));}catch(e){report(e.message,'error');}};
 button(bar,readMessage?'生成并朗读本层':'生成并朗读',()=>generateSpeech(false)).className='amin-primary';
 button(bar,'仅生成勾选段落',()=>generateSpeech(true));
 const retry=button(playback,'重试失败段落',()=>{if(readMessage&&readMessage()!==rendered){player.stop();report('正文已变化，请重新点击朗读本层','error');return;}playbackPlayer().retry();});retry.hidden=true;
 const pause=button(playback,'暂停',()=>playbackPlayer().pause()),resume=button(playback,'继续',()=>playbackPlayer().resume()),stop=button(playback,'停止',()=>playbackPlayer().stop());
 const libraryCard=card(saved,'已生成语音','音频按段保存在本机，重听不重新合成。重新生成成功后替换该段，失败会保留旧音频。'),savedRows=el('div',null,'amin-stack');let allHistory=null;
 if(canBrowseAll){allHistory=input(libraryCard,'全部本机历史','','checkbox');allHistory.checked=false;allHistory.onchange=()=>void refreshSaved();libraryCard.append(el('p','默认只显示当前输入的音频。打开“全部本机历史”可找回其他聊天和旧版记录；重听保留原来源，不会关联到当前楼层。','amin-meta'));}
 libraryCard.append(savedRows);saved.append(el('p','批量生成最多 3 路同时进行，DXL1 变声依次处理。','amin-meta'));let disposed=false,revision=0;
 async function refreshSaved(){
  const ticket=++revision;
  try{const records=await (allHistory?.checked?audioLibrary.listAll():audioLibrary.list(source));if(disposed||ticket!==revision)return;savedRows.replaceChildren();if(!records.length){savedRows.append(el('p',allHistory?.checked?'本机音频库暂无已保存记录。':'尚无已生成语音。先在“朗读与分段”中生成，完成后会自动显示在这里。','amin-empty'));return;}
   for(const record of records){const row=el('div',null,'amin-card amin-stack');row.append(el('strong','第 '+record.sectionNumber+' 段 · '+(record.type==='dialogue'?'对话':'旁白')),el('p',record.text));const actions=el('div',null,'amin-toolbar');
    if(canBrowseAll){const date=new Date(record.updatedAt);row.append(el('p','来源：'+(record.source===source?'当前输入':record.source||'未知来源'),'amin-meta'),el('p','保存时间：'+(Number.isFinite(date.getTime())?date.toLocaleString():'未知'),'amin-meta'));}
    button(actions,'重听',()=>{historySource=canBrowseAll&&record.source!==source?record.source:null;Promise.resolve(playbackPlayer().replay(record)).catch(e=>report(e.message,'error'));});
    if(record.source===source)button(actions,'重新生成',()=>{try{const config=collect();saveSettings(config);historySource=null;player.regenerate(record,config);}catch(e){report(e.message,'error');}});
    button(actions,'下载',()=>{const url=URL.createObjectURL(record.blob),link=el('a');link.href=url;link.download='语音-第'+record.sectionNumber+'段.'+(record.blob.type.includes('mpeg')?'mp3':'wav');link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});
    button(actions,'删除',async()=>{try{await audioLibrary.remove(record.id,record.source);}catch{report('删除失败，请检查本机存储','error');}});row.append(actions);savedRows.append(row);
   }
  }catch{if(!disposed&&ticket===revision){savedRows.replaceChildren(el('p','暂时无法读取本机音频库，请重新尝试。','amin-empty'));button(savedRows,'重新读取',()=>void refreshSaved());}}
 }
 const offSaved=audioLibrary.subscribe(changed=>{if(allHistory?.checked||changed===source)void refreshSaved();});void refreshSaved();
 const off=sharedPlayer.subscribe(state=>{const s=state.source===source||(historySource&&state.source===historySource)?state:{phase:'idle',message:'准备就绪',canRetry:false};report(s.message,s.phase==='error'?'error':['loading','playing','waiting'].includes(s.phase)?'busy':'');retry.hidden=!s.canRetry;retry.disabled=!s.canRetry;pause.disabled=s.phase!=='playing';resume.disabled=s.phase!=='paused';stop.disabled=!s.canRetry&&!['loading','playing','paused','waiting'].includes(s.phase);});
 function reflectProvider(){
  const cloud=['mimo-direct','volcengine'].includes(provider.value);localBar.hidden=cloud||(provider.value==='mimo'&&remote.checked);remote.parentElement.hidden=provider.value!=='mimo';remoteKey.parentElement.hidden=provider.value!=='mimo'||!remote.checked;url.parentElement.hidden=cloud;seed.parentElement.hidden=cloud;ratio.parentElement.hidden=provider.value!=='mimo';mimoKey.parentElement.hidden=provider.value!=='mimo-direct';for(const f of [volcAppId,volcToken,speaker,resource])f.parentElement.hidden=provider.value!=='volcengine';cloudFields.hidden=!cloud;voiceCard.hidden=provider.value==='volcengine'||provider.value==='azuma';
  for(const v of Object.values(fields)){v.speed.max=speedMax(provider.value);v.speed.title='范围 0.7～'+speedMax(provider.value)+'；MiMo 为保持音高的播放倍速';v.emotionBox.hidden=!['mimo-direct','mimo'].includes(provider.value);v.volcEmotion.parentElement.hidden=provider.value!=='volcengine';}
 }
 // Remember in-progress endpoint edits when changing between local providers.
 const urls={azuma:cfg.provider==='azuma'?cfg.url:'http://127.0.0.1:9883',mimo:cfg.provider==='mimo'?cfg.url:'http://127.0.0.1:9884'};let previousProvider=provider.value;
 remote.onchange=reflectProvider;provider.onchange=()=>{launchController?.abort();if(previousProvider in urls)urls[previousProvider]=url.value;if(provider.value in urls)url.value=urls[provider.value];previousProvider=provider.value;reflectProvider();};
 target.append(root);reflectProvider();analyze();return {dispose(){disposed=true;offSaved();launchController?.abort();off();root.remove();},open(){}};
}
