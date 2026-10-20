import { uuid } from '../../uuid.js';
import {deleteAbility,restoreAbility,UNGROUPED,abilityGroup,groupNames,addGroup,renameGroup,removeGroup} from './library.js';
import {renderConsole,appearance} from './console.js';
import {getAI} from '../../ai/service.js';
import {draftRule} from './draft.js';
import {bookCatalog,readBook} from './books.js';
import {hostWorldSettings} from '../reply/world-context.js';
import {activeEffects,anchor,belongs,change,compile,splitEffect,directEffect,effectTarget} from './model.js';
import {getSharedService} from './service.js';
import {durationFields,appendTiming,timingLabel} from './timing-view.js';
import {ruleFields,appendRules} from './rules-view.js';
import {ACTION_TEMPLATES,actionTaskFields} from './action-fields.js';
import {contextLine} from '../shared/context-line.js';
import {takeAppRequest} from '../shared/open-app.js';
import {attachLinkageBadge} from '../linkage/badge.js';
import {collapseTabs} from '../../ui/tabs.js';
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export function mount(target,options={}){
 const instanceId='amin-'+uuid();
 const api=options.api??getSharedService();
 const page=node('div',null,'amin-page amin-app-page amin-effects'),context=node('div',contextLine(api.context(),'能力发动与持续效果'),'amin-context');
 attachLinkageBadge(context,'effects',{getContext:()=>api.context?.()});
 const tabs=node('div',null,'amin-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','持续效果页面');
 const status=node('div',null,'amin-notice');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const recovery=node('section',null,'amin-card amin-stack');recovery.hidden=true;
 const body=node('section',null,'amin-stack');body.id=instanceId+'-body';body.setAttribute('role','tabpanel');
 page.append(context,tabs,status,recovery,body);target.append(page);const consoleState={target:'',holder:'',group:'',skillId:'',targetMode:null};const managementState={group:'',skillId:''};let formOpen=false,formDirty=false;let selected='能力面板',entries=[],books=[],chosenBook='',loadedBook='',loadEpoch=0,draftController=null,consoleView=null;
 const clearBody=()=>{consoleView?.dispose();consoleView=null;body.replaceChildren();};
 const mutate=(token,op,data)=>api.mutate?api.mutate(token,op,data):api.save(token,s=>change(s,api.context().chat,op,data));
 const openForm=()=>{formOpen=true;formDirty=false;};
 body.addEventListener('input',()=>{if(formOpen)formDirty=true;});body.addEventListener('change',()=>{if(formOpen)formDirty=true;});
 const navigate=fn=>{if(formOpen&&(formDirty||draftController)){say('有未保存的编辑，请先保存，或点击表单的取消／返回按钮放弃修改。');return;}fn();};
 const stopDraft=()=>{draftController?.abort();draftController=null;};
 const say=(text,state)=>{status.textContent=text;status.dataset.state=state??(draftController?'busy':'');};
 const button=(parent,label,fn,primary=false)=>{const b=node('button',label,typeof primary==='string'?primary:primary?'amin-primary':'');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){say(e.message);status.dataset.state='error';}finally{b.disabled=false;syncRecovery();}};parent.append(b);return b;};
 const operationButton=(parent,label,fn,primary=false)=>{const b=button(parent,label,fn,primary);b.dataset.effectMutation='true';b.disabled=!!api.dirty?.();return b;};
 recovery.append(node('p','效果变更已应用到当前内存，聊天存储尚未完成。重试只保存这次结果，不会重复发动、暂停或延长效果。'));
 button(recovery,'重试保存',async()=>{await api.retrySave();finish('已保存之前的效果变更');},true);
 function syncRecovery(){const dirty=!!api.dirty?.();recovery.hidden=!dirty;for(const b of page.querySelectorAll('[data-effect-mutation]'))b.disabled=dirty||b.dataset.expired==='true';}
 const tabButtons=['能力面板','能力管理','生效中','行动结算','周期结算','变更记录','提示预览'].map((name,i)=>{
  const b=button(tabs,name,()=>navigate(()=>{selected=name;render();}));b.id=instanceId+'-tab-'+i;b.setAttribute('role','tab');b.setAttribute('aria-controls',body.id);return b;
 });
 // The panel follows effect changes and chat switches; “⋯” keeps a manual fallback.
 const overflow=collapseTabs(tabs,{keep:['能力面板','生效中','行动结算','能力管理'],label:'更多能力页面',actions:[{label:'重新读取能力列表',title:'仅在显示异常时使用',run:()=>navigate(render)}]});
 tabs.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();let i=tabButtons.findIndex(b=>b.textContent===selected),n=tabButtons.length;i=e.key==='Home'?0:e.key==='End'?n-1:(i+(e.key==='ArrowRight'?1:n-1))%n;navigate(()=>{selected=tabButtons[i].textContent;render();tabButtons[i].focus();});};
 function field(parent,label,value='',multiline=false){const row=node('label',label,'amin-field'+(multiline?' amin-span-full':'')),input=node(multiline?'textarea':'input');input.value=value;input.setAttribute('aria-label',label);if(multiline)input.rows=4;row.append(input);parent.append(row);return input;}
 function select(parent,label,options){const row=node('label',label,'amin-field'),input=node('select');input.setAttribute('aria-label',label);for(const [value,text]of options){const o=node('option',text);o.value=value;input.append(o);}row.append(input);parent.append(row);return input;}
 function card(title,parent=body){const c=node('section',null,'amin-card amin-stack');c.append(node('h3',title,'amin-section-heading'));parent.append(c);return c;}
 function grid(parent){const c=node('div',null,'amin-form-grid');parent.append(c);return c;}
 function toolbar(parent){const c=node('div',null,'amin-toolbar');parent.append(c);return c;}
 function finish(text){render();say(text);}
 async function load(){const token=api.capture(),epoch=++loadEpoch;const c=api.check(token);say('读取当前启用的世界书列表…');const config=await hostWorldSettings(c);api.check(token);if(epoch!==loadEpoch)return;books=bookCatalog(c,config);chosenBook='';loadedBook='';entries=[];render();say(books.length?'请选择一本世界书，再读取条目。':'当前没有全局启用或绑定的世界书，请先在酒馆中启用。');}
 async function loadSelected(){if(!chosenBook)throw Error('请先选择世界书');const token=api.capture(),epoch=++loadEpoch;const c=api.check(token),name=chosenBook;const config=await hostWorldSettings(c);api.check(token);if(epoch!==loadEpoch)return;const book=bookCatalog(c,config).find(b=>b.name===name);if(!book)throw Error('这本世界书已停用或解绑，请刷新列表');say('读取「'+name+'」…');const result=await readBook(c,book);api.check(token);if(epoch!==loadEpoch)return;entries=result;loadedBook=name;render();say(`已读取「${name}」：${entries.length} 条有效条目`);}
 function importForm(entry,existing){openForm();stopDraft();const token=api.capture();clearBody();const c=card(existing?'编辑能力':'添加能力');const name=field(c,'技能名称',existing?.name||entry.title||'未命名技能');let source;if(entry.custom){source=field(c,'能力原文 / 设定',entry.content,true);}else{const original=node('details');original.append(node('summary','查看世界书原文'),node('pre',entry.content));c.append(original);}const sourceText=()=>source?.value??entry.content;
  const reminder=field(c,'持续提醒规则（可精简，不修改世界书）',existing?.reminder??entry.content,true);c.append(node('p','生效时保存规则快照；世界书以后修改，不会悄悄改变已发动的效果。'));
  const ui=appearance(existing??{name:name.value});const buttonOptions=node('details');buttonOptions.append(node('summary','分组、外观与默认发动设置'));c.append(buttonOptions);const settings=grid(buttonOptions);
  const icon=field(settings,'按钮图标（文字或符号）',ui.icon);icon.maxLength=12;
  const size=select(settings,'按钮大小',[['small','小'],['medium','中'],['wide','宽']]);size.value=ui.size;
  const tone=select(settings,'按钮颜色',[['accent','主题强调'],['soft','柔和'],['plain','简洁']]);tone.value=ui.tone;
  const availableGroups=groupNames(api.read());
   const group=select(settings,'所属分组',availableGroups.map(n=>[n,n]));group.value=existing?abilityGroup(existing):(availableGroups.includes(consoleState.group)?consoleState.group:UNGROUPED);
   const newGroup=field(settings,'新分组名称（可选）');newGroup.maxLength=40;
   const defaultMode=select(settings,'默认发动方式',[['targeted','对指定对象使用'],['direct','直接发动（无指定对象）']]);defaultMode.value=ui.targetMode;
   const scopeDefault=field(settings,'默认作用层面',entry.custom&&!existing?'':ui.scope),commandDefault=field(settings,'默认指令',ui.command,true),conditionDefault=field(settings,'默认持续条件',ui.condition,true);
  const visibleLabel=node('label',null,'amin-check');const visible=node('input');visible.type='checkbox';visible.checked=!ui.hidden;visibleLabel.append(visible,node('span','在能力面板显示'));buttonOptions.append(visibleLabel);
  const buttonConfig=()=>({...existing?.ui,icon:icon.value.trim()||'✦',size:size.value,tone:tone.value,group:newGroup.value.trim()||group.value,targetMode:defaultMode.value,scope:scopeDefault.value.trim()||name.value.trim(),command:commandDefault.value,condition:conditionDefault.value.trim()||'直到主动解除',hidden:!visible.checked});
  const instruction=field(c,'给 AI 的补充要求（可选）','',true);instruction.placeholder='例如：精简为关键规则，完整保留解除条件。';
  const actions=node('div',null,'amin-toolbar');c.append(actions);
  const draftBox=node('section',null,'amin-card');draftBox.hidden=true;const candidate=field(draftBox,'AI 草稿（可修改后采用）','',true);c.append(draftBox);
  button(draftBox,'采用草稿到规则框',()=>{reminder.value=candidate.value;formDirty=true;say('已放入规则框，点击“保存能力”才会保存。');});
  button(actions,'AI 编写提醒',async()=>{
   const controller=new AbortController();draftController=controller;cancel.hidden=false;draftBox.hidden=true;say('AI 正在读取所选技能并起草规则…');
   const check=()=>{api.check(token);if(!c.isConnected)throw Error('规则编辑页已关闭');};
   try{const result=await draftRule({ai:getAI(),ctx:api.check(token),entry:{...entry,content:sourceText()},name:name.value,current:reminder.value,instruction:instruction.value,signal:controller.signal,check});candidate.value=result;draftBox.hidden=false;say('草稿已生成，请检查后采用；原规则尚未修改。');}
   catch(e){if(c.isConnected)say(controller.signal.aborted?'已取消，原规则未修改':e.message);}
   finally{cancel.hidden=true;if(draftController===controller)draftController=null;}
  },true);
  const cancel=button(actions,'取消生成',()=>{draftController?.abort();});cancel.hidden=true;
  c.append(node('p','使用 Amin os 的共享 API 和预设。AI 草稿不会自动保存，也不会改动已生效的规则快照。'));
  const saveActions=toolbar(c);button(saveActions,'保存能力',async()=>{if(!name.value.trim()||!sourceText().trim())throw Error('能力名称和原文不能为空');if(!reminder.value.trim())reminder.value=sourceText();await api.saveLibrary(token,s=>{if(newGroup.value.trim())s=addGroup(s,newGroup.value);if(!groupNames(s).includes(buttonConfig().group))throw Error('分组已不存在，请重新打开编辑器');if(!existing&&s.skills.some(x=>x.book===entry.book&&x.entryId===entry.id))throw Error('此条目已经关联');if(existing){const skill=s.skills.find(x=>x.id===existing.id);if(!skill)throw Error('技能已不存在');skill.name=name.value.trim();skill.reminder=reminder.value.trim();skill.ui=buttonConfig();if(entry.custom)skill.original=sourceText();return s;}s.skills.push({id:uuid(),book:entry.book,entryId:entry.id,name:name.value.trim(),original:sourceText(),custom:!!entry.custom,ui:buttonConfig(),reminder:reminder.value.trim()});return s;});finish('已保存到共享能力库，可在任意角色和聊天中发动');},true);button(saveActions,'取消编辑',render);
 }
 function deleteForm(skill){openForm();const token=api.capture();stopDraft();clearBody();const c=card('删除能力：'+skill.name);
  c.append(node('p','将从共享能力库和所有角色、聊天的能力按钮中移除。已发动效果继续保留，可在“生效中”单独暂停或解除。原世界书不受影响。'));
  c.append(node('p','删除后可在能力管理下方的“已删除能力”中恢复。'));
  const actions=toolbar(c);button(actions,'确认删除能力',async()=>{await api.saveLibrary(token,s=>deleteAbility(s,skill.id));finish('已删除能力；可在“已删除能力”中恢复，已发动效果保留');},'amin-danger');button(actions,'取消',render);
 }
 function effectForm(effect){
  openForm();const token=api.capture(),store=api.read();clearBody();const c=card(effect?'调整指令 / 转让 / 时长':'建立生效记录'),fields=grid(c);let skill,group;
  if(!effect){group=select(fields,'记录能力分组',[['','全部分组'],...groupNames(store).map(n=>[n,n])]);skill=select(fields,'技能',[['','请选择能力'],...store.skills.map(s=>[s.id,s.name])]);}
  const mode=select(fields,'发动方式',[['targeted','对指定对象使用'],['direct','直接发动（无指定对象）']]);mode.value=directEffect(effect)?'direct':'targeted';mode.disabled=!!effect;
  const holder=field(fields,'持有者',effect?.holder??api.context()?.name1??''),targetField=field(fields,'目标',effect?.target??''),scope=field(fields,'作用层面',effect?.scope??'');if(effect){targetField.disabled=true;scope.disabled=true;}
  const reflect=()=>{targetField.parentElement.hidden=mode.value==='direct';targetField.required=mode.value!=='direct';};mode.onchange=reflect;reflect();
  if(skill){group.onchange=()=>{skill.replaceChildren();for(const [id,text]of [['','请选择能力'],...store.skills.filter(s=>!group.value||abilityGroup(s)===group.value).map(s=>[s.id,s.name])]){const o=node('option',text);o.value=id;skill.append(o);}skill.value='';};skill.onchange=()=>{mode.value=store.skills.find(s=>s.id===skill.value)?.ui?.targetMode??'targeted';reflect();};}
  const command=field(fields,'当前指令',effect?.command??'',true),condition=field(fields,'持续或解除条件',effect?.condition??'直到主动解除或转让；其他条件按技能规则人工确认。',true);
  if(effect)appendTiming(c,effect);const duration=durationFields(c,{effect,clock:api.gameClock?.()});const rules=ruleFields(c,{effect,ctx:api.context()});
  const actions=toolbar(c);operationButton(actions,'确认保存',async()=>{await mutate(token,effect?'update':'create',{id:effect?.id,skillId:skill?.value,holder:holder.value,targetMode:mode.value,target:mode.value==='direct'?'':targetField.value,scope:scope.value,command:command.value,condition:condition.value,durationMinutes:duration.read(),...rules.read()});finish('生效记录已保存');},true);button(actions,'取消',render);
 }
 function groupManager(){
  stopDraft();formOpen=false;formDirty=false;clearBody();const store=api.read();card('能力分组').append(node('p','分组跨角色和聊天共享。删除分组只将能力移回“未分组”，不删除能力或历史效果。'));
  const actions=toolbar(body);button(actions,'新建分组',()=>groupEditor(),true);button(actions,'返回',render);
  for(const name of groupNames(store)){const c=card(name+' · '+store.skills.filter(s=>abilityGroup(s)===name).length+' 项');if(name===UNGROUPED)continue;const actions=toolbar(c);button(actions,'重命名分组',()=>groupEditor(name));button(actions,'删除分组',()=>deleteGroupForm(name),'amin-danger');}
 }
 function groupEditor(from){
  openForm();const token=api.capture();clearBody();const c=card(from?'重命名分组：'+from:'新建分组'),name=field(c,'分组名称',from??'');name.maxLength=40;
  const actions=toolbar(c);button(actions,'保存分组',async()=>{await api.saveLibrary(token,s=>from?renameGroup(s,from,name.value):addGroup(s,name.value));if(consoleState.group===from)consoleState.group=name.value.trim();if(managementState.group===from)managementState.group=name.value.trim();finish('分组已保存；已有能力和规则快照均保留');},true);button(actions,'取消',render);
 }
 function deleteGroupForm(name){
  openForm();const token=api.capture();clearBody();const c=card('删除分组：'+name);c.append(node('p','确认后该组能力移到“未分组”。不会删除能力，也不会改写已经发动的效果。'));
  const actions=toolbar(c);button(actions,'确认删除分组',async()=>{await api.saveLibrary(token,s=>removeGroup(s,name));if(consoleState.group===name){consoleState.group=UNGROUPED;consoleState.skillId='';}if(managementState.group===name){managementState.group=UNGROUPED;managementState.skillId='';}finish('已删除分组，能力已移到“未分组”');},'amin-danger');button(actions,'取消',render);
 }
 function deleteEffect(effect){const token=api.capture();return mutate(token,'delete',{id:effect.id}).then(()=>finish('已删除此生效记录，不再发送该效果；能力库保留'));}
 function endForm(effect){openForm();const token=api.capture();clearBody();const c=card('解除：'+effectTarget(effect)+' / '+effect.scope),reason=field(c,'解除依据','',true);operationButton(c,'确认解除',async()=>{await mutate(token,'end',{id:effect.id,reason:reason.value});finish('已解除此项效果');},true);button(c,'取消',render);}
 function splitForm(effect){openForm();const token=api.capture();clearBody();const c=card('分割：'+effectTarget(effect)+' / '+effect.scope);c.append(node('p','每行填写“作用层面 | 持有者”。保存后原关系结束，由子记录接替；请完整列出需要保留的范围。'));
  const parts=field(c,'分割与分配','',true);operationButton(c,'确认分割',async()=>{const rows=parts.value.split('\n').filter(x=>x.trim()).map(x=>x.split('|').map(v=>v.trim()));if(rows.length<2||rows.some(x=>x.length!==2||!x[0]||!x[1]))throw Error('至少填写两行，格式为：右手 | 持有者');const assignments=rows.map(([scope,holder])=>({scope,holder}));if(api.split)await api.split(token,effect.id,assignments);else await api.save(token,s=>splitEffect(s,api.context().chat,effect.id,assignments));finish('已分割，子记录保留原规则快照与剩余时长');},true);button(c,'取消',render);
 }
 function settlementForm(ids){
  openForm();const token=api.capture();let preview;try{preview=api.stageSettlement(token,ids);}catch(error){formOpen=false;throw error;}clearBody();
  const c=card('确认周期结算');c.append(node('p',preview.summary),node('p','以下变更与已结算时刻一起保存；任何数值越界或资源不足都会阻止整组操作。','amin-meta'));
  for(const row of preview.rows){const section=node('section',null,'amin-card');section.append(node('h3',row.name+' · '+row.target),node('p',`${row.ticks} 个周期${row.stacks>1?' × '+row.stacks+' 层':''}`));for(const change of row.changes)section.append(node('p',`${change.label}：${change.before} → ${change.after}`));c.append(section);}
  const actions=toolbar(c);operationButton(actions,'确认结算',async()=>{await api.confirmSettlement();finish('周期结算已保存，重复预览不会再次扣除');},true);button(actions,'取消结算',()=>{api.discardSettlement?.();render();});
 }
 function actionForm(){
  const c=card('行动结算'),resources=api.actionResources?.();
  c.append(node('p','设置一次能力使用、治疗、伤害或物品消耗。预览后统一确认；不会自动发送消息，也不会自动判断完整游戏规则。','amin-meta'));
  if(!resources){c.append(node('p','请刷新插件以使用行动结算。'));return;}
  const previous=api.actionResult?.();if(previous){const result=card('最近已结算行动',c);result.append(node('pre',previous.text));button(toolbar(result),'复制最近结算结果',async()=>{if(api.actionResult?.()?.text!==previous.text)throw Error('聊天或回复版本已变化，请重新查看行动结果');await navigator.clipboard.writeText(previous.text);say('已复制固定结果');});}
  openForm();const token=api.capture(),fields=grid(c),skills=api.read().skills;
  const skill=select(fields,'参考能力',[['','自定义行动'],...skills.map(s=>[s.id,s.name])]);
  const name=field(fields,'行动名称','使用能力');skill.onchange=()=>{if(skill.value)name.value=skills.find(s=>s.id===skill.value).name;};
  const cost=select(fields,'消耗资源',[['','无消耗'],...resources.costs.map((r,i)=>[String(i),`${r.label} · ${r.value}`])]),amount=field(fields,'消耗数量','1');amount.type='number';amount.min='0';amount.step='any';
  const targetStat=select(fields,'目标属性',[['','不改变属性'],...resources.stats.map((r,i)=>[String(i),`${r.label} · ${r.value}`])]),delta=field(fields,'目标增减（治疗填正数，伤害填负数）','1');delta.type='number';delta.step='any';
  const minutes=field(fields,'耗时（分钟，0 不推进）','0');minutes.type='number';minutes.min='0';minutes.step='1';
  const roll=select(fields,'引用已有骰点',[['','不引用'],...(resources.rolls??[]).map(r=>[r.id,r.text])]);
  const template=select(fields,'行动模板',[['','选择快捷模板'],...ACTION_TEMPLATES.map(t=>[t.id,t.name])]);
  const templateHint=node('p','','amin-meta');c.append(templateHint);
  button(toolbar(c),'填入模板到当前草稿',()=>{const preset=ACTION_TEMPLATES.find(t=>t.id===template.value);if(!preset)throw Error('请先选择行动模板');name.value=preset.name;minutes.value=String(preset.minutes);skill.value='';cost.value='';targetStat.value='';roll.value='';amount.value='1';delta.value='1';templateHint.textContent=preset.hint;formDirty=true;});
  const taskFields=actionTaskFields(c,resources,{node,field,select,button,grid,toolbar});
  c.append(node('p','属性来自人物卡已绑定的世界状态数值；请先在人物卡绑定生命、魔力等字段。超出进度上限会拒绝结算，请调整数值。','amin-meta'));
  operationButton(toolbar(c),'预览行动结算',()=>{
   api.check(token);const plan=api.stageAction({name:name.value,cost:cost.value===''?null:resources.costs[Number(cost.value)],costAmount:Number(amount.value),target:targetStat.value===''?null:resources.stats[Number(targetStat.value)],delta:Number(delta.value),minutes:Number(minutes.value),rollId:roll.value,task:taskFields.read()});
   clearBody();openForm();const preview=card('确认行动：'+plan.name);for(const row of plan.rows)preview.append(node('p',row));
   const actions=toolbar(preview);operationButton(actions,'确认行动结算',async()=>{await api.confirmAction();formOpen=false;clearBody();const done=card('行动已结算');done.append(node('pre',plan.text));button(toolbar(done),'复制固定结果',async()=>{if(api.actionResult?.()?.text!==plan.text)throw Error('聊天或回复版本已变化，请重新查看行动结果');await navigator.clipboard.writeText(plan.text);say('已复制，可粘贴到聊天草稿');});button(toolbar(done),'返回行动结算',render);say('行动已保存；复制结果不会再次扣除资源');},true);
   button(actions,'取消行动结算',()=>{api.discardSettlement?.();render();});
  },true);
 }
 function render(){
  formOpen=false;formDirty=false;
  body.onpointerdown=body.onpointermove=body.onpointerup=body.onpointercancel=null;
  stopDraft();
  for(const b of tabButtons){const on=b.textContent===selected;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;if(on)body.setAttribute('aria-labelledby',b.id);}overflow.update();
  clearBody();syncRecovery();target.scrollTop=0;status.textContent=api.status();context.textContent=contextLine(api.context(),'能力发动与持续效果');
  try{const store=api.read(),chat=api.context()?.chat??[];
   if(selected==='能力面板'){consoleView=renderConsole({body,api,state:consoleState,say,render,manage:()=>{selected='能力管理';render();},groups:groupManager,editSkill:s=>importForm({book:s.book,id:s.entryId,title:s.name,content:s.original,custom:s.custom},s),onFormOpen:openForm,adjust:effectForm,end:endForm,remove:deleteEffect});
   }else if(selected==='能力管理'){
    const actions=toolbar(body);button(actions,'手动添加能力',()=>importForm({book:'自定义能力',id:uuid(),title:'',content:'',custom:true}),true);button(actions,'管理分组',groupManager);
    const library=card('共享能力库 · '+store.skills.length+' 项');library.append(node('p','所有角色和聊天通用。能力原文与提醒规则独立保存，生效记录归属当前聊天。','amin-meta'));
    const filters=grid(library);
    const allGroups=groupNames(store);if(managementState.group&&!allGroups.includes(managementState.group)){managementState.group='';managementState.skillId='';}
    const groupFilter=select(filters,'管理分组筛选',[['','全部分组'],...allGroups.map(n=>[n,n])]);groupFilter.value=managementState.group;
    const matching=store.skills.filter(s=>!managementState.group||abilityGroup(s)===managementState.group);if(!matching.some(s=>s.id===managementState.skillId))managementState.skillId='';
    const abilitySelect=select(filters,'管理能力',[['','请选择要管理的能力'],...matching.map(s=>[s.id,s.name+(s.ui?.hidden?'（已隐藏）':'')])]);abilitySelect.value=managementState.skillId;
    groupFilter.onchange=()=>{managementState.group=groupFilter.value;managementState.skillId='';render();};abilitySelect.onchange=()=>{managementState.skillId=abilitySelect.value;render();};
    for(const s of matching.filter(s=>s.id===managementState.skillId)){const c=card(s.name,library);c.append(node('p',s.book+' · 条目 '+s.entryId,'amin-meta'));const d=node('details');d.append(node('summary','查看保存的原文与提醒规则'),node('pre',s.original),node('pre',s.reminder));c.append(d);const actions=toolbar(c);button(actions,'编辑能力',()=>importForm({book:s.book,id:s.entryId,title:s.name,content:s.original,custom:s.custom},s),true);button(actions,'删除能力',()=>deleteForm(s),'amin-danger');}
    if(!matching.length)library.append(node('p',store.skills.length?'这个分组还没有能力。':'添加自定义能力，或展开下方世界书导入。','amin-empty'));
    else if(!managementState.skillId)library.append(node('p','选择一项能力，即可编辑原文、提醒规则与显示设置。','amin-empty'));
    const importer=node('details',null,'amin-card');importer.open=!!books.length||!!loadedBook;importer.append(node('summary','从世界书导入能力'));body.append(importer);
    importer.append(node('p','读取全局启用或当前角色绑定的世界书。导入会保存能力副本，保留原世界书。','amin-meta'));button(toolbar(importer),'刷新世界书列表',load);
    if(books.length){const picker=select(importer,'选择世界书',[['','请选择一本世界书'],...books.map(b=>[b.name,b.name+' · '+b.sources.join(' / ')])]);picker.value=chosenBook;picker.onchange=()=>{chosenBook=picker.value;entries=[];loadedBook='';loadEpoch++;render();};button(toolbar(importer),'读取所选世界书',loadSelected,true).disabled=!chosenBook;}
    if(loadedBook)importer.append(node('p','当前查看：'+loadedBook+(entries.length?'':' · 没有启用的非空条目'),'amin-meta'));
    if(entries.length){const filter=field(importer,'筛选世界书条目'),list=node('div',null,'amin-stack');filter.type='search';importer.append(list);const draw=()=>{list.replaceChildren();const matched=entries.filter(e=>(e.book+e.title+e.content).toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase()));for(const e of matched)button(list,(e.title||'条目 '+e.id)+' · '+e.book,()=>importForm(e));if(!matched.length)list.append(node('p','没有匹配条目，请调整搜索词。','amin-empty'));};filter.oninput=draw;draw();}
    if(store.trash?.length){const deleted=node('details');deleted.append(node('summary','已删除能力 · '+store.trash.length));body.append(deleted);for(const item of store.trash){const row=node('section',null,'amin-card');row.append(node('h3',item.skill.name));button(row,'恢复能力',async()=>{const token=api.capture();await api.saveLibrary(token,s=>restoreAbility(s,item.skill.id));finish('能力已恢复到共享能力库');});deleted.append(row);}}
   }else if(selected==='生效中'){
    button(toolbar(body),'建立生效记录',()=>effectForm(),true).disabled=!store.skills.length;
    const effects=api.timedEffects?.()??activeEffects(store,chat);if(!effects.length)body.append(node('p',store.skills.length?'当前分支没有持续效果。选择能力并确认发动后，会显示在这里。':'先在能力管理中添加能力，再建立生效记录。','amin-empty'));
    for(const e of effects){const c=card(e.skill.name+' · '+effectTarget(e));c.append(node('p',timingLabel(e),'amin-meta'),node('p','持有者：'+e.holder+' ｜ 层面：'+e.scope),node('p','当前指令：'+(e.command||'未指定')),node('p','持续条件：'+e.condition));appendTiming(c,e);appendRules(c,e);const actions=toolbar(c);button(actions,'调整 / 转让 / 时长',()=>effectForm(e));const pause=operationButton(actions,e.paused?'恢复效果':'暂停效果',async()=>{const token=api.capture();await mutate(token,'pause',{id:e.id,paused:!e.paused});finish(e.paused?'已恢复效果':'已暂停效果');});pause.dataset.expired=String(e.timingStatus?.state==='expired');pause.disabled=!!api.dirty?.()||e.timingStatus?.state==='expired';if(e.timingStatus?.state==='expired')c.append(node('p','效果已到期；可调整时长重新计时，或解除记录。','amin-meta'));button(actions,'分割',()=>splitForm(e));button(actions,'解除',()=>endForm(e));operationButton(actions,'删除生效记录',()=>deleteEffect(e),'amin-danger');}
   }else if(selected==='行动结算'){actionForm();
   }else if(selected==='周期结算'){
    const forecast=api.periodicPreview?.();const intro=card('周期效果与资源结算');intro.append(node('p','推进游戏时间只产生待结算周期。请先预览生命、资源与物品变更，再确认整组保存。读取剧情提示不会执行伤害或消耗。','amin-meta'));
    if(!forecast)intro.append(node('p','当前服务暂不支持周期结算，请刷新扩展。','amin-empty'));
    else{if(forecast.pending.length)operationButton(toolbar(intro),'预览全部周期结算',()=>settlementForm(),true);if(!forecast.records.length)intro.append(node('p','尚未设置周期规则。可在建立或调整效果时展开“叠加与周期规则”。','amin-empty'));for(const record of forecast.records){const c=card(record.name+' · '+record.target);c.append(node('p',record.label));if(record.lastSettledAt){const at=record.lastSettledAt;c.append(node('p',`上次结算剧情时刻：${at.year}/${at.month}/${at.day} ${String(at.hour).padStart(2,'0')}:${String(at.minute).padStart(2,'0')}`,'amin-meta'));}if(record.pendingTicks)operationButton(toolbar(c),'预览此效果结算',()=>settlementForm([record.id]));}}
   }else if(selected==='变更记录'){
    const now=anchor(chat);if(!store.events.length)body.append(node('p','发动、调整或解除能力后，这里会保留变更记录。','amin-empty'));
    for(const e of [...store.events].reverse()){const active=belongs(e,now),c=card(`${e.floor} 楼 · ${{create:'建立',update:'调整 / 转让',end:'解除',delete:'删除生效记录',pause:e.paused?'暂停':'恢复',settle:'周期结算',refresh:'刷新计时',stack:'叠层',restore:'恢复存档'}[e.op]}`);c.append(node('p',active?'属于当前分支':'原分支记录 · 当前不生效','amin-meta'),node('p',e.at));const detail=node('details');detail.append(node('summary','查看变更详情'),node('pre',JSON.stringify(e.effect??e.patch??{原因:e.reason},null,2)));if(e.changes)detail.append(node('pre',JSON.stringify(e.changes,null,2)));c.append(detail);}
   }else{
    const token=api.capture(),settings=card('剧情提醒设置');const toggle=node('label',null,'amin-check'),check=node('input');check.type='checkbox';check.checked=store.enabled;toggle.append(check,node('span','生成时附加持续提醒'));settings.append(toggle);
    const limit=field(settings,'提醒字符上限（1000–200000）',String(store.limit));limit.type='number';limit.min=1000;limit.max=200000;
    button(toolbar(settings),'保存提醒设置',async()=>{const n=Number(limit.value);if(!Number.isInteger(n)||n<1000||n>200000)throw Error('字符上限需为 1000–200000 的整数');await api.save(token,s=>({...s,enabled:check.checked,limit:n}));finish('提醒设置已保存');},true);
    let prompt,note='下次生成将使用以下提醒；超过上限会明确提示，不会截掉部分效果。';try{if(api.promptPreview){const result=api.promptPreview();prompt=result.text;note=result.note;}else prompt=api.prompt?api.prompt():compile(store,chat);}catch(e){prompt=e.message;}const preview=card('当前分支 · 提示预览');preview.append(node('p',note,'amin-meta'),node('pre',prompt||'无提醒','amin-result'));
   }
  }catch(e){say(e.message);}
 }
 const unsubscribe=api.subscribe(event=>{if(!formOpen&&!event?.error)render();else status.textContent=api.status();syncRecovery();});
 const ctx=api.context(),events=ctx.eventTypes??ctx.event_types??{};
 const chatChanged=()=>{entries=[];books=[];chosenBook='';loadedBook='';consoleState.target='';consoleState.holder='';consoleState.skillId='';consoleState.targetMode=null;managementState.skillId='';loadEpoch++;render();};if(events.CHAT_CHANGED)ctx.eventSource?.on(events.CHAT_CHANGED,chatChanged);
 render();return {open(){const request=takeAppRequest('effects');if(formOpen)return;if(request?.focus&&request.tab==='能力管理'){selected='能力管理';managementState.group='';managementState.skillId=request.focus;}else if(request?.tab==='生效中')selected='生效中';render();},dispose(){stopDraft();consoleView?.dispose();consoleView=null;loadEpoch++;unsubscribe();overflow.dispose();if(events.CHAT_CHANGED)ctx.eventSource?.removeListener?.(events.CHAT_CHANGED,chatChanged);page.remove();}};
}
