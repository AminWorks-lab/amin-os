import {mediaURL} from './desktop-effects-model.js';
export const TILE_KEY='amin-os.tiles.v3';
export const PREVIOUS_TILE_KEY='amin-os.tiles.v2';
export const LEGACY_TILE_KEY='amin-os.tiles.v1';
export const TILE_COLUMNS=6;
export const TILE_MAX_ROWS=256;
const gridColumns=value=>value===4?4:6;
export function normalizeTileGrid(value){return {columns:gridColumns(value?.columns),scale:Number.isFinite(value?.scale)&&value.scale>=70&&value.scale<=100?Math.round(value.scale):100};}
export const TILE_SPANS=Object.freeze({small:{w:1,h:1},slimWide:{w:2,h:1},slimTall:{w:1,h:2},medium:{w:2,h:2},wide:{w:4,h:2},tall:{w:2,h:4},compactWide:{w:3,h:2},compactTall:{w:2,h:3}});
export const tileSpan=size=>TILE_SPANS[size]??TILE_SPANS.medium;
const tileDefaults=()=>[
 {id:'characters',target:'characters',label:'',size:'wide'},{id:'inventory',target:'inventory',label:'',size:'medium'},
 {id:'relationships',target:'relationships',label:'',size:'medium'},{id:'saves',target:'saves',label:'',size:'medium'},
 {id:'scene',target:'scene',label:'',size:'wide'},{id:'journal',target:'journal',label:'',size:'medium'},
 {id:'dice',target:'dice',label:'',size:'medium'},
 {id:'map',target:'map',label:'',size:'wide'},{id:'status',target:'status',label:'',size:'medium'},{id:'organizations',target:'organizations',label:'',size:'wide'},{id:'reply',target:'reply',label:'',size:'medium'},
 {id:'information',target:'information',label:'',size:'wide'},{id:'effects',target:'effects',label:'',size:'wide'},{id:'worldbooks',target:'worldbooks',label:'',size:'medium'},{id:'tts',target:'tts',label:'',size:'medium'},{id:'ai',target:'ai',label:'',size:'small'},{id:'settings',target:'settings',label:'',size:'small'},
 {id:'linkage',target:'linkage',label:'',size:'slimWide'},
];
export const defaultTiles=(columns=TILE_COLUMNS)=>normalizeTiles(tileDefaults(),columns);
const validCell=(x,y,size,columns=TILE_COLUMNS)=>{const {w,h}=tileSpan(size);return Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x+w<=gridColumns(columns)&&y+h<=TILE_MAX_ROWS;};
const overlaps=(a,b)=>{const sa=tileSpan(a.size),sb=tileSpan(b.size);return a.x<b.x+sb.w&&a.x+sa.w>b.x&&a.y<b.y+sb.h&&a.y+sa.h>b.y;};
export function canPlaceTile(tiles,id,x,y,size,columns=TILE_COLUMNS){
 const source=tiles.find(t=>t.id===id);if(!source&&!size)return false;
 const candidate={...source,id,x,y,size:size??source.size};
 return validCell(x,y,candidate.size,columns)&&!tiles.some(t=>t.id!==id&&overlaps(candidate,t));
}
export function normalizeTiles(value,columns=TILE_COLUMNS){
 columns=gridColumns(columns);
 if(!Array.isArray(value))value=tileDefaults();
 const known=new Set(tileDefaults().map(t=>t.target)),seen=new Set();
 const cleaned=value.flatMap(t=>{
  if(typeof t?.id!=='string'||!t.id||seen.has(t.id)||!known.has(t.target))return [];
  seen.add(t.id);let image='';try{image=mediaURL(t.image);}catch{}
  const colors={};for(const key of ['backgroundColor','textColor','iconColor'])if(typeof t[key]==='string'&&/^#[0-9a-f]{6}$/i.test(t[key]))colors[key]=t[key];
  return [{...(image?{image}:{}),...colors,id:t.id,target:t.target,label:typeof t.label==='string'?t.label.slice(0,60):'',size:Object.hasOwn(TILE_SPANS,t.size)?t.size:'medium',x:t.x,y:t.y}];
 });
 // Reserve valid explicit cells first, so newly added tiles cannot move existing ones.
 const placed=[],pending=[];
 for(const tile of cleaned){if(validCell(tile.x,tile.y,tile.size,columns)&&!placed.some(other=>overlaps(tile,other)))placed.push(tile);else pending.push(tile);}
 for(const tile of pending){
  let found=false;
  for(let y=0;y<TILE_MAX_ROWS&&!found;y++)for(let x=0;x<columns&&!found;x++)if(canPlaceTile(placed,tile.id,x,y,tile.size,columns)){tile.x=x;tile.y=y;placed.push(tile);found=true;}
 }
 const included=new Set(placed.map(t=>t.id));return cleaned.filter(t=>included.has(t.id));
}
// New applications join a saved layout below its last row instead of filling an earlier gap.
export function appendBelow(tiles,tile,columns=TILE_COLUMNS){
 columns=gridColumns(columns);const placed=normalizeTiles(tiles,columns),bottom=Math.max(0,...placed.map(t=>t.y+tileSpan(t.size).h));
 for(let y=bottom;y<TILE_MAX_ROWS;y++)for(let x=0;x<columns;x++)if(canPlaceTile(placed,tile.id,x,y,tile.size,columns))return {...tile,x,y};
 return {...tile};
}
export function migrateTiles(value){
 const defaults=tileDefaults(),seen=new Set(),result=[];
 for(const t of Array.isArray(value)?value:[]){const d=defaults.find(d=>d.id===t?.id);if(!d||seen.has(t.id))continue;seen.add(t.id);result.push({...d,size:Object.hasOwn(TILE_SPANS,t.size)?t.size:d.size});}
 return normalizeTiles(result.concat(defaults.filter(t=>!seen.has(t.id))));
}
function readSaved(storage,key){try{const raw=storage.getItem(key);if(raw===null)return null;const data=JSON.parse(raw);return (data?.version===2||data?.version===3)&&Array.isArray(data.tiles)?data:null;}catch{return null;}}
export function loadTileGrid(storage){const data=readSaved(storage,TILE_KEY)??readSaved(storage,PREVIOUS_TILE_KEY);return normalizeTileGrid(data?.grid);}
export function loadTiles(storage){
 try{
  const data=readSaved(storage,TILE_KEY)??readSaved(storage,PREVIOUS_TILE_KEY);
  if(data){
   const grid=normalizeTileGrid(data.grid),tiles=normalizeTiles(data.tiles,grid.columns),introduced=['characters','inventory','relationships','saves','linkage'];
   const known=Array.isArray(data.knownTargets)?data.knownTargets:tileDefaults().map(t=>t.target).filter(id=>!introduced.includes(id));
   const missing=tileDefaults().filter(t=>!known.includes(t.target)&&!tiles.some(item=>item.target===t.target));
   const ids=new Set(tiles.map(t=>t.id));for(const tile of missing){let id=tile.id;while(ids.has(id))id+='-new';ids.add(id);tiles.push(appendBelow(tiles,{...tile,id},grid.columns));}
   const normalized=normalizeTiles(tiles,grid.columns);try{saveTiles(storage,normalized,grid);}catch{}return normalized;
  }
  // Keep the older keys intact so a failed storage write never destroys the source layout.
  const legacy=storage.getItem(LEGACY_TILE_KEY);
  const tiles=legacy===null?defaultTiles():migrateTiles(JSON.parse(legacy));try{saveTiles(storage,tiles);}catch{}return tiles;
 }catch{return defaultTiles();}
}
export function saveTiles(storage,tiles,grid){const settings=grid===undefined?loadTileGrid(storage):normalizeTileGrid(grid);storage.setItem(TILE_KEY,JSON.stringify({version:3,knownTargets:tileDefaults().map(t=>t.target),grid:settings,tiles:normalizeTiles(tiles,settings.columns)}));}
export function saveTileGrid(storage,grid){saveTiles(storage,loadTiles(storage),grid);}
export function moveTileToCell(tiles,id,x,y,columns=TILE_COLUMNS){
 const list=normalizeTiles(tiles,columns),source=list.find(t=>t.id===id);
 if(!source)return {success:false,tiles:list,reason:'missing'};
 if(!validCell(x,y,source.size,columns))return {success:false,tiles:list,reason:'bounds'};
 if(!canPlaceTile(list,id,x,y,undefined,columns))return {success:false,tiles:list,reason:'occupied'};
 return {success:true,tiles:list.map(t=>t.id===id?{...t,x,y}:t),reason:''};
}
export function moveTile(tiles,id,target,after=false){
 const list=normalizeTiles(tiles),source=list.find(t=>t.id===id);if(!source||id===target)return list;
 const rest=list.filter(t=>t.id!==id),index=rest.findIndex(t=>t.id===target);if(index<0)return list;rest.splice(index+(after?1:0),0,source);return rest;
}
export function resetTileLayout(){try{saveTiles(localStorage,defaultTiles(loadTileGrid(localStorage).columns));}catch{}window.dispatchEvent(new Event('amin-os:reset-tiles'));}
