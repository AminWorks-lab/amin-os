import { uuid } from './uuid.js';
import {installDesktopEffects} from './desktop-effects.js';
import {mediaURL} from './desktop-effects-model.js';
import {defaultTiles,loadTiles,loadTileGrid,saveTiles,normalizeTiles,moveTileToCell,canPlaceTile,tileSpan,TILE_MAX_ROWS} from './tile-layout.js';
import {createTileColorEditor,applyTileColors} from './tile-colors.js';

export function createTileDesktop({home,cards,apps,createIcon,openApp,onLayout}){
 const make=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e;};
 let grid=loadTileGrid(localStorage);
 let layout;try{layout=loadTiles(localStorage);}catch{layout=defaultTiles(grid.columns);}
 let editing=false,selected=layout[0]?.id??'',gesture=null,hold=null,preview=null,extraRows=4,suppress=false,suppressTimer=null,undo=null;
 const buttons=new Map();
 const top=make('div','amin-start-heading'),title=make('h2','','开始'),edit=make('button','amin-edit-tiles','编辑布局');
 edit.type='button';edit.setAttribute('aria-pressed','false');top.append(title,edit);home.prepend(top);
 const editor=make('div','amin-tile-editor');editor.hidden=true;
 const columns=make('select','');columns.setAttribute('aria-label','网格列数');for(const value of [4,6]){const o=make('option','',value+' 格宽');o.value=String(value);columns.append(o);}
 const scale=make('input','');scale.type='range';scale.min='70';scale.max='100';scale.step='5';scale.setAttribute('aria-label','磁贴整体大小');const scaleValue=make('output','amin-tile-scale-value');
 const choice=make('select','');choice.setAttribute('aria-label','选择磁贴');
 const sizes=make('select','');sizes.setAttribute('aria-label','磁贴尺寸');
 for(const [value,name]of [['small','小 · 1×1'],['slimWide','小横 · 2×1'],['slimTall','小竖 · 1×2'],['medium','中 · 2×2'],['compactWide','短宽 · 3×2'],['wide','宽 · 4×2'],['compactTall','短长 · 2×3'],['tall','长 · 2×4']]){const o=make('option','',name);o.value=value;sizes.append(o);}
 const target=make('select','');target.setAttribute('aria-label','磁贴打开的应用');
 const name=make('input','');name.type='text';name.maxLength=60;name.placeholder='留空使用应用名称';name.setAttribute('aria-label','磁贴名称');
 const image=make('input','');image.type='url';image.setAttribute('aria-label','磁贴背景图片地址');image.placeholder='留空跟随统一外观';
 const positionX=make('input',''),positionY=make('input','');for(const input of [positionX,positionY]){input.type='number';input.min='1';input.step='1';}positionX.max=String(grid.columns);positionY.max=String(TILE_MAX_ROWS);positionX.setAttribute('aria-label','磁贴左上角列');positionY.setAttribute('aria-label','磁贴左上角行');
 const up=make('button','','上移一格'),down=make('button','','下移一格'),left=make('button','','左移一格'),right=make('button','','右移一格'),add=make('button','','新增磁贴'),copy=make('button','','复制磁贴'),remove=make('button','','删除磁贴'),restore=make('button','','撤销删除'),extend=make('button','','增加空白行');
 for(const b of [up,down,left,right,add,copy,remove,restore,extend])b.type='button';
 const hint=make('p','amin-tile-hint','长按磁贴可调整布局');hint.setAttribute('role','status');
 const field=(text,control)=>{const label=make('label','amin-tile-field',text);label.append(control);return label;};
 const colors=createTileColorEditor({make,field,onChange:patch=>update(patch)});
 const scaleField=field('磁贴整体大小（70%–100%）',scale);scaleField.append(scaleValue);
 editor.append(field('网格宽度',columns),scaleField,field('选择磁贴',choice),field('打开应用',target),field('名称',name),field('尺寸',sizes),field('左上角列',positionX),field('左上角行',positionY),field('背景图片地址',image),colors.element,up,down,left,right,add,copy,remove,restore,extend);top.after(editor);home.append(hint);
 const catalog=make('details','amin-tile-catalog'),summary=make('summary','','所有应用'),all=make('div','amin-tile-editor');catalog.append(summary,all);home.append(catalog);
 for(const app of apps){const o=make('option','',app.name);o.value=app.id;target.append(o);const b=make('button','',app.name);b.type='button';b.onclick=()=>openApp(app.id);all.append(b);}
 catalog.ontoggle=()=>onLayout();
 const save=()=>{try{saveTiles(localStorage,layout,grid);hint.textContent='布局已保存';}catch{hint.textContent='本次布局已应用，浏览器未允许保存';}};
 const appFor=t=>apps.find(a=>a.id===t.target);
 const labelFor=t=>t.label.trim()||appFor(t).name;
 function syncSelection(){columns.value=String(grid.columns);scale.value=String(grid.scale);scaleValue.value=grid.scale+'%';scale.setAttribute('aria-valuetext',grid.scale+'%');positionX.max=String(grid.columns);const t=layout.find(t=>t.id===selected);choice.value=selected;sizes.value=t?.size??'medium';target.value=t?.target??apps[0].id;name.value=t?.label??'';image.value=t?.image??'';positionX.value=t?String(t.x+1):'';positionY.value=t?String(t.y+1):'';colors.sync(t);for(const e of [choice,sizes,target,name,image,positionX,positionY,copy,remove,up,down,left,right])e.disabled=!t;buttons.forEach((b,id)=>b.classList.toggle('is-selected',editing&&id===selected));restore.disabled=!undo;}
 function gridRows(){return Math.min(TILE_MAX_ROWS,Math.max(1,...layout.map(t=>t.y+tileSpan(t.size).h))+(editing?extraRows:0));}
 function measure(){const stage=cards.parentElement;if(stage?.classList.contains('amin-tile-stage')){stage.style.width=grid.scale+'%';stage.style.alignSelf='center';}cards.style.gridTemplateColumns=`repeat(${grid.columns},minmax(0,1fr))`;const width=cards.clientWidth,gap=parseFloat(getComputedStyle(cards).columnGap)||6;if(width>0){cards.style.setProperty('--amin-tile-unit',Math.max(1,(width-gap*(grid.columns-1))/grid.columns)+'px');}cards.style.gridTemplateRows=`repeat(${gridRows()},var(--amin-tile-unit))`;}
 function render(){
  if(!layout.some(t=>t.id===selected))selected=layout[0]?.id??'';
  for(const [id,b]of buttons)if(!layout.some(t=>t.id===id)){b.remove();buttons.delete(id);}
  choice.replaceChildren();
  for(const [i,t]of layout.entries()){const app=appFor(t),label=labelFor(t);let b=buttons.get(t.id);if(!b){b=make('button','amin-app-card');b.type='button';b.dataset.tile=t.id;buttons.set(t.id,b);}b.dataset.image=String(!!t.image);b.style.setProperty('--amin-tile-image',t.image?`url(${JSON.stringify(t.image)})`:'none');b.dataset.target=t.target;b.dataset.size=t.size;b.dataset.x=String(t.x);b.dataset.y=String(t.y);const span=tileSpan(t.size);b.style.gridColumn=`${t.x+1} / span ${span.w}`;b.style.gridRow=`${t.y+1} / span ${span.h}`;applyTileColors(b,t);b.setAttribute('aria-label',`打开${label}`);b.title=`${label} → ${app.name}`;const icon=make('span','amin-app-icon'),text=make('span','amin-card-copy');icon.append(createIcon(t.target));text.append(make('strong','',label));b.replaceChildren(icon,text);cards.append(b);const o=make('option','',`${i+1}. ${label}`);o.value=t.id;choice.append(o);}
  measure();syncSelection();onLayout();
 }
 function setEditing(value){clearGesture();editing=value;home.classList.toggle('amin-tiles-editing',value);editor.hidden=!value;edit.textContent=value?'完成':'编辑布局';edit.setAttribute('aria-pressed',String(value));hint.textContent=value?'小格是定位单位：落点作为左上角，绿色可放，红色被占用；方向键移动一格。':'长按磁贴可调整布局';measure();syncSelection();onLayout();}
 edit.onclick=()=>setEditing(!editing);
 columns.onchange=()=>{clearGesture();const next={...grid,columns:Number(columns.value)},reflowed=normalizeTiles(layout,next.columns);if(reflowed.length!==layout.length){syncSelection();hint.textContent='当前磁贴过多，较窄的网格无法全部容纳；已保留原布局。';return;}grid=next;layout=reflowed;undo=null;render();save();hint.textContent=`已切换为 ${grid.columns} 格宽，超出边界的磁贴已移入空位。`;};
 scale.oninput=()=>{clearGesture();grid={...grid,scale:Number(scale.value)};measure();syncSelection();onLayout();save();};
 choice.onchange=()=>{selected=choice.value;syncSelection();};
 const update=patch=>{const t=layout.find(t=>t.id===selected);if(!t)return;if(patch.size&&!canPlaceTile(layout,t.id,t.x,t.y,patch.size,grid.columns)){syncSelection();hint.textContent='这个尺寸会越界或覆盖其他磁贴，请先移到足够大的空位。';return;}layout=normalizeTiles(layout.map(t=>t.id===selected?{...t,...patch}:t),grid.columns);render();save();};
 image.onchange=()=>{try{update({image:mediaURL(image.value)});}catch(e){hint.textContent=e.message;}};
 sizes.onchange=()=>update({size:sizes.value});target.onchange=()=>update({target:target.value});name.oninput=()=>{const start=name.selectionStart,end=name.selectionEnd;update({label:name.value});name.setSelectionRange(start,end);};
 add.onclick=()=>{clearGesture();const t={id:uuid(),target:target.value||apps[0].id,label:'',size:'medium'};layout=normalizeTiles([...layout,t],grid.columns);selected=t.id;render();save();name.focus();};
 copy.onclick=()=>{const t=layout.find(t=>t.id===selected);if(!t)return;const clone={...t,id:uuid()};delete clone.x;delete clone.y;layout=normalizeTiles([...layout,clone],grid.columns);selected=clone.id;render();save();};
 remove.onclick=()=>{const i=layout.findIndex(t=>t.id===selected);if(i<0)return;clearGesture();undo={tile:layout[i],index:i};layout.splice(i,1);selected=layout[Math.min(i,layout.length-1)]?.id??'';render();save();};
 restore.onclick=()=>{if(!undo)return;const restored={...undo.tile};if(!canPlaceTile(layout,restored.id,restored.x,restored.y,restored.size,grid.columns)){delete restored.x;delete restored.y;}layout.splice(Math.min(undo.index,layout.length),0,restored);layout=normalizeTiles(layout,grid.columns);selected=undo.tile.id;undo=null;render();save();};
 function move(id,x,y){const result=moveTileToCell(layout,id,x,y,grid.columns);if(!result.success){hint.textContent=result.reason==='occupied'?'该区域已有磁贴，请选择空位。':'磁贴超出网格边界，请选择能容纳整个磁贴的位置。';syncSelection();return false;}layout=result.tiles;render();save();return true;}
 function step(dx,dy){const t=layout.find(t=>t.id===selected);if(t)move(t.id,t.x+dx,t.y+dy);}
 up.onclick=()=>step(0,-1);down.onclick=()=>step(0,1);left.onclick=()=>step(-1,0);right.onclick=()=>step(1,0);
 positionX.onchange=positionY.onchange=()=>move(selected,Number(positionX.value)-1,Number(positionY.value)-1);
 extend.onclick=()=>{extraRows=Math.min(TILE_MAX_ROWS,extraRows+4);measure();onLayout();hint.textContent='已增加空白网格，可向下滚动放置磁贴。';};
 function blockClick(){suppress=true;clearTimeout(suppressTimer);suppressTimer=setTimeout(()=>{suppress=false;},500);}
 function clearGesture(){clearTimeout(hold);hold=null;preview?.remove();preview=null;buttons.forEach(b=>b.classList.remove('is-dragging'));gesture=null;}
 function previewAt(x,y){if(!gesture)return;const t=layout.find(t=>t.id===gesture.tile);if(!t)return;const r=cards.getBoundingClientRect(),gap=parseFloat(getComputedStyle(cards).columnGap)||6,unit=parseFloat(cards.style.getPropertyValue('--amin-tile-unit')),pitch=unit+gap,span=tileSpan(t.size);const gx=Math.floor((x-r.left)/pitch),gy=Math.floor((y-r.top)/pitch);gesture.cell={x:gx,y:gy};const valid=x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom&&canPlaceTile(layout,t.id,gx,gy,undefined,grid.columns);gesture.valid=valid;
  if(!preview){preview=make('div','amin-tile-drop-preview');preview.setAttribute('aria-hidden','true');cards.append(preview);}preview.dataset.valid=String(valid);Object.assign(preview.style,{left:gx*pitch+'px',top:gy*pitch+'px',width:span.w*unit+(span.w-1)*gap+'px',height:span.h*unit+(span.h-1)*gap+'px'});const message=`${valid?'放置':'不可放置'} · 第 ${gy+1} 行，第 ${gx+1} 列 · ${span.w}×${span.h}`;preview.textContent=span.w===1&&span.h===1?(valid?'1×1':'×'):message;if(hint.textContent!==message)hint.textContent=message;
 }
 cards.addEventListener('click',e=>{const b=e.target.closest('[data-tile]');if(!b)return;if(suppress){suppress=false;e.preventDefault();return;}if(editing){selected=b.dataset.tile;syncSelection();}else openApp(layout.find(t=>t.id===b.dataset.tile)?.target);});
 cards.addEventListener('contextmenu',e=>e.preventDefault());
 cards.addEventListener('pointerdown',e=>{
  const b=e.target.closest('[data-tile]');if(!b||b.disabled||!e.isPrimary||e.button!==0)return;
  suppress=false;gesture={id:e.pointerId,tile:b.dataset.tile,x:e.clientX,y:e.clientY,moved:false,drag:editing,cell:null,valid:false};
  if(editing){selected=b.dataset.tile;syncSelection();cards.setPointerCapture(e.pointerId);e.preventDefault();}
  else hold=setTimeout(()=>{if(!gesture)return;selected=b.dataset.tile;setEditing(true);blockClick();hint.textContent='已进入网格编辑，松手后拖动磁贴。';},450);
 });
 cards.addEventListener('pointermove',e=>{
  if(!gesture||gesture.id!==e.pointerId)return;
  if(Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)<7&&!gesture.moved)return;
  clearTimeout(hold);hold=null;if(!gesture.drag){clearGesture();return;}
  gesture.moved=true;blockClick();e.preventDefault();buttons.get(gesture.tile)?.classList.add('is-dragging');
  const r=home.getBoundingClientRect();if(e.clientY>r.bottom-40)home.scrollTop+=12;else if(e.clientY<r.top+40)home.scrollTop-=12;
  previewAt(e.clientX,e.clientY);
 });
 cards.addEventListener('pointerup',e=>{if(gesture?.id!==e.pointerId)return;const g=gesture;clearGesture();if(g.moved&&g.cell){if(g.valid)move(g.tile,g.cell.x,g.cell.y);else hint.textContent='落点被占用或超出边界，磁贴保留原位。';}if(cards.hasPointerCapture(e.pointerId))cards.releasePointerCapture(e.pointerId);});
 cards.addEventListener('pointercancel',()=>{blockClick();clearGesture();});
 cards.addEventListener('lostpointercapture',clearGesture);
 cards.addEventListener('keydown',e=>{if(!editing)return;const b=e.target.closest('[data-tile]');if(!b)return;selected=b.dataset.tile;const offsets={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(offsets[e.key]){e.preventDefault();step(...offsets[e.key]);buttons.get(selected)?.focus();}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setEditing(false);edit.focus();}});
 home.addEventListener('keydown',e=>{if(e.key==='Escape'&&gesture){e.preventDefault();e.stopPropagation();blockClick();clearGesture();}});
 const observer=new ResizeObserver(()=>{measure();onLayout();});observer.observe(cards);
 window.addEventListener('amin-os:reset-tiles',()=>{clearGesture();suppress=false;grid=loadTileGrid(localStorage);layout=loadTiles(localStorage);undo=null;selected=layout[0]?.id??'';render();save();});
 window.addEventListener('blur',clearGesture);
 installDesktopEffects(home,cards);render();
 return {leave(){clearGesture();setEditing(false);}};
}
