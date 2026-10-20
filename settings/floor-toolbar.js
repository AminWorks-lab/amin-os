import {getAppearance,FLOOR_BUTTON_ORDER as DEFAULT_ORDER} from './appearance.js';

export function moveFloorButton(order,id,target,after=false){
 if(id===target||!order.includes(id)||!order.includes(target))return [...order];
 const next=order.filter(x=>x!==id);next.splice(next.indexOf(target)+(after?1:0),0,id);return next;
}

export function placeFloorButtons(parent,buttons,before=null){
 let anchor=before;
 for(let index=buttons.length-1;index>=0;index--){const button=buttons[index];if(button.parentNode!==parent||button.nextSibling!==anchor)parent.insertBefore(button,anchor);anchor=button;}
}

// Only button nodes move. The hosts below this toolbar may contain live iframes.
export function createFloorToolbar(row,document){
 const toolbar=row.toolbar;
 if(!toolbar.addEventListener)return {render(){for(const item of [...row.items].sort((a,b)=>DEFAULT_ORDER.indexOf(a.id)-DEFAULT_ORDER.indexOf(b.id)))toolbar.append(item.button);},dispose(){}};
 const more=document.createElement('button'),edit=document.createElement('button'),overflow=document.createElement('div'),hint=document.createElement('span');
 more.type=edit.type='button';more.className='amin-floor-toolbar-more';more.textContent='更多';more.setAttribute('aria-expanded','false');
 edit.className='amin-floor-toolbar-edit';edit.textContent='调整排列';edit.setAttribute('aria-pressed','false');
 overflow.className='amin-floor-toolbar-overflow';overflow.setAttribute('role','group');overflow.setAttribute('aria-label','更多楼层应用');overflow.hidden=true;
 hint.className='amin-floor-toolbar-hint';hint.setAttribute('role','status');hint.hidden=true;
 toolbar.append(more,overflow,hint);overflow.append(edit);
 let editing=false,expanded=false,gesture=null,suppressClick=false,suppressTimer=null,keyOff=null;
 const gestureOff=[];
 const listeners=[];
 function listen(node,type,fn,options){node.addEventListener(type,fn,options);listeners.push(()=>node.removeEventListener(type,fn,options));}
 function state(){return getAppearance()?.snapshot().floor??{};}
 function order(){return [...new Set([...(state().buttonOrder??DEFAULT_ORDER),...DEFAULT_ORDER,...[...row.items].map(x=>x.id)])];}
 function appButton(target){const button=target?.closest?.('[data-floor-app]');return [...row.items].some(x=>x.button===button)?button:null;}
 function render(){
  const prefs=state(),ids=order(),hidden=new Set(prefs.moreButtons??[]),items=[...row.items].sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id));
  if(toolbar.dataset.toolbarAlignment!==(prefs.toolbarAlignment??'left'))toolbar.dataset.toolbarAlignment=prefs.toolbarAlignment??'left';if(toolbar.dataset.editing!==String(editing))toolbar.dataset.editing=String(editing);
  // “调整排列” lives at the end of the expanded overflow; while editing it stays in the row as “完成排列”.
  if(editing){if(edit.parentNode!==toolbar||edit.nextSibling!==hint)toolbar.insertBefore(edit,hint);}else if(edit.parentNode!==overflow||edit.nextSibling)overflow.append(edit);
  placeFloorButtons(toolbar,items.filter(item=>editing||!hidden.has(item.id)).map(item=>item.button),more);
  placeFloorButtons(overflow,items.filter(item=>!editing&&hidden.has(item.id)).map(item=>item.button),editing?null:edit);
  const hasMore=items.some(x=>hidden.has(x.id)&&(x.shown??x.visible));more.hidden=editing;overflow.hidden=editing||!expanded;const moreLabel=hasMore?'更多':'⋯';if(more.textContent!==moreLabel){more.textContent=moreLabel;more.title=hasMore?'更多楼层应用与排列':'调整排列';}
  if(more.getAttribute('aria-expanded')!==String(!overflow.hidden))more.setAttribute('aria-expanded',String(!overflow.hidden));if(edit.getAttribute('aria-pressed')!==String(editing))edit.setAttribute('aria-pressed',String(editing));const label=editing?'完成排列':'调整排列';if(edit.textContent!==label)edit.textContent=label;hint.hidden=!editing;
  if(editing&&!hint.textContent)hint.textContent='拖动按钮调整顺序；也可聚焦按钮后按 Alt + 方向键。';
 }
 function cancel(){if(gesture?.dragging)suppress();gestureOff.splice(0).forEach(off=>off());if(gesture?.timer)clearTimeout(gesture.timer);gesture=null;for(const item of row.items){delete item.button.dataset.dragging;delete item.button.dataset.drop;}}
 function setEditing(value){cancel();keyOff?.();keyOff=null;editing=value;if(editing){const escape=event=>{if(event.key==='Escape')setEditing(false);};document.addEventListener('keydown',escape);keyOff=()=>document.removeEventListener('keydown',escape);}render();}
 function save(next){const appearance=getAppearance();if(!appearance)return;const fresh=appearance.snapshot();fresh.floor.buttonOrder=next;appearance.save(fresh);}
 function saveMove(id,target,after){try{save(moveFloorButton(order(),id,target,after));render();hint.textContent='排列已保存，所有楼层同步。';}catch(error){hint.hidden=false;hint.textContent=`保存失败：${error.message}`;}}
 function suppress(){suppressClick=true;clearTimeout(suppressTimer);suppressTimer=setTimeout(()=>{suppressClick=false;},500);}
 listen(more,'click',()=>{expanded=!expanded;render();});listen(edit,'click',()=>setEditing(!editing));
 listen(toolbar,'click',event=>{if(event.isTrusted&&appButton(event.target)&&(editing||suppressClick)){event.preventDefault();event.stopImmediatePropagation();}},true);
 listen(toolbar,'keydown',event=>{
  if(event.key==='Escape'){setEditing(false);return;}
  const button=appButton(event.target);if(!editing||!button||!event.altKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
  event.preventDefault();const ids=order().filter(id=>[...row.items].some(item=>item.id===id&&(item.shown??item.visible))),index=ids.indexOf(button.dataset.floorApp),after=['ArrowRight','ArrowDown'].includes(event.key),target=ids[index+(after?1:-1)];if(target)saveMove(button.dataset.floorApp,target,after);button.focus();
 });
 listen(toolbar,'pointerdown',event=>{
  const button=appButton(event.target);if(!button||event.button!==0||event.isPrimary===false)return;cancel();
  const current={button,id:button.dataset.floorApp,pointerId:event.pointerId,x:event.clientX,y:event.clientY,dragging:false,target:null};gesture=current;bindGesture();
  if(!editing&&event.pointerType==='touch')current.timer=setTimeout(()=>{if(gesture!==current)return;suppress();setEditing(true);hint.textContent='已进入调整模式，松手后拖动按钮。';},500);
  if(editing)event.preventDefault();
 });
 function bindGesture(){
 const bind=(type,fn,options)=>{document.addEventListener(type,fn,options);gestureOff.push(()=>document.removeEventListener(type,fn,options));};
 bind('pointermove',event=>{
  const current=gesture;if(!current||event.pointerId!==current.pointerId)return;
  const distance=Math.hypot(event.clientX-current.x,event.clientY-current.y);
  if(!editing){if(distance>8)cancel();return;}
  if(!current.dragging&&distance<5)return;
  event.preventDefault();current.dragging=true;current.button.dataset.dragging='true';
  const target=appButton(document.elementFromPoint(event.clientX,event.clientY));for(const item of row.items)delete item.button.dataset.drop;
  current.target=null;if(!target||target===current.button||target.hidden)return;
  const rect=target.getBoundingClientRect();current.after=event.clientX>rect.left+rect.width/2;current.target=target.dataset.floorApp;target.dataset.drop=current.after?'after':'before';
 },{passive:false});
 bind('pointerup',event=>{const current=gesture;if(!current||event.pointerId!==current.pointerId)return;if(current.dragging){suppress();if(current.target)saveMove(current.id,current.target,current.after);}cancel();});
 bind('pointercancel',()=>cancel());
 }
 return {render,dispose(){cancel();keyOff?.();clearTimeout(suppressTimer);listeners.forEach(off=>off());more.remove();edit.remove();overflow.remove();hint.remove();}};
}
