import {mediaURL} from './desktop-effects-model.js';
import {SUITES,suiteOf} from './apps/suites/registry.js';
export const TILE_KEY='amin-os.tiles.v3';
export const PREVIOUS_TILE_KEY='amin-os.tiles.v2';
export const LEGACY_TILE_KEY='amin-os.tiles.v1';
export const TILE_COLUMNS=6;
export const TILE_MAX_ROWS=256;
const gridColumns=value=>value===4?4:6;
export function normalizeTileGrid(value){return {columns:gridColumns(value?.columns),scale:Number.isFinite(value?.scale)&&value.scale>=70&&value.scale<=100?Math.round(value.scale):100};}
export const TILE_SPANS=Object.freeze({small:{w:1,h:1},slimWide:{w:2,h:1},slimTall:{w:1,h:2},medium:{w:2,h:2},wide:{w:4,h:2},tall:{w:2,h:4},compactWide:{w:3,h:2},compactTall:{w:2,h:3}});
export const tileSpan=size=>TILE_SPANS[size]??TILE_SPANS.medium;
// Home entries: standalone apps plus one tile per suite (apps/suites/registry.js).
const tileDefaults=()=>[
 {id:'characters',target:'characters',label:'',size:'wide'},{id:'inventory',target:'inventory',label:'',size:'medium'},
 {id:'scene',target:'scene',label:'',size:'wide'},{id:'journal',target:'journal',label:'',size:'medium'},
 {id:'map',target:'map',label:'',size:'wide'},{id:'status',target:'status',label:'',size:'medium'},
 {id:'abilities',target:'abilities',label:'',size:'wide'},{id:'relationships',target:'relationships',label:'',size:'medium'},
 {id:'library',target:'library',label:'',size:'wide'},{id:'archive',target:'archive',label:'',size:'medium'},
 {id:'reply',target:'reply',label:'',size:'medium'},{id:'tts',target:'tts',label:'',size:'medium'},{id:'preferences',target:'preferences',label:'',size:'medium'},
 {id:'linkage',target:'linkage',label:'',size:'slimWide'},
];
// Home targets before 0.19.0, when every suite member had its own default tile.
const SEPARATE_TARGETS=Object.freeze(['characters','inventory','relationships','saves','scene','journal','dice','map','status','organizations','reply','information','effects','worldbooks','tts','ai','settings','linkage']);
// A tile may open a suite or any app inside one, so a custom 骰子 tile stays valid.
export const TILE_TARGETS=Object.freeze([...new Set([...tileDefaults().map(t=>t.target),...SUITES.flatMap(suite=>suite.members.map(m=>m.id))])]);
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
 const known=new Set(TILE_TARGETS),seen=new Set();
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
const area=size=>{const {w,h}=tileSpan(size);return w*h;};
const hasCell=t=>Number.isInteger(t.x)&&Number.isInteger(t.y);
/**
 * 0.19.0 layout migration: tiles of apps that now share a suite become one suite tile.
 * It takes the place of the group's first tile in reading order (or the next one whose
 * cell fits the grid width) and the largest size among them; custom image and colours
 * carry over. Other tiles are left untouched.
 */
export function groupSuiteTiles(value,columns=TILE_COLUMNS){
 const list=(Array.isArray(value)?value:[]).filter(t=>t&&typeof t==='object'),groups=new Map();
 for(const [index,t]of list.entries()){const suite=suiteOf(t.target);if(suite){if(!groups.has(suite.id))groups.set(suite.id,[]);groups.get(suite.id).push({t,index});}}
 if(!groups.size)return list.slice();
 const ids=new Set(list.filter(t=>!suiteOf(t.target)).map(t=>t.id)),merged=new Map();
 for(const [id,members]of groups){
  const ordered=[...members].sort((a,b)=>hasCell(a.t)&&hasCell(b.t)?a.t.y-b.t.y||a.t.x-b.t.x||a.index-b.index:hasCell(a.t)?-1:hasCell(b.t)?1:a.index-b.index);
  const anchor=ordered[0].t,sizes=ordered.map(({t})=>Object.hasOwn(TILE_SPANS,t.size)?t.size:'medium'),size=sizes.reduce((best,next)=>area(next)>area(best)?next:best);
  let tileId=id;while(ids.has(tileId))tileId+='-suite';ids.add(tileId);
  const cell=ordered.map(({t})=>t).find(t=>hasCell(t)&&t.x+tileSpan(size).w<=gridColumns(columns))??anchor;
  const tile={id:tileId,target:id,label:'',size};if(hasCell(cell)){tile.x=cell.x;tile.y=cell.y;}
  for(const key of ['image','backgroundColor','textColor','iconColor']){const source=ordered.find(({t})=>typeof t[key]==='string'&&t[key]);if(source)tile[key]=source.t[key];}
  merged.set(Math.min(...members.map(m=>m.index)),tile);
 }
 return list.flatMap((t,index)=>suiteOf(t.target)?(merged.has(index)?[merged.get(index)]:[]):[t]);
}
// Targets a layout already knew also cover the suite that now holds them.
const withSuites=targets=>[...new Set(targets.flatMap(id=>[id,suiteOf(id)?.id].filter(Boolean)))];
export function migrateTiles(value){
 const defaults=tileDefaults(),order=[],sizes=new Map();
 for(const t of Array.isArray(value)?value:[]){
  if(typeof t?.id!=='string')continue;const id=suiteOf(t.id)?.id??t.id,d=defaults.find(d=>d.id===id);if(!d)continue;
  const size=Object.hasOwn(TILE_SPANS,t.size)?t.size:d.size;
  if(!sizes.has(id)){order.push(id);sizes.set(id,size);}else if(area(size)>area(sizes.get(id)))sizes.set(id,size);
 }
 const result=order.map(id=>({...defaults.find(d=>d.id===id),size:sizes.get(id)}));
 return normalizeTiles(result.concat(defaults.filter(t=>!sizes.has(t.id))));
}
function readSaved(storage,key){try{const raw=storage.getItem(key);if(raw===null)return null;const data=JSON.parse(raw);return [2,3,4].includes(data?.version)&&Array.isArray(data.tiles)?data:null;}catch{return null;}}
export function loadTileGrid(storage){const data=readSaved(storage,TILE_KEY)??readSaved(storage,PREVIOUS_TILE_KEY);return normalizeTileGrid(data?.grid);}
export function loadTiles(storage){
 try{
  const data=readSaved(storage,TILE_KEY)??readSaved(storage,PREVIOUS_TILE_KEY);
  if(data){
   const grid=normalizeTileGrid(data.grid),grouped=data.version<4,introduced=['characters','inventory','relationships','saves','linkage'];
   const tiles=normalizeTiles(grouped?groupSuiteTiles(data.tiles,grid.columns):data.tiles,grid.columns);
   let known=Array.isArray(data.knownTargets)?data.knownTargets:SEPARATE_TARGETS.filter(id=>!introduced.includes(id));if(grouped)known=withSuites(known);
   const missing=tileDefaults().filter(t=>!known.includes(t.target)&&!tiles.some(item=>item.target===t.target));
   const ids=new Set(tiles.map(t=>t.id));for(const tile of missing){let id=tile.id;while(ids.has(id))id+='-new';ids.add(id);tiles.push(appendBelow(tiles,{...tile,id},grid.columns));}
   const normalized=normalizeTiles(tiles,grid.columns);try{saveTiles(storage,normalized,grid);}catch{}return normalized;
  }
  // Keep the older keys intact so a failed storage write never destroys the source layout.
  const legacy=storage.getItem(LEGACY_TILE_KEY);
  const tiles=legacy===null?defaultTiles():migrateTiles(JSON.parse(legacy));try{saveTiles(storage,tiles);}catch{}return tiles;
 }catch{return defaultTiles();}
}
export function saveTiles(storage,tiles,grid){const settings=grid===undefined?loadTileGrid(storage):normalizeTileGrid(grid);storage.setItem(TILE_KEY,JSON.stringify({version:4,knownTargets:tileDefaults().map(t=>t.target),grid:settings,tiles:normalizeTiles(tiles,settings.columns)}));}
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
