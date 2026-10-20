import {createTileDesktop} from './tile-desktop.js';
import {createBrandMark,createCollapseMark} from './brand.js';
import {getAppearance} from './settings/appearance.js';
import { clampPosition, drawerPlacement, resizedHeight } from './window-state.js';
import { STORY_APPS, renderStoryGate } from './apps/shared/story-readiness.js';

const APPS=[
    {id:'characters',name:'人物卡',sub:'人物档案、状态绑定与属性检定',icon:'♙',color:'mint'},
    {id:'inventory',name:'背包与账本',sub:'物品、装备、资源与转移记录',icon:'▣',color:'peach'},
    {id:'relationships',name:'人物关系',sub:'有向关系图与人物关联',icon:'♧',color:'lavender'},
    {id:'saves',name:'跨应用存档',sub:'保存剧情状态、预览恢复与导入导出',icon:'▤',color:'mint'},
    {id:'scene',name:'场景与时间',sub:'游戏时钟、在场人物与场景快照',icon:'◷',color:'mint'},
    {id:'journal',name:'剧情档案',sub:'伏笔追踪、编年史与确认引用',icon:'▤',color:'peach'},
    {id:'dice',name:'骰子',sub:'通用掷骰、D20 判定与 CoC 检定',icon:'⚄',color:'lavender'},
    {id:'tts',name:'语音朗读',sub:'东雪莲本地语音',icon:'▷',color:'mint'},
    {id:'worldbooks',name:'世界书管理',sub:'角色全局组合与条目开关',icon:'▥',color:'mint'},
    {id:'information',name:'信息面板',sub:'检索资料与编辑人物、事物和世界',icon:'▤',color:'mint'},
    {id:'effects',name:'能力面板',sub:'世界书技能与当前生效记录',icon:'✧',color:'lavender'},
    {id:'map',name:'地图',sub:'记录地点，探索你的世界',icon:'⌘',color:'mint'},
    {id:'status',name:'世界状态',sub:'角色、关系与剧情的此刻',icon:'◈',color:'lavender'},
    {id:'organizations',name:'势力概览',sub:'组织、联盟、地区与局势评估',icon:'◎',color:'mint'},
    {id:'reply',name:'回复选项',sub:'拟写下一句，由你决定',icon:'≋',color:'peach'},
    {id:'ai',name:'AI 设置',sub:'共享 API、异步预设与任务',icon:'✧',color:'mint'},
    {id:'settings',name:'设置',sub:'全局外观与应用个性化',icon:'⚙',color:'lavender'},
];
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};

function icon(id){
    const paths={scene:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',journal:'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5',tts:'M3 9h4l5-5v16l-5-5H3z M16 8q5 4 0 8 M19 4q9 8 0 16',worldbooks:'M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3z M12 6v16',information:'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5',effects:'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z',map:'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2V5z M9 3v16 M15 5v16',status:'M4 5h16v14H4z M8 9h3 M8 13h8 M15 9h1',organizations:'M4 20V9h6v11 M14 20V4h6v16 M2 20h20 M6 12h2 M16 7h2 M16 11h2',reply:'M4 4h16v12H9l-5 4V4z M8 8h8 M8 12h5',stylewriter:'M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.6 7.6',ai:'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8'};
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    for(const [key,value]of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
    if(id==='settings')paths.settings='M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6';
    Object.assign(paths,{characters:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-2a8 8 0 0 1 16 0v2',inventory:'M8 7V4h8v3 M4 7h16v14H4z M4 12h16 M10 12v3h4v-3',relationships:'M6 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M18 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M12 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M8 7h8 M7 9l4 7 M17 9l-4 7',saves:'M4 3h13l3 3v15H4z M8 3v6h8V3 M8 21v-8h8v8'});
    if(id==='dice')paths.dice='M5 3h14l2 2v14l-2 2H5l-2-2V5z M8 8h.01 M16 8h.01 M12 12h.01 M8 16h.01 M16 16h.01';
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',paths[id]);svg.append(path);return svg;
}
const STORE='amin-os.window.v1';
export function createShell(){
    const root=el('div');root.id='amin-os';
    const launcher=el('button','amin-launcher');launcher.type='button';launcher.title='点击打开 Amin os · 拖动移动';launcher.setAttribute('aria-label','打开 Amin os');launcher.setAttribute('aria-expanded','false');launcher.setAttribute('aria-controls','amin-drawer');
    const launcherMark=el('span','amin-mark');launcherMark.append(createBrandMark(document,{compact:true}));launcher.append(launcherMark,el('span','amin-launcher-name','Amin os'));
    const drawer=el('section','amin-drawer');drawer.id='amin-drawer';drawer.setAttribute('aria-label','Amin os 应用侧栏');drawer.hidden=true;
    const head=el('header','amin-head'),brand=el('div','amin-brand');const brandCopy=el('div');brandCopy.append(el('div','amin-wordmark','Amin os'));const brandMark=el('span','amin-brand-icon');brandMark.append(createBrandMark());brand.append(brandMark,brandCopy);
    const collapse=el('button','amin-icon-button');collapse.append(createCollapseMark());collapse.type='button';collapse.title='收起';collapse.setAttribute('aria-label','收起 Amin os');head.append(brand,collapse);
    const nav=el('nav','amin-app-nav');nav.setAttribute('aria-label','应用导航');
    const homeButton=el('button','amin-home-tab','←');homeButton.type='button';homeButton.title='返回开始屏';homeButton.setAttribute('aria-label','Amin os 首页');nav.append(homeButton);const appHeading=el('span','amin-current-app');nav.append(appHeading);
    const area=el('div','amin-area'),home=el('div','amin-home');
    const cards=el('div','amin-home-apps');home.append(cards);
    const panes={},tabs={},handlers={};let tileDesktop;let active='home',opened=false,epoch=0,blocked='',drag=null,suppressClick=false;
    for(const app of APPS){
        const tab=el('button','amin-app-tab',app.name);tab.type='button';tab.dataset.app=app.id;tab.addEventListener('click',()=>showApp(app.id));tabs[app.id]=tab;nav.append(tab);
        const pane=el('section','amin-app-pane amin-ui');pane.dataset.app=app.id;pane.hidden=true;pane.setAttribute('aria-label',app.name);panes[app.id]=pane;
    }
    const notice=el('div','amin-notice');notice.hidden=true;notice.setAttribute('role','status');
    const message=el('p'),retry=el('button','amin-retry','重试');retry.type='button';retry.addEventListener('click',()=>showApp(active));notice.append(message,retry);
    area.append(home,...Object.values(panes),notice);
    // Story-backed apps share one setup prompt while the current chat has no Amin story state.
    const storyGate=el('div','amin-story-gate amin-ui');storyGate.hidden=true;storyGate.setAttribute('role','status');drawer.append(head,nav,storyGate,area);
    const resizeGrip=el('div','amin-height-grip');resizeGrip.tabIndex=0;resizeGrip.setAttribute('role','slider');resizeGrip.setAttribute('aria-label','调整窗口高度');resizeGrip.setAttribute('aria-orientation','vertical');resizeGrip.title='上下拖动调整高度 · 双击恢复自动高度';drawer.append(resizeGrip);
    root.append(drawer,launcher);document.body.append(root);
    let saved;try{saved=JSON.parse(localStorage.getItem(STORE));}catch{}
    const viewport=()=>({width:Math.min(document.documentElement.clientWidth||innerWidth,window.visualViewport?.width||innerWidth),height:window.visualViewport?.height||innerHeight,x:window.visualViewport?.offsetLeft||0,y:window.visualViewport?.offsetTop||0});
    const initial=viewport();let manualHeight=Number.isFinite(saved?.height)&&saved.height>0?saved.height:null,resizing=null;let configuredHeight=getAppearance()?.snapshot().window.height;
    let position=clampPosition(saved??{x:initial.width-142,y:initial.height-78},initial.width,initial.height);
    function place(){
        const {width,height,x,y}=viewport();
        root.dataset.mobile=String(width<=640);root.dataset.open=String(opened);resizeGrip.hidden=width<=640;
        position=clampPosition(position,width,height);launcher.style.left=(position.x+x)+'px';launcher.style.top=(position.y+y)+'px';
        const options=getAppearance()?.snapshot().window;
        let rect=drawerPlacement(position,width,height,{...options,...(manualHeight===null?{}:{height:manualHeight})});
        Object.assign(drawer.style,{left:(rect.x+x)+'px',top:(rect.y+y)+'px',width:rect.width+'px',height:rect.height+'px'});
        if(width>640&&opened&&active==='home'&&manualHeight===null){
            const contentHeight=Math.ceil(head.getBoundingClientRect().height+nav.getBoundingClientRect().height+home.scrollHeight+4);
            rect=drawerPlacement(position,width,height,{...options,height:Math.min(rect.height,contentHeight)});
            Object.assign(drawer.style,{top:(rect.y+y)+'px',height:rect.height+'px'});
        }
        syncGrip();
    }
    function save(){try{localStorage.setItem(STORE,JSON.stringify({...position,height:manualHeight}));}catch{}}
    function resizeLimits(){const v=viewport(),r=drawerPlacement(position,v.width,v.height,{height:Number.MAX_SAFE_INTEGER});return {edge:r.y<position.y?'top':'bottom',available:r.height};}
    function syncGrip(){const limits=resizeLimits();resizeGrip.dataset.edge=limits.edge;resizeGrip.setAttribute('aria-valuemin',String(Math.round(Math.min(220,limits.available))));resizeGrip.setAttribute('aria-valuemax',String(Math.round(limits.available)));resizeGrip.setAttribute('aria-valuenow',String(Math.round(parseFloat(drawer.style.height)||0)));resizeGrip.setAttribute('aria-valuetext',`${Math.round(parseFloat(drawer.style.height)||0)} 像素`);}
    function endResize(cancel=false){if(!resizing)return;const previous=resizing;resizing=null;if(cancel)manualHeight=previous.original;root.classList.remove('amin-resizing-height');if(resizeGrip.hasPointerCapture(previous.id))resizeGrip.releasePointerCapture(previous.id);place();save();}
    resizeGrip.addEventListener('pointerdown',e=>{if(!e.isPrimary||e.button!==0)return;e.preventDefault();e.stopPropagation();const limits=resizeLimits();resizing={id:e.pointerId,y:e.clientY,start:drawer.getBoundingClientRect().height,original:manualHeight,...limits};resizeGrip.setPointerCapture(e.pointerId);root.classList.add('amin-resizing-height');});
    resizeGrip.addEventListener('pointermove',e=>{if(resizing?.id!==e.pointerId)return;e.preventDefault();manualHeight=resizedHeight(resizing.start,e.clientY-resizing.y,resizing.edge,resizing.available);place();});
    resizeGrip.addEventListener('pointerup',()=>endResize());resizeGrip.addEventListener('pointercancel',()=>endResize(true));resizeGrip.addEventListener('lostpointercapture',()=>endResize(true));
    resizeGrip.addEventListener('dblclick',()=>{endResize(true);manualHeight=null;place();save();});
    resizeGrip.addEventListener('keydown',e=>{if(e.key==='Escape'&&resizing){e.preventDefault();e.stopPropagation();endResize(true);return;}if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();const {edge,available}=resizeLimits();manualHeight=e.key==='Home'?Math.min(220,available):e.key==='End'?available:resizedHeight(drawer.getBoundingClientRect().height,(e.key==='ArrowUp'?-1:1)*(e.shiftKey?40:10),edge,available);place();save();});
    window.addEventListener('blur',()=>endResize(true));
    function open(){opened=true;drawer.hidden=false;launcher.setAttribute('aria-expanded','true');launcher.setAttribute('aria-label','收起 Amin os');place();}
    function close(){endResize(true);tileDesktop?.leave();opened=false;drawer.hidden=true;root.dataset.open='false';launcher.setAttribute('aria-expanded','false');launcher.setAttribute('aria-label','打开 Amin os');launcher.focus();}
    function select(id){active=id;nav.hidden=id==='home';appHeading.textContent=APPS.find(a=>a.id===id)?.name??'';home.hidden=id!=='home';for(const [key,pane]of Object.entries(panes)){pane.hidden=key!==id;tabs[key].setAttribute('aria-current',key===id?'page':'false');}homeButton.setAttribute('aria-current',id==='home'?'page':'false');notice.hidden=true;updateStoryGate();}
    function updateStoryGate(){if(!STORY_APPS.includes(active)){storyGate.hidden=true;return;}try{renderStoryGate(storyGate,globalThis.SillyTavern?.getContext?.(),document);}catch{storyGate.hidden=true;}}
    function showHome(){epoch++;select('home');open();if(blocked){message.textContent=blocked;retry.hidden=true;notice.hidden=false;}}
    async function showApp(id){
        if(!panes[id])return;
        if(blocked){showHome();return;}
        tileDesktop?.leave();select(id);open();const ticket=++epoch;message.textContent='正在打开…';retry.hidden=true;notice.hidden=false;
        try{if(!handlers[id])throw Error('应用仍在加载，请稍后重试。');await handlers[id]();if(ticket===epoch)notice.hidden=true;}
        catch(error){if(ticket===epoch){message.textContent=error.message||'打开失败，请重试。';retry.hidden=false;notice.hidden=false;}}
    }
    const resume=()=>active==='home'?open():showApp(active);
    launcher.addEventListener('click',()=>{if(suppressClick){suppressClick=false;return;}if(opened)close();else resume();});
    collapse.addEventListener('click',close);homeButton.addEventListener('click',showHome);
    drawer.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close();}});
    launcher.addEventListener('keydown',e=>{const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(moves[e.key]){e.preventDefault();position.x+=moves[e.key][0]*10;position.y+=moves[e.key][1]*10;place();save();}});
    launcher.addEventListener('pointerdown',e=>{if(!e.isPrimary||e.button!==0)return;suppressClick=false;drag={id:e.pointerId,x:e.clientX,y:e.clientY,start:{...position},moved:false};launcher.setPointerCapture(e.pointerId);});
    launcher.addEventListener('pointermove',e=>{if(drag?.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>5)drag.moved=true;if(drag.moved){position={x:drag.start.x+dx,y:drag.start.y+dy};place();}});
    const stop=e=>{if(drag?.id!==e.pointerId)return;suppressClick=drag.moved;drag=null;save();};
    for(const name of ['pointerup','pointercancel','lostpointercapture'])launcher.addEventListener(name,stop);
    getAppearance()?.subscribe(()=>{const next=getAppearance().snapshot().window.height;if(next!==configuredHeight){configuredHeight=next;manualHeight=null;save();}place();});
    window.addEventListener('resize',place);window.visualViewport?.addEventListener('resize',place);window.visualViewport?.addEventListener('scroll',place);place();select('home');
    tileDesktop=createTileDesktop({home,cards,apps:APPS,createIcon:icon,openApp:showApp,onLayout:place});
    return {panes,open:resume,close,home:showHome,showApp,register(id,fn){handlers[id]=fn;},refreshActive(){if(opened&&active!=='home')showApp(active);},setBlocked(text){blocked=text;cards.querySelectorAll('button').forEach(b=>b.disabled=true);message.textContent=text;retry.hidden=true;notice.hidden=false;}};
}
