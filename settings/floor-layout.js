import {getAppearance} from './appearance.js';
import {createFloorToolbar} from './floor-toolbar.js';
import {observeChatFloors} from '../apps/floor-scheduler.js';
// UI-only dock: preserve message text, own button visibility and opening order.
const rows=new WeakMap(),live=new Set();let watch=null;
const hostContext=()=>globalThis.SillyTavern?.getContext?.();
// The latest floor is the last non-system message. An unknown chat keeps every row visible.
export function latestFloorIndex(chat){if(!Array.isArray(chat))return null;for(let i=chat.length-1;i>=0;i--)if(chat[i]&&!chat[i].is_system)return i;return -1;}
export function isLatestFloor(element,ctx=hostContext()){const index=Number(element?.getAttribute?.('mesid')),latest=latestFloorIndex(ctx?.chat);return latest===null||!Number.isInteger(index)||index===latest;}
function updateRow(row){
 const prefs=getAppearance()?.snapshot().floor,active=[...row.items].some(x=>x.shown??x.visible),open=[...row.items].some(x=>x.open);
 // Open windows stay mounted on older floors; only the idle button row is withdrawn.
 const bar=active&&(prefs?.latestOnly!==true||open||isLatestFloor(row.element));
 if(row.toolbar.hidden!==!bar)row.toolbar.hidden=!bar;row.root.hidden=!bar&&!open;
}
function track(row,document){live.add(row);if(!watch&&typeof document?.querySelectorAll==='function'){try{watch=observeChatFloors(()=>{for(const item of live)updateRow(item);},{document});}catch{watch=null;}}}
function untrack(row){live.delete(row);if(!live.size&&watch){const off=watch;watch=null;off.dispose();}}
export function mountFloorControl(element,id,host,button,document=globalThis.document){
 let row=rows.get(element);
 if(!row){
  const root=document.createElement('div'),toolbar=document.createElement('div');root.className='amin-floor';toolbar.className='amin-floor-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','楼层应用');root.append(toolbar);(element.querySelector('.mes_block')??element).append(root);
  row={element,root,toolbar,items:new Set(),opened:[]};rows.set(element,row);row.controls=createFloorToolbar(row,document);track(row,document);
 }
 host.dataset.floorApp=id;button.dataset.floorApp=id;row.toolbar.append(button);row.root.append(host);
 const item={id,button,visible:true,open:false,host};row.items.add(item);
 // CSS order preserves the iframe document and its local UI state.
 const reorder=()=>{for(const i of row.items)if(i.host.style)i.host.style.order=String(i.open?row.opened.indexOf(i)+1:row.items.size+1);};
 function setOpen(value){if(value===item.open)return;item.open=value;row.opened=row.opened.filter(x=>x!==item);if(value)row.opened.push(item);reorder();updateRow(row);}
 const reflect=()=>{
  const visible=item.visible&&(getAppearance()?.snapshot().floor.buttons?.[id]!==false);
  if(!visible&&item.open){button.click?.();setOpen(false);}
  item.shown=visible;host.hidden=!visible;button.hidden=!visible;updateRow(row);row.controls.render();
 };
 const off=getAppearance()?.subscribe(reflect);reflect();
 return {setOpen,setVisible(value){item.visible=value;reflect();},dispose(){off?.();setOpen(false);host.remove();button.remove();row.items.delete(item);if(!row.items.size){row.controls.dispose();row.root.remove();rows.delete(element);untrack(row);}else {reorder();row.controls.render();updateRow(row);}}};
}
