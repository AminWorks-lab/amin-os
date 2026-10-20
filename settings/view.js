import {resetTileLayout} from '../tile-layout.js';
import {getAppearance,PALETTES,APP_NAMES,defaults,mergeFloorToolbarDraft} from './appearance.js';
import {mountStoryStorage} from './story-storage-view.js';
import {contextLine,globalContextLine} from '../apps/shared/context-line.js';
import {takeAppRequest} from '../apps/shared/open-app.js';
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export function mount(target){
 const service=getAppearance();target.classList.add('amin-ai','amin-settings','amin-app-page');
 let page='global',draft=service.snapshot(),message='',messageState='',storyView=null,noticeNode=null;
 const editedToolbarFields=new Set();
 function draw(){
  storyView?.dispose();storyView=null;
  draft=mergeFloorToolbarDraft(draft,service.snapshot(),editedToolbarFields);
  target.replaceChildren();const heading=el('header',null,'amin-context');heading.append(el('p',page==='story'?contextLine(globalThis.SillyTavern?.getContext?.(),'剧情文件、备份与跨设备同步'):globalContextLine('主题、布局与楼层窗口','切换分页会保留未保存的修改')));target.append(heading);
  const nav=el('nav',null,'amin-tabs'),body=el('section',null,'amin-stack'),notice=el('p',message,'amin-result');nav.setAttribute('aria-label','设置分类');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');notice.dataset.state=messageState;notice.hidden=!message;target.append(nav,notice,body);noticeNode=notice;
  const report=(text,state='success')=>{message=text;messageState=state;if(noticeNode){noticeNode.textContent=text;noticeNode.dataset.state=state;noticeNode.hidden=!text;}};
  const button=(parent,label,fn)=>{const e=el('button',label);e.type='button';e.onclick=()=>{try{fn();}catch(error){report(error.message,'error');}};parent.append(e);return e;};
  const section=(title,description)=>{const box=el('section',null,'amin-card amin-stack');box.append(el('h3',title,'amin-section-heading'));if(description)box.append(el('p',description,'amin-meta'));body.append(box);return box;};
  const grid=parent=>{const wrap=el('div',null,'amin-form-grid');parent.append(wrap);return wrap;};
  const toolbar=parent=>{const bar=el('div',null,'amin-toolbar');parent.append(bar);return bar;};
  for(const [id,name]of [['global','整体外观'],['apps','单个应用'],['floor','楼层窗口'],['effects','背景与动效'],['story','剧情存储']]){const b=button(nav,name,()=>{page=id;draw();});b.setAttribute('aria-pressed',String(page===id));}
  function select(parent,label,items,value,onchange){const wrap=el('label',null,'amin-field'),control=el('select');for(const [id,name]of items){const o=el('option',name);o.value=id;control.append(o);}control.value=value;control.onchange=()=>onchange(control.value);wrap.append(el('span',label),control);parent.append(wrap);return control;}
  function numeric(parent,label,value,min,max,onchange){const wrap=el('label',null,'amin-field'),control=el('input');control.type='number';control.min=min;control.max=max;control.value=value;control.oninput=()=>onchange(Number(control.value));wrap.append(el('span',`${label}（${min}–${max}）`),control);parent.append(wrap);return control;}
  function fields(parent,value){
   select(parent,'主题',Object.entries(PALETTES).map(([id,p])=>[id,p.name]),value.theme,v=>value.theme=v);
   select(parent,'内容间距',[['comfortable','舒适'],['compact','紧凑']],value.density,v=>value.density=v);
   numeric(parent,'字号',value.fontSize,11,20,v=>value.fontSize=v);numeric(parent,'圆角',value.radius,0,24,v=>value.radius=v);
   numeric(parent,'背景不透明度 %',value.opacity,70,100,v=>value.opacity=v);numeric(parent,'背景模糊',value.blur,0,24,v=>value.blur=v);
  }
  if(page==='story'){
   storyView=mountStoryStorage(body,report);
  }else if(page==='global'){
   const desktop=section('主页与窗口','自动模式为 Windows 10 磁贴搭配深色直角窗口。'),desktopGrid=grid(desktop);
   select(desktopGrid,'主页磁贴风格',[['classic','风格 1 · 跟随主题'],['win10','风格 2 · Windows 10']],draft.desktop.style,v=>draft.desktop.style=v);
   select(desktopGrid,'窗口主题',[['auto','自动搭配磁贴风格'],['current','保留原有主题'],['win10','Windows 10 深色'],['win10light','Windows 10 浅色']],draft.desktop.windowTheme,v=>draft.desktop.windowTheme=v);
   const appearance=section('全局外观','应用默认使用这里的设置，也可在“单个应用”中覆盖。');fields(grid(appearance),draft.global);
   const dimensions=section('侧栏尺寸','屏幕空间不足时自动缩小，位置保持在可见范围内。'),dimensionsGrid=grid(dimensions);
   numeric(dimensionsGrid,'桌面侧栏宽度',draft.window.width,340,800,v=>draft.window.width=v);numeric(dimensionsGrid,'侧栏最大高度',draft.window.height,400,1000,v=>draft.window.height=v);
   const layout=section('磁贴排列','立即恢复磁贴的默认顺序和尺寸。');button(toolbar(layout),'恢复磁贴默认布局',()=>{resetTileLayout();report('磁贴已恢复默认顺序和尺寸。');});
  }else if(page==='apps'){
   body.append(el('p','展开应用设置主题、字号和间距；未单独配置的应用自动跟随全局。','amin-meta'));
   for(const [id,name]of Object.entries(APP_NAMES)){
    const card=el('details',null,'amin-card amin-appearance-card');card.append(el('summary',name));const content=el('div',null,'amin-stack');card.append(content);body.append(card);
    select(content,'外观来源',[['inherit','跟随全局'],['own','使用单独外观']],draft.apps[id]?'own':'inherit',value=>{if(value==='own')draft.apps[id]={...draft.global};else delete draft.apps[id];render();});
    const editor=el('div',null,'amin-form-grid');content.append(editor);const render=()=>{editor.replaceChildren();if(draft.apps[id])fields(editor,draft.apps[id]);else editor.append(el('p','全局外观变化会自动应用到这里。','amin-meta amin-span-full'));};render();
   }
  }else if(page==='effects'){
   const d=draft.desktop.effects,background=section('主页背景'),backgroundGrid=grid(background),tiles=section('磁贴质感'),tilesGrid=grid(tiles),effects=section('动态效果','编辑布局、收起窗口或系统要求减少动态时暂停。'),effectsGrid=grid(effects);
   const text=(parent,label,key)=>{const wrap=el('label',null,'amin-field amin-span-full'),input=el('input');input.type='url';input.value=d[key];input.oninput=()=>d[key]=input.value;wrap.append(el('span',label),input);parent.append(wrap);return wrap;};
   const preset=select(backgroundGrid,'主页背景',[['none','跟随主题'],['paper','纸页纹理'],['aurora','极光山影'],['image','自定义图片']],d.preset,v=>{d.preset=v;reflect();}),image=text(backgroundGrid,'主页背景图片地址','image');
   numeric(backgroundGrid,'背景遮罩深浅 %',d.shade,0,90,v=>d.shade=v);
   numeric(tilesGrid,'磁贴不透明度 %',d.tileOpacity,15,100,v=>d.tileOpacity=v);numeric(tilesGrid,'磁贴边框',d.border,0,3,v=>d.border=v);numeric(tilesGrid,'磁贴阴影',d.shadow,0,30,v=>d.shadow=v);
   const effect=select(effectsGrid,'磁贴区域动态效果',[['none','关闭'],['sakura','樱花飘落'],['video','自定义视频层']],d.effect,v=>{d.effect=v;reflect();}),video=text(effectsGrid,'视频地址','video');
   const amount=numeric(effectsGrid,'樱花数量',d.amount,4,50,v=>d.amount=v),speed=numeric(effectsGrid,'飘落时长（秒，越大越慢）',d.speed,4,30,v=>d.speed=v),opacity=numeric(effectsGrid,'动态层不透明度 %',d.effectOpacity,5,100,v=>d.effectOpacity=v);
   const reflect=()=>{image.hidden=preset.value!=='image';video.hidden=effect.value!=='video';amount.parentElement.hidden=speed.parentElement.hidden=effect.value!=='sakura';opacity.parentElement.hidden=effect.value==='none';};reflect();
   body.append(el('p','填写可直接访问的图片或视频地址，也支持 / 开头的酒馆资源路径。视频静音循环，加载依赖资源服务器。单块磁贴背景在主页编辑布局中设置。','amin-meta'));
  }else{
   const names=Object.keys(defaults().floor.buttons).map(id=>[id,APP_NAMES[id]||id]);
   const buttons=section('楼层入口','选择消息楼层下显示的应用按钮。'),buttonGrid=grid(buttons);
   for(const [id,name]of names){const row=el('label',null,'amin-field amin-check'),check=el('input');check.type='checkbox';check.checked=draft.floor.buttons[id];check.onchange=()=>draft.floor.buttons[id]=check.checked;row.append(check,el('span','显示'+name+'按钮'));buttonGrid.append(row);}
   {const row=el('label',null,'amin-field amin-check amin-span-full'),check=el('input');check.type='checkbox';check.checked=draft.floor.latestOnly!==false;check.onchange=()=>draft.floor.latestOnly=check.checked;row.append(check,el('span','只在最新一楼显示按钮行（已打开的窗口保持不变）'));buttonGrid.prepend(row);}
   const arrangement=section('按钮排列与收纳','也可在消息楼层展开“更多”，点击“调整排列”拖动排序。放入“更多”的按钮仍然可以打开应用。'),arrangementGrid=grid(arrangement);
   select(arrangementGrid,'按钮整排对齐',[['left','靠左'],['center','居中'],['right','靠右']],draft.floor.toolbarAlignment,v=>{draft.floor.toolbarAlignment=v;editedToolbarFields.add('toolbarAlignment');});
   const order=el('div',null,'amin-stack amin-floor-order-settings');arrangement.append(order);
   function drawOrder(){
    order.replaceChildren();
    draft.floor.buttonOrder.forEach((id,index)=>{
     const row=el('div',null,'amin-toolbar amin-floor-order-row');row.dataset.floorButton=id;row.append(el('span',APP_NAMES[id]||id,'amin-floor-order-name'));
     const move=delta=>{const list=[...draft.floor.buttonOrder];[list[index],list[index+delta]]=[list[index+delta],list[index]];draft.floor.buttonOrder=list;editedToolbarFields.add('buttonOrder');drawOrder();order.querySelector(`[data-floor-button="${id}"] button[data-move="${delta}"]:not(:disabled)`)?.focus();};
     const up=button(row,'上移',()=>move(-1));up.dataset.move='-1';up.disabled=index===0;up.setAttribute('aria-label',`${APP_NAMES[id]}上移`);
     const down=button(row,'下移',()=>move(1));down.dataset.move='1';down.disabled=index===draft.floor.buttonOrder.length-1;down.setAttribute('aria-label',`${APP_NAMES[id]}下移`);
     const label=el('label',null,'amin-field amin-check'),check=el('input');check.type='checkbox';check.checked=draft.floor.moreButtons.includes(id);check.onchange=()=>{draft.floor.moreButtons=draft.floor.moreButtons.filter(value=>value!==id);if(check.checked)draft.floor.moreButtons.push(id);draft.floor.moreButtonsCustomized=true;editedToolbarFields.add('moreButtons');};label.append(check,el('span','放入更多'));row.append(label);order.append(row);
    });
   }
   drawOrder();
   button(toolbar(arrangement),'恢复按钮默认排列',()=>{const floor=defaults().floor;for(const key of ['buttonOrder','moreButtons','toolbarAlignment']){draft.floor[key]=floor[key];editedToolbarFields.add(key);}draft.floor.moreButtonsCustomized=false;draw();});
   const shared=section('统一窗口尺寸','窗口不会超过消息宽度。先打开的窗口排在上面，重新打开会排到末尾。'),sharedGrid=grid(shared);
   select(sharedGrid,'窗口对齐',[['left','靠左'],['center','居中'],['right','靠右']],draft.floor.alignment,v=>draft.floor.alignment=v);
   select(sharedGrid,'窗口高度',[['fixed','统一高度'],['auto','随内容变化（不超过上限）']],draft.floor.sizeMode,v=>draft.floor.sizeMode=v);
   const dimensions=(parent,value)=>{numeric(parent,'桌面最大宽度',value.width,320,1400,v=>value.width=v);numeric(parent,'桌面高度（占屏幕 %）',value.desktopHeight,30,90,v=>value.desktopHeight=v);numeric(parent,'手机高度（占屏幕 %）',value.mobileHeight,30,85,v=>value.mobileHeight=v);};
   dimensions(sharedGrid,draft.floor);
   const overrides=section('各应用窗口尺寸','需要不同尺寸时，展开应用并选择“单独设置”。');
   for(const [id,name]of names){const card=el('details',null,'amin-card');card.append(el('summary',name));overrides.append(card);const content=el('div',null,'amin-stack'),editor=el('div',null,'amin-form-grid');card.append(content);select(content,'尺寸来源',[['inherit','跟随统一尺寸'],['own','单独设置']],draft.floor.overrides[id]?'own':'inherit',v=>{if(v==='own')draft.floor.overrides[id]={width:draft.floor.width,desktopHeight:draft.floor.desktopHeight,mobileHeight:draft.floor.mobileHeight};else delete draft.floor.overrides[id];render();});content.append(editor);const render=()=>{editor.replaceChildren();if(draft.floor.overrides[id])dimensions(editor,draft.floor.overrides[id]);else editor.append(el('p','使用上方统一窗口尺寸。','amin-meta amin-span-full'));};render();}
  }
  if(page!=='story'){
   const actions=toolbar(body);
   button(actions,'保存并应用',()=>{service.save(mergeFloorToolbarDraft(draft,service.snapshot(),editedToolbarFields));draft=service.snapshot();editedToolbarFields.clear();report('已应用所有分页的修改。打开的窗口同步更新。');draw();}).className='amin-primary';
   button(actions,'恢复本页默认',()=>{const d=defaults();if(page==='global'){draft.global=d.global;draft.window=d.window;draft.desktop.style=d.desktop.style;draft.desktop.windowTheme=d.desktop.windowTheme;}else if(page==='apps')draft.apps={};else if(page==='effects')draft.desktop.effects=d.desktop.effects;else{draft.floor=d.floor;for(const key of ['buttonOrder','moreButtons','toolbarAlignment'])editedToolbarFields.add(key);}message='本页已恢复默认，点击“保存并应用”生效。';messageState='';draw();});
  }
 }
 // Other apps may ask for a specific page, e.g. 剧情存储 from a “还没有剧情资料” prompt.
 draw();return {open(){const request=takeAppRequest('settings');if(request?.page&&['global','apps','floor','effects','story'].includes(request.page)&&request.page!==page){page=request.page;draw();}if(request?.focus==='import')target.querySelector?.('[data-story-import]')?.focus?.();},dispose(){storyView?.dispose();noticeNode=null;target.replaceChildren();}};
}
