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
