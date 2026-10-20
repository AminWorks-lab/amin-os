// The independent colour palettes (nexus, sakura, parchment, amethyst, mono) were removed in 0.19.0:
// world status follows the global --amin-* theme. A saved `theme` setting is ignored, not rejected.
export const STYLES = [
  {id:'paper',name:'古典书页',note:'小圆角 · 双线边框 · 衬线标题'},
  {id:'tech',name:'切角科技',note:'斜切卡片 · 细网格 · 高亮边线'},
  {id:'dossier',name:'角色档案',note:'直角 · 编号标题 · 装订边'},
  {id:'terminal',name:'终端面板',note:'直角线框 · 等宽字体 · 终端标记'},
  {id:'flat',name:'极简平面',note:'弱化边框 · 清爽留白 · 细分隔线'},
];
export const normalizeStyle = id => STYLES.some(s=>s.id===id)?id:'paper';
export function applyStyle(document,id){
  const style=normalizeStyle(id);document.documentElement.setAttribute('data-wsh-style',style);
  for(const frame of document.querySelectorAll('.wsh-dialog iframe')){try{frame.contentDocument?.documentElement?.setAttribute('data-wsh-style',style);}catch{}}
  return style;
}
export function createStylePicker({node,context,settingsKey,document}){
  const section=node('section',undefined,'wsh-style-section'),grid=node('div',undefined,'wsh-theme-grid'),buttons=[];
  section.append(node('h3','面板款式'),node('p','款式决定边框、底纹与排版，可与任意配色搭配。默认使用古典书页的小圆角。','wsh-note'));
  function select(id){for(const [button,key]of buttons)button.setAttribute('aria-pressed',String(id===key));}
  for(const style of STYLES){
    const button=node('button',undefined,'wsh-style-choice');button.type='button';button.setAttribute('data-wsh-style-preview',style.id);
    button.append(node('strong',style.name),node('span',style.note,'wsh-theme-note'));
    button.onclick=()=>{const ctx=context();ctx.extensionSettings[settingsKey]={...ctx.extensionSettings[settingsKey],panelStyle:style.id};applyStyle(document,style.id);select(style.id);ctx.saveSettingsDebounced();};
    grid.append(button);buttons.push([button,style.id]);
  }
  select(normalizeStyle(context().extensionSettings[settingsKey]?.panelStyle));section.append(grid);return section;
}
export function glassSettings(settings={}) {
  return {enabled:settings.glassEnabled===true,transparency:Number.isFinite(settings.glassTransparency)?Math.max(10,Math.min(80,settings.glassTransparency)):35};
}
export function applyGlass(document,settings){
  const glass=glassSettings(settings);
  function apply(doc){doc.documentElement.setAttribute('data-wsh-glass',glass.enabled?'on':'off');doc.documentElement.style.setProperty('--wsh-glass-opacity',(100-glass.transparency)+'%');}
  apply(document);for(const frame of document.querySelectorAll('.wsh-dialog iframe')){try{if(frame.contentDocument)apply(frame.contentDocument);}catch{}}
}
export function createGlassSettings({node,context,settingsKey,document}){
  const section=node('section'),title=node('h3','毛玻璃窗口'),label=node('label','启用半透明与背景模糊'),toggle=node('input'),rangeLabel=node('label','背景透明度'),range=node('input'),value=node('span');
  const initial=glassSettings(context().extensionSettings[settingsKey]);toggle.type='checkbox';toggle.checked=initial.enabled;range.type='range';range.min='10';range.max='80';range.step='5';range.value=initial.transparency;range.disabled=!initial.enabled;value.textContent=initial.transparency+'%';
  function save(){const ctx=context();const s={...ctx.extensionSettings[settingsKey],glassEnabled:toggle.checked,glassTransparency:Number(range.value)};ctx.extensionSettings[settingsKey]=s;range.disabled=!toggle.checked;value.textContent=range.value+'%';applyGlass(document,s);ctx.saveSettingsDebounced();}
  toggle.onchange=save;range.oninput=save;label.append(toggle);rangeLabel.append(range,value);section.append(title,label,rangeLabel,node('p','透明度越高，聊天背景越明显。文字保持清晰；关闭可恢复实心背景。','wsh-note'));return section;
}
