import { uuid } from '../../uuid.js';
import {getAI} from '../../ai/service.js';
import {getSharedService} from './service.js';
import {current,apply,diff,compile,matches,path,fieldKey,groupRecords,resetRecord,archive} from './model.js';
import {catalog,searchEndpoint} from './sources.js';
import {generateRecord,simulate} from './generator.js';
import {contextLine} from '../shared/context-line.js';
import {takeAppRequest} from '../shared/open-app.js';
import {attachLinkageBadge} from '../linkage/badge.js';
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
const STATUS={known:'资料记载',inferred:'待确认推测',invented:'新增设定',unknown:'未知',edited:'手动改写'},KIND={person:'人物',thing:'事物',world:'世界'},VIEW_KEY='amin-information-view';
export function mount(target){
 const instanceId='amin-'+uuid();
 const api=getSharedService();const page=node('div',null,'amin-page amin-app-page amin-information'),intro=node('div',contextLine(api.context(),'资料档案','预览后应用到当前剧情'),'amin-context'),tabs=node('nav',null,'amin-tabs'),notice=node('div',null,'amin-notice'),body=node('section',null,'amin-stack');tabs.setAttribute('aria-label','信息面板页面');tabs.setAttribute('role','tablist');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');body.id=instanceId+'-body';body.setAttribute('role','tabpanel');page.append(intro,tabs,notice,body);target.append(page);
 attachLinkageBadge(intro,'information');
 let tab='资料面板',draft=null,base=null,token=null,naming=false,fieldSession=null,query='',onlyChanged=false,closed=new Set(),view=(()=>{try{return globalThis.localStorage?.getItem(VIEW_KEY);}catch{return null;}})()==='tree'?'tree':'panel',review=false,simulation=null,search=null,controller=null,epoch=0,bookList=[],loaded=false,selectedId='',drafts=new Map();
 const options={name:'',kind:'person',requirement:'',allowInvent:false,scope:'local',books:[],includeCard:true,includeChat:true,keywords:'',sourceLimit:90000,webQuery:'',webKey:'',webEndpoint:'https://api.tavily.com/search'};
 const chatDrafts=new Map();
 let taskNotice='';const say=(text,state=controller?'busy':'')=>{taskNotice=text;notice.textContent=text;notice.dataset.state=state;};let chatScope;try{chatScope=api.capture();}catch{}
 function stop(){epoch++;controller?.abort();controller=null;}
 const button=(parent,text,fn,primary=false)=>{const b=node('button',text,typeof primary==='string'?primary:primary?'amin-primary':'');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){say(e.message);notice.dataset.state='error';}finally{b.disabled=false;}};parent.append(b);return b;};
 const navigate=name=>{if(fieldSession){say('请先完成或取消当前字段编辑，输入内容已保留。');return false;}tab=name;render();return true;};
 const labels=['资料面板','生成资料','历史版本','检索设置'];const tabButtons=labels.map((name,i)=>{const b=button(tabs,name,()=>navigate(name));b.id=instanceId+'-tab-'+i;b.setAttribute('role','tab');b.setAttribute('aria-controls',body.id);return b;});
 tabs.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const i=labels.indexOf(tab),next=e.key==='Home'?0:e.key==='End'?3:(i+(e.key==='ArrowRight'?1:3))%4;if(navigate(labels[next]))tabButtons[next].focus();};
 function input(parent,label,value,update,{area=false,type='text',placeholder=''}={}){const row=node('label',label,'amin-field'+(area?' amin-span-full':'')),e=node(area?'textarea':'input');if(!area)e.type=type;e.value=value??'';e.placeholder=placeholder;e.setAttribute('aria-label',label);if(area)e.rows=4;e.oninput=()=>update(e.value);row.append(e);parent.append(row);return e;}
 function select(parent,label,value,values,update){const row=node('label',label,'amin-field'),e=node('select');e.setAttribute('aria-label',label);for(const [v,text]of values){const o=node('option',text);o.value=v;e.append(o);}e.value=value;e.onchange=()=>update(e.value);row.append(e);parent.append(row);return e;}
 function check(parent,label,value,update){const row=node('label',null,'amin-info-check amin-check'),e=node('input');e.type='checkbox';e.checked=value;e.setAttribute('aria-label',label);e.onchange=()=>update(e.checked);row.append(e,node('span',label));parent.append(row);return e;}
 function card(title,parent=body){const c=node('section',null,'amin-card amin-stack');if(title)c.append(node('h3',title,'amin-section-heading'));parent.append(c);return c;}
 function grid(parent){const c=node('div',null,'amin-form-grid');parent.append(c);return c;}
 function toolbar(parent){const c=node('div',null,'amin-toolbar');parent.append(c);return c;}
 function dirty(){stop();review=false;simulation=null;}
 function newDraft(record,old=null){draft=structuredClone(record);base=structuredClone(old);token=api.capture();selectedId=record.id;naming=false;closeField();review=false;simulation=null;tab='资料面板';render();}
 function keepDraft(){if(draft)drafts.set(draft.id,{draft,base,token,search,fieldSession});}
 function choose(id){stop();keepDraft();selectedId=id;const cached=drafts.get(id);if(cached){({draft,base,token,search}=cached);}else{const entry=api.library().find(e=>e.record.id===id),saved=current(api.read(),api.context().chat).find(r=>r.id===id),record=entry?.record??saved;draft=structuredClone(record);base=structuredClone(saved??{...record,fields:record.baselineFields??record.fields});token=api.capture();search=entry?.search??null;}naming=false;closeField();review=false;simulation=null;render();const pending=cached?.fieldSession;if(pending){const field=pending.isNew?pending.changed:draft.fields.find(f=>f.id===pending.changed.id);if(field)editField(field,{isNew:pending.isNew,initial:pending.changed});}}
 async function books(){const t=api.capture(),run=++epoch;const found=await catalog(api.check(t));api.check(t);if(run!==epoch)return;bookList=found;options.books=loaded?options.books.filter(n=>found.some(b=>b.name===n)):found.map(b=>b.name);loaded=true;render();say(`已载入 ${found.length} 本可选世界书`);}
 async function generate(){
  if(!options.name.trim())throw Error('请填写人物、事物或世界名称');if(!Number.isInteger(options.sourceLimit)||options.sourceLimit<5000||options.sourceLimit>400000)throw Error('资料字符预算需为 5000–400000');
  if(options.scope!=='local'){searchEndpoint(options.webEndpoint,location.origin);if(!options.webKey.trim())throw Error('请在检索设置填写搜索 API Key');}
  stop();const run=epoch,c=new AbortController();controller=c;const t=api.capture(),settings=structuredClone(options);const old=selectedId?current(api.read(),api.context().chat).find(r=>r.id===selectedId&&r.name===settings.name&&r.kind===settings.kind):null;const inputOld=draft&&draft.name===settings.name&&draft.kind===settings.kind?structuredClone(draft):old;
  const guard=()=>{api.check(t);if(run!==epoch||c.signal.aborted)throw Error('已取消或切换页面');};render();say('开始检索资料…');
  try{const result=await generateRecord({ai:getAI(),ctx:api.check(t),options:settings,existing:inputOld,signal:c.signal,check:guard,report:text=>{if(run===epoch)say(text);}});guard();await api.saveRecord(t,result.record,result.search);guard();const viewing=tab;keepDraft();search=result.search;controller=null;newDraft(result.record,old??{...result.record,fields:result.record.baselineFields});if(viewing!=='生成资料'){tab=viewing;render();}say(`资料草稿已生成：采用 ${search.report.included} 个片段，预算外 ${search.report.omitted} 个。检查后再应用。`);}
  catch(e){if(run===epoch)say(c.signal.aborted?'已取消，原面板保持不变':e.message,c.signal.aborted?'':'error');}
  finally{if(controller===c){controller=null;if(!fieldSession)render();}body.querySelectorAll('[data-running]').forEach(e=>e.disabled=false);}
 }
 async function runSimulation(){api.check(token);stop();const run=epoch,c=new AbortController();controller=c;const guard=()=>{api.check(token);if(run!==epoch||c.signal.aborted)throw Error('已取消');};render();say('正在模拟改写的关联影响…');
  try{const result=await simulate({ai:getAI(),ctx:api.check(token),before:base,draft:structuredClone(draft),requirement:options.requirement,signal:c.signal,check:guard});guard();simulation=result;controller=null;render();say('模拟完成，建议尚未采用，面板尚未应用。');}catch(e){if(run===epoch)say(c.signal.aborted?'已取消模拟':e.message,c.signal.aborted?'':'error');}finally{if(controller===c){controller=null;if(!fieldSession)render();}}
 }
 // Field editing happens inline (like 角色卡资料). The session survives re-renders, tab switches are blocked while it is open.
 function editField(field,{isNew=false,initial=field}={}){stop();tab='资料面板';const back=fieldSession?.back??view;if(!isNew)view='tree';fieldSession={isNew,id:field.id,changed:structuredClone(initial),focus:true,back};if(!isNew)closed.delete(field.category);render();}
 function closeField(){if(fieldSession)view=fieldSession.back;fieldSession=null;}
 function fieldEditor(){
  const session=fieldSession,changed=session.changed,box=node('div',null,'amin-cardprofile-editor amin-stack amin-info-editor');box.append(node('strong',session.isNew?'添加字段':'编辑字段'),node('p','完成编辑后写入资料草稿；预览并应用后才会影响剧情。','amin-meta'));
  const fields=grid(box);input(fields,'分类',changed.category,v=>changed.category=v);input(fields,'字段名称',changed.label,v=>changed.label=v);const value=input(fields,'字段值',changed.value,v=>changed.value=v,{area:true});
  const before=baseField(changed);if(before&&before.value!==changed.value)box.append(node('p','已保存版本：'+(before.value||'（空）'),'amin-meta'));
  const actions=toolbar(box);button(actions,'完成编辑',()=>{if(!changed.category.trim()||!changed.label.trim())throw Error('分类和字段名称不能为空');changed.category=changed.category.trim();changed.label=changed.label.trim();const clash=draft.fields.find(f=>f.id!==session.id&&fieldKey(f)===fieldKey(changed));if(clash)throw Error('同一分类下已有同名字段');changed.status='edited';if(session.isNew)draft.fields.push(changed);else Object.assign(draft.fields.find(f=>f.id===session.id)??{},changed);closed.delete(changed.category);closeField();dirty();render();},true);button(actions,'取消编辑',()=>{closeField();render();});
  if(!session.isNew)button(actions,'删除字段',()=>{draft.fields=draft.fields.filter(f=>f.id!==session.id);closeField();dirty();render();},'amin-danger');
  if(session.focus){session.focus=false;queueMicrotask(()=>value.focus());}
  return box;
 }
 const baseField=f=>(base?.fields??[]).find(b=>fieldKey(b)===fieldKey(f));
 function changeOf(f){if(!base)return null;const old=baseField(f);if(!old)return {type:'added'};return old.value!==f.value?{type:'changed',before:old.value}:null;}
 function sourceDetails(parent,sources){if(!sources?.length)return;const d=node('details',null,'amin-info-sources');d.onclick=e=>e?.stopPropagation?.();d.append(node('summary','来源 '+sources.length));for(const s of sources){d.append(node('p',s.title,'amin-meta'),node('blockquote',s.quote));if(s.url){const a=node('a','打开来源网页');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';d.append(a);}}parent.append(d);}
 const statusTag=(status,cls='')=>{const t=node('span',STATUS[status],'amin-info-status'+cls);t.dataset.status=status;return t;};
 const clickable=(row,label,fn)=>{row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label',label);row.onclick=()=>fn();row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fn();}};return row;};
 const categories=()=>[...new Set(draft.fields.map(f=>f.category))];
 function board(){
  const saved=current(api.read(),api.context().chat),choices=new Map(saved.map(r=>[r.id,r]));for(const e of api.library())choices.set(e.record.id,e.record);for(const [id,c]of drafts)choices.set(id,c.draft);if(draft)choices.set(draft.id,draft);
  const actions=toolbar(body);
  if(choices.size){const row=node('label',null,'amin-field amin-info-picker'),pick=node('select');pick.setAttribute('aria-label','选择资料');if(!draft){const o=node('option','选择一份资料…');o.value='';pick.append(o);}
   for(const group of groupRecords([...choices.values()]))for(const [i,r]of group.records.entries()){const o=node('option',`${group.name} · ${KIND[group.kind]}${group.records.length>1?' · 资料 '+(i+1):''} · ${r.fields.length} 项`);o.value=r.id;pick.append(o);}
   pick.value=draft?.id??'';pick.onchange=()=>{if(fieldSession){say('请先完成或取消当前字段编辑。');pick.value=draft?.id??'';return;}if(pick.value)choose(pick.value);};row.append(pick);actions.append(row);}
  button(actions,'AI 搜索并生成',()=>{if(draft&&!controller){options.name=draft.name;options.kind=draft.kind;}navigate('生成资料');},true);button(actions,'新建空白面板',()=>{if(fieldSession)throw Error('请先完成或取消当前字段编辑。');keepDraft();search=null;newDraft({id:uuid(),name:'新面板',kind:'person',mode:'retcon',fields:[]});naming=true;render();});
  if(!draft){body.append(node('p',choices.size?'在上方选择一份已收纳的资料继续编辑，或整理新资料。':'还没有资料。点“AI 搜索并生成”从酒馆资料整理，或新建空白面板手动填写。','amin-empty'));return;}
  const changes=draft.fields.filter(changeOf),removed=(base?.fields??[]).filter(b=>!draft.fields.some(f=>fieldKey(f)===fieldKey(b)));
  const heading=card(null);const title=node('div',null,'amin-info-title');title.append(node('h3',draft.name,'amin-section-heading'),node('span',KIND[draft.kind]+'面板','amin-info-kind'));heading.append(title);
  heading.append(node('p',[`${draft.fields.length} 个字段`,base?(changes.length+removed.length?`与已保存版本相比有 ${changes.length+removed.length} 处改动（未应用）`:'与已保存版本相同'):'尚未应用的新面板'].join(' · '),'amin-meta'));
  const top=node('div',null,'amin-cardprofile-settings');heading.append(top);select(top,'改写方式',draft.mode,[['retcon','现实重构：新设定一直成立，仅使用者记得改写前'],['forward','普通修改：从现在起变化，保留历史']],v=>{draft.mode=v;dirty();});
  button(toolbar(top),naming?'完成改名':'改名称 / 类型',()=>{stop();naming=!naming;render();});
  if(naming){const fields=grid(heading);input(fields,'面板名称',draft.name,v=>{draft.name=v;dirty();});select(fields,'面板类型',draft.kind,[['person','人物'],['thing','事物'],['world','世界']],v=>{draft.kind=v;dirty();});}
  if(search){const d=node('details');d.append(node('summary',`检索详情 · ${search.report.included} 个片段 / ${search.report.webResults} 条联网结果`),node('p','关键词：'+search.queries.join('、')),node('p',`有 ${search.report.omitted} 个命中片段因字符预算未送入模型；结果不保证覆盖全部资料。`));for(const s of search.sources){const item=node('details');item.append(node('summary',s.title),node('pre',s.text));if(s.url){const a=node('a','搜索来源');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';item.append(a);}d.append(item);}heading.append(d);}
  const switcher=toolbar(body);button(switcher,view==='panel'?'切换到编辑视图':'切换到面板视图',()=>{view=view==='panel'?'tree':'panel';try{globalThis.localStorage?.setItem(VIEW_KEY,view);}catch{}render();});button(switcher,'添加字段',()=>editField({id:uuid(),category:categories()[0]??'自定义',label:'新字段',value:'',status:'edited',sources:[]},{isNew:true}));
  if(fieldSession?.isNew)body.append(fieldEditor());
  if(view==='panel')panelView();else fieldTree(switcher);
  if(removed.length){const lost=card(`已删除的字段 · ${removed.length}`);for(const f of removed){const row=node('div',null,'amin-cardprofile-removed');row.append(node('span',`${f.category} / ${f.label}：${f.value}`));button(row,'恢复',()=>{draft.fields.push(structuredClone(f));dirty();render();});lost.append(row);}}
  if(fieldSession){body.append(node('p','正在编辑字段：完成或取消后再保存、预览或应用。','amin-meta'));return;}
  const bar=toolbar(body),maintenance=node('details',null,'amin-card');maintenance.append(node('summary','草稿管理与重置'));const maintenanceActions=toolbar(maintenance);body.append(maintenance);button(bar,'保存资料（不影响正文）',async()=>{await api.saveRecord(token,draft,search);token=api.capture();keepDraft();say('资料已收纳，不影响正文');});button(maintenanceActions,'一键重置当前面板修改',async()=>{stop();const id=draft.id;await api.save(token,s=>resetRecord(s,api.context().chat,id),(entries,s)=>archive(entries,current(s,api.context().chat).find(r=>r.id===id),search));drafts.delete(id);base=structuredClone(current(api.read(),api.context().chat).find(r=>r.id===id));draft=structuredClone(base);token=api.capture();review=false;simulation=null;render();say('已恢复修改前资料，当前面板的累计修改不再发送；历史版本仍保留。');},'amin-danger');button(bar,'预览改写',()=>{stop();api.check(token);review=true;render();},true);button(bar,'AI 模拟演变',runSimulation).disabled=!!controller;if(controller)button(bar,'取消生成 / 模拟',()=>{stop();render();say('已取消，草稿保留');});button(maintenanceActions,'放弃草稿',()=>{stop();drafts.delete(draft.id);draft=base?structuredClone(base):null;selectedId=draft?.id??'';token=draft?api.capture():null;review=false;simulation=null;render();},'amin-danger');
  if(simulation){const c=card('模拟结果 · 未应用');c.append(node('p',simulation.summary));const list=node('ul',null,'amin-cardprofile-proposals');for(const p of simulation.proposals){const li=node('li',null,'amin-cardprofile-proposal');li.dataset.status='pending';li.append(node('strong',`${p.category} / ${p.label}`),node('div','建议：'+p.value,'amin-cardprofile-proposal-after'),node('div','依据：'+p.reason,'amin-cardprofile-proposal-reason'));list.append(li);}c.append(list);button(c,'采用这些建议到草稿',()=>{for(const p of simulation.proposals){const f=draft.fields.find(f=>fieldKey(f)===fieldKey(p));if(f){f.value=p.value;f.status='invented';f.sources=[];}else draft.fields.push({id:uuid(),category:p.category,label:p.label,value:p.value,status:'invented',sources:[]});}dirty();render();say('已采用到草稿，尚未应用到剧情。');});}
  if(review){const c=card('确认改写');const changes=diff(base??{...draft,fields:draft.baselineFields??[]},draft);c.append(node('p','每次确认保存修改前后资料，后续正文请求按顺序附带全部修改记录。同一字段最后一次修改为准；单纯查询不注入。','amin-meta'));const list=node('ul',null,'amin-cardprofile-proposals');for(const d of changes){const li=node('li',null,'amin-cardprofile-proposal');li.dataset.status='pending';li.append(node('strong',`${d.category} / ${d.label}`),node('div','当前：'+d.before,'amin-cardprofile-proposal-before'),node('div','改为：'+d.after,'amin-cardprofile-proposal-after'));list.append(li);}c.append(list);if(!changes.length)c.append(node('p','字段值无变化；将保存当前名称和改写方式。'));button(c,'确认应用到当前剧情',async()=>{await api.saveRecord(token,draft,search);await api.save(token,s=>apply(s,api.context().chat,draft));drafts.delete(draft.id);base=structuredClone(current(api.read(),api.context().chat).find(r=>r.id===draft.id));draft=structuredClone(base);token=api.capture();review=false;simulation=null;render();say('已应用。原世界书、旧聊天和其他应用的数据未改写。');},true);}
 }
 // 编辑视图: collapsible categories with compact "字段：值" rows; click a row to edit it in place.
 function fieldTree(tools){
  const searchRow=node('label',null,'amin-field amin-cardprofile-search'),find=node('input');find.type='search';find.placeholder='搜索字段或内容';find.value=query;find.dataset.infoSearch='1';find.setAttribute('aria-label','搜索资料字段');
  find.oninput=e=>{query=find.value;if(!e?.isComposing)render();};find.addEventListener('compositionend',()=>{query=find.value;render();});searchRow.append(find);tools.append(searchRow);
  if(base)button(tools,onlyChanged?'显示全部':'只看改动',()=>{onlyChanged=!onlyChanged;render();});const all=categories();button(tools,all.every(c=>closed.has(c))?'全部展开':'全部折叠',()=>{if(all.every(c=>closed.has(c)))closed.clear();else all.forEach(c=>closed.add(c));render();});
  const q=query.trim().toLowerCase(),hit=f=>!q||[f.category,f.label,f.value].some(t=>t.toLowerCase().includes(q)),editingId=fieldSession&&!fieldSession.isNew?fieldSession.id:null;
  const tree=node('div',null,'amin-cardprofile-tree');let shown=0;
  for(const category of all){const fields=draft.fields.filter(f=>f.category===category&&(f.id===editingId||(hit(f)&&(!onlyChanged||changeOf(f)))));if(!fields.length)continue;shown++;
   const group=node('details',null,'amin-cardprofile-group');group.open=!closed.has(category)||!!q;group.ontoggle=()=>{if(group.open)closed.delete(category);else closed.add(category);};
   const summary=node('summary');summary.append(node('span',category,'amin-cardprofile-key'),node('span',`${fields.length} 项`,'amin-meta'));if(fields.some(changeOf))summary.append(node('span','内有改动','amin-cardprofile-badge amin-cardprofile-badge-soft'));group.append(summary);
   const children=node('div',null,'amin-cardprofile-children');group.append(children);
   for(const f of fields){if(f.id===editingId){children.append(fieldEditor());continue;}
    const row=clickable(node('div',null,'amin-cardprofile-leaf amin-info-leaf'),'编辑 '+f.label,()=>editField(f)),change=changeOf(f);
    const tags=node('span',null,'amin-info-tags');if(f.status!=='known')tags.append(statusTag(f.status));if(change)tags.append(node('span',change.type==='added'?'新增':'已改','amin-cardprofile-badge'));
    row.append(node('span',f.label,'amin-cardprofile-key'),node('span',f.value||'（空）','amin-cardprofile-value'+(f.status==='unknown'?' amin-info-unknown':'')));if(tags.children?.length??tags.childElementCount)row.append(tags);if(change?.type==='changed')row.append(node('span','原：'+(change.before||'（空）'),'amin-cardprofile-before'));
    sourceDetails(row,f.sources);children.append(row);}
   tree.append(group);}
  if(!shown)tree.append(node('p',!draft.fields.length?'还没有字段，点击“添加字段”开始编辑。':q?'没有匹配的字段。':'还没有改动。','amin-empty'));else tree.append(node('p','点任意一项就地编辑。没有标签的字段为资料记载。','amin-meta'));body.append(tree);
 }
 // 面板视图: read-only, game-style sheet. Categories become cards; changed values are highlighted; click to edit.
 function panelView(){
  const root=node('div',null,'amin-cardprofile-panel amin-info-panel');
  for(const category of categories()){const fields=draft.fields.filter(f=>f.category===category),section=node('section',null,'amin-cardprofile-panel-section');if(fields.some(changeOf))section.dataset.changed='1';section.append(node('h4',category,'amin-cardprofile-panel-head'));
   for(const f of fields){const change=changeOf(f),row=clickable(node('div',null,'amin-cardprofile-panel-row'),'编辑 '+f.label,()=>editField(f));if(change)row.dataset.changed=change.type;
    row.append(node('span',f.label,'amin-cardprofile-panel-key'),node('span',f.value||'—','amin-cardprofile-panel-value'+(f.status==='unknown'?' amin-info-unknown':'')));if(f.status!=='known')row.append(statusTag(f.status,' amin-info-status-mini'));
    if(change?.type==='changed')row.append(node('span','原：'+(change.before||'（空）'),'amin-cardprofile-panel-before'));section.append(row);}
   root.append(section);}
  if(!draft.fields.length)root.append(node('p','还没有字段，点击“添加字段”开始编辑。','amin-empty'));
  else root.append(node('p','点任意一项进入编辑。高亮的是与已保存版本不同的地方；没有标签的字段为资料记载。','amin-meta'));body.append(root);
 }
 function generation(){
  const c=card('查询或生成资料');const changed=(key,value)=>{stop();options[key]=value;};
  const fields=grid(c);input(fields,'对象或世界名称',options.name,v=>changed('name',v));select(fields,'对象类型',options.kind,[['person','人物'],['thing','物品 / 地点 / 组织等事物'],['world','世界']],v=>changed('kind',v));
  input(fields,'整理要求 / 新增设定要求',options.requirement,v=>changed('requirement',v),{area:true,placeholder:'例如：整理身份、经历和技能；额外设计一个资料里没有的天赋。'});check(c,'允许按要求创造资料里没有的信息',options.allowInvent,v=>changed('allowInvent',v));
  const sources=card('资料来源');select(sources,'检索范围',options.scope,[['local','酒馆资料'],['web','互联网'],['both','酒馆资料＋互联网']],v=>{changed('scope',v);render();});
  if(options.scope!=='web'){
   check(sources,'读取当前角色卡及其绑定世界书',options.includeCard,v=>changed('includeCard',v));check(sources,'检索当前聊天记录',options.includeChat,v=>changed('includeChat',v));
   const booksBox=node('details');booksBox.append(node('summary','额外世界书 · 已选 '+options.books.length+' 本'));sources.append(booksBox);button(toolbar(booksBox),'刷新世界书列表',books);const choices=node('div',null,'amin-stack');booksBox.append(choices);
   for(const b of bookList)check(choices,b.name+' · '+b.sources.join(' / '),options.books.includes(b.name),v=>{stop();options.books=v?[...options.books,b.name]:options.books.filter(n=>n!==b.name);});
   if(!bookList.length)choices.append(node('p',loaded?'当前没有可选的额外世界书。':'刷新列表后，可勾选额外世界书。角色绑定书由上方选项控制。','amin-empty'));
  }
  if(options.scope!=='local'){input(sources,'联网搜索词（空白使用对象名称）',options.webQuery,v=>changed('webQuery',v));sources.append(node('p','联网使用检索设置中的 Tavily 或兼容代理。仅将联网搜索词发给搜索服务；结果与所选资料会交给共享 AI 整理。','amin-meta'));}
  const more=node('details',null,'amin-card');more.append(node('summary','高级检索设置'));body.append(more);const advanced=grid(more);input(advanced,'补充检索关键词（逗号分隔）',options.keywords,v=>changed('keywords',v));const budget=input(advanced,'送入模型的资料字符预算',options.sourceLimit,v=>changed('sourceLimit',Number(v)),{type:'number'});budget.min=5000;budget.max=400000;budget.step=1000;
  const actions=toolbar(body),go=button(actions,'AI 搜索并生成草稿',generate,true);go.disabled=!!controller;go.dataset.running='true';if(controller)button(actions,'取消生成',()=>{stop();render();say('已取消，原面板和草稿保持不变');});
 }
 function changeList(changes){const list=node('ul',null,'amin-cardprofile-proposals');for(const d of changes??[]){const li=node('li',null,'amin-cardprofile-proposal');li.dataset.status='pending';li.append(node('strong',`${d.category} / ${d.label}`),node('div','之前：'+d.before,'amin-cardprofile-proposal-before'),node('div','之后：'+d.after,'amin-cardprofile-proposal-after'));list.append(li);}if(!changes?.length)list.append(node('li','字段值无变化','amin-meta'));return list;}
 function history(){const history=api.read().history;if(!history.length){body.append(node('p','应用改写后，这里会保存每次版本与差异。','amin-empty'));return;}const prefix=path(api.context().chat);for(const e of [...history].reverse()){const c=card(e.snapshot?.name??'移除的面板');c.append(node('p',[e.at?.startsWith('1970')?'初始资料':new Date(e.at).toLocaleString(),e.reason??'初始资料',matches(e,prefix)?'当前分支':'其他分支'].filter((x,i,a)=>a.indexOf(x)===i).join(' · '),'amin-meta'),changeList(e.changes));if(e.before){const details=node('details');details.append(node('summary','查看修改前后完整资料'),node('pre',JSON.stringify({修改前:e.before,修改后:e.snapshot},null,2)));c.append(details);}if(e.snapshot)button(c,'载入此版本为回滚草稿',()=>{keepDraft();search=null;newDraft(e.snapshot,current(api.read(),api.context().chat).find(r=>r.id===e.recordId));say('历史版本已载入草稿。预览并确认应用后才会回滚当前面板。');});}}
 function settings(){
  const c=card('联网搜索');c.append(node('p','可选择酒馆、互联网或混合检索。联网需要 Tavily 搜索密钥；也可填写返回同样格式的代理地址。密钥仅保留到本次页面刷新，不写入聊天或预设。'));
  const connection=grid(c);input(connection,'搜索 API 地址',options.webEndpoint,v=>{stop();options.webEndpoint=v;});const key=input(connection,'搜索 API Key',options.webKey,v=>{stop();options.webKey=v;},{type:'password'});key.autocomplete='off';button(c,'清除搜索密钥',()=>{options.webKey='';render();});
  const s=api.read(),t=api.capture(),r=card('当前剧情提醒');let enabled=s.enabled,limit=s.limit;check(r,'生成剧情时附加全部修改前后记录',enabled,v=>enabled=v);input(r,'提醒字符上限（1000–200000）',limit,v=>limit=Number(v),{type:'number'});button(r,'保存提醒设置',async()=>{if(!Number.isInteger(limit)||limit<1000||limit>200000)throw Error('上限需为 1000–200000');await api.save(t,s=>({...s,enabled,limit}));if(draft)token=api.capture();render();},true);
  const d=node('details');d.append(node('summary','查看当前剧情提醒'));try{d.append(node('pre',compile(s,api.context().chat)||'无提醒'));}catch(e){d.append(node('p',e.message));}r.append(d);
 }
 function render(){const refocus=document.activeElement?.dataset?.infoSearch==='1',caret=document.activeElement?.selectionStart;body.replaceChildren();intro.textContent=contextLine(api.context(),'资料档案','预览后应用到当前剧情');for(const b of tabButtons){const on=b.textContent===tab;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;if(on)body.setAttribute('aria-labelledby',b.id);}notice.textContent=taskNotice||api.status();try{if(tab==='资料面板')board();else if(tab==='生成资料')generation();else if(tab==='历史版本')history();else settings();}catch(e){say(e.message);}if(refocus){const box=[...body.querySelectorAll?.('[data-info-search="1"]')??[]][0];box?.focus();if(box&&Number.isInteger(caret))box.setSelectionRange(caret,caret);}}
 const unsubscribe=api.subscribe(()=>{if(!controller&&!taskNotice)notice.textContent=api.status();});const ctx=api.context(),events=ctx.eventTypes??ctx.event_types??{};
 const chatChanged=()=>{let now;try{now=api.capture();}catch{}if(now&&chatScope&&now.meta===chatScope.meta&&now.identity===chatScope.identity)return;if(chatScope){keepDraft();chatDrafts.set(chatScope.identity,{drafts:new Map(drafts),selectedId});}closeField();chatScope=now;taskNotice='已切换聊天，旧聊天的任务已取消';stop();draft=null;base=null;token=null;search=null;simulation=null;drafts.clear();selectedId='';bookList=[];loaded=false;options.books=[];options.name='';options.requirement='';options.webQuery='';const cached=chatDrafts.get(now?.identity);if(cached){drafts=new Map(cached.drafts);for(const entry of drafts.values()){const fresh=api.capture();if(entry.token?.path===fresh.path&&entry.token?.revision===fresh.revision)entry.token=fresh;}selectedId=cached.selectedId;}if(selectedId){choose(selectedId);}else render();};if(events.CHAT_CHANGED)ctx.eventSource?.on(events.CHAT_CHANGED,chatChanged);
 render();return {open(){const request=takeAppRequest('information');if(fieldSession)return;if(request?.focus&&!controller&&current(api.read(),api.context().chat).some(r=>r.id===request.focus)){tab='资料面板';choose(request.focus);return;}render();},dispose(){stop();unsubscribe();if(events.CHAT_CHANGED)ctx.eventSource?.removeListener?.(events.CHAT_CHANGED,chatChanged);page.remove();}};
}
