// Live tile summaries: a plain snapshot of current story data in, short tile text out.
// Pure and synchronous; tile-live-feed.js gathers the snapshot from the app services.
// Suite tiles show their most telling member: 能力与检定 shows the active effects.
export const LIVE_TARGETS=Object.freeze(['status','characters','scene','effects','journal','inventory','relationships','abilities']);
const SMALL_SIZES=new Set(['small','slimWide','slimTall']);
export const isSmallTile=size=>SMALL_SIZES.has(size);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clean=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
const pad=n=>String(n).padStart(2,'0');
/** 128 → "128", 12500 → "1.3万", 2.5 → "2.5". */
export function compactNumber(value){
 if(!Number.isFinite(value))return '';
 const abs=Math.abs(value);
 if(abs>=1e8)return +(value/1e8).toFixed(1)+'亿';
 if(abs>=1e4)return +(value/1e4).toFixed(1)+'万';
 return String(+value.toFixed(2));
}
const WORLD_FIELDS=Object.freeze({
 location:['地点','当前地点','位置','当前位置','所在地','所在位置','场所','location'],
 time:['时间','当前时间','游戏时间','时刻','日期','time'],
 weather:['天气','当前天气','气候','weather'],
});
/** First scalar world-state field named like a location, time or weather, searched project by project. */
export function worldFields(world){
 const result={location:'',time:'',weather:''};
 if(!object(world)||!object(world.项目))return result;
 const projects=Object.values(world.项目).filter(object);
 for(const [key,names]of Object.entries(WORLD_FIELDS))
  for(const name of names){
   const project=projects.find(p=>Object.hasOwn(p,name)&&clean(p[name]));
   if(project){result[key]=clean(project[name]);break;}
  }
 return result;
}
const HEALTH=/生命|血量|体力|^hp$|health/i;
function boundValue(world,binding){
 if(!object(world?.项目)||typeof binding!=='string')return undefined;
 const [project,field,...rest]=binding.split('.');if(rest.length||!project||!field)return undefined;
 const fields=world.项目[project];return object(fields)?fields[field]:undefined;
}
/** The PC's health stat, read through its world-state binding. */
export function pcHealth(character,world){
 for(const stat of Array.isArray(character?.stats)?character.stats:[]){
  if(!HEALTH.test(String(stat?.label??'').trim()))continue;
  const value=boundValue(world,stat.binding);
  if(object(value)&&Number.isFinite(value.当前)&&Number.isFinite(value.最大))return {label:stat.label,current:value.当前,max:value.最大};
  if(Number.isFinite(value))return {label:stat.label,current:value,max:null};
 }
 return null;
}
const pcOf=characters=>Array.isArray(characters)?characters.find(c=>c?.kind==='pc')??null:null;
const summary=(lines,short)=>{lines=lines.map(clean).filter(Boolean).slice(0,2);short=clean(short);return lines.length||short?{lines,short:short||lines[0]}:null;};

const summarize={
 status(s){
  const {location,time,weather}=worldFields(s.world);
  return summary([location,[time,weather].filter(Boolean).join(' · ')],weather||time||location);
 },
 characters(s){
  const pc=pcOf(s.characters);if(!pc||!clean(pc.name))return null;
  const health=pcHealth(pc,s.world),value=health?(health.max===null?compactNumber(health.current):`${compactNumber(health.current)}/${compactNumber(health.max)}`):'';
  return summary([pc.name,health?`${health.label} ${value}`:''],value||pc.name);
 },
 scene(s){
  const c=s.scene?.clock;if(!object(c)||![c.year,c.month,c.day,c.hour,c.minute].every(Number.isInteger))return null;
  const minutes=c.hour*60+c.minute,period=[...(Array.isArray(s.scene.periods)?s.scene.periods:[])].reverse().find(p=>Number.isFinite(p?.startMinute)&&p.startMinute<=minutes);
  const clock=`${pad(c.hour)}:${pad(c.minute)}`;
  return summary([`${clean(c.calendarLabel)?clean(c.calendarLabel)+' ':''}${c.year}-${pad(c.month)}-${pad(c.day)} ${clock}`,[period?.name,s.scene.sceneName].map(clean).filter(Boolean).join(' · ')],clock);
 },
 effects(s){
  if(!Array.isArray(s.effects))return null;
  const active=s.effects.filter(e=>!e?.paused).length,paused=s.effects.length-active;
  return summary([`${active} 个效果生效中`,paused?`${paused} 个已暂停`:''],String(active));
 },
 abilities(s){return summarize.effects(s);},
 journal(s){
  if(!Array.isArray(s.journal))return null;
  const tasks=s.journal.filter(e=>e?.kind==='task'),active=tasks.filter(t=>t.status==='active').length,waiting=tasks.filter(t=>t.status==='open').length;
  return summary([`${active} 项任务进行中`,waiting?`${waiting} 项待开始`:`共 ${s.journal.length} 条档案`],String(active));
 },
 inventory(s){
  const inv=s.inventory;if(!object(inv))return null;
  const items=Array.isArray(inv.items)?inv.items:[],balances=Array.isArray(inv.balances)?inv.balances:[];
  if(!items.length&&!balances.length)return null;
  const pc=pcOf(s.characters),own=list=>pc?list.filter(x=>x?.ownerId===pc.id):list;
  const balance=own(balances).find(b=>Number.isFinite(b?.amount)),count=own(items).reduce((n,i)=>n+(Number.isFinite(i?.quantity)?i.quantity:1),0);
  const money=balance?[clean(balance.name),compactNumber(balance.amount)+clean(balance.unit)].filter(Boolean).join(' '):'';
  return summary([money||`${count} 件物品`,money?`${count} 件物品`:''],balance?compactNumber(balance.amount):String(count));
 },
 relationships(s){
  const list=s.relationships?.relationships;if(!Array.isArray(list)||!list.length)return null;
  const people=new Set(list.flatMap(r=>[r?.fromId,r?.toId]).filter(Boolean)).size;
  return summary([`${list.length} 条关系`,people?`涉及 ${people} 位人物`:''],String(list.length));
 },
};
/** Snapshot → {target: {lines:[≤2 strings], short}}; targets without story data are omitted. */
export function summarizeTiles(snapshot){
 const result={};
 if(!object(snapshot)||!snapshot.chat)return result;
 for(const target of LIVE_TARGETS){
  try{const value=summarize[target](snapshot);if(value)result[target]=value;}catch{/* One app's damaged data hides only its own summary. */}
 }
 return result;
}
