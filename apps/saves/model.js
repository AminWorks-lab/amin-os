import { validateModules } from './adapters.js';
import { validMessageRevision } from '../shared/message-revision.js';
import { sha256HexSync } from '../tts/source-hash.js';
export const KEY='amin_os_saves_v1';
export const FORMAT='amin-os-save';
// checkpoints: the configurable ring size. ring: references kept in chat metadata.
// inlineRing: full fallback snapshots kept in metadata while external storage is unavailable.
export const LIMITS=Object.freeze({saves:20,backups:5,checkpoints:24,ring:32,inlineRing:2,snapshotBytes:8*1024*1024,storeBytes:24*1024*1024});
export const DEFAULT_CHECKPOINT_SETTINGS=Object.freeze({enabled:true,limit:10});
export const RING_KINDS=Object.freeze(['auto','before-restore','before-change']);
const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const forbidden=new Set(['__proto__','constructor','prototype']);
export const candidateBinding = (path, candidate) => 'sha256:' + sha256HexSync(JSON.stringify([path?.at(-1) ?? null, candidate]));
export function validateJSON(value,limit=LIMITS.snapshotBytes){
    const seen=new Set();let count=0;
    function visit(v,depth){
        if(++count>500000||depth>50)throw Error('存档结构过大或嵌套过深。');
        if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
        if(typeof v!=='object'||(!Array.isArray(v)&&!object(v))||seen.has(v))throw Error('存档必须是有效 JSON 数据。');
        if(Array.isArray(v)&&(Object.keys(v).length!==v.length||Array.from({length:v.length},(_,i)=>i).some(i=>!Object.hasOwn(v,i))))throw Error('存档数组不能有空位或额外字段。');
        seen.add(v);for(const key of Reflect.ownKeys(v)){if(Array.isArray(v)&&key==='length')continue;if(typeof key!=='string'||forbidden.has(key))throw Error('存档含受保护字段。');const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!('value'in d))throw Error('存档含非数据字段。');visit(d.value,depth+1);}seen.delete(v);
    }
    visit(value,0);const raw=JSON.stringify(value);if(new TextEncoder().encode(raw).byteLength>limit)throw Error('存档超过大小上限，请减少资料后重试。');return value;
}
const shape=(v,allowed,label)=>{if(!object(v)||Object.keys(v).some(key=>!allowed.includes(key)))throw Error(label+'格式无效或包含未知字段。');};
const text=(v,max,label,required=false)=>{if(typeof v!=='string'||v.length>max||required&&!v.trim())throw Error(label+'无效或过长。');return v;};
export function validateSnapshot(value){
    validateJSON(value);shape(value,['format','version','id','name','note','createdAt','source','modules'],'存档');
    if(value.format!==FORMAT||value.version!==1)throw Error('存档版本或类型不兼容。');
    text(value.id,100,'存档编号',true);text(value.name,120,'存档名称',true);text(value.note,2000,'存档备注');text(value.createdAt,100,'创建时间',true);
    if(!Number.isFinite(Date.parse(value.createdAt)))throw Error('存档创建时间无效。');
    shape(value.source,['identity','floor','candidate','path','candidateBinding'],'来源');text(value.source.identity,2000,'来源聊天',true);
    if(!Number.isInteger(value.source.floor)||value.source.floor<0||!Number.isInteger(value.source.candidate)||value.source.candidate<0)throw Error('存档来源楼层无效。');
    if(value.source.path===undefined&&value.source.candidateBinding!==undefined)throw Error('存档缺少来源楼层记录。');
    if(value.source.path!==undefined){
        if(!Array.isArray(value.source.path)||value.source.path.length!==value.source.floor||value.source.path.length>100000)throw Error('存档来源消息路径不完整。');
        for(const revision of value.source.path){
            text(revision,LIMITS.snapshotBytes,'来源楼层记录',true);
            if(!validMessageRevision(revision))throw Error('存档的来源楼层记录无效。');
        }
        // Old revisions contained the swipe index in clear text. Compact
        // revisions bind the separate candidate field to the last digest.
        const last=value.source.path.at(-1);
        if(last?.startsWith('[')&&JSON.parse(last)[3]!==value.source.candidate)throw Error('存档候选与来源消息不一致。');
        if((last?.startsWith('sha256:')||value.source.candidateBinding!==undefined)
            && value.source.candidateBinding!==candidateBinding(value.source.path,value.source.candidate))throw Error('存档的回复候选与来源楼层记录不一致。');
    }
    validateModules(value.modules);return clone(value);
}
export function validateCheckpointSettings(value){
    shape(value,['enabled','limit'],'检查点设置');
    if(typeof value.enabled!=='boolean'||!Number.isInteger(value.limit)||value.limit<1||value.limit>LIMITS.checkpoints)throw Error(`检查点设置无效；保留数量应为 1 至 ${LIMITS.checkpoints}。`);
    return clone(value);
}
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':object(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const modulesHash=modules=>'sha256:'+sha256HexSync(canonical(modules));
const HASH=/^sha256:[a-f0-9]{64}$/u;
/** Chat metadata keeps {id,hash,revision,kind,at,label}; snapshot is present only for inline copies. */
export function validateItem(value,kinds){
    shape(value,['id','hash','revision','kind','at','label','snapshot'],'存档引用');
    text(value.id,100,'存档编号',true);text(value.label,120,'存档名称',true);text(value.at,100,'存档时间',true);
    if(!Number.isFinite(Date.parse(value.at))||!HASH.test(value.hash??'')||!kinds.includes(value.kind)
        ||!(value.revision===null||Number.isSafeInteger(value.revision)&&value.revision>=0))throw Error('存档引用无效。');
    if(value.snapshot!==undefined){
        const saved=validateSnapshot(value.snapshot);
        if(saved.id!==value.id||saved.createdAt!==value.at||saved.name!==value.label||modulesHash(saved.modules)!==value.hash)throw Error('存档引用与内容不一致。');
    }
    return clone(value);
}
export const itemOf=(snapshot,kind,revision=null)=>validateItem({id:snapshot.id,hash:modulesHash(snapshot.modules),revision,kind,at:snapshot.createdAt,label:snapshot.name,snapshot},kind==='named'?['named']:RING_KINDS);
export const refOf=({snapshot,...ref})=>clone(ref);
export const empty=()=>({version:2,saves:[],ring:[],checkpointSettings:{...DEFAULT_CHECKPOINT_SETTINGS}});
function validateStoreV2(value){
    shape(value,['version','saves','ring','checkpointSettings','legacy'],'存档库');
    if(!Array.isArray(value.saves)||!Array.isArray(value.ring)||value.saves.length>LIMITS.saves||value.ring.length>LIMITS.ring)throw Error('存档库数量或格式无效。');
    const saves=value.saves.map(item=>validateItem(item,['named'])),ring=value.ring.map(item=>validateItem(item,RING_KINDS));
    if(ring.filter(item=>item.snapshot).length>LIMITS.inlineRing)throw Error('聊天内保留的完整备份超过上限。');
    let legacy;
    if(value.legacy!==undefined){
        shape(value.legacy,['backups','checkpoints'],'旧检查点');
        if(!Array.isArray(value.legacy.backups)||!Array.isArray(value.legacy.checkpoints)||value.legacy.backups.length>LIMITS.backups||value.legacy.checkpoints.length>LIMITS.checkpoints)throw Error('旧检查点数量或格式无效。');
        legacy={backups:value.legacy.backups.map(validateSnapshot),checkpoints:value.legacy.checkpoints.map(validateSnapshot)};
    }
    const ids=new Set();for(const id of [...saves,...ring,...(legacy?.backups??[]),...(legacy?.checkpoints??[])].map(item=>item.id)){if(ids.has(id))throw Error('存档编号重复。');ids.add(id);}
    return {version:2,saves,ring,checkpointSettings:validateCheckpointSettings(value.checkpointSettings??DEFAULT_CHECKPOINT_SETTINGS),...(legacy?{legacy}:{})};
}
/** Version 1 (0.18 and earlier) kept every full snapshot in metadata; it stays readable. */
export function validateStore(value){
    validateJSON(value,LIMITS.storeBytes);
    if(object(value)&&value.version===2)return validateStoreV2(value);
    shape(value,['version','saves','backups','checkpoints','checkpointSettings'],'存档库');
    if(value.version!==1||!Array.isArray(value.saves)||!Array.isArray(value.backups)||value.saves.length>LIMITS.saves||value.backups.length>LIMITS.backups)throw Error('存档库版本、格式或数量不兼容。');
    if(value.checkpoints!==undefined&&(!Array.isArray(value.checkpoints)||value.checkpoints.length>LIMITS.checkpoints))throw Error('检查点数量或格式无效。');
    const settings=validateCheckpointSettings(value.checkpointSettings??DEFAULT_CHECKPOINT_SETTINGS);
    const ids=new Set();for(const item of [...value.saves,...value.backups,...(value.checkpoints??[])]){validateSnapshot(item);if(ids.has(item.id))throw Error('存档编号重复。');ids.add(item.id);}
    for(const checkpoint of value.checkpoints??[])if(!checkpoint.source.path||!checkpoint.source.floor)throw Error('自动检查点缺少完整来源消息。');
    return {...clone(value),checkpoints:clone(value.checkpoints??[]),checkpointSettings:settings};
}
export function readStore(ctx){return ctx?.chatMetadata?.[KEY]===undefined?empty():validateStore(ctx.chatMetadata[KEY]);}
/** In-memory v2 view of any store. Old checkpoints and backups stay as read-only legacy copies. */
export function upgradeStore(store){
    if(store.version===2)return clone(store);
    const legacy=store.backups.length||store.checkpoints.length?{legacy:{backups:clone(store.backups),checkpoints:clone(store.checkpoints)}}:{};
    return {version:2,saves:store.saves.map(saved=>itemOf(saved,'named')),ring:[],checkpointSettings:clone(store.checkpointSettings),...legacy};
}
export function ringLimit(ctx){try{return readStore(ctx).checkpointSettings.limit;}catch{return DEFAULT_CHECKPOINT_SETTINGS.limit;}}
export function parseImport(raw){
    if(typeof raw!=='string'||new TextEncoder().encode(raw).byteLength>LIMITS.snapshotBytes)throw Error('导入文件无效或超过 8 MiB。');
    let value;try{value=JSON.parse(raw);}catch{throw Error('导入文件不是有效 JSON。');}return validateSnapshot(value);
}
