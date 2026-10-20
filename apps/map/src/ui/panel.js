import { uuid } from '../../../../uuid.js';
import { legacyModule, isIndependent } from '../../../story-state/access.js';
import { mapIntegrationPrompt } from './integration-prompt.js';
import { attachLinkageBadge } from '../../../linkage/badge.js';
import {mountWorldbookSources} from '../../../worldbook-source-ui.js';
import {sourceSettings,saveSourceSettings} from '../../../worldbook-sources.js';
import {getAI} from '../../../../ai/service.js';
import {parseModelJSON} from '../../../../ai/json.js';
import { inspectMapRegex, syncMapRegex } from '../adapters/text-regex.js';
import { TEXT_PROMPT } from '../integrations/text-updates.js';
import { mapChanges } from './map-presentation.js';
import { TOOL_PROMPT, targetWorldbook, syncToolPrompt, inspectToolPrompt } from '../adapters/tool-lorebook.js';
import { GENERATION_LEVELS, mapPath, mapChoices, locationPath, projectedLocation, generationScope, levelPrompt } from '../core/hierarchy.js';
import { renderCellEditor, renderCellDetails, renderCellRules } from './cells.js';
import { cellKey } from '../core/cells.js';
import { applyGeneratedMap } from '../core/map-generation.js';
import { isTileMap, layoutTiles, applyTilePlacement } from '../core/tiles.js';
import { autoLayout } from '../core/auto-layout.js';
import { recentMapChat, applyMapExpansion } from '../core/map-expansion.js';
import { startGenerationJob } from '../core/generation-job.js';
import { buildMapGenerationPrompt } from '../core/generation-prompt.js';
import { createDraftSession } from '../core/draft.js';
import { createMap, createNode, createEdge, validateDocument } from '../core/protocol.js';
import { DIRECTIONS, prepareDocument, layoutMap, validateRules, applyPlacement, connectionDetails, roadName, roadDistance, splitRoad } from '../core/spatial.js';
import { readMapSources } from '../adapters/sources.js';
import { renderMap, fitCamera } from './graph.js';
import { attachFloatingWindow, readWindowPreferences } from './floating.js';
const layoutClasses={
    'dm-form':'amin-card amin-form-grid',
    'dm-route':'amin-card amin-form-grid amin-span-full',
    'dm-actions':'amin-toolbar amin-span-full',
    'dm-toolbar':'amin-toolbar',
    'dm-help':'amin-meta',
    'dm-detail-card':'amin-card',
    'dm-change-preview':'amin-card',
    'dm-settings-categories':'amin-tabs',
};
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=[cls,...cls.split(' ').map(name=>layoutClasses[name]??'')].filter(Boolean).join(' ');return e;};
const mapTypes=[{id:'graph',name:'节点连线'},{id:'hex',name:'六边形'},{id:'grid',name:'方格'}];
const uid=prefix=>`${prefix}_${uuid().replaceAll('-','')}`;
const button=(text,fn)=>{const e=el('button',text);e.type='button';if(/^(保存|生成地图草稿|一键写入)/.test(text))e.classList.add('dm-primary');if(/^(删除|断开)/.test(text))e.classList.add('dm-danger');e.addEventListener('click',fn);return e;};
const input=(value='',type='text')=>{const e=el('input');e.type=type;e.value=value;return e;};
const select=(items,value)=>{const e=el('select');for(const item of items){const o=el('option',item.name??item.label);o.value=item.id;e.append(o);}e.value=value;return e;};
const field=(host,name,control)=>{
    const check=control.type==='checkbox',label=el('label',undefined,check?'amin-check amin-span-full':'amin-field');
    const caption=el('span',name);
    if(check)label.append(control,caption);else label.append(caption,control);
    if(control.tagName==='TEXTAREA'||control.type==='file')label.classList.add('amin-span-full');
    host.append(label);return control;
};
// Keep action groups together when a form wraps into one column on a phone.
function arrangeFormActions(root){
    for(const form of root.querySelectorAll('.dm-form,.dm-route')){
        let actions=null;
        for(const child of [...form.children]){
            if(child.tagName==='BUTTON'){
                if(!actions){actions=el('div',undefined,'dm-actions');form.insertBefore(actions,child);}
                actions.append(child);
            }else actions=null;
        }
    }
}
const download=(data)=>{const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='dynamic-map.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};

export function createPanel(store,persistence,preferences,options={}){
    const kit={el,field,input,select,button,uid};let selectedCells=[],brushCells=false,browsedMap=null,browseScope=null,navigationRevision=0,aiLevel='world',aiMapKey='',searchTerm='',settingsCategory='appearance';
    const draft=options.draft??createDraftSession(store,persistence), panel=el('section');let disposed=false,activeJob=null,generationStatus='';panel.id=options.inline?uid('dynamic-map-inline'):'dynamic-map-panel';panel.className='dynamic-map-panel amin-ui'+(options.inline?' dm-inline':'')+(options.embedded?' amin-map-embedded':'');panel.setAttribute('aria-label',options.inline?'消息末尾地图窗口':'动态地图悬浮窗');
    panel.innerHTML='<header class="dm-header"><div class="dm-handle" tabindex="0" aria-label="拖动地图窗口，方向键移动"><span aria-hidden="true">🗺</span><strong class="dm-compact-location"></strong></div><button class="dm-toggle" type="button"></button></header><div class="dm-content"><nav class="dm-tabs amin-tabs" role="tablist" aria-label="地图功能"></nav><div class="dm-page amin-app-page" role="tabpanel"></div><div class="dm-savebar amin-toolbar"></div><p class="dm-save-status" role="status"></p><p class="dm-feedback" role="status" aria-live="polite"></p></div>';
    (options.mount??document.body).append(panel);
    const content=panel.querySelector('.dm-content'),page=panel.querySelector('.dm-page'),feedback=panel.querySelector('.dm-feedback'),savebar=panel.querySelector('.dm-savebar'),toggle=panel.querySelector('.dm-toggle');
    let collapsed=options.inline?false:(readWindowPreferences()?.collapsed??true),tab='view',selected=null,unlocked=false,dragMode='move',camera=null,cameraKey='',method='walk',notice='',aiBusy=false,aiPrompt='',aiEntrance='',aiChildType='grid',sourcePicker=null,coverage='full',nameRoads=false,distanceRoads=false,sourceReport='',editorTool='move',rulesTool='distance',routeId='';
    const floating=options.inline?{keepVisible(){},save(){},reset(){},destroy(){}}:attachFloatingWindow(panel,panel.querySelector('.dm-handle'),()=>collapsed);
    if(options.inline){panel.querySelector('.dm-handle').removeAttribute('tabindex');panel.querySelector('.dm-handle').setAttribute('aria-label','消息末尾地图');}
    const tabs=[['view','查看地图'],['edit','调整地图'],['rules','地图规则'],['ai','AI生成地图'],['templates','地图模板'],['settings','设置']];
    const run=fn=>{try{fn();}catch(error){notice=error.message;render();}};
    const edit=fn=>run(()=>{draft.mutate(d=>{fn(d.maps[browsedMap??d.activeMap],d);for(const m of Object.values(d.maps))layoutTiles(m);});});
    const layoutEdit=fn=>edit((m,d)=>{fn(m,d);if(m.type==='graph')autoLayout(m);camera=null;});
    function setCollapsed(value){collapsed=value;content.hidden=value;panel.classList.toggle('dm-collapsed',value);toggle.textContent=value?'展开':'收起';toggle.setAttribute('aria-expanded',String(!value));render();floating.keepVisible();floating.save();}
    toggle.addEventListener('click',()=>setCollapsed(!collapsed));
    if(options.embedded){toggle.hidden=true;panel.setAttribute('aria-label','地图应用');}
    panel.addEventListener('keydown',e=>{if(e.key==='Escape'&&!options.embedded){setCollapsed(true);toggle.focus();}});
    page.id=panel.id+'-page';
    for(const [id,name]of tabs){const titles={view:'查看',edit:'编辑',rules:'规则',ai:'AI 生成',templates:'模板',settings:'设置'};const b=button(titles[id],()=>{tab=id;camera=null;notice='';render();});b.id=panel.id+'-tab-'+id;b.setAttribute('aria-label',name);b.setAttribute('aria-controls',page.id);b.title=name;b.dataset.tab=id;b.setAttribute('role','tab');panel.querySelector('.dm-tabs').append(b);}
    panel.querySelector('.dm-tabs').addEventListener('keydown',event=>{
        const buttons=[...panel.querySelectorAll('.dm-tabs [role=tab]')],index=buttons.indexOf(event.target);
        if(index<0)return;
        const next=event.key==='ArrowRight'?(index+1)%buttons.length:event.key==='ArrowLeft'?(index+buttons.length-1)%buttons.length:event.key==='Home'?0:event.key==='End'?buttons.length-1:null;
        if(next===null)return;event.preventDefault();buttons[next].click();buttons[next].focus();
    });
    function render(){
        sourcePicker?.dispose();sourcePicker=null;
        if(disposed)return;
        const saved=prepareDocument(store.snapshot()),document=tab==='view'?saved:draft.snapshot();
        if(browseScope!==persistence.scope()){browseScope=persistence.scope();browsedMap=null;searchTerm='';navigationRevision++;}
        if(!document.maps[browsedMap]){browsedMap=document.activeMap;navigationRevision++;}const map=document.maps[browsedMap];
        panel.querySelector('.dm-compact-location').textContent=locationPath(saved);
        for(const b of panel.querySelectorAll('[data-tab]')){const active=b.dataset.tab===tab;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;}
        page.setAttribute('aria-labelledby',panel.id+'-tab-'+tab);
        page.replaceChildren();savebar.replaceChildren();feedback.textContent=notice;
        if(collapsed)return;
        const key=`${persistence.scope()}:${tab}:${map.id}`;if(key!==cameraKey){camera=null;selected=null;unlocked=false;dragMode='move';cameraKey=key;selectedCells=[];brushCells=false;}
        const context=el('section',undefined,'dm-map-context amin-context');attachLinkageBadge(context,'map',{document:panel.ownerDocument});
        context.append(el('p',tab==='settings'?'地图设置':tab==='view'?'当前已保存地图':'正在编辑地图草稿','dm-browse-label'),el('h2',map.name),el('p','📍 角色位置：'+locationPath(saved),'dm-role-location'));page.append(context);
        const mapNavigation=el('div',undefined,'dm-actions');
        if(map.parentMap)mapNavigation.append(button('返回上级：'+document.maps[map.parentMap].name,()=>navigateMap(map.parentMap)));
        const children=Object.values(document.maps).filter(m=>m.parentMap===map.id);
        for(const child of children)if(tab!=='view')mapNavigation.append(button('进入：'+child.name,()=>navigateMap(child.id)));
        if(mapNavigation.children.length)context.append(mapNavigation);

        const pathBar=el('nav',undefined,'dm-actions');pathBar.setAttribute('aria-label','地图层级');for(const ancestor of mapPath(document,map.id))pathBar.append(button(ancestor.name,()=>navigateMap(ancestor.id)));if(mapPath(document,map.id).length>1)context.append(pathBar);
        if(Object.keys(document.maps).length>1){const picker=el('div',undefined,'dm-map-picker amin-form-grid'),search=field(picker,'搜索地图',input(searchTerm)),s=field(picker,'切换地图',select(mapChoices(document),map.id));search.placeholder='按地图名称搜索';search.type='search';context.append(picker);search.oninput=()=>{searchTerm=search.value;const matches=mapChoices(document).filter(m=>m.name.toLowerCase().includes(searchTerm.toLowerCase()));s.replaceChildren(...select(matches.length?matches:[{id:'',name:'没有匹配的地图'}],map.id).children);s.disabled=!matches.length;};s.onchange=()=>{if(s.value)navigateMap(s.value);};}
        if(tab==='edit'){
            const name=field(page,'地图名称',input(map.name));page.append(button('应用地图名称',()=>edit(m=>{if(!name.value.trim())throw new Error('地图名称不能为空');m.name=name.value.trim();})));
        }
        if(tab==='view'||tab==='edit')renderCanvas(map);
        if(tab==='edit')renderEditor(map);
        if(tab==='rules')renderRules(map);
        if(tab==='settings')renderSettings(map);
        if(tab==='ai')renderAI(map);
        if(tab==='templates')renderTemplates();
        if(tab!=='settings'){
            const status=draft.status();savebar.append(el('span',status.conflict?'已保存地图发生变化，请放弃草稿后重试':status.dirty?('未保存：'+(status.changedMaps.join('、')||'角色位置')):legacyModule(globalThis.SillyTavern?.getContext?.(),'map','dynamicMapV1')?'✓ 已保存':'初始地图尚未保存'));savebar.classList.toggle('dm-unsaved',status.dirty);
            const saveButton=button('保存全部地图调整',()=>run(()=>{draft.save();notice='地图已保存，查看地图与变量接口现已使用新地图。';render();}));saveButton.disabled=status.conflict||(!status.dirty&&!!legacyModule(globalThis.SillyTavern?.getContext?.(),'map','dynamicMapV1'));savebar.append(saveButton,button('放弃草稿',()=>{draft.discard();notice='已放弃未保存调整';camera=null;render();}));
            if(status.dirty&&tab!=='view')renderChanges(saved,draft.snapshot());
        }
        for(const text of [...page.querySelectorAll('.dm-help')])if(text.textContent.length>180){const fold=el('details',undefined,'dm-help-fold');fold.append(el('summary','使用说明'));text.replaceWith(fold);fold.append(text);}
        arrangeFormActions(page);
    }
    function renderChanges(before,after){
        const changes=mapChanges(before,after),box=el('details',undefined,'dm-change-preview');box.append(el('summary',`待保存变更 · ${changes.length} 项`));
        for(const item of changes){const b=button(item.label,()=>{if(!after.maps[item.mapId]){notice='该地图已删除，可放弃草稿恢复';render();return;}tab='edit';navigateMap(item.mapId);selected=item.nodeId??null;routeId=item.edgeId??'';editorTool=item.edgeId?'route':item.nodeId?'node':'maps';const target=item.nodeId?after.maps[item.mapId].nodes[item.nodeId]:null;if(target)camera={zoom:1.2,x:360-target.position.x*1.2,y:220-target.position.y*1.2};else if(item.edgeId){const m=after.maps[item.mapId],e=m.edges.find(e=>e.id===item.edgeId),a=m.nodes[e.from].position,b=m.nodes[e.to].position,zoom=Math.max(.1,Math.min(1.2,500/(Math.hypot(a.x-b.x,a.y-b.y)+80)));camera={zoom,x:360-(a.x+b.x)/2*zoom,y:220-(a.y+b.y)/2*zoom};}render();});b.className='dm-change-item';box.append(b);}
        page.append(box);
    }
    function navigateMap(id){browsedMap=id;selected=null;camera=null;searchTerm='';navigationRevision++;render();}
    function renderCanvas(map){
        const controls=el('div',undefined,'dm-toolbar');
        controls.append(button('居中显示全图',()=>{camera=fitCamera(map,tab==='edit');render();}));
        if(tab==='edit'){const b=button(`${unlocked?'✓ ':''}允许拖动地点`,()=>{unlocked=!unlocked;render();});b.setAttribute('aria-pressed',String(unlocked));b.disabled=!persistence.scope();if(b.disabled)b.title='请先打开角色卡的聊天';controls.append(b);}
        if(tab==='edit'&&isTileMap(map)&&editorTool==='cells'){const brush=button(`${brushCells?'✓ ':''}刷选格子`,()=>{brushCells=!brushCells;render();});brush.setAttribute('aria-pressed',String(brushCells));controls.append(brush,button('清空格子选择',()=>{selectedCells=[];render();}));}
        if(tab==='edit'&&!isTileMap(map))controls.append(el('span','拖动模式：'+(dragMode==='reconnect'?'重新连接':'调整位置')));
        page.append(controls);
        const stage=el('div',undefined,'dm-map-stage'),canvas=el('div',undefined,'dm-canvas');stage.append(canvas);page.append(stage);
        const hint=el('p',notice,'dm-drag-hint');hint.setAttribute('role','status');page.append(hint);
        camera??=fitCamera(map,tab==='edit');
        const displayDoc=tab==='view'?prepareDocument(store.snapshot()):draft.snapshot();const displayMap={...map,currentLocation:projectedLocation(displayDoc,map.id)};
        const childCounts={};for(const child of Object.values(displayDoc.maps))if(child.parentMap===map.id&&child.metadata.parentNode)childCounts[child.metadata.parentNode]=(childCounts[child.metadata.parentNode]??0)+1;
        canvas.append(renderMap(displayMap,{camera,selected,dragMode,selectedEdge:routeId,childCounts,onEdgeSelect:tab==='edit'?id=>{routeId=id;selected=null;editorTool='route';render();}:undefined,cellEditing:tab==='edit'&&editorTool==='cells',brushCells,selectedCells,onCells:(keys,append)=>{selected=null;selectedCells=append?[...new Set([...selectedCells,...keys])]:keys;render();},adjusting:tab==='edit',editable:tab==='edit'&&unlocked&&editorTool!=='cells',onSelect:id=>{selectedCells=[];selected=id;routeId='';if(tab==='edit')editorTool='node';render();},onCamera:value=>{camera=value;render();},onSnap:(id,plan)=>edit(m=>{if(isTileMap(m))applyTilePlacement(m,id,plan);else applyPlacement(m,id,plan,uid('edge'));notice='已调整草稿；保存地图后生效';}),onHint:text=>{hint.textContent=text;}}));
        page.append(el('p',`${isTileMap(map)?(map.type==='hex'?'六边形格子':'方格') :map.metadata.layout?.mode==='auto'?'自动布局，图上线长不代表距离':'等长方位布局'} · 距离以道路资料为准 · 拖动空白平移 · 双指缩放与平移 · 滚轮缩放`,'dm-help'));
        if(tab==='edit'){if(map.nodes[selected])page.append(el('p',"已选中："+map.nodes[selected].name,'dm-help'));return;}
        const node=map.nodes[selected],card=el('details',undefined,'dm-detail-card');card.open=true;card.append(el('summary',node?.name??'地点说明'));const details=el('div',undefined,'dm-details');card.append(details);stage.append(card);
        if(isTileMap(map)&&selectedCells.length){renderCellDetails(details,map,selectedCells[0],kit);return;}
        if(!node||(!node.discovered&&tab==='view')){details.textContent='点击地点或途经点查看说明与相邻路线。';return;}
        details.append(el('p',map.metadata.nodeTypes.find(t=>t.id===node.type)?.name??node.type,'dm-type-chip'),el('p',node.description||'暂无说明'));
        for(const child of Object.values(displayDoc.maps).filter(m=>m.parentMap===map.id&&m.metadata.parentNode===node.id))details.append(button('进入内部地图：'+child.name,()=>navigateMap(child.id)));
        const methods=map.metadata.rules.methods;if(!methods.some(m=>m.id===method))method=methods[0].id;
        const travel=select(methods,method);field(details,'通行方式',travel);travel.onchange=()=>{method=travel.value;render();};
        const links=connectionDetails(map,node.id,method);
        if(!links.length)details.append(el('p','暂无已发现的相邻路线'));
        for(const link of links){const line=el('p',undefined,'dm-connection-row');line.append(button(link.node.name,()=>{selected=link.node.id;render();}),document.createTextNode(` · ${link.direction.label} · ${link.distance===null?'距离未设置':link.distance+' '+link.unit}${roadName(map,link.edge)?' · '+roadName(map,link.edge):''} · ${map.metadata.roadTypes.find(t=>t.id===link.edge.type)?.name||link.edge.type} · ${link.edge.bidirectional?'双向':link.accessible?'单向出发':'单向到达，不能沿此路出发'} · ${link.minutes===null?'时间无法估算':link.method+'约 '+Number(link.minutes.toFixed(1))+' 分钟'}`));details.append(line);}
    }
    function switches(host,items,current,change){
        const bar=el('div',undefined,'dm-actions');for(const [id,name]of items){const b=button(name,()=>{change(id);render();});b.setAttribute('aria-pressed',String(id===current));bar.append(b);}host.append(bar);
    }
    function renderEditor(map){
        switches(page,[['maps','地图类型与层级'],...(isTileMap(map)?[['cells','编辑格子']]:[]),['move','移动地点'],['layout','自动布局'],['node','地点资料'],['route','路线连接'],['waypoint','途经点'],['delete','删除']],editorTool,id=>editorTool=id);
        const form=el('div',undefined,'dm-form');page.append(form);const node=map.nodes[selected],nodes=Object.values(map.nodes);
        if(editorTool==='cells'){if(isTileMap(map))renderCellEditor(form,map,selectedCells,edit,kit);else form.append(el('p','请先切换为六边形或方格地图'));return;}
        if(editorTool==='maps'){
            const type=field(form,'地图形态',select(mapTypes,map.type));
            form.append(el('p','转换形态会重新吸附地点，保留道路资料与连接。格子地图按位置显示方位，不锁定道路方位。','dm-help'));
            form.append(button('应用地图形态',()=>edit(m=>{if(m.type===type.value)return;m.type=type.value;if(isTileMap(m))layoutTiles(m);else{m.metadata.layout={...m.metadata.layout,mode:'auto'};}camera=null;})));
            const name=field(form,'新地图名称',input()),kind=field(form,'新地图形态',select(mapTypes,'grid'));
            const entrance=field(form,'上级入口地点',select([{id:'',name:'整个当前地图'},...nodes],node?.id??''));
            const create=child=>edit((m,d)=>{if(!name.value.trim())throw new Error('请填写新地图名称');const id=uid('map'),next=createMap(id,name.value.trim(),kind.value);for(const key of ['rules','nodeTypes','roadTypes'])next.metadata[key]=structuredClone(m.metadata[key]);if(child){next.parentMap=m.id;if(entrance.value)next.metadata.parentNode=entrance.value;}d.maps[id]=next;browsedMap=id;navigationRevision++;camera=null;notice='已创建地图草稿；新增地点后保存地图';});
            form.append(button('创建子地图',()=>create(true)),button('创建独立地图',()=>create(false)));
            form.append(el('p','每张地图分别保存当前位置和规则；进入或返回只切换查看范围，不代表角色移动。删除入口地点前需先调整其子地图归属。','dm-help'));
            const doc=draft.snapshot();const parents=Object.values(doc.maps).filter(x=>{let p=x;while(p){if(p.id===map.id)return false;p=doc.maps[p.parentMap];}return true;});
            const parent=field(form,'所属上级地图',select([{id:'',name:'无（独立地图）'},...parents],map.parentMap??''));
            const entry=field(form,'关联入口地点',select([{id:'',name:'整个上级地图'},...Object.values(doc.maps[parent.value]?.nodes??{})],map.metadata.parentNode??''));
            parent.onchange=()=>{entry.replaceChildren(...select([{id:'',name:'整个上级地图'},...Object.values(doc.maps[parent.value]?.nodes??{})],'').children);};
            form.append(button('应用地图归属',()=>edit(m=>{m.parentMap=parent.value||null;delete m.metadata.parentNode;if(parent.value&&entry.value)m.metadata.parentNode=entry.value;})));
            form.append(button('删除空地图',()=>edit((m,d)=>{if(Object.keys(m.nodes).length||m.edges.length)throw new Error('请先清空这张地图的地点与路线');if(Object.values(d.maps).some(x=>x.parentMap===m.id))throw new Error('请先调整子地图归属');if(Object.keys(d.maps).length===1)throw new Error('至少保留一张地图');delete d.maps[m.id];browsedMap=m.parentMap??Object.keys(d.maps)[0];if(d.activeMap===m.id)d.activeMap=browsedMap;})));return;
        }
        if(editorTool==='layout'&&isTileMap(map)){form.append(el('p','格子地图自动吸附到空格，拖动地点可调整排列，原有道路保持连接。'),button('整理到格子',()=>edit(m=>{layoutTiles(m);camera=null;})));return;}
        if(editorTool==='layout'){form.append(el('p','以现有道路长度为参考，尽量保留远近关系，分散重叠、排列独立区域并处理闭环。图上线长可以不同，不改变道路的实际距离、名称和连接；普通路线方位随布局更新，锁定方位和固定地点必须保留。','dm-help'));form.append(button('自动整理地图',()=>edit(m=>{const result=autoLayout(m);camera=null;notice=`已自动布局 ${result.nodes} 个地点、${result.components} 个区域，调整 ${result.changedDirections} 条路线方位；保存地图后生效`; })));form.append(el('p','在地点资料中固定位置，在路线连接中锁定方位。无法同时满足时会提示冲突。道路交叉只表示线条相交，不代表新增路口；需要路口请添加途经点。','dm-help'));return;}
        if(editorTool==='move'&&isTileMap(map)){form.append(el('p','勾选“允许拖动地点”后拖动，松手吸附到空格；一格一个地点，全部道路随地点移动且保持连接。','dm-help'));return;}
        if(editorTool==='move'){switches(form,[['move',(dragMode==='move'?'✓ ':'')+'调整位置'],['reconnect',(dragMode==='reconnect'?'✓ ':'')+'重新连接']],dragMode,id=>dragMode=id);form.append(el('p','勾选“允许拖动地点”。调整位置保留全部连接；重新连接在靠近地点松手时连接它并断开其他旧路，远处松手断开旧路。两种模式均按16方位吸附并保留拖出的距离。锁定道路方位冲突时需先解锁。','dm-help'));return;}
        if(editorTool==='node'){
            const pick=field(form,'选择地点',select([{id:'',name:'新增地点'},...nodes],node?.id??''));pick.onchange=()=>{selected=pick.value||null;render();};
            const name=field(form,'名称',input(node?.name??'')),type=field(form,'地点类型',select(map.metadata.nodeTypes,node?.type??map.metadata.nodeTypes[0].id)),description=field(form,'说明',el('textarea'));description.value=node?.description??'';
            const pin=field(form,'固定此地点位置（自动布局时保留）',input('','checkbox'));pin.checked=!!node?.layout.pinned;
            form.append(button(node?'应用地点调整':'新增地点',()=>edit(m=>{
                if(!name.value.trim())throw new Error('请填写地点名称');const id=node?.id??uid('node');
                m.nodes[id]=node?{...m.nodes[id],name:name.value.trim(),type:type.value,description:description.value}:createNode(id,name.value.trim(),{type:type.value,description:description.value,position:{x:100+Object.keys(m.nodes).length*210,y:480}});m.nodes[id].layout.pinned=pin.checked;if(!node&&m.type==='graph'&&m.metadata.layout?.mode==='auto')autoLayout(m,{pinnedIds:Object.keys(m.nodes).filter(key=>key!==id)});selected=id;camera=null;
            })));
            if(node)form.append(button('设为当前位置',()=>edit((m,d)=>{d.activeMap=m.id;m.currentLocation=node.id;m.nodes[node.id].discovered=true;})));return;
        }
        const roads=map.edges.map(e=>({id:e.id,name:`${map.nodes[e.from].name} → ${map.nodes[e.to].name}`}));
        if(editorTool==='route'){
            if(nodes.length<2){form.append(el('p','请先新增至少两个地点'));return;}
            const edge=map.edges.find(e=>e.id===routeId);const pick=field(form,'选择路线',select([{id:'',name:'新增路线'},...roads],edge?.id??''));pick.onchange=()=>{routeId=pick.value;render();};
            const from=field(form,'起点',select(nodes,edge?.from??node?.id??nodes[0].id)),to=field(form,'终点',select(nodes,edge?.to??nodes.find(n=>n.id!==from.value)?.id)),dir=field(form,'终点位于起点的',select(DIRECTIONS,edge?.direction??'east')),type=field(form,'道路类型',select(map.metadata.roadTypes,edge?.type??map.metadata.roadTypes[0].id)),single=field(form,'单向通行（起点 → 终点）',input('','checkbox'));single.checked=edge?!edge.bidirectional:false;
            const roadLabel=field(form,'道路名称（可留空）',input(edge?.name??'')), roadLength=field(form,`道路距离（${map.metadata.rules.unit}，可留空）`,input(edge?roadDistance(map,edge)??'':'','number')); roadLength.min='0'; roadLength.step='any';
            const lock=field(form,'锁定此道路方位（自动布局时保留）',input('','checkbox'));lock.checked=!isTileMap(map)&&(edge?!!edge.metadata.directionLocked:true);if(isTileMap(map)){dir.disabled=true;lock.disabled=true;form.append(el('p','格子地图的方位由地点位置确定，连接任意两个格子不会移动地点。','dm-help'));}
            form.append(button(edge?'应用路线调整':'添加路线',()=>layoutEdit(m=>{
                if(from.value===to.value)throw new Error('起点与终点不能相同');
                if(m.edges.some(e=>e.id!==edge?.id&&((e.from===from.value&&e.to===to.value)||(e.to===from.value&&e.from===to.value))))throw new Error('这两个地点已经连接');
                const id=edge?.id??uid('edge');const next=createEdge(id,from.value,to.value,{...(edge??{}),from:from.value,to:to.value,direction:dir.value,type:type.value,name:roadLabel.value.trim(),distance:roadLength.value.trim()===''?null:Number(roadLength.value),bidirectional:!single.checked,metadata:{...(edge?.metadata??{}),directionLocked:lock.checked}});
                m.edges=m.edges.filter(e=>e.id!==id);m.edges.push(next);routeId=id;
            })));return;
        }
        if(editorTool==='waypoint'){
            const addWaypoint=m=>{if(!m.metadata.nodeTypes.some(t=>t.id==='waypoint'))m.metadata.nodeTypes.push({id:'waypoint',name:'途经点'});const id=uid('waypoint');m.nodes[id]=createNode(id,'途经点',{type:'waypoint',position:{x:100+Object.keys(m.nodes).length*210,y:480}});selected=id;return id;};
            form.append(button('新增独立途经点',()=>edit(m=>{addWaypoint(m);camera=null;})));
            if(roads.length){const pick=field(form,'插入到哪条路线',select(roads,roads[0].id));form.append(button('插入途经点',()=>layoutEdit(m=>{const e=m.edges.find(x=>x.id===pick.value),id=addWaypoint(m);m.edges=m.edges.filter(x=>x.id!==e.id);m.edges.push(...splitRoad(m,e,id,uid('edge')));})));}
            form.append(el('p','插入途经点会把道路分成两段，已填距离各分一半、总距离不变；未填距离仍为空。途经点也可以连接其他地点。','dm-help'));return;
        }
        if(editorTool==='delete'){
            if(nodes.length){const pick=field(form,'删除地点',select(nodes,node?.id??nodes[0].id));form.append(button('删除地点及关联路线',()=>edit(m=>{if(Object.values(draft.snapshot().maps).some(child=>child.parentMap===m.id&&child.metadata.parentNode===pick.value))throw new Error('此地点关联子地图，请先调整子地图归属');delete m.nodes[pick.value];m.edges=m.edges.filter(e=>e.from!==pick.value&&e.to!==pick.value);if(m.currentLocation===pick.value)m.currentLocation=null;selected=null;})));}
            if(roads.length){const pick=field(form,'断开路线',select(roads,roads[0].id));form.append(button('断开选中路线',()=>edit(m=>{m.edges=m.edges.filter(e=>e.id!==pick.value);})));}
        }
    }
    function renderRules(map){
        switches(page,[['distance','距离'],['travel','通行方式'],['nodeTypes','地点类型'],['roadTypes','道路类型'],['areas','格子区域类型'],['terrains','格子地形'],['regions','行政区域']],rulesTool,id=>rulesTool=id);
        const form=el('div',undefined,'dm-form');page.append(form);const rules=map.metadata.rules;
        if(['areas','terrains','regions'].includes(rulesTool)){renderCellRules(form,map,rulesTool,edit,kit);return;}
        if(rulesTool==='distance'){
            const unit=field(form,'距离单位',input(rules.unit));form.append(el('p','每条道路在路线连接页单独填写距离。修改单位不会换算已有数值；通行速度使用该单位/小时。','dm-help'));
            form.append(button('应用距离规则',()=>edit(m=>{m.metadata.rules.unit=unit.value.trim();validateRules(m);})));return;
        }
        if(rulesTool==='travel'){
            form.append(el('p','速度单位：距离单位 / 小时。','dm-help'));
            for(const mode of rules.methods){const row=el('div',undefined,'dm-route'),name=field(row,'通行方式',input(mode.name)),speed=field(row,'每小时速度',input(mode.speed,'number'));row.append(button('应用速度',()=>edit(m=>{Object.assign(m.metadata.rules.methods.find(x=>x.id===mode.id),{name:name.value.trim(),speed:Number(speed.value)});validateRules(m);})),button('删除方式',()=>edit(m=>{m.metadata.rules.methods=m.metadata.rules.methods.filter(x=>x.id!==mode.id);validateRules(m);})));form.append(row);}
            const name=field(form,'新通行方式',input()),speed=field(form,'每小时速度',input(20,'number'));form.append(button('添加通行方式',()=>edit(m=>{m.metadata.rules.methods.push({id:uid('travel'),name:name.value.trim(),speed:Number(speed.value)});validateRules(m);})));return;
        }
        const key=rulesTool,label=key==='nodeTypes'?'地点':'道路',catalog=map.metadata[key];
        for(const type of catalog){const row=el('div',undefined,'dm-route'),name=field(row,'类型名称',input(type.name));
            row.append(button('更名',()=>edit(m=>{m.metadata[key].find(t=>t.id===type.id).name=name.value.trim();validateRules(m);})),button('删除类型',()=>edit(m=>{const used=key==='nodeTypes'?Object.values(m.nodes):m.edges;if(used.some(x=>x.type===type.id))throw new Error(`有${label}正在使用此类型，请先更换这些${label}的类型`);m.metadata[key]=m.metadata[key].filter(t=>t.id!==type.id);validateRules(m);})));form.append(row);}
        const name=field(form,`新${label}类型名称`,input());form.append(button('添加类型',()=>edit(m=>{m.metadata[key].push({id:uid('type'),name:name.value.trim()});validateRules(m);})));
    }
    function renderSettings(){
        const categories=[['appearance','界面外观'],...(options.integration?[['integration',isIndependent(globalThis.SillyTavern?.getContext?.())?'剧情资料与状态栏':'变量与状态栏']]:[]),...(options.tools?[['tools','AI 动态更新']]:[]),['api','生成 API'],['presets','生成预设']];
        if(!categories.some(([id])=>id===settingsCategory))settingsCategory='appearance';
        const nav=el('nav',undefined,'dm-settings-categories');nav.setAttribute('aria-label','设置分类');page.append(nav);
        const sections=new Map(),buttons=new Map();
        const activate=id=>{settingsCategory=id;for(const [key,section] of sections)section.hidden=key!==id;for(const [key,item] of buttons)item.setAttribute('aria-pressed',String(key===id));};
        for(const [id,label] of categories){const item=button(label,()=>activate(id));item.setAttribute('aria-pressed',String(id===settingsCategory));nav.append(item);buttons.set(id,item);const section=el('section',undefined,'dm-form dm-settings-section');section.setAttribute('aria-label',label);section.hidden=id!==settingsCategory;sections.set(id,section);page.append(section);}
        let form=sections.get('appearance');form.append(el('h3','界面外观'));const settings=preferences.snapshot();
        const enabled=field(form,'在消息末尾显示小型地图按钮',input('','checkbox'));enabled.checked=settings.messageButtons;enabled.onchange=()=>run(()=>preferences.update({messageButtons:enabled.checked}));
        form.append(button('打开设置 · 统一外观',()=>globalThis.AminOS?.openApp('settings')));
        form.append(el('p','消息末尾的“🗺 地图”按钮在该消息下方展开完整地图窗口。界面设置立即生效，不修改地图和变量。','dm-help'));
        if(options.integration){
            form=sections.get('integration');const bridge=options.integration,state=bridge.status(),ctx=globalThis.SillyTavern?.getContext?.(),independent=isIndependent(ctx);form.append(el('h3',independent?'地图与剧情资料联动':'小白X与状态栏联动'));
            const controls=independent?[['hud','在状态栏显示地图位置']]:[['variables','同步地图摘要到聊天变量'],['hud','在状态栏显示地图位置'],['allowMoves','允许小白X提交位置更新']];
            for(const [key,label] of controls){const toggle=field(form,label,input('','checkbox'));toggle.checked=state[key];toggle.onchange=()=>run(()=>bridge.configure({[key]:toggle.checked}));}
            form.append(el('p',(independent?'Amin 独立剧情资料':state.littleWhiteBox?'已检测到小白X 2.0':'未检测到小白X 2.0；聊天变量仍可供其他插件读取')+' · 状态栏：'+(state.statusHud?'已检测到':'未检测到')+' · '+state.message,'dm-integration-status'),button(independent?'刷新地图联动状态':'重试地图变量同步',async()=>{await bridge.sync();if(independent)render();}));
            const help=field(form,independent?'当前地图联动资料与规则（只读预览）':'联动提示词（复制到你的世界书）',el('textarea'));help.readOnly=true;help.value=mapIntegrationPrompt(ctx);
        }
        if(options.tools){
            form=sections.get('tools');const tools=options.tools,state=tools.status();form.append(el('h3','AI 动态更新与 Tool Calling'));
            const mode=field(form,'更新方式',select([{id:'native',name:'原生工具调用'},{id:'text',name:'正文更新块（无需工具调用）'}],state.textMode?'text':'native'));mode.onchange=()=>run(()=>{tools.configure({textMode:mode.value==='text'});options.textUpdates?.reset();render();});
            for(const [key,label] of [['enabled','启用聊天中的地图工具'],['autoSave','自动保存 AI 地图更新'],['allowDelete','允许 AI 删除地点和道路']]){const toggle=field(form,label,input('','checkbox'));toggle.checked=state[key];toggle.onchange=()=>run(()=>{tools.configure({[key]:toggle.checked});options.textUpdates?.reset();render();});}
            form.append(el('p',state.textMode?(options.textUpdates?.status().supported?'正文模式可用，无需模型支持工具调用':'当前酒馆缺少正文模式所需接口'):(state.registered?'地图工具已注册':'当前酒馆未提供工具注册接口')+' · '+(state.supported?'模型工具调用已启用':'请在酒馆 AI 响应配置中启用函数调用，并选择支持工具的模型'),'dm-help'));
            form.append(el('p',state.textMode?(options.textUpdates?.status().message??'尚未启用'):state.message),button('刷新工具状态',render));
            form.append(el('p','默认只生成草稿，检查后保存全部地图。自动保存开启后立即应用；人工编辑草稿会阻止 AI 覆盖。原生工具使用酒馆聊天模型，独立地图生成 API 仍用于生成页面。','dm-help'));
            const prompt=field(form,'工具使用提示词（可复制到世界书）',el('textarea'));prompt.readOnly=true;prompt.value=state.textMode?TEXT_PROMPT:TOOL_PROMPT;
            if(state.textMode)form.append(el('p','启用后自动附加当前地图资料与格式规则，不额外请求模型。仅处理新生成的完整回复，续写不触发；更新块保留在消息原文中。若以前写入过工具提示词，请点击更新提示词替换旧规则。','dm-help'));
            const getContext=()=>globalThis.SillyTavern?.getContext?.()??{};
            if(state.textMode){
                const regexFeedback=el('p');let regexBusy=false;
                const refreshRegex=()=>{try{const info=inspectMapRegex(getContext);regexFeedback.textContent=info.message;removeRegex.disabled=!info.exists;}catch(e){regexFeedback.textContent=e.message;removeRegex.disabled=true;}};
                const changeRegex=async remove=>{if(regexBusy)return;regexBusy=true;addRegex.disabled=removeRegex.disabled=true;try{regexFeedback.textContent=await syncMapRegex(getContext,remove);}catch(e){regexFeedback.textContent=e.message;}finally{regexBusy=false;addRegex.disabled=false;try{removeRegex.disabled=!inspectMapRegex(getContext).exists;}catch{removeRegex.disabled=true;}}};
                const addRegex=button('一键添加隐藏正则',()=>void changeRegex(false)),removeRegex=button('移除地图隐藏正则',()=>void changeRegex(true));
                form.append(el('h3','隐藏正文更新块'),el('p','添加到酒馆全局正则，仅隐藏 AI 回复中完整的 <map_update> 块。保留消息原文与发送给模型的内容，地图更新仍可读取。不会自动启用已关闭的酒馆正则扩展。','dm-help'),addRegex,removeRegex,regexFeedback);refreshRegex();
            }
            let target;try{target=targetWorldbook(getContext());}catch(e){target=e.message;}
            form.append(el('p','目标：'+target+'。共享同一本世界书的角色会共用此条目。','dm-help'));
            const feedback=el('p','正在检查世界书提示词状态…');let promptBusy=false;form.append(feedback);
            const apply=async remove=>{promptBusy=true;write.disabled=erase.disabled=true;feedback.textContent=remove?'正在删除提示词…':'正在写入提示词…';try{const result=await syncToolPrompt({getContext,remove,prompt:prompt.value});feedback.textContent=result.name+'：'+result.message;}catch(e){feedback.textContent=e.message;}finally{promptBusy=false;write.disabled=false;void inspect(false);}};
            const write=button('一键写入世界书',()=>void apply(false)),erase=button('删除已写入提示词',()=>void apply(true));form.append(write,erase);
            async function inspect(show=true){try{const info=await inspectToolPrompt({getContext,prompt:prompt.value});if(promptBusy)return;write.textContent=info.exists?'更新提示词':'一键写入世界书';write.setAttribute('aria-label','一键写入世界书');erase.disabled=!info.exists;if(show)feedback.textContent=info.name+'：'+info.message;}catch(e){if(show&&!promptBusy)feedback.textContent=e.message;erase.disabled=true;}}
            erase.disabled=true;form.append(button('检查世界书状态',()=>void inspect()));void inspect();

        }
        for(const name of ['api','presets'])sections.get(name).append(el('p','API 与异步预设统一在 AI 设置中管理。'),button('打开 AI 设置',()=>globalThis.AminOS?.openApp('ai')));

    }
    function renderAI(map){
        const form=el('div',undefined,'dm-form');page.append(form);form.append(el('h3','生成地图草稿'),button('API 与提示词设置',()=>globalThis.AminOS?.openApp('ai')));
        form.setAttribute('aria-busy',String(aiBusy));
        if(aiMapKey!==map.id){aiMapKey=map.id;aiLevel=map.metadata.generationLevel??(map.type==='graph'?'world':'city');aiEntrance='';}
        const level=field(form,'生成层级',select(GENERATION_LEVELS,aiLevel));level.disabled=aiBusy;level.onchange=()=>{aiLevel=level.value;levelRules.textContent=levelPrompt(aiLevel);};
        const levelGuide=el('details'),levelRules=el('pre',levelPrompt(aiLevel));levelGuide.append(el('summary','查看当前层级的生成约束'),levelRules);form.append(levelGuide);
        const density=field(form,'地点覆盖程度',select([{id:'full',name:'全面 · 覆盖各分区与相关地点'},{id:'balanced',name:'适中 · 主要地点与枢纽'},{id:'brief',name:'简略 · 少量地标概览'}],coverage));density.disabled=aiBusy;density.onchange=()=>{coverage=density.value;};
        form.append(el('p','全面模式优先覆盖范围内地点，不保证穷尽现实世界。较大地图需要更多输出预算；可在 AI 设置中调整，或分地区生成后继续新增。','dm-help'));
        if(coverage==='full'&&getAI().capture('map').config.maxTokens<8192)form.append(el('p','当前输出上限低于 8192 tokens，较大地图可能受预算限制；可按模型支持范围提高至 8192–16384。不会自动更改你的 API 设置。','dm-help'));
        form.append(el('p','生成地图草稿：重新生成「'+mapPath(draft.snapshot(),map.id).map(m=>m.name).join(' → ')+'」，保留其他地图；新增按钮只添加内容。','dm-help'));
        const entrance=field(form,'内部地图入口地点',select([{id:'',name:'请选择地点'},...Object.values(map.nodes)],map.nodes[aiEntrance]?aiEntrance:selected??'')),childType=field(form,'内部地图形态',select(mapTypes,aiChildType));entrance.disabled=childType.disabled=aiBusy;entrance.onchange=()=>{aiEntrance=entrance.value;};childType.onchange=()=>{aiChildType=childType.value;};
        const progress=el('p',generationStatus,'dm-generation-progress');progress.setAttribute('role','status');form.append(progress);
        const distances=field(form,'为道路生成距离',input('','checkbox'));distances.checked=distanceRoads;distances.disabled=aiBusy;distances.onchange=()=>{distanceRoads=distances.checked;};
        form.append(el('p','新生成和新增都会读取当前资料、当前地图草稿及最近 30 条非系统聊天正文（不设资料字符上限）。新增只补地点和道路，保留已有资料与当前位置。','dm-help'));
        const naming=field(form,'为道路生成名称',input('','checkbox'));naming.checked=nameRoads;naming.disabled=aiBusy;naming.onchange=()=>{nameRoads=naming.checked;};
        const sourceContext=()=>globalThis.SillyTavern?.getContext?.();
        sourcePicker=mountWorldbookSources(form,{context:sourceContext,value:sourceSettings(sourceContext(),'map',{legacyBindings:true,includeGlobal:false}),disabled:aiBusy,onChange:value=>saveSourceSettings(sourceContext(),'map',value)});
        form.append(el('p',sourceReport,'dm-help'));
        const prompt=field(form,'描述你想要的地图',el('textarea'));prompt.value=aiPrompt;prompt.disabled=aiBusy;prompt.oninput=()=>{aiPrompt=prompt.value;};
        const generateAction=async(expand=false,childMode=false)=>{
            if(aiBusy||disposed)return;
            if(childMode&&!map.nodes[entrance.value]){notice='请先选择内部地图入口地点';render();return;}
            const sharedAI=getAI(),snapshot=sharedAI.capture('map'),api=snapshot.config;
            const ctx=globalThis.SillyTavern?.getContext?.();if(!api.enabled&&typeof ctx?.generateRaw!=='function'){notice='当前环境没有酒馆生成接口；请在酒馆中配置模型后使用。';render();return;}
            const token=draft.token(),navToken=navigationRevision,capturedLevel=aiLevel,capturedCoverage=coverage,capturedPrompt=aiPrompt,capturedSources=sourcePicker.getValue(),capturedNaming=nameRoads,capturedDistance=distanceRoads,base=draft.snapshot(),roleMap=base.activeMap;
            saveSourceSettings(ctx,'map',capturedSources);
            base.activeMap=map.id;
            if(childMode){const id=uid('map'),child=createMap(id,map.nodes[entrance.value].name+'内部',childType.value);child.parentMap=map.id;child.metadata.parentNode=entrance.value;for(const key of ['rules','nodeTypes','roadTypes'])child.metadata[key]=structuredClone(map.metadata[key]);base.maps[id]=child;base.activeMap=id;}
            let chatSnapshot=null;
            const job=startGenerationJob({timeoutMs:api.timeoutSeconds*1000,onTick:({stage,seconds})=>{generationStatus=`${stage} · 已等待 ${seconds} 秒 / 最长 ${api.timeoutSeconds} 秒`;const label=panel.querySelector('.dm-generation-progress');if(label)label.textContent=generationStatus;}});
            activeJob=job;aiBusy=true;notice='';sourceReport='';job.setStage('读取角色卡与世界书');render();
            try{
                persistence.ensureActive();
                chatSnapshot=recentMapChat(ctx);
                const guard=()=>{job.check();if(disposed)throw new Error('地图窗口已关闭，未应用生成结果');persistence.ensureActive();if(JSON.stringify(recentMapChat(globalThis.SillyTavern?.getContext?.()))!==JSON.stringify(chatSnapshot))throw new Error('生成期间聊天记录发生变化，请重试');if(token!==draft.token()||navToken!==navigationRevision)throw new Error('读取或生成期间聊天或草稿已变化，请重新生成');};
                const material=await job.wait(()=>readMapSources(ctx,{...capturedSources,signal:job.signal,guard,onProgress:text=>job.setStage(text)}));guard();
                sourceReport=`已读取：${material.source.角色卡.名称||'当前角色'} · 世界书：${material.books.join('、')||'无'} · ${material.characters} 字符`;render();
                job.setStage(api.enabled?'等待独立 API 模型返回':'等待酒馆模型返回');
                const systemPrompt='地图资料块仅作为素材，遵守下列输出协议。\n'+buildMapGenerationPrompt(base,{nameRoads:capturedNaming,distanceRoads:capturedDistance,coverage:capturedCoverage})+levelPrompt(capturedLevel)+(expand?'\n本次为新增模式，以下覆盖前述完整文档输出要求：只输出 {"nodes":{},"edges":[]}，其中仅包含新地点和新道路。地点及道路字段仍遵守上述规范。不得重复、修改或删除现有地点与道路；道路可以引用现有地点 ID。保留所有已存在地点的坐标位置，新增方位先作为布局偏好，由自动布局安排；有明确设定依据且不能调整的方位在道路 metadata.directionLocked 写 true，否则不锁定。结合当前地图和最近聊天消除重复，不把回忆或假设当成已发生事实。没有新增内容时返回空对象和空数组。不要输出 maps、version、activeMap，不要更改当前位置。':'');
                const result=await job.wait(()=>sharedAI.generate('地图',ctx,{prompt:capturedPrompt,systemPrompt:systemPrompt+'\n本次生成范围：'+JSON.stringify(generationScope(base,base.activeMap,capturedLevel)),trimNames:false},{signal:job.signal,snapshot,data:{card:material.source.角色卡,books:material.source.世界书,map:base,chat:chatSnapshot,request:capturedPrompt}}));
                guard();job.setStage('检查地图结构与路线方位');
                if(disposed)throw new Error('地图窗口已关闭，未应用生成结果');
                if(token!==draft.token()||navToken!==navigationRevision)throw new Error('生成期间聊天或草稿发生变化，未覆盖当前地图，请重新生成');
                const parsed=parseModelJSON(result,{label:'地图生成结果'});
                if(!expand)for(const m of Object.values(parsed.maps??{}))for(const e of m.edges??[]){if(!capturedNaming)e.name='';if(!capturedDistance)e.distance=null;}
                const doc=expand?applyMapExpansion(base,parsed,{nameRoads:capturedNaming,distanceRoads:capturedDistance}):applyGeneratedMap(base,parsed);for(const m of Object.values(doc.maps))validateRules(m);
                if(!expand)for(const m of [doc.maps[base.activeMap]])if(['沧州 · 示例地图','未命名地图','根据世界设定命名'].includes(m.name))m.name=`${material.source.角色卡.名称||'当前世界'} · 地图`;
                doc.maps[base.activeMap].metadata.generationLevel=capturedLevel;doc.activeMap=roleMap;const target=doc.maps[base.activeMap];browsedMap=target.id;draft.applyGeneration(doc);generationStatus=`${childMode?'已创建内部地图':expand?'已新增内容':'已重新生成当前地图'}：${target.name}，${Object.keys(target.nodes).length} 个地点、${target.edges.length} 条道路；保存全部地图调整后生效`; notice='已生成草稿；请检查并保存地图。';if(!expand&&capturedCoverage==='full'&&Object.keys(target.nodes).length<6)notice+=' 本次返回的地点较少，请核对生成层级、世界书读取范围与输出预算；可继续新增补全。';
            }catch(error){generationStatus=error.message;notice=`生成未应用：${error.message}`;}finally{job.finish();activeJob=null;aiBusy=false;render();}
        };const generate=button(aiBusy?'正在生成…':'生成地图草稿',()=>generateAction(false)),add=button('新增地点与道路',()=>generateAction(true));add.title='根据资料与聊天记录新增地点和道路，保留现有内容';generate.disabled=add.disabled=aiBusy;const child=button('生成内部地图',()=>generateAction(false,true));child.title='为选择的入口地点生成子地图';child.disabled=aiBusy||!Object.keys(map.nodes).length;form.append(generate,add,child);const undo=button('撤销本次生成',()=>run(()=>{draft.undoGeneration();generationStatus='已撤销本次生成，恢复生成前草稿';render();}));undo.disabled=aiBusy||!draft.status().canUndo;form.append(undo,el('p','生成可在后续编辑或保存之前撤销；生成期间切换地图会取消结果应用。','dm-help'));if(aiBusy)form.append(button('取消生成',()=>activeJob?.cancel()));
    }
    const libraryKey=`dynamic-map-templates:${persistence.namespace}`;
    function library(){const value=JSON.parse(localStorage.getItem(libraryKey)||'[]');if(!Array.isArray(value))throw new Error('模板库格式错误');return value;}
    function renderTemplates(){
        const form=el('div',undefined,'dm-form');page.append(form);const name=field(form,'模板名称',input('我的地图模板'));
        form.append(button('存为模板（当前草稿）',()=>run(()=>{if(!name.value.trim())throw new Error('请输入模板名称');const items=library();items.push({id:uid('template'),name:name.value.trim(),document:draft.snapshot()});localStorage.setItem(libraryKey,JSON.stringify(items));notice='模板已保存在此浏览器';render();})),button('导出已保存地图',()=>download(persistence.exportDocument())),button('导出草稿',()=>download(draft.snapshot())),button('重试同步已保存地图',()=>run(()=>persistence.retry())));
        const upload=field(form,'导入地图 JSON 到草稿',input('','file'));upload.accept='.json,application/json';upload.onchange=async()=>{const file=upload.files[0],token=draft.token();if(!file)return;try{if(file.size>5*1024*1024)throw new Error('地图文件不能超过 5 MB');const text=await file.text();if(disposed||token!==draft.token())throw new Error('窗口已关闭或读取期间聊天或草稿发生变化，请重试');draft.replace(JSON.parse(text));notice='已导入草稿；保存后才生效';render();}catch(error){notice=error.message;render();}};
        try{for(const item of library()){const row=el('div',undefined,'dm-route');row.append(el('strong',item.name),button('载入草稿',()=>run(()=>{draft.replace(item.document);notice='模板已载入草稿';camera=null;render();})),button('删除模板',()=>run(()=>{localStorage.setItem(libraryKey,JSON.stringify(library().filter(x=>x.id!==item.id)));render();})));form.append(row);}}catch(error){form.append(el('p',error.message));}
        form.append(el('p','模板保存在此浏览器。载入模板会替换未保存草稿；可先导出草稿备份。','dm-help'));
    }
    const offIntegration=options.integration?.subscribe(state=>{for(const p of panel.querySelectorAll('.dm-integration-status'))p.textContent=(isIndependent(globalThis.SillyTavern?.getContext?.())?'Amin 独立剧情资料':state.littleWhiteBox?'已检测到小白X 2.0':'未检测到小白X 2.0')+' · 状态栏：'+(state.statusHud?'已检测到':'未检测到')+' · '+state.message;});
    const off=draft.subscribe(render),offPreferences=preferences.subscribe(render);setCollapsed(collapsed);
    return {open(options={}){if(options.current){browsedMap=store.snapshot().activeMap;navigationRevision++;}const focus=options.focus?.mapId&&store.snapshot().maps?.[options.focus.mapId]?options.focus:null;if(focus){browsedMap=focus.mapId;searchTerm='';navigationRevision++;}tab='view';camera=null;selected=null;setCollapsed(false);if(focus?.nodeId){selected=focus.nodeId;render();}},resetPosition:floating.reset,setStatus(text){panel.querySelector('.dm-save-status').textContent=text;},destroy(){disposed=true;sourcePicker?.dispose();activeJob?.cancel('地图窗口已关闭，未应用生成结果');off();offPreferences();offIntegration?.();if(!options.draft)draft.destroy();floating.destroy();panel.remove();}};
}
