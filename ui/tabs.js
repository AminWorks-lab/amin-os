// Single-row tab strips: edge fades follow the scroll position and the selected tab is kept in view.
export const TAB_LIST_SELECTOR='.amin-tabs,[role=tablist],.dm-tabs,.dm-settings-categories';
const SELECTED=':scope>:is([aria-selected=true],[aria-pressed=true],[aria-current=page])';
const owned=list=>Boolean(list?.closest?.('.amin-ui,html[data-wsh-frame][data-amin-surface]'));
export function updateTabFade(list){
 const max=list.scrollWidth-list.clientWidth,left=Math.abs(list.scrollLeft),value=[max>1&&left>1&&'start',max>1&&left<max-1&&'end'].filter(Boolean).join(' ');
 if((list.dataset.fade??'')!==value){if(value)list.dataset.fade=value;else delete list.dataset.fade;}
}
export function revealSelectedTab(list,margin=28){
 const tab=list.querySelector(SELECTED);if(!tab||list.scrollWidth<=list.clientWidth)return;
 const box=list.getBoundingClientRect(),rect=tab.getBoundingClientRect();
 if(rect.left<box.left+margin)list.scrollLeft-=box.left+margin-rect.left;else if(rect.right>box.right-margin)list.scrollLeft+=rect.right-(box.right-margin);
}
export function installTabScroll(document=globalThis.document){
 const view=document.defaultView??globalThis,seen=new WeakSet(),chosen=new WeakMap();let queued=false;
 const resize=view.ResizeObserver?new view.ResizeObserver(entries=>{for(const entry of entries){revealSelectedTab(entry.target);updateTabFade(entry.target);}}):null;
 function scan(){
  queued=false;
  for(const list of document.querySelectorAll(TAB_LIST_SELECTOR)){
   if(!owned(list))continue;
   if(!seen.has(list)){seen.add(list);resize?.observe(list);}
   const tab=list.querySelector(SELECTED);if(tab&&list.clientWidth&&chosen.get(list)!==tab){chosen.set(list,tab);revealSelectedTab(list);}
   updateTabFade(list);
  }
 }
 const schedule=()=>{if(!queued){queued=true;(view.requestAnimationFrame??setTimeout)(scan);}};
 const onScroll=event=>{const list=event.target;if(list?.matches?.(TAB_LIST_SELECTOR)&&owned(list))updateTabFade(list);};
 // A vertical wheel scrolls a strip that only overflows sideways.
 const onWheel=event=>{const list=event.target?.closest?.(TAB_LIST_SELECTOR);if(!list||!owned(list)||event.ctrlKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)||list.scrollWidth<=list.clientWidth)return;const before=list.scrollLeft;list.scrollLeft+=event.deltaY;if(list.scrollLeft!==before)event.preventDefault();};
 const observer=new view.MutationObserver(schedule);
 observer.observe(document.body??document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-selected','aria-pressed','aria-current','hidden']});
 document.addEventListener('scroll',onScroll,true);document.addEventListener('wheel',onWheel,{passive:false});view.addEventListener?.('resize',schedule);schedule();
 return {refresh:schedule,dispose(){observer.disconnect();resize?.disconnect();document.removeEventListener('scroll',onScroll,true);document.removeEventListener('wheel',onWheel,{passive:false});view.removeEventListener?.('resize',schedule);}};
}

let menuCount=0;
// A “⋯” menu: a toggle button plus a menu panel inserted after `anchor()` (or after the
// toggle's tab strip / toolbar), outside any horizontally scrolling strip so it is never clipped.
// items() is read each time the menu opens: [{label, run, title?, disabled?} | {separator:true}].
export function createMoreMenu(document,{items,label='更多',anchor}={}){
 const wrap=document.createElement('span'),toggle=document.createElement('button'),panel=document.createElement('div'),id='amin-more-'+(++menuCount);
 wrap.className='amin-more';toggle.type='button';toggle.className='amin-more-toggle';toggle.textContent='⋯';toggle.title=label;
 toggle.setAttribute('aria-label',label);toggle.setAttribute('aria-haspopup','menu');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',id);
 panel.id=id;panel.className='amin-more-menu';panel.setAttribute('role','menu');panel.setAttribute('aria-label',label);panel.hidden=true;wrap.append(toggle);
 const entries=()=>[...(panel.children??[])].filter(item=>item.getAttribute?.('role')==='menuitem'&&!item.disabled);
 const inside=target=>target&&(wrap.contains?.(target)||panel.contains?.(target));
 const onOutside=event=>{if(!inside(event.target))close(false);};
 function close(focus=true){
  if(panel.hidden)return;panel.hidden=true;toggle.setAttribute('aria-expanded','false');
  document.removeEventListener?.('pointerdown',onOutside,true);if(focus)toggle.focus?.();
 }
 function open(focusFirst=false){
  panel.replaceChildren();
  for(const item of items?.()??[]){
   if(item.separator){const line=document.createElement('div');line.setAttribute('role','separator');line.className='amin-more-separator';panel.append(line);continue;}
   const entry=document.createElement('button');entry.type='button';entry.textContent=item.label;entry.setAttribute('role','menuitem');entry.tabIndex=-1;
   if(item.title)entry.title=item.title;if(item.disabled)entry.disabled=true;
   entry.addEventListener('click',()=>{close(false);item.run?.();});panel.append(entry);
  }
  if(!entries().length)return;
  const after=anchor?.()??wrap.closest?.('[role=tablist],.amin-tabs,.amin-toolbar')??wrap;
  if(panel.previousElementSibling!==after)after.after?.(panel);
  panel.hidden=false;toggle.setAttribute('aria-expanded','true');
  document.addEventListener?.('pointerdown',onOutside,true);
  if(focusFirst)entries()[0]?.focus?.();
 }
 toggle.addEventListener('click',()=>{if(panel.hidden)open(false);else close();});
 // Keys stay inside the menu: host tab strips listen for arrows too.
 toggle.addEventListener('keydown',event=>{
  if(event.key==='ArrowDown'&&panel.hidden){event.preventDefault?.();open(true);}
  else if(event.key==='Escape')close();
  else if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.stopPropagation?.();
 });
 panel.addEventListener('keydown',event=>{
  const list=entries(),index=list.indexOf(document.activeElement);let next=null;
  if(event.key==='ArrowDown'||event.key==='ArrowRight')next=list[(index+1)%list.length];
  else if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=list[(index+list.length-1)%list.length];
  else if(event.key==='Home')next=list[0];else if(event.key==='End')next=list.at(-1);
  else if(event.key==='Escape'){event.preventDefault?.();close();}
  else if(event.key==='Tab')close(false);
  else return;
  event.stopPropagation?.();if(next){event.preventDefault?.();next.focus?.();}
 });
 return {element:wrap,toggle,panel,open,close,dispose(){close(false);panel.remove?.();wrap.remove?.();}};
}

// At most the `keep` tabs (by label) stay in the strip; the others open from a “⋯” at its end.
// The selected tab always stays in the strip. `actions` adds menu-only commands such as a
// fallback refresh. Views that redraw their tabs call update() afterwards; a MutationObserver
// covers redraws where the browser provides one.
export function collapseTabs(list,{keep=[],actions=[],label='更多页面'}={}){
 const document=list?.ownerDocument;
 if(!document?.createElement||!list.append)return {update(){},dispose(){},menu:null};
 const pinned=new Set(keep),name=tab=>String(tab.textContent??'').trim();
 const selected=tab=>['aria-selected','aria-pressed'].some(key=>tab.getAttribute?.(key)==='true')||tab.getAttribute?.('aria-current')==='page';
 const extra=()=>(typeof actions==='function'?actions():actions).filter(Boolean);
 const tabs=()=>[...(list.children??[])].filter(tab=>tab!==menu.element&&tab.tagName==='BUTTON');
 const menu=createMoreMenu(document,{label,anchor:()=>list,items:()=>{
  const hidden=tabs().filter(tab=>tab.dataset.tabOverflow==='true').map(tab=>({label:name(tab),run(){
   const label=name(tab);tab.click?.();
   queueMicrotask(()=>tabs().find(item=>name(item)===label&&item.dataset.tabOverflow!=='true')?.focus?.());
  }}));
  const more=extra();return [...hidden,...(hidden.length&&more.length?[{separator:true}]:[]),...more];
 }});
 let updating=false;
 function update(){
  if(updating)return;updating=true;
  try{
   let overflow=0;
   for(const tab of tabs()){
    const hide=pinned.size>0&&!pinned.has(name(tab))&&!selected(tab);
    if(hide)overflow++;
    if((tab.dataset.tabOverflow==='true')!==hide){if(hide)tab.dataset.tabOverflow='true';else delete tab.dataset.tabOverflow;}
   }
   const wanted=overflow>0||extra().length>0;
   if(menu.element.hidden===wanted)menu.element.hidden=!wanted;
   if([...(list.children??[])].at(-1)!==menu.element)list.append(menu.element);
  }finally{updating=false;}
 }
 const Observer=document.defaultView?.MutationObserver;
 const observer=typeof Observer==='function'?new Observer(records=>{if(records.some(record=>!menu.element.contains?.(record.target)&&record.target!==menu.element))update();}):null;
 observer?.observe(list,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-selected','aria-pressed','aria-current']});
 update();
 return {update,menu,dispose(){observer?.disconnect();menu.dispose();}};
}
