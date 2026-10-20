import { uuid } from '../../uuid.js';
import {styleLibrary,contentLibrary} from './writing-library.js';
import {mountContentStyles} from './content-styles-view.js';
import {referenceSamples,chatIdentity} from '../stylewriter/model.js';
import {getAI} from '../../ai/service.js';
import {LINKED_SOURCES,DEFAULT_LINKED_SOURCES,collectLinkedContext} from './linked-context.js';
import {getState2Runtime} from '../state2/runtime.js';
import { styleTags, usedStyleKeys, rememberStyles } from './style-tags.js';
import { CONTENT_MODES, normalizeSettings, chatStamp, collectContext, generateOptions, inputElement, DraftSelection, waitForResult } from './generator.js';
const KEY='reply_options_mvp';
const context=()=>globalThis.SillyTavern?.getContext?.();
const node=(tag,text,cls)=>{const n=document.createElement(tag); if(text)n.textContent=text;if(cls)n.className=cls;return n;};
export function mount({target,instanceId='reply-options-panel',contextProvider,headingText,getContext} = {}) {
    const hostContext=getContext??(()=>globalThis.SillyTavern?.getContext?.());
    const context=()=>{const ctx=hostContext();const scoped=contextProvider?contextProvider(ctx??{}):ctx;return scoped?{...scoped,replyState2Ready:getState2Runtime()?.ready(ctx)}:scoped;};
    const settingsId=instanceId==='reply-options-panel'?'reply-options-settings':instanceId+'-settings';
    const removers=[];
    if(document.getElementById(instanceId))return;
    const ctx=context(), form=document.querySelector('#send_form');if(!ctx||!form)return;
    let settings=normalizeSettings(ctx.extensionSettings?.[KEY]), revision=0, controller=null;
    const draft=new DraftSelection(hostContext);let draftIdentity=null;
    let candidates=[],candidateScope=null,excludedLinkedRecords=[];
    const styles=styleLibrary(hostContext),contents=contentLibrary(hostContext);
    const panel=node('details');panel.id=instanceId;panel.className='ro-panel amin-stack';panel.open=target ? true : settings.expanded;
    panel.append(node('summary','回复选项'));
    const controls=node('div',null,'ro-controls amin-toolbar'), cards=node('div',null,'ro-options'), status=node('div','点击生成，选择后填入，由你发送。','ro-status');
    const tagRow=node('div',null,'ro-style-tags');tagRow.setAttribute('role','group');tagRow.setAttribute('aria-label','常用风格');
    controls.setAttribute('aria-label','候选操作');cards.setAttribute('aria-label','回复候选');
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const button=(label,fn,parent=controls)=>{const b=node('button',label,'menu_button');b.type='button';b.addEventListener('click',fn);parent.append(b);return b;};
    const generate=button('生成选项',()=>run(false)), expand=button('根据草稿扩写',()=>run(true));
    generate.className='menu_button amin-primary ro-generate';
    const cancel=button('停止等待',()=>controller?.abort());cancel.hidden=true;
    const undo=button('撤销填入',()=>{try{if(chatIdentity(context())!==draftIdentity)throw Error('聊天已变化，不能撤销旧候选。');draft.undo(inputElement());status.textContent='已还原原草稿。';updateSelection();}catch(e){status.textContent=e.message;}});
    const settingsBox=node('section');settingsBox.id=settingsId;settingsBox.className='ro-settings amin-card amin-form-grid';settingsBox.hidden=true;
    settingsBox.append(node('h3','生成设置','amin-section-heading amin-span-full'));
    // Styles the user picks become the quick tags on the candidates page (most recent first).
    function rememberUsed(){settings.recentStyles=rememberStyles(settings.recentStyles,usedStyleKeys(settings));}
    function save(){const c=hostContext();if(c?.extensionSettings){c.extensionSettings[KEY]={...settings};c.saveSettingsDebounced?.();}}
    function invalidate(message='上下文已更新，请重新生成。',reset=false){drawTags();revision++;controller?.abort();candidates=[];candidateScope=null;cards.replaceChildren();if(reset){draft.reset();excludedLinkedRecords=[];}updateSelection();status.textContent=message;}
    const fieldRows=new Map();
    function field(key,label,type,options){
        const row=node('label',null,type==='checkbox'?'amin-check':type==='textarea'?'amin-field amin-span-full':'amin-field'), title=node('span',label);row.append(title);fieldRows.set(key,row);
        const el=node(type==='textarea'?'textarea':options?'select':'input');el.setAttribute('aria-label',label);
        if(options)for(const [value,text] of options){const o=node('option',text);o.value=value;el.append(o);}
        if(type==='checkbox'){el.type='checkbox';el.checked=settings[key];}else {if(type==='number'){el.type='number';el.min=key==='count'?2:key==='timeout'?15:1;el.max=key==='count'?6:key==='timeout'?300:40;}el.value=settings[key];}
        if(key==='subjectName'){el.type='text';el.maxLength=100;el.placeholder='填写任意剧情角色名字；留空使用当前用户角色';}
        if(type==='textarea')el.maxLength=['prompt','authorPrompt','authorSystemPrompt','roleplaySystemPrompt'].includes(key)?32000:8000;
        el.addEventListener('change',()=>{settings=normalizeSettings({...settings,[key]:type==='checkbox'?el.checked:el.value});if(type!=='checkbox')el.value=settings[key];save();invalidate('设置已保存，请重新生成。');});row.append(el);settingsBox.append(row);
    }
    function directionsEditor(key,rowKey,title){
        const box=node('section',null,'ro-direction-list amin-stack amin-span-full');fieldRows.set(rowKey,box);settingsBox.append(box);
        const persist=()=>{settings=normalizeSettings({...settings,[key]:settings[key]});save();invalidate('方向已保存，请重新生成。');};
        function draw(){box.replaceChildren();box.append(node('h4',title,'amin-section-heading'));for(const item of settings[key]){
            const row=node('div',null,'ro-direction-item'),toggle=node('input'),text=node('input');toggle.type='checkbox';toggle.checked=item.enabled;toggle.setAttribute('aria-label','启用'+title+'：'+(item.text||'未命名'));text.value=item.text;text.maxLength=600;text.setAttribute('aria-label',title+'内容');
            toggle.addEventListener('change',()=>{settings[key].find(v=>v.id===item.id).enabled=toggle.checked;persist();draw();});text.addEventListener('change',()=>{settings[key].find(v=>v.id===item.id).text=text.value;persist();draw();});row.append(toggle,text);button('删除',()=>{settings[key]=settings[key].filter(v=>v.id!==item.id);persist();draw();},row);box.append(row);
        }button('添加'+title,()=>{settings[key].push({id:uuid(),text:'',enabled:true});persist();draw();},box);box.append(node('p','仅抽取启用且非空的方向；全部禁用时不会请求模型。','amin-meta'));}
        draw();
    }
    if(getAI())button('AI 设置 · 全局 API 与预设',()=>globalThis.AminOS?.openApp('ai'),settingsBox).className='menu_button amin-span-full';
    field('count','选项数量','number');field('depth','最近聊天条数','number');
    field('length','选项长度','select',[['short','短：约 1 句'],['medium','中：1–3 句'],['long','长：3–6 句']]);
    field('style','回复形式','select',[['mixed','对白与动作'],['dialogue','仅对白'],['action','动作描写为主']]);
    field('perspective','叙述人称','select',[['auto','跟随上文'],['first','第一人称：我'],['second','第二人称：你'],['third','第三人称：名字']]);
    field('subjectName','回复主体（任意剧情角色，所有人称生效）','text');
    field('mode','普通生成填入方式','select',[['append','保留原草稿，切换候选'],['replace','替换原草稿，支持撤销']]);
    field('persona','参考用户人设','checkbox');field('character','参考角色设定（含绑定世界书）','checkbox');field('world','参考激活的全体世界书','checkbox');
    field('roleplaySystemPrompt','角色扮演模式提示词（角色定位）','textarea');
    directionsEditor('directionItems','directions','选项方向');field('prompt','自定义生成要求','textarea');
    directionsEditor('authorDirectionItems','authorDirections','剧情方向');
    field('authorSystemPrompt','剧情模式提示词（作者 / 编剧定位）','textarea');field('authorPrompt','作者要求（节奏、冲突、伏笔、希望避免的走向等）','textarea');
    const roleHelp=node('p','回复主体可填写任意剧情角色的名字，不限于玩家或当前角色卡。留空使用当前用户角色；旧第三人称名字会迁移为主体。对白中的人称按语义保留。方向少于选项数量时允许重复抽取；方向足够时不重复抽取。重复方向仍生成不同回复。草稿扩写会用候选替换原草稿，可撤销。角色设定包含绑定世界书；全体世界书包含当前全局启用及角色、聊天、人设绑定的书。读取全部未禁用的非空条目，不要求关键词触发。','amin-meta amin-span-full');settingsBox.append(roleHelp);
    if(target){const heading=node('header',null,'amin-reply-heading amin-context');heading.append(node('p','生成候选或扩写草稿，选中后填入聊天。'));panel.append(heading);}
    const modeRow=node('label',null,'ro-writing-mode amin-field'),modeSelect=node('select'),modeHelp=node('p',null,'amin-meta');modeRow.append(node('span','创作模式'));modeSelect.setAttribute('aria-label','创作模式');for(const [value,label]of [['roleplay','角色扮演 · 拟写角色回复'],['author','创意写作 · 规划剧情走向']]){const option=node('option',label);option.value=value;modeSelect.append(option);}modeRow.append(modeSelect);
    function reflectMode(){const author=settings.writingMode==='author';roleHelp.hidden=author;modeSelect.value=settings.writingMode;for(const key of ['style','perspective','subjectName','directions','prompt','roleplaySystemPrompt'])fieldRows.get(key).hidden=author;for(const key of ['authorDirections','authorPrompt','authorSystemPrompt'])fieldRows.get(key).hidden=!author;expand.textContent=author?'展开作者构想':'根据草稿扩写';modeHelp.textContent=author?'以作者 / 编剧视角选择下一步事件、冲突与转折。选中后填入作者指令，不自动发送。':'以指定剧情角色为主体生成对白与行动。选中后填入输入框，不自动发送。';const heading=panel.querySelector('.amin-reply-heading h2');if(heading)heading.textContent=author?'接下来，故事怎么走':headingText||'下一句，由你决定';}
    modeSelect.onchange=()=>{settings=normalizeSettings({...settings,writingMode:modeSelect.value});save();invalidate('模式已切换，请重新生成。');reflectMode();};
    const contentRow=node('div',null,'ro-content-settings amin-stack');
    const contentControls=mountContentStyles(contentRow,{library:contents,
        getSelection:()=>settings.contentMode,
        setSelection:id=>{const changed=settings.contentMode!==id;settings.contentMode=id;if(changed)rememberUsed();save();},
        onChange:()=>invalidate('内容风格已变化，请重新生成。'),
    });
    const styleRow=node('div',null,'ro-writing-mode amin-field'),styleMode=node('select'),styleSelect=node('select');
    styleMode.setAttribute('aria-label','候选文风');styleSelect.setAttribute('aria-label','候选文风预设');
    for(const [value,text] of [['none','不额外指定文风'],['chat','参考当前聊天文风'],['custom','自定义文风']]){const o=node('option',text);o.value=value;styleMode.append(o);}
    const styleLabel=node('label',null,'amin-field');styleLabel.append(node('span','文风'),styleMode);styleRow.append(styleLabel,styleSelect);
    const configGrid=node('div',null,'amin-form-grid ro-configuration');configGrid.append(modeRow,styleRow);
    function reflectContent(){
        styleMode.value=settings.writingStyleMode;styleSelect.hidden=settings.writingStyleMode!=='custom';
        styleSelect.replaceChildren();const empty=node('option','请选择文风预设');empty.value='';styleSelect.append(empty);
        for(const p of styles.list()){const o=node('option',p.name);o.value=p.id;styleSelect.append(o);}
        if(settings.writingStyleId&&!styles.get(settings.writingStyleId)){settings.writingStyleId='';settings.writingStyleMode='none';save();styleMode.value='none';styleSelect.hidden=true;}
        styleSelect.value=settings.writingStyleId;
    }
    styleMode.addEventListener('change',()=>{settings.writingStyleMode=styleMode.value;save();reflectContent();invalidate('文风已变化，请重新生成。');});
    styleSelect.addEventListener('change',()=>{settings.writingStyleId=styleSelect.value;rememberUsed();save();invalidate('文风已变化，请重新生成。');});
    const styleManager=node('div',null,'ro-style-manager');
    const styleControls=mountContentStyles(styleManager,{library:styles,kind:'文风预设',managementOnly:true,
        getSelection:()=>settings.writingStyleId||'none',
        setSelection:id=>{const changed=settings.writingStyleId!==(id==='none'?'':id);settings.writingStyleId=id==='none'?'':id;if(id!=='none')settings.writingStyleMode='custom';if(changed)rememberUsed();save();reflectContent();},
        onChange:()=>invalidate('文风预设已变化，请重新生成。')});
    const selectedStyleStamp=()=>settings.writingStyleMode==='custom'?JSON.stringify([settings.writingStyleId,styles.get(settings.writingStyleId),styles.hasDraft(settings.writingStyleId)]):settings.writingStyleMode;
    let styleMark=selectedStyleStamp();
    const unsubscribeStyles=styles.subscribe(()=>{reflectContent();const mark=selectedStyleStamp();if(mark!==styleMark){styleMark=mark;invalidate('文风预设或编辑已变化，请重新生成。');}});
    reflectContent();

    const referenceBox=node('details',null,'ro-references amin-card amin-stack');
    referenceBox.append(node('summary','本次参考资料'));
    const sourceControls=node('div',null,'amin-toolbar'),referenceList=node('div',null,'amin-stack'),referenceNotice=node('p',null,'amin-meta');
    const sourceEnabled=id=>(settings.linkedSources??DEFAULT_LINKED_SOURCES).includes(id);
    for(const source of LINKED_SOURCES){const label=node('label',null,'amin-check'),toggle=node('input');toggle.type='checkbox';toggle.checked=sourceEnabled(source.id);toggle.setAttribute('aria-label','参考'+source.label);label.append(toggle,node('span',source.label));sourceControls.append(label);toggle.addEventListener('change',()=>{const enabled=Array.isArray(settings.linkedSources)?settings.linkedSources:DEFAULT_LINKED_SOURCES;settings.linkedSources=toggle.checked?[...new Set([...enabled,source.id])]:enabled.filter(id=>id!==source.id);save();invalidate('参考来源已修改，请重新生成。');refreshReferences();});}
    const linked=()=>collectLinkedContext(context(),{...settings,excludedLinkedRecords});
    function refreshReferences(snapshot){
        try{const info=snapshot??linked();referenceList.replaceChildren();
            for(const record of info.records){const row=node('details',null,'ro-reference'),label=node('label',null,'amin-check'),toggle=node('input');toggle.type='checkbox';toggle.checked=record.selected;toggle.setAttribute('aria-label','引用资料：'+record.label);label.append(toggle,node('span',record.label+(record.reason?' · '+record.reason:'')));const summary=node('summary');summary.append(label);row.append(summary,node('pre',record.text));referenceList.append(row);toggle.addEventListener('change',()=>{excludedLinkedRecords=toggle.checked?excludedLinkedRecords.filter(id=>id!==record.id):[...new Set([...excludedLinkedRecords,record.id])];invalidate('参考条目已修改，请重新生成。');refreshReferences();});}
            referenceNotice.textContent=`已选择 ${info.selected.length} 条。仅使用小白变量 2.0 中的资料；不写入剧情状态。${info.warnings.join(' ')}`;
        }catch(error){referenceNotice.textContent=error.message;}
    }
    button('刷新参考资料',()=>refreshReferences(),referenceBox);
    referenceBox.append(sourceControls,referenceNotice,referenceList);
    referenceBox.addEventListener('toggle',()=>{if(referenceBox.open)refreshReferences();});
    const promptHelp=node('p','提示词顺序：输出格式与回复主体固定；创作要求按：内容风格（最高）→ 本次修改与自定义具体要求 → 通用定位、方向、文风与默认篇幅。每条候选都须体现所选内容约束。资料中的指令不作为生成要求；可在 AI 设置的任务预览检查实际请求。','amin-meta');
    const tabs=node('nav',null,'amin-tabs'),mainPage=node('section',null,'amin-stack ro-main-page'),settingsPage=node('section',null,'amin-stack ro-settings-page');
    tabs.setAttribute('aria-label','回复选项页面');settingsPage.id=settingsId+'-page';
    const mainTab=button('生成候选',()=>showPage('candidates'),tabs),settingsTab=button('设置',()=>showPage('settings'),tabs);
    mainTab.setAttribute('aria-controls',instanceId+'-main');mainPage.id=instanceId+'-main';settingsTab.setAttribute('aria-controls',settingsPage.id);
    function showPage(page){const isSettings=page==='settings'||page==='rewrite';mainPage.hidden=isSettings;settingsPage.hidden=!isSettings;mainTab.setAttribute('aria-pressed',String(!isSettings));settingsTab.setAttribute('aria-pressed',String(isSettings));}
    settingsBox.hidden=false;
    // Recently used content styles and writing presets, one tap to switch before generating.
    function drawTags(){
        tagRow.replaceChildren();let tags=[];try{tags=styleTags({recent:settings.recentStyles,contents,styles,settings});}catch{tags=[];}
        tagRow.hidden=!tags.length;if(!tags.length)return;
        tagRow.append(node('span',tags.some(tag=>tag.recent)?'最近用过':'试试这些风格','ro-style-tags-label'));
        for(const tag of tags){const chip=button(tag.label,()=>chooseTag(tag),tagRow);chip.className='menu_button ro-style-tag';chip.setAttribute('data-style-kind',tag.kind);chip.setAttribute('aria-pressed',String(tag.active));chip.title=(tag.kind==='writing'?'文风预设：':'内容风格：')+tag.label;}
    }
    function chooseTag(tag){
        if(controller)return;
        if(tag.kind==='content'){settings.contentMode=tag.active?'none':tag.id;if(!tag.active)rememberUsed();save();contentControls.refresh();}
        else{settings.writingStyleMode=tag.active?'none':'custom';settings.writingStyleId=tag.active?'':tag.id;if(!tag.active)rememberUsed();save();reflectContent();invalidate('文风已变化，请重新生成。');}
        drawTags();status.textContent=tag.active?`已取消「${tag.label}」，点击生成使用新的设置。`:`已选择「${tag.label}」，点击生成使用。`;
    }
    mainPage.append(tagRow,controls,status,cards);drawTags();
    settingsPage.append(configGrid,modeHelp,contentRow,styleManager,settingsBox,promptHelp,referenceBox);
    panel.append(tabs,mainPage,settingsPage);showPage('candidates');reflectMode();
    if(target){target.append(panel);panel.classList.add('amin-reply-embedded');}else form.before(panel);
    panel.addEventListener('toggle',()=>{if(!target){settings.expanded=panel.open;save();}});
    function updateSelection(){undo.disabled=draft.base===null;for(const b of cards.querySelectorAll('.ro-card'))b.setAttribute('aria-pressed','false');}
    updateSelection();
    function setBusy(value){generate.disabled=value;expand.disabled=value;cancel.hidden=!value;generate.textContent=value?'生成中…':'生成 / 换一批';cards.setAttribute('aria-busy',String(value));for(const control of cards.querySelectorAll('button,input,textarea'))control.disabled=value;}
    const scopeCurrent=scope=>scope && scope.stamp===chatStamp(context()) && scope.identity===chatIdentity(context()) && scope.linkedStamp===linked().stamp;
    function drawCandidates(){
        cards.replaceChildren();
        candidates.forEach(option=>{
            const row=node('div',null,'ro-candidate amin-stack'),card=node('button',null,'ro-card');
            card.type='button';card.setAttribute('aria-pressed','false');card.append(node('strong',option.label),node('span',option.text));
            card.addEventListener('click',()=>{try{
                if(controller)return;
                if(!scopeCurrent(candidateScope))return invalidate();
                const input=inputElement(),scope=candidateScope;
                if(scope.fromDraft&&draft.base===null&&input.value!==scope.original)throw Error('扩写期间草稿已改变，请重新扩写或使用普通生成。');
                if(draft.last!==null&&input.value!==draft.last)throw Error('草稿已被修改，请重新生成选项后再选择。');
                draft.choose(input,option.text,scope.fromDraft?'replace':scope.config.mode);draftIdentity=scope.identity;updateSelection();card.setAttribute('aria-pressed','true');status.textContent='已填入，尚未发送；发送后清空本组选项。';
            }catch(error){status.textContent=error.message;}});
            row.append(card);cards.append(row);
        });
    }
    async function run(fromDraft){
        if(controller)return;
        let initial,stamp,identity,config,ticket,original,contentStyle,writingStyle,refs;
        try{
            initial=context();stamp=chatStamp(initial);identity=chatIdentity(initial);config={...settings};
            contentControls.assertSaved();contentStyle=contentControls.selection();
            if(styles.hasDraft(config.writingStyleId)&&config.writingStyleMode==='custom')throw Error('请先保存或放弃所选文风预设的修改。');
            writingStyle={mode:config.writingStyleMode,preset:styles.get(config.writingStyleId),samples:config.writingStyleMode==='chat'?referenceSamples(initial):undefined};
            reflectMode();reflectContent();styleMark=selectedStyleStamp();original=inputElement().value;
            if(fromDraft&&!original.trim())throw Error(settings.writingMode==='author'?'先在输入框写下剧情构想或推进要求。':'先在输入框写下草稿或回复意图。');
            refs=linked();refreshReferences(refs);
        }catch(e){status.textContent=e.message;return;}
        ticket=++revision;const current=new AbortController();controller=current;setBusy(true);
        let sources='正在读取参考资料…';status.textContent=sources;
        const isCurrent=()=>!current.signal.aborted&&ticket===revision&&stamp===chatStamp(context())&&identity===chatIdentity(context())&&refs.stamp===linked().stamp;
        try{
            const options=await waitForResult(generateOptions(initial,config,{
                draft:fromDraft?original:'',contentStyle,writingStyle,
                linkedContext:{records:refs.selected},
                signal:current.signal,isCurrent,onContext:(info,lore)=>{sources=`角色：${info.characters.length}；世界书：${lore.books.length} 本 / ${info.world.length} 条；关联资料：${refs.selected.length} 条`;status.textContent=`生成中… ${sources}`;}
            }),(getAI()?.capture('reply').config.timeoutSeconds??config.timeout)*1000,current.signal);
            if(!isCurrent())throw Error('聊天、设置或参考资料已变化，本次结果已丢弃。');
            draft.reset();
            candidates=options;
            candidateScope={stamp,identity,config,fromDraft,original,linkedStamp:refs.stamp};
            drawCandidates();updateSelection();
            status.textContent=`${'已生成 '+options.length+' 个选项'} · ${sources}${refs.warnings.length?' · '+refs.warnings.join(' '):''}`;
        }catch(e){if(ticket===revision)status.textContent=(e.message||'生成失败，请检查模型连接。')+' 原候选未改动。';}
        finally{if(controller===current){controller=null;setBusy(false);}}
    }
    const events=ctx.eventTypes||ctx.event_types||{};
    const on=(name,fn)=>{if(events[name]){ctx.eventSource?.on(events[name],fn);removers.push(()=>{const source=ctx.eventSource;if(source?.removeListener)source.removeListener(events[name],fn);else source?.off?.(events[name],fn);});}};
    for(const event of ['CHAT_CHANGED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','PERSONA_CHANGED','CHARACTER_EDITED','WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED'])on(event,()=>{
        invalidate(undefined,['CHAT_CHANGED','MESSAGE_SENT'].includes(event));
    });
    return {open(page='candidates'){context();showPage(page);},dispose(){revision++;controller?.abort();unsubscribeStyles();contentControls.dispose();styleControls.dispose();for(const remove of removers)remove();panel.remove();}};
}
