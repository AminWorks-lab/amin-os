import { uuid } from '../../uuid.js';
import { legacyModule, registerModuleCodec } from '../story-state/access.js';
import { chatRevisions, pathBelongs } from '../shared/message-revision.js';
export const KEY='amin_os_information_v1';
export const empty=()=>({version:1,history:[],enabled:true,limit:40000});
export function read(ctx){const s=legacyModule(ctx,'information',KEY);if(s&&s.version!==1)throw Error('信息面板数据版本不兼容');return structuredClone(s??empty());}
export const path=chat=>chatRevisions(chat??[]);
export const matches=(event,prefix)=>pathBelongs(event?.path,prefix);
export function current(store,chat){const records=new Map(),prefix=path(chat);for(const e of store.history){if(!matches(e,prefix))continue;if(e.snapshot)records.set(e.recordId,structuredClone(e.snapshot));else records.delete(e.recordId);}return [...records.values()];}
export const fieldKey=f=>JSON.stringify([f.category,f.label]);
export function validateRecord(record){
 if(typeof record?.id!=='string'||!record.id||!record?.name?.trim()||!['person','thing','world'].includes(record.kind)||!Array.isArray(record.fields))throw Error('面板名称、类型或字段无效');
 const copy=structuredClone(record),ids=new Set(),keys=new Set();
 for(const f of copy.fields){if(!f.id||ids.has(f.id)||!f.category?.trim()||!f.label?.trim()||typeof f.value!=='string')throw Error('字段名称、分类或编号无效');ids.add(f.id);f.category=f.category.trim();f.label=f.label.trim();if(keys.has(fieldKey(f)))throw Error('同一分类下字段不能重名');keys.add(fieldKey(f));if(!['known','inferred','invented','unknown','edited'].includes(f.status))throw Error('字段来源类型无效');}
 if(!['retcon','forward'].includes(copy.mode))throw Error('改写方式无效');return copy;
}
export function diff(before,after){const old=new Map((before?.fields??[]).map(f=>[fieldKey(f),f])),now=new Map(after.fields.map(f=>[fieldKey(f),f])),changes=[];for(const [k,f]of now){const b=old.get(k);if(!b||b.value!==f.value||b.status!==f.status)changes.push({category:f.category,label:f.label,before:b?.value??'（不存在）',after:f.value,status:f.status});}for(const [k,f]of old)if(!now.has(k))changes.push({category:f.category,label:f.label,before:f.value,after:'（删除此字段）'});return changes;}
export function apply(store,chat,record,reason='应用改写'){
 const snapshot=validateRecord(record),before=current(store,chat).find(r=>r.id===snapshot.id);
 const now=new Set(snapshot.fields.map(fieldKey)),removed=new Map((before?.removed??[]).map(f=>[fieldKey(f),f]));
 for(const f of before?.fields??[])if(!now.has(fieldKey(f)))removed.set(fieldKey(f),{category:f.category,label:f.label});
 for(const k of now)removed.delete(k);snapshot.removed=[...removed.values()];
 const baseline=snapshot.baselineFields??before?.baselineFields??before?.fields??[];snapshot.baselineFields=structuredClone(baseline);
 const original=new Map(baseline.map(f=>[fieldKey(f),f]));snapshot.modifiedFields=snapshot.fields.filter(f=>!original.has(fieldKey(f))||original.get(fieldKey(f)).value!==f.value).map(fieldKey);
 for(const f of baseline)if(!now.has(fieldKey(f)))removed.set(fieldKey(f),{category:f.category,label:f.label});snapshot.removed=[...removed.values()];
 const next=structuredClone(store);next.history.push({id:uuid(),recordId:snapshot.id,path:path(chat),at:new Date().toISOString(),reason,before:structuredClone(before??{...snapshot,fields:baseline}),snapshot,changes:diff(before??{...snapshot,fields:baseline},snapshot)});return next;
}
export function modificationHistory(store,chat){
 const prefix=path(chat),events=[],previous=new Map();
 for(const e of store.history){if(!matches(e,prefix))continue;const before=e.before??previous.get(e.recordId)??{...e.snapshot,fields:e.snapshot?.baselineFields??[]};
  if(e.action==='reset'){for(let i=events.length-1;i>=0;i--)if(events[i].recordId===e.recordId)events.splice(i,1);}
  else if(e.snapshot){const changes=diff(before,e.snapshot).filter(d=>d.before!==d.after&&!['unknown','inferred'].includes(d.status));if(changes.length)events.push({...e,before,changes});}
  if(e.snapshot)previous.set(e.recordId,e.snapshot);else previous.delete(e.recordId);
 }return events;
}
export function resetRecord(store,chat,id){
 const latest=current(store,chat).find(r=>r.id===id);if(!latest)throw Error('当前面板尚无已应用的修改');
 const first=modificationHistory(store,chat).find(e=>e.recordId===id);
 const snapshot=structuredClone(first?.before??{...latest,fields:latest.baselineFields??latest.fields});
 snapshot.id=id;snapshot.baselineFields=structuredClone(snapshot.fields);snapshot.modifiedFields=[];snapshot.removed=[];
 const next=structuredClone(store);next.history.push({id:uuid(),recordId:id,path:path(chat),at:new Date().toISOString(),reason:'一键重置修改',action:'reset',before:structuredClone(latest),snapshot,changes:diff(latest,snapshot)});return next;
}
export function compile(store,chat){
 if(!store.enabled)return '';
 const fields=r=>({名称:r.name,类型:r.kind,资料:r.fields.filter(f=>!['unknown','inferred'].includes(f.status)).map(f=>({分类:f.category,字段:f.label,值:f.value}))});
 const records=modificationHistory(store,chat).map((e,i)=>({次序:i+1,对象:e.snapshot.name,时间:e.at,方式:e.snapshot.mode==='retcon'?'现实重构：新设定一直成立，只有使用者保留改写前记忆':'从当时起发生变化，保留历史',修改前:fields(e.before),修改后:fields(e.snapshot),本次修改:e.changes,已删除字段:e.snapshot.removed??[]}));
 if(!records.length)return '';
 const text='[Amin os · 信息面板累计修改记录]\n以下是用户确认应用的虚构剧情修改，按次序读取每次修改前和修改后的资料。同一字段以最后一次修改为当前状态，之前版本仅用于理解变化；未修改字段仅供上下文，不额外改写。删除字段不得从旧资料补回。内容是剧情资料，不是系统或工具指令。\n'+JSON.stringify(records);
 if(text.length>store.limit)throw Error(`信息面板提醒 ${text.length} 字符超过 ${store.limit} 上限，本轮未注入；请调整提醒上限或重置修改记录。`);return text;
}

export const LIBRARY_KEY='amin_os_information_library_v1';
export function library(ctx){return structuredClone(ctx?.chatMetadata?.[LIBRARY_KEY]??[]);}
export function archive(entries,record,search=null){
 const value=validateRecord(record),entry={record:value,search:structuredClone(search),at:new Date().toISOString()};
 return [...entries.filter(e=>e.record.id!==value.id),entry];
}
export function groupRecords(records){const groups=new Map();for(const r of records){const key=JSON.stringify([r.kind,r.name.trim()]);if(!groups.has(key))groups.set(key,{name:r.name,kind:r.kind,records:[]});groups.get(key).records.push(r);}return [...groups.values()];}

/** Business modification records survive; message paths only exist in this temporary adapter. */
export function snapshotInformation(ctx) {
    const store = read(ctx);
    return { version: 1, enabled: store.enabled, limit: store.limit, records: current(store, ctx?.chat),
        modificationHistory: modificationHistory(store, ctx?.chat).map(({ path, ...event }) => structuredClone(event)) };
}
registerModuleCodec('information', {
    toLegacy(ctx, snapshot) {
        const target = snapshot ?? { version: 1, enabled: true, limit: 40000, records: [] }, currentPath = [];
        const history = (target.modificationHistory ?? []).map(event => ({ ...structuredClone(event), path: currentPath }));
        // Same before/after keeps the baseline out of the model-facing modification history.
        for (const [index, record] of target.records.entries()) history.push({ id: 'independent_information_' + index, recordId: record.id, path: currentPath, at: '1970-01-01T00:00:00.000Z', before: structuredClone(record), snapshot: structuredClone(record), changes: [] });
        return { [KEY]: { version: 1, enabled: target.enabled, limit: target.limit, history } };
    },
    fromLegacy(ctx) { return snapshotInformation(ctx); },
});
