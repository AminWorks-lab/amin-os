import { getAI } from '../../ai/service.js';
import { createLinkageService } from '../linkage/service.js';
import { adapters } from '../linkage/registry.js';
import { parseUpdate } from '../linkage/protocol.js';
import { createOperationService, chatIdentity, chatPath } from '../shared/operations.js';
import { collectGenerationSources } from './sources.js';
import { mayManuallyUpdateStatus, modulePolicy } from '../linkage/policy.js';
import { compileRules } from '../status/rules.js';
import { bindings, bindingParts } from '../characters/model.js';
import { currentDrafts, readStore as readJournalStore } from '../journal/model.js';
import { isIndependent, toLegacyContext } from '../story-state/access.js';
import { allocateUpdateEntityIds } from '../linkage/entity-ids.js';
import { updateSchema } from '../linkage/contract.js';
import { buildReferenceIndex } from '../linkage/references.js';

export const GENERATION_MODULES = ['characters', 'inventory', 'relationships', 'scene', 'journal', 'status'];
const labels = { status:'世界状态', characters:'人物卡', inventory:'背包与账本', relationships:'人物关系', scene:'场景与时间', journal:'剧情档案', linkage:'联合初始化' };
const actions = {
    status:['set-field'],
    characters:['create-character','update-character','update-appearance','save-stat'],
    inventory:['create-item','update-item','create-balance','update-balance','set-condition'],
    relationships:['save-relationship'], scene:['set-time','save-scene','save-schedule'],
    journal:['save-fact','save-knowledge','save-hook','save-task','save-clue','draft-chronicle'],
};
/** response_format schema for one generation run: only the selected modules and their allowed actions. */
export const generationSchema = modules => updateSchema(modules.length === 1 ? `${modules[0]}_generation` : 'joint_generation',
    modules.map(id => ({ id, spec: adapters.find(adapter => adapter.id === id).spec, actions: actions[id] })));
const clone = value => structuredClone(value), same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const empty = value => value == null || value === '' || (Array.isArray(value) && !value.length);
// False and zero are explicit values, not missing fields. Arrays preserve their
// existing members; ID-bearing arrays may add new members without replacing old ones.
function preserves(before, after) {
    if (empty(before)) return true;
    if (Array.isArray(before)) return Array.isArray(after) && before.every((item,index) => preserves(item, item?.id ? after.find(next => next?.id === item.id) : after[index]));
    if (typeof before === 'object') return after && typeof after === 'object' && Object.keys(before).every(key => preserves(before[key],after[key]));
    return same(before,after);
}
function record(state, change) {
    if (change.module === 'status') { const [project, field] = bindingParts(change.target); return state.项目[project]?.[field]; }
    if (change.module === 'characters') return state.characters.find(item => item.id === change.target);
    if (change.module === 'inventory') return [...state.items,...state.balances].find(item => item.id === change.target);
    if (change.module === 'relationships') return state.relationships.find(item => item.id === change.target);
    if (change.module === 'journal') return [...state.entries,...(state.drafts??[])].find(item => item.id === change.target);
    if (change.action === 'set-time') return state.clock;
    return change.action === 'save-schedule' ? state.schedules.find(item => item.id === change.target) : state.scenes[change.target];
}
function content(value) {
    if (Array.isArray(value)) return value.map(content);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['evidence','sourceRange','sourceValid','savedAt','savedFloor','eventId'].includes(key)).map(([key,v]) => [key,content(v)]));
}
function patch(metadata, item) {
    let parent = metadata;
    for (const key of item.path.slice(0,-1)) parent = parent[key] ??= {};
    if (item.remove) delete parent[item.path.at(-1)]; else parent[item.path.at(-1)] = clone(item.value);
}
export function createGenerationService(getContext, { ai = getAI, collectSources = collectGenerationSources } = {}) {
    let current = null, transaction = null, controller = null, working = false, disposed = false, message = '';
    const listeners = new Set(), recovery = createOperationService(getContext);
    const notify = () => { for (const fn of listeners) { try { fn(); } catch {} } };
    const context = () => { if (disposed) throw Error('资料生成已关闭。'); const ctx = getContext(); if (!ctx?.chatMetadata || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null) throw Error('请先打开聊天。'); return ctx; };
    const read = (adapter,ctx) => adapter.id==='journal'?{...adapter.read(ctx),drafts:currentDrafts(readJournalStore(ctx),ctx.chat)}:adapter.read(ctx);
    const data = ctx => Object.fromEntries(adapters.map(adapter => [adapter.id,read(adapter,ctx)]));
    const statusRules = ctx => compileRules(ctx, 'world_status_hud_v1', 'update');
    function statusPermission(ctx) {
        if (!mayManuallyUpdateStatus(ctx)) throw Error('请在“联动更新”中启用世界状态、提供资料并允许模型更新，再按剧情更新；不会自动更改权限。');
        return modulePolicy(ctx, 'status');
    }
    function check(basis) {
        const ctx = context();
        if (basis.statusPolicy && (!same(statusPermission(ctx), basis.statusPolicy) || statusRules(ctx) !== basis.statusRules)) throw Error('世界状态权限或更新规则已变化，请重新生成。');
        if (ctx.chatMetadata !== basis.metadata || chatIdentity(ctx) !== basis.identity || !same(chatPath(ctx.chat),basis.path) || !same(data(ctx),basis.data)) throw Error('聊天、来源楼层或关联资料已变化，请重新生成。');
        return ctx;
    }
    function validate(changes) {
        if (!current) throw Error('请先生成资料草稿。');
        const ctx = check(current.basis), parsed = parseUpdate({version:1,changes}).changes;
        const independent = isIndependent(ctx), indices = current.provenance.chat?.indices ?? [];
        // Source constraints are normalized on the editable draft. IDs remain
        // temporary aliases until the reviewed transaction issues final UUIDs.
        for (const change of parsed) {
            if (!current.modules.includes(change.module) || !actions[change.module]?.includes(change.action)) throw Error('资料建议包含未选择的模块或不允许的操作。');
            if (change.module === 'journal') {
                if (!indices.length) throw Error('剧情档案需要已选择的真实聊天楼层，不能凭空建立来源。');
                const start = change.data.sourceStart, end = change.data.sourceEnd ?? start;
                if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end-start >= indices.length || !Array.from({length:end-start+1},(_,n)=>start+n).every(n=>indices.includes(n))) throw Error('档案来源超出所选聊天楼层。');
            }
            if (change.module === 'relationships') {
                change.data.sources ??= [];
                if (!Array.isArray(change.data.sources) || change.data.sources.some(n=>!indices.includes(n))) throw Error('关系来源超出所选聊天楼层。');
            }
        }
        const existingIds = independent ? [...buildReferenceIndex(current.basis.data).entities.map(entity=>entity.id),
            ...(current.basis.data.relationships?.thresholdRules??[]).map(rule=>`relationships:${rule.id}`)] : [];
        const checked = independent ? allocateUpdateEntityIds({version:1,changes:parsed},{existingIds}).update.changes : parsed;
        const sandbox = independent ? toLegacyContext(ctx) : {...ctx,chatMetadata:clone(ctx.chatMetadata)};
        for (const [index,change] of checked.entries()) {
            const adapter = adapters.find(item=>item.id===change.module), before = record(read(adapter,sandbox),change);
            if(change.action==='create-character' && read(adapter,sandbox).characters.some(person=>person.kind===(change.data.kind??'npc')&&person.name.trim().normalize('NFKC').toLowerCase()===String(change.data.name).trim().normalize('NFKC').toLowerCase()))throw Error('已有同名同类型人物，请复用现有稳定 ID。');
            if (current.mode === 'create' && before != null) throw Error('从零建立仅允许新增记录，不能修改现有资料。');
            if (change.module === 'scene' && change.data.activate === true && current.mode !== 'update' && adapter.read(sandbox).activeSceneId) throw Error('新增或补充资料不能切换已有活动场景。');
            const result = adapter.apply(sandbox,change,{operationId:`generation_preview_${index}`,now:new Date().toISOString()});
            for (const item of result.patches) patch(sandbox.chatMetadata,item);
            if (current.mode === 'supplement' && before != null && !preserves(content(before),content(record(read(adapter,sandbox),change)))) throw Error('补充缺项不能覆盖已有内容，请改为按剧情更新或只填写空缺字段。');
        }
        return parsed;
    }
    function ensureIdle() { if (working || recovery.busy() || recovery.dirty()) throw Error('请先完成当前生成或重试尚未保存的资料。'); }
    return {
        async generate({modules,mode='create',sources={},instruction=''}, {signal}={}) {
            ensureIdle();
            if (!Array.isArray(modules) || !modules.length || modules.some(id=>!GENERATION_MODULES.includes(id)) || new Set(modules).size!==modules.length) throw Error('请选择支持的资料应用。');
            if (!['create','supplement','update'].includes(mode) || typeof instruction !== 'string') throw Error('资料生成模式或要求无效。');
            if(!instruction.trim() && !sources?.includeCharacter && !sources?.includePersona && !sources?.includeChat && !(sources?.readWorldbooks && sources?.selectedBooks?.length))throw Error('请选择资料来源或填写明确的生成要求。');
            const statusOnly = modules.includes('status');
            if (statusOnly && (modules.length !== 1 || mode !== 'update' || sources.includeChat !== true)) throw Error('世界状态仅支持单独按剧情更新，请选择真实聊天楼层；初始化请使用生成／补充或模板。');
            transaction?.dispose(); transaction=null; current=null; controller=new AbortController();
            const activeController=controller, abort=()=>activeController.abort(signal.reason ?? Error('已取消资料生成。'));
            if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
            working=true; message='正在读取来源并生成资料草稿。'; notify();
            try {
                const ctx=context(), statusPolicy=statusOnly ? clone(statusPermission(ctx)) : null, basis={statusPolicy, statusRules:statusOnly ? statusRules(ctx) : '', metadata:ctx.chatMetadata,identity:chatIdentity(ctx),path:chatPath(ctx.chat),data:data(ctx)};
                if (statusOnly && !Object.values(basis.data.status.项目).some(project => Object.keys(project).length)) throw Error('当前没有可更新的状态字段，请先使用生成／补充、模板或手动编辑建立状态。');
                const assertCurrent=()=>{if(activeController.signal.aborted)throw activeController.signal.reason ?? Error('已取消资料生成。');check(basis);};
                const provider=typeof ai==='function'?ai():ai;
                if (!provider?.capture || !provider?.generate) throw Error('共享 AI 尚未就绪，请检查 AI 设置。');
                const route=modules.length===1?modules[0]:'linkage', snapshot=provider.capture(route);
                const sourceResult=await collectSources(ctx,clone(sources),{signal:activeController.signal,check:assertCurrent}); assertCurrent();
                if (statusOnly && !sourceResult.provenance.chat?.indices?.length) throw Error('世界状态更新需要所选真实聊天楼层。');
                const warnings=[];
                const effective=modules.filter(id=>id!=='journal'||sourceResult.provenance.chat?.indices?.length);
                if(effective.length!==modules.length)warnings.push('剧情档案需要所选真实聊天楼层，本次跳过档案生成。');
                if(!effective.length)throw Error(warnings[0]);
                const references=statusOnly ? {} : {characters:basis.data.characters.characters.map(({id,name})=>({id,name})),bindings:effective.includes('characters')?bindings(ctx).map(({binding,component,label})=>({binding,component,label})):[],locations:effective.includes('scene')?Object.values(basis.data.map.maps).flatMap(map=>Object.values(map.nodes).map(({id,name})=>({mapId:map.id,nodeId:id,name}))):[]};
                if(effective.includes('journal'))Object.assign(references,{scenes:Object.values(basis.data.scene.scenes).map(({id,name})=>({id,name})),items:basis.data.inventory.items.map(({id,name})=>({id,name})),tasks:basis.data.journal.entries.filter(e=>e.kind==='task').map(({id,title})=>({id,title}))});
                const prompt=JSON.stringify({mode,modules:effective,existing:Object.fromEntries(effective.map(id=>[id,basis.data[id]])),references,sources:sourceResult.text,provenance:sourceResult.provenance,instruction,...(statusOnly ? {statusRules:basis.statusRules} : {})});
                const independent=isIndependent(ctx), newTarget=independent?'@new:person':'safe_id';
                const identityRules=independent?'新增实体 target 必须使用 @new:alias 临时别名，由插件分配最终UUID，不允许自行指定新人物或其他实体的持久ID。别名以英文字母开头，最多60个字母、数字、下划线、连字符。同批引用新人物/物品/场景/事实/任务时，在明确引用字段中使用相同临时别名；新属性stats[].id等嵌套实体也使用别名。已有实体保留 references 中稳定ID。备注、姓名、正文等自然语言不可用别名代替。以下协议中的新ID均指临时别名。':'';
                const statusContract = 'set-field: target="项目名.字段名", data={value: 与现有字段同类型的最终值, component?: "value"|"current"|"max"}。value/省略 component 指整个字段；current/max 仅适用于已有进度的当前/最大。数字、文本、布尔、字符串列表和进度保持原类型；进度保持 0≤当前≤最大、最大>0。不新增、删除、重命名或转换类型。';
                const statusInstruction = '按所选已有剧情核对当前世界状态，不续写、不重生成聊天正文。只返回有明确依据的已有字段最终值，reason 说明依据的楼层和事实。使用绝对值，不重复扣减已反映在当前状态中的事件；不确定或没有变化时 changes=[]。已保存的状态规则不能扩大本次操作的类型和权限。';
                const systemPrompt=statusOnly ? `${statusInstruction}只输出 JSON {"version":1,"changes":[{"module":"status","action":"set-field","target":"实际项目.实际字段","data":{"value":"与现有类型一致"},"reason":"第N楼的明确事实"}]}，最多64项。${statusContract}` : `根据用户选定来源整理资料，不续写剧情。只输出 JSON {"version":1,"changes":[{"module":"characters","action":"create-character","target":"${newTarget}","data":{},"reason":"来源依据"}]}。最多64项。仅处理指定模块。先人物后物品、关系、场景，先事实后记忆，先任务后关联线索；任务奖励仅为说明，不自动发放；使用稳定ID，不重复建立已有实体。create仅新增；supplement仅填空，不覆盖已有内容（0和false也是已有值）；update允许有依据的资料修订。不得删除、消费、转账、结算、调整配置、掷骰或凭空生成属性数值。档案必须提供所选真实sourceStart/sourceEnd；关系sources仅可用所选楼层，非聊天来源填[]并在reason说明。无适用内容输出空changes。${identityRules}下列协议中只允许每个模块列出的操作：\n`+effective.map(id=>`${id}: 允许 ${actions[id].join(',')}\n${adapters.find(a=>a.id===id).contract}`).join('\n');
                const raw=await provider.generate(`${labels[route]} · 资料生成`,{...ctx,chat:clone(ctx.chat),chatMetadata:clone(ctx.chatMetadata)},{systemPrompt:systemPrompt+(statusOnly ? '' : '\n人物数值属性只可绑定 references.bindings 中已有字段；没有可用字段时 stats=[]，来源数值可记在 notes 供用户以后配置。'),prompt,schema:generationSchema(effective)},{signal:activeController.signal,snapshot,data:{request:prompt},includeEffects:false,includeJournal:false,includeScene:false,includeLinkage:false}); assertCurrent();
                const parsed=parseUpdate(raw);
                current={modules:effective,mode,sources:clone(sources),provenance:clone(sourceResult.provenance),sourceText:sourceResult.text,warnings,basis,changes:parsed.changes};
                current.changes=validate(parsed.changes);
                transaction=createLinkageService(getContext,{manualModules:effective}); transaction.subscribe(notify);
                message=current.changes.length?'资料草稿已生成，请编辑并预览后确认。':'所选来源没有可生成的资料。';
                return this.draft();
            } catch(error) { current=null; message=error.message; throw error; }
            finally { working=false;controller=null;signal?.removeEventListener('abort',abort);notify(); }
        },
        draft(){if(!current)return null;const {basis,sourceText,...visible}=current;return clone(visible);},
        stage(changes){ensureIdle();const validated=validate(changes);transaction.discard();const result=transaction.stage({version:1,changes:validated});message='已校验所选变更，确认后统一保存。';notify();return result;},
        preview:()=>transaction?.preview()??null,
        async confirm(){
            ensureIdle();if(!current||!transaction?.preview())throw Error('请先预览所选资料。');
            working=true;controller=new AbortController();const confirming=controller,guard=()=>{if(confirming.signal.aborted)throw confirming.signal.reason??Error('已取消资料确认。');return check(current.basis);};notify();
            try{const ctx=guard();const selected=await collectSources(ctx,clone(current.sources),{signal:confirming.signal,check:guard});guard();if(!same(selected.provenance,current.provenance)||selected.text!==current.sourceText)throw Error('角色卡、设定或世界书来源已变化，请重新生成。');const result=await transaction.confirm();current=null;message='资料已统一保存。';return result;}
            catch(error){message=error.message;throw error;}finally{working=false;controller=null;notify();}
        },
        async retrySave(){if(working)throw Error('操作正在进行。');if(!recovery.dirty())throw Error('没有待重试的已确认保存。');try{const result=await (transaction ? transaction.retrySave() : recovery.retrySave());current=null;message='资料保存已完成。';return result;}finally{notify();}},
        cancel(){controller?.abort(Error('已取消资料生成。'));},
        discard(){ensureIdle();transaction?.discard();message='已返回草稿编辑。';notify();},
        status:()=>message, busy:()=>working||recovery.busy(),dirty:()=>recovery.dirty(),
        subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
        dispose(){controller?.abort(Error('资料生成已关闭。'));transaction?.dispose();recovery.dispose();disposed=true;listeners.clear();},
    };
}
