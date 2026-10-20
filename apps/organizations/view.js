import {worldbookChoices,selectedBookNames} from './sources.js';
import {getAI} from '../../ai/service.js';
import {getStore,chatIdentity} from './service.js';
import {GROUPS,LABELS,FIELDS,LINKS,entity,uid,clone,deleteEntity,rankMetrics} from './model.js';
import {generate,followPrompt} from './ai.js';
import {syncWorldbook} from './lorebook.js';
import {isIndependent} from '../story-state/access.js';
import {contextLine} from '../shared/context-line.js';
import {takeAppRequest} from '../shared/open-app.js';
const el=(tag,text='',cls='')=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
const show=v=>v===null||v===undefined||v===''?'未明确':typeof v==='object'?JSON.stringify(v,null,2):String(v);
const storyReference=m=>JSON.stringify([m?.extra?.amin_story_v2??null,m?.swipe_info?.[m.swipe_id??0]?.extra?.amin_story_v2??null]);
const tabsMap={overview:'总览',organizations:'组织',alliances:'联盟／阵营',regions:'地区',assessment:'评估排行',settings:'生成与规则'};
const mounted=new WeakMap();
export async function mount(target,{api:provided,ai=getAI,sourceOptions={}}={}){
 mounted.get(target)?.dispose();const api=provided??await getStore();mounted.get(target)?.dispose();
 const page=el('div','','amin-page amin-app-page amin-organizations'),header=el('header','','amin-context'),tabs=el('div','','amin-tabs'),actions=el('div','','amin-stack'),notice=el('div','','amin-notice'),body=el('section','','amin-stack'),viewId='amin-organizations-'+uid();
 notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','势力资料页面');body.id=viewId+'-panel';body.setAttribute('role','tabpanel');body.tabIndex=0;page.append(header,tabs,actions,notice,body);target.append(page);
 let selected='overview',chosen={},search='',editing=false,disposed=false,historyIndex=null,historyRecord=null,historyMetadata=null,historyRequest=0,lastIdentity='',requesting=false;
 const say=t=>{notice.textContent=t;};
 const btn=(parent,label,fn,primary=false)=>{const b=el('button',label,primary?'amin-primary':'');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){say(e.message);}finally{if(!disposed)b.disabled=false;}};parent.append(b);return b;};
 const card=(title,parent=body)=>{const c=el('section','','amin-card amin-stack');if(title)c.append(el('h3',title,'amin-section-heading'));parent.append(c);return c;};
 const grid=parent=>{const g=el('div','','amin-form-grid');parent.append(g);return g;};
 const toolbar=parent=>{const t=el('div','','amin-toolbar');parent.append(t);return t;};
 const details=(parent,label)=>{const d=el('details','','amin-card amin-stack');d.append(el('summary',label,'amin-section-heading'));parent.append(d);return d;};
 const field=(parent,label,value='',multi=false,full=false)=>{const row=el('label','','amin-field'+(full?' amin-span-full':'')),input=el(multi?'textarea':'input');row.append(el('span',label));input.value=String(value??'');input.setAttribute('aria-label',label);if(multi)input.rows=3;row.append(input);parent.append(row);return input;};
 const check=(parent,label,value=false)=>{const row=el('label','','amin-check'),i=el('input');i.type='checkbox';i.setAttribute('aria-label',label);i.checked=!!value;row.append(i,el('span',label));parent.append(row);return i;};
 const select=(parent,label,options,value)=>{const row=el('label','','amin-field'),i=el('select');row.append(el('span',label));i.setAttribute('aria-label',label);for(const[v,n]of options){const o=el('option',n);o.value=v;i.append(o);}i.value=value??options[0]?.[0]??'';row.append(i);parent.append(row);return i;};
 const leave=()=>!editing||globalThis.confirm?.('离开将放弃尚未保存的表单草稿，是否继续？');
 const navigate=(tab,id)=>{if(!leave())return false;editing=false;historyRequest++;if(tab==='settings'){historyIndex=null;historyRecord=null;historyMetadata=null;}selected=tab;if(id)chosen[tab]=id;render();return true;};
 function draftStart(title){editing=true;body.replaceChildren();return card(title);}
 function cancelEdit(){editing=false;render();}
 async function run(mode,targetEntity=null){
  if(requesting||api.busy())throw Error('已有操作进行中');
  if(!leave())return;editing=false;historyRequest++;historyIndex=null;historyRecord=null;historyMetadata=null;requesting=true;drawActions();say('正在准备资料并请求AI…');
  try{await generate({api,ai:ai(),mode,target:targetEntity,sourceOptions});render();say('结果已生成，请检查变更后确认；尚未写入');}
  finally{requesting=false;if(!disposed)drawActions();}
 }
 function drawHeader(){
  header.replaceChildren();header.append(el('p',contextLine(api.context(),...(historyIndex!==null?['只读浏览第 '+(historyIndex+1)+' 楼资料']:['当前分支的组织、联盟与地区','变更预览后确认']))));
 }
 function drawActions(){
  actions.replaceChildren();const busy=requesting||api.busy();body.setAttribute('aria-busy',String(!!busy));
  if(historyIndex!==null){btn(toolbar(actions),'返回当前资料',()=>{historyRequest++;historyIndex=null;historyRecord=null;historyMetadata=null;render();},true);return;}
  // Generation lives in the “生成与规则” tab; this row only links there.
  const main=toolbar(actions);if(selected!=='settings')btn(main,'生成／补充',()=>{navigate('settings');},true);btn(main,'按当前剧情更新',()=>run('update')).disabled=busy;
  if(busy){main.append(el('span','正在处理请求…','amin-meta'));btn(main,'取消请求',()=>{api.cancel();say('已取消请求');});}
  if(api.error?.())btn(main,'重试保存',async()=>{await api.retrySave();say('聊天保存已完成');}).disabled=busy;
 }
 function drawPreview(p){
  const c=card(p.kind==='assessment'?'评估预览 · 仅供user':'资料变更预览');
  c.append(el('p','确认后才会保存到当前聊天。请先检查每项变更。','amin-result'),el('p','若当前聊天、楼层、资料或锁定设置发生变化，需要重新生成预览。','amin-meta'));
  if(p.kind==='assessment')drawAssessment(p.assessment,c);
  else{c.append(el('p','待确认变更 · '+p.changes.length+' 项','amin-meta'));for(const change of p.changes){const item=details(c,change.label),compare=grid(item);for(const [label,value]of [['原资料',change.before],['新资料',change.after]]){const side=el('div','','amin-result amin-stack'),text=el('pre',show(value));text.style.whiteSpace='pre-wrap';text.style.overflowWrap='anywhere';side.append(el('strong',label),text);compare.append(side);}}}
  const tools=toolbar(c);
  btn(tools,'确认应用',async()=>{await api.confirm();editing=false;render();say('已写入并保存到当前聊天');},true);
  btn(tools,'放弃结果',()=>{api.discard();editing=false;render();});
 }
 function drawOverview(doc){
  const c=card(doc.name||'尚未建立资料');c.append(el('p',doc.summary||'从上方生成／补充开始，也可在组织、联盟和地区页手动新增资料。',doc.summary?'':'amin-empty'),el('p','资料时间：'+(doc.time||'未明确'),'amin-meta'));
  if(historyIndex===null)btn(c,'编辑总览',()=>{
   const token=api.capture(),f=draftStart('编辑总览'),form=grid(f),name=field(form,'资料标题',doc.name),time=field(form,'资料时间',doc.time),summary=field(form,'当前局势',doc.summary,true,true),tools=toolbar(f);
   btn(tools,'预览保存',()=>{const next=clone(doc);next.name=name.value;next.summary=summary.value;next.time=time.value;api.stage(next,token,{manual:true});editing=false;render();},true);btn(tools,'取消',cancelEdit);
  });
  const groups=grid(body);
  for(const group of GROUPS){const entries=Object.entries(doc[group]),c=card(LABELS[group]+' · '+entries.length,groups);if(!entries.length){c.append(el('p','尚未建立'+LABELS[group]+'资料。','amin-empty'));btn(c,'查看'+LABELS[group],()=>navigate(group));}for(const[id,e]of entries){const row=el('div','','amin-result amin-stack');btn(row,e.name,()=>navigate(group,id));row.append(el('span',e.status||e.summary||'未明确','amin-meta'));c.append(row);}}
  const h=details(body,'楼层记录 · 只读');h.append(el('p','仅记录启用后的资料。回退或切换候选会恢复相应状态；未记录的过去不补造数据。','amin-meta'));
  const records=api.history().filter(r=>r.available).slice(-40);
  if(!records.length)h.append(el('p','暂无可查看的楼层记录。','amin-empty'));const recordList=el('div','','amin-stack');h.append(recordList);
  for(const r of records)btn(recordList,'第'+(r.index+1)+'楼 · '+r.name,async()=>{
   if(!leave())return;
   const request=++historyRequest;
   const loaded=await api.readHistory(r.index);
   if(disposed||request!==historyRequest)return;
   editing=false;historyRecord=loaded;historyMetadata=api.context().chatMetadata;historyIndex=r.index;selected='overview';render();
  });
 }
 function drawGroup(doc,group){
  const catalog=card(LABELS[group]+'资料'),filters=grid(catalog),query=field(filters,'搜索名称、类型或概况',search);query.type='search';query.onchange=()=>{search=query.value;render();};
  if(historyIndex===null)btn(toolbar(catalog),'新增'+LABELS[group],()=>editEntity(group,null),true);
  const list=Object.entries(doc[group]).filter(([,e])=>!search||[e.name,e.type,e.summary].join(' ').includes(search));
  if(!list.length){catalog.append(el('p',search?'没有匹配的资料，请调整搜索词。':'尚无'+LABELS[group]+'资料。可手动新增，或使用上方生成／补充。','amin-empty'));return;}
  if(!list.some(([id])=>id===chosen[group]))chosen[group]=list[0][0];
  const picker=select(filters,'选择资料 · '+list.length+' 项',list.map(([id,e])=>[id,e.name]),chosen[group]);picker.onchange=()=>{chosen[group]=picker.value;render();};
  const id=chosen[group],e=doc[group][id],c=card(e.name);c.append(el('p',e.type||'类型未明确','amin-meta'),el('p',e.summary||'概况未明确'));
  if(historyIndex===null){const tools=toolbar(c);btn(tools,'编辑资料',()=>editEntity(group,id),true);btn(tools,'按剧情更新此项',()=>run('update',{group,id})).disabled=requesting||api.busy();const more=details(c,'资料管理'),manage=toolbar(more);btn(manage,'锁定字段',()=>editLocks(group,id));btn(manage,'删除并预览关联影响',()=>{const t=api.capture();api.stage(deleteEntity(t.doc,group,id),t,{manual:true});render();}).classList.add('amin-danger');}
  const metrics=card('实力与资源 / 自定义指标');
  const metricGrid=grid(metrics);for(const m of e.metrics){const row=el('div','','amin-result amin-stack');row.append(el('strong',m.label),el('span',(m.kind==='unknown'?'未知':m.kind==='range'?m.value.join('—'):String(m.value))+(m.unit?' '+m.unit:'')),el('small',m.source||'依据未明确','amin-meta'));metricGrid.append(row);}
  if(!e.metrics.length)metrics.append(el('p','未记录指标。可在编辑资料中添加数值、范围或文字指标。','amin-empty'));
  const current=grid(card('当前状态'));for(const k of ['status','affairs','goals','leadership','ideology','capabilities'])if(k in e){const item=el('div','','amin-result amin-stack');item.append(el('h4',FIELDS[group][k],'amin-section-heading'),el('p',e[k]||'未明确'));current.append(item);}
  const detail=grid(details(body,'详细档案与资料依据'));
  for(const[k,label]of Object.entries(FIELDS[group]))if(!['name','summary','status','affairs','goals','leadership','ideology','capabilities'].includes(k)){const item=el('div','','amin-stack');item.append(el('h4',label,'amin-section-heading'),el('p',e[k]||'未明确'));detail.append(item);}
  const links=card('关联资料');
  const key=group==='organizations'?'relations':group==='alliances'?'members':'controllers';
  for(const l of e[key]){const row=el('div','','amin-result amin-stack');btn(row,doc.organizations[l.organization]?.name??l.organization,()=>navigate('organizations',l.organization));row.append(el('span',[l.role,l.note].filter(Boolean).join(' · ')||'关系未明确','amin-meta'));links.append(row);}
  if(group==='regions'&&e.parent)btn(links,'上级地区：'+doc.regions[e.parent].name,()=>navigate('regions',e.parent));
  if(group==='organizations'){
   for(const [aid,a]of Object.entries(doc.alliances))if(a.members.some(m=>m.organization===id))btn(links,'联盟：'+a.name,()=>navigate('alliances',aid));
   for(const [rid,r]of Object.entries(doc.regions))if(r.controllers.some(m=>m.organization===id))btn(links,'地区：'+r.name,()=>navigate('regions',rid));
  }
  if(links.children.length===1)links.append(el('p','尚无关联资料。可在编辑资料中建立组织关系、联盟成员或地区归属。','amin-empty'));
 }
 function editLocks(group,id){
  const doc=api.read(),e=doc[group][id],c=draftStart('锁定字段 · '+e.name),all=api.locks(),checks={};
  c.append(el('p','锁定后AI和日常变量更新不得修改这些字段。你仍可通过手动编辑明确修改。','amin-meta'));
  const fields=grid(c);for(const k of Object.keys(e))checks[k]=check(fields,FIELDS[group][k]??LINKS[group][k]??'指标',all.includes([group,id,k].join('.')));
  const t=api.capture(),tools=toolbar(c);btn(tools,'保存锁定设置',async()=>{api.check(t);await api.setLocks([...all.filter(p=>!p.startsWith(group+'.'+id+'.')),...Object.entries(checks).filter(([,i])=>i.checked).map(([k])=>[group,id,k].join('.'))]);editing=false;render();say(isIndependent(api.context())?'锁定设置已保存；后续剧情更新会读取当前锁定规则。':'锁定设置已保存；日常提示词请重新同步世界书');},true);btn(tools,'取消',cancelEdit);
 }
 function editEntity(group,id){
  const token=api.capture(),doc=token.doc,original=id?doc[group][id]:entity(group,''),f=draftStart((id?'编辑':'新增')+LABELS[group]),inputs={};
  f.append(el('p','填写资料后预览变更，确认应用后保存。未填写的内容可保留为空。','amin-meta'));
  const basic=grid(card('基本资料',f)),current=grid(card('当前状态与特点',f)),archive=grid(details(f,'背景、资料依据与时间'));
  for(const[k,label]of Object.entries(FIELDS[group])){const parent=['name','type','summary'].includes(k)?basic:['background','source','certainty','updatedAt'].includes(k)?archive:current;inputs[k]=field(parent,label,original[k],!['name','type','certainty','updatedAt'].includes(k),k==='summary'||k==='background'||k==='source');}
  const metricBox=card('自定义指标',f),metricRows=[];
  metricBox.append(el('p','相同含义的指标请使用同一个标识，数值排行会同时核对标识和单位。','amin-meta'));
  const addMetric=(m={key:uid(),label:'',kind:'unknown',value:null,unit:'',source:''})=>{
   const row=el('div','','amin-result amin-stack');metricBox.append(row);const fields=grid(row);
   const label=field(fields,'指标名称',m.label),key=field(fields,'指标标识',m.key),kind=select(fields,'指标类型',[['unknown','未知'],['number','明确数字'],['range','范围'],['text','文字／等级']],m.kind),value=field(fields,'值（范围用 最小,最大）',Array.isArray(m.value)?m.value.join(','):m.value??''),unit=field(fields,'单位',m.unit),source=field(fields,'依据',m.source);
   const updateValue=()=>{value.disabled=kind.value==='unknown';value.inputMode=kind.value==='number'?'decimal':'text';value.placeholder=kind.value==='range'?'例如：100,200':kind.value==='unknown'?'未知类型无需填写数值':'';};kind.onchange=updateValue;updateValue();
   const record={row,label,key,kind,value,unit,source,removed:false};metricRows.push(record);btn(toolbar(row),'移除此指标',()=>{record.removed=true;row.remove();}).classList.add('amin-danger');
  };
  original.metrics.forEach(addMetric);btn(toolbar(metricBox),'增加指标',()=>addMetric());
  const linkKey=group==='organizations'?'relations':group==='alliances'?'members':'controllers',linkBox=card(LINKS[group][linkKey],f),linkRows=[];
  const choices=Object.entries(doc.organizations).filter(([oid])=>group!=='organizations'||oid!==id).map(([oid,e])=>[oid,e.name]);
  const addLink=(l={})=>{if(!choices.length)throw Error('请先建立可关联的组织');const row=el('div','','amin-result amin-stack');linkBox.append(row);const fields=grid(row),organization=select(fields,'关联组织',choices,l.organization),role=field(fields,'关系 / 身份 / 权利性质',l.role??''),note=field(fields,'说明',l.note??'',true,true);const record={row,organization,role,note,removed:false};linkRows.push(record);btn(toolbar(row),'移除此关联',()=>{record.removed=true;row.remove();}).classList.add('amin-danger');};
  original[linkKey].forEach(addLink);btn(toolbar(linkBox),'增加关联',()=>addLink()).disabled=!choices.length;if(!choices.length)linkBox.append(el('p','先建立其他组织，即可在这里添加关联。','amin-empty'));
  const parent=group==='regions'?select(f,'上级地区',[['','无'],...Object.entries(doc.regions).filter(([rid])=>rid!==id).map(([rid,r])=>[rid,r.name])],original.parent??''):null;
  const tools=toolbar(f);btn(tools,'预览保存',()=>{
   api.check(token);const next=clone(doc),e=entity(group,inputs.name.value);
   for(const[k,input]of Object.entries(inputs))e[k]=input.value;
   e.metrics=metricRows.filter(r=>!r.removed).map(r=>{const kind=r.kind.value,raw=r.value.value.trim();if(['number','range'].includes(kind)&&!raw)throw Error('数字指标不能留空，请选择未知');return {key:r.key.value.trim(),label:r.label.value.trim(),kind,value:kind==='unknown'?null:kind==='number'?Number(raw):kind==='range'?raw.split(/[,，]/).map(n=>n.trim()?Number(n):NaN):raw,unit:r.unit.value,source:r.source.value};});
   e[linkKey]=linkRows.filter(r=>!r.removed).map(r=>({organization:r.organization.value,role:r.role.value,note:r.note.value}));if(parent)e.parent=parent.value||null;
   next[group][id??uid()]=e;api.stage(next,token,{manual:true});editing=false;render();
  },true);btn(tools,'取消',cancelEdit);
 }
 function drawAssessment(a,parent=body){
  const c=card(a.title||'AI评估',parent);c.append(el('p',a.summary,'amin-result'),el('p','评估口径：'+a.criteria,'amin-meta'),el('p','局限：'+a.limitations,'amin-meta'));
  const doc=historyIndex===null?api.read():historyRecord.state.doc;for(const row of a.rows??[]){const item=card((row.rank==null?'未排名':row.rank+'名')+' · '+(doc[row.group]?.[row.id]?.name??row.id),c);for(const[k,label]of Object.entries({assessment:'结论',basis:'依据',strengths:'优势',weaknesses:'短板',confidence:'资料充分程度'})){const text=el('p');text.append(el('strong',label+'：'),el('span',row[k]||'未明确'));item.append(text);}}
 }
 function assessmentPage(doc){
  const c=card('个人评估参考');c.append(el('p','AI评估用于比较与参考，不默认注入日常聊天。评估范围与口径可在生成与规则中设置。','amin-meta'));
  if(historyIndex===null)btn(toolbar(c),'生成／刷新AI评估',()=>run('assessment'),true).disabled=requesting||api.busy();
  const a=historyIndex===null?api.assessment():historyRecord.state.assessment;
  if(a){c.append(el('p',(a.stale?'资料已变化，评估待刷新。 ':'')+'评估时间：'+new Date(a.at).toLocaleString(),'amin-meta'));drawAssessment(a);}else c.append(el('p','尚无评估。生成后可先查看结论与依据，再确认保存。','amin-empty'));
  const rank=card('按明确指标排序'),filters=grid(rank),g=select(filters,'主体类型',GROUPS.map(g=>[g,LABELS[g]]),'organizations'),key=field(filters,'指标标识',''),unit=field(filters,'比较单位',''),ascending=check(filters,'从小到大',false),result=el('div','','amin-stack');result.setAttribute('aria-live','polite');
  btn(toolbar(rank),'查看数值排行',()=>{result.replaceChildren();const r=rankMetrics(doc,{group:g.value,key:key.value,unit:unit.value,ascending:ascending.checked});for(const row of r.included)result.append(el('p',row.rank+' · '+row.name+'：'+row.value+' '+unit.value,'amin-result'));if(!r.included.length)result.append(el('p','没有同标识、同单位的明确数值，未生成排行。','amin-empty'));if(r.excluded.length){const excluded=details(result,'未参与排行 · '+r.excluded.length+' 项');for(const row of r.excluded)excluded.append(el('p',row.name+'：'+row.reason,'amin-meta'));}});rank.append(result);
 }
 function settingsPage(){
  const busy=requesting||api.busy(),launch=card('生成／补充');launch.append(el('p','按已保存的范围与规则生成；修改设置后请先保存。重新生成会先提供整套变更预览。','amin-meta'));
  const launchTools=toolbar(launch);const launchRun=mode=>{editing=false;return run(mode);};btn(launchTools,'生成／补充',()=>launchRun('fill'),true).disabled=busy;btn(launchTools,'重新生成整套',()=>launchRun('replace')).disabled=busy;
  editing=true;const token=api.capture(),cfg=api.config(),f=card('生成范围');
  f.append(el('p','选项按角色保存，聊天资料彼此隔离。修改后先保存，再生成或更新资料。','amin-meta'));
  const scopeFields=grid(f),scope=field(scopeFields,'整理范围',cfg.scope,true,true),detail=select(scopeFields,'详细程度',[['简略','简略'],['标准','标准'],['详细','详细']],cfg.detail),groups={},groupFields=grid(f);
  for(const g of GROUPS)groups[g]=check(groupFields,'包括'+LABELS[g],cfg.groups.includes(g));
  const sources=card('资料来源'),sourceFields=grid(sources),includeCharacter=check(sourceFields,'读取当前角色设定',cfg.includeCharacter),includeChat=check(sourceFields,'读取已加载的最近20条非系统消息',cfg.includeChat),readWorldbooks=check(sourceFields,'读取世界书',cfg.readWorldbooks!==false);
   sources.append(el('p','每次生成或评估都会读取最新资料。世界书仅使用启用条目；开启角色读取时，也会读取角色绑定与附加书。关闭世界书读取会保留选书。','amin-meta'));
   const bookPanel=details(sources,'世界书选择'),bookList=el('div','','amin-stack'),bookStatus=el('p','','amin-meta');bookStatus.setAttribute('role','status');bookPanel.append(bookStatus,bookList);
   const selectedBooks=new Set(selectedBookNames(cfg));let choices=[],catalogReady=false,listRequest=0;
   const drawBooks=()=>{
    bookList.replaceChildren();const names=new Set(choices.map(b=>b.name));
    for(const b of [...choices,...[...selectedBooks].filter(n=>!names.has(n)).map(name=>({name,sources:['当前未启用，不会读取；请取消选择或先启用'],automatic:false}))]){
     const automatic=includeCharacter.checked&&b.automatic;
     const input=check(bookList,b.name+(automatic?'（随角色自动读取）':'')+' · '+b.sources.join('、'),automatic||selectedBooks.has(b.name));input.dataset.worldbook=b.name;input.disabled=!readWorldbooks.checked||automatic;
     input.onchange=()=>{if(input.checked)selectedBooks.add(b.name);else selectedBooks.delete(b.name);};
    }
    if(!choices.length&&catalogReady)bookList.append(el('p','当前没有已启用的世界书。','amin-empty'));
   };
   const refreshBooks=async()=>{const request=++listRequest;catalogReady=false;bookStatus.textContent='正在读取当前启用列表（不加载条目正文）…';try{const next=await worldbookChoices(api.context(),{...sourceOptions,check:()=>api.check(token)});if(disposed||!f.isConnected||request!==listRequest)return;choices=next;catalogReady=true;bookStatus.textContent='只列出当前启用的书；角色自动读取与手选会合并去重。';drawBooks();}catch(e){if(!disposed&&f.isConnected&&request===listRequest){bookStatus.textContent=e.message;drawBooks();}}};
   includeCharacter.onchange=drawBooks;readWorldbooks.onchange=drawBooks;btn(toolbar(bookPanel),'刷新已启用世界书列表',refreshBooks);void refreshBooks();
   sources.append(el('p','仅使用已加载的聊天消息。世界书读取不判断关键词、概率等激活策略。','amin-meta'));
  const advanced=details(body,'高级生成规则'),policy=grid(advanced),allowInference=check(policy,'允许合理推演（必须标记）',cfg.allowInference),allowNew=check(policy,'剧情更新允许新增主体',cfg.allowNew);
  const rules={};for(const[k,label]of [['generation','生成／补充规则'],['update','剧情更新规则'],['assessment','评估规则']]){const c=card(label,advanced);rules[k+'Enabled']=check(c,'启用'+label,cfg[k+'Enabled']);rules[k+'Rules']=field(c,label+'要求',cfg[k+'Rules'],true);}
  const independent=isIndependent(api.context()),follow=details(body,independent?'剧情更新协议':'日常变量联动与世界书同步'),followEnabled=independent?{checked:cfg.follow}:check(follow,'启用日常剧情变量更新（保存后需同步世界书）',cfg.follow);
  if(independent){
   follow.append(el('p','插件直接提供统一 amin_update 更新规则。是否允许势力更新由“联动更新”中的模块与读写权限控制；这里复制当前实际生效的规则。','amin-meta'),el('p','无需同步到世界书。原有小白规则条目由你自行管理，插件不会改写这些条目。','amin-meta'));
  }else{
   const mode=api.context()?.extensionSettings?.LittleWhiteBox?.variablesMode;follow.append(el('p','小白X变量管理2.0 · 当前模式：'+(mode??'未检测到')+'。按钮生成与手动编辑不依赖此联动开关。','amin-meta'));
   follow.append(el('p','先保存本页设置，再手动同步已保存规则。同步仅修改本应用的世界书条目；关闭联动后再次同步会禁用该条目。锁定或规则修改后也需重新同步。','amin-meta'),el('p','多个角色共用世界书时会共用最后同步的规则，请使用独立世界书。','amin-meta'));
  }
  const followTools=toolbar(follow);btn(followTools,independent?'复制当前统一更新规则':'复制已保存的更新提示词',async()=>{const text=followPrompt(api.config(),api.locks(),api.context());if(globalThis.navigator?.clipboard?.writeText){await navigator.clipboard.writeText(text);say('已复制，不会自动发送');}else{field(follow,'手动复制',text,true);}});
  if(!independent)btn(followTools,'同步已保存规则到世界书',async()=>{api.check(token);const r=await syncWorldbook(api);say(r.name+'：'+r.action+(r.warning?' · '+r.warning:''));});
  const tools=toolbar(body);
  btn(tools,'保存生成与规则设置',async()=>{api.check(token);if(readWorldbooks.checked&&!catalogReady)throw Error('世界书列表尚未成功加载，请刷新或关闭世界书读取');const next={...cfg,scope:scope.value,detail:detail.value,groups:GROUPS.filter(g=>groups[g].checked),includeCharacter:includeCharacter.checked,includeChat:includeChat.checked,readWorldbooks:readWorldbooks.checked,selectedBooks:[...selectedBooks],books:'',allowInference:allowInference.checked,allowNew:allowNew.checked,follow:followEnabled.checked};if(!next.groups.length)throw Error('至少选择一种资料类型');for(const[k,input]of Object.entries(rules))next[k]=k.endsWith('Enabled')?input.checked:input.value;await api.saveConfig(next);editing=false;selected='overview';render();say(independent?'规则已保存；后续剧情更新使用统一协议与当前权限。':'规则已保存；日常联动请另行同步世界书');},true);
  btn(tools,'取消',()=>{selected='overview';cancelEdit();});
 }
 function render(){
  if(disposed)return;
  body.replaceChildren();tabs.replaceChildren();drawHeader();drawActions();
  try{
   lastIdentity=chatIdentity(api.context());
   for(const[k,label]of Object.entries(tabsMap)){
    if(historyIndex!==null&&k==='settings')continue;
    const b=el('button',label);b.type='button';b.id=viewId+'-tab-'+k;b.setAttribute('role','tab');b.setAttribute('aria-controls',body.id);b.setAttribute('aria-selected',String(selected===k));b.tabIndex=selected===k?0:-1;
    b.onclick=()=>{if(navigate(k))tabs.querySelector('[aria-selected="true"]')?.focus();};
    b.onkeydown=event=>{
     const buttons=[...tabs.querySelectorAll('[role="tab"]')],index=buttons.indexOf(b);let next;
     if(event.key==='ArrowRight')next=(index+1)%buttons.length;else if(event.key==='ArrowLeft')next=(index-1+buttons.length)%buttons.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=buttons.length-1;else return;
     event.preventDefault();buttons.forEach((button,i)=>{button.tabIndex=i===next?0:-1;});buttons[next].focus();
    };
    tabs.append(b);
   }
   body.setAttribute('aria-labelledby',viewId+'-tab-'+selected);
   const pending=api.pending();if(pending&&historyIndex===null){drawPreview(pending);return;}
   let doc=api.read();
   if(historyIndex!==null){
    const message=api.context().chat?.[historyIndex];
    if(!historyRecord?.available||!message||api.context().chatMetadata!==historyMetadata||historyRecord.external&&
      (String(message.swipe_id??0)!==historyRecord.variant||storyReference(message)!==historyRecord.reference||message.mes!==historyRecord.content||api.context().chatMetadata?.amin_os_story_storage_v2?.indexId!==historyRecord.indexId))
      throw Error('该楼层记录已变化，请返回当前资料重新打开。');
    doc=historyRecord.state.doc;
   }
   if(selected==='overview')drawOverview(doc);else if(GROUPS.includes(selected))drawGroup(doc,selected);else if(selected==='assessment')assessmentPage(doc);else settingsPage();
  }catch(e){say(e.message);body.append(el('p','请打开聊天，或检查变量资料格式。现有资料将保留。','amin-empty'));}
 }
 const unsubscribe=api.subscribe(()=>{
  if(disposed)return;try{const id=chatIdentity(api.context());if(lastIdentity!==id||historyIndex!==null&&api.context().chatMetadata!==historyMetadata){editing=false;historyRequest++;historyIndex=null;historyRecord=null;historyMetadata=null;lastIdentity=id;render();return;}}catch{editing=false;historyRequest++;historyIndex=null;historyRecord=null;historyMetadata=null;render();return;}
  if(api.error())say(api.error());
  if(!editing)render();else if(!api.pending())say(api.error()||'资料可能已更新；表单草稿保留，保存时会检查冲突。');
 });
 const handle={open(){const request=takeAppRequest('organizations');if(editing)return;if(request?.focus&&GROUPS.includes(request.group)&&historyIndex===null){search='';navigate(request.group,request.focus);return;}render();},dispose(){disposed=true;historyRequest++;unsubscribe();page.remove();if(mounted.get(target)===handle)mounted.delete(target);}};
 mounted.set(target,handle);render();return handle;
}
