// Dark base colors keep default white labels legible while distinguishing apps.
export const TILE_PALETTE=Object.freeze({
 characters:'#356099',inventory:'#77572A',relationships:'#96506D',saves:'#526079',
 scene:'#326B4D',journal:'#825A48',dice:'#6E4FA2',map:'#167271',status:'#85459C',
 organizations:'#776825',reply:'#A04722',information:'#286CA3',effects:'#A32959',
 worldbooks:'#4E6632',tts:'#824433',ai:'#445188',settings:'#565B63',linkage:'#2E6378',
});
const valid=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
const fields=[['backgroundColor','背景色','--amin-tile-custom-bg'],['textColor','文字色','--amin-tile-custom-text'],['iconColor','图标色','--amin-tile-custom-icon']];
export function applyTileColors(button,tile){
 button.style.setProperty('--amin-tile-base-color',TILE_PALETTE[tile.target]??'#445188');
 button.dataset.tilePalette='true';
 for(const [key,,variable]of fields){
  if(valid(tile[key]))button.style.setProperty(variable,tile[key]);
  else button.style.removeProperty(variable);
 }
 button.dataset.customBackground=String(valid(tile.backgroundColor));
}
export function createTileColorEditor({make,field,onChange}){
 const element=make('div','amin-tile-colors'),controls=[];
 let tile=null;
 for(const [key,label]of fields){
  const row=make('div','amin-tile-color-row'),enabled=make('input',''),picker=make('input','');
  enabled.type='checkbox';enabled.setAttribute('aria-label',`自定义${label}`);
  picker.type='color';picker.setAttribute('aria-label',`磁贴${label}`);
  row.append(field(`自定义${label}`,enabled),picker);element.append(row);
  enabled.onchange=()=>{if(tile)onChange({[key]:enabled.checked?picker.value:''});};
  picker.oninput=()=>{if(tile&&enabled.checked&&valid(picker.value))onChange({[key]:picker.value});};
  controls.push({key,enabled,picker});
 }
 const reset=make('button','','恢复默认配色');reset.type='button';
 reset.onclick=()=>{if(tile)onChange({backgroundColor:'',textColor:'',iconColor:''});};
 const hint=make('small','amin-tile-color-note','各项可独立设置；背景图片覆盖背景色，清空图片后显示背景色。');
 element.append(reset,hint);
 function sync(value){
  tile=value??null;
  for(const {key,enabled,picker}of controls){
   const custom=valid(tile?.[key]);enabled.checked=custom;enabled.disabled=!tile;
   picker.disabled=!tile||!custom;
   picker.value=custom?tile[key]:(key==='backgroundColor'?TILE_PALETTE[tile?.target]??'#445188':key==='iconColor'&&valid(tile?.textColor)?tile.textColor:'#FFFFFF');
  }
  reset.disabled=!tile||!fields.some(([key])=>valid(tile[key]));
 }
 sync(null);return {element,sync};
}
