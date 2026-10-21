import { nativeState2Status, getState2Runtime } from '../state2/runtime.js';
import { uuid } from '../../uuid.js';
import { createOperationService, subscribeStateChanges, chatIdentity, chatPath } from '../shared/operations.js';
import { adapters as allAdapters } from './registry.js';
import { KEY, MODULES, SCOPE_TEMPLATE_KEY, scopeTemplate, readScopeTemplate, readLinkageState, readLinkageSettings, validateLinkageState, compactLinkageReceipts, modulePolicy, moduleAvailable, mayWrite, mayManuallyUpdateStatus, plain, validateJSON } from './policy.js';
import { parseUpdate, hasUpdate } from './protocol.js';
import { buildUnifiedPrompt, buildDataPrompt, buildUpdateRules, buildDataPromptReport } from './prompt.js';
import { buildReferenceIndex } from './references.js';
import { isIndependent, STATE_KEY, toLegacyContext } from '../story-state/access.js';
import { sha256HexSync } from '../tts/source-hash.js';
import { allocateUpdateEntityIds } from './entity-ids.js';
import { summarizeChanges, rejectionCategory, rawUpdateText } from './turns.js';
import { validateState } from '../story-state/schema.js';
import { createIndependentBackups, stateSnapshot } from '../story-state/backups.js';

const clone = value => structuredClone(value), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
// These archives are derived from canonical state and are never read by the
// reference index or a model-facing projection. Host observers may append the
// current floor asynchronously. Guard them only when an adapter actually writes
// them; operation.stage automatically adds every patch path to its save token.
const derivedHistories = new Set(['world_status_hud_history_v1', 'amin_os_organizations_history_v1', 'dynamicMapPositionHistoryV1']);
function valueAt(object, path) {
    for (const key of path) { if (!object || typeof object !== 'object' || !own(object, key)) return { exists: false }; object = object[key]; }
    return { exists: true, value: object };
}
function applyPatch(metadata, patch) {
    if (!plain(patch) || !Array.isArray(patch.path) || !patch.path.length || patch.path.some(k => typeof k !== 'string' || !k || ['__proto__','prototype','constructor'].includes(k))) throw Error('应用适配器返回无效的写入路径。');
    if (patch.remove !== true) validateJSON(patch.value);
    let parent = metadata;
    for (const key of patch.path.slice(0, -1)) { if (!own(parent, key)) parent[key] = {}; if (!plain(parent[key])) throw Error('更新路径上级不是对象。'); parent = parent[key]; }
    if (patch.remove === true) delete parent[patch.path.at(-1)]; else parent[patch.path.at(-1)] = clone(patch.value);
}
function pathModule(path) {
    if (path[0] === 'variables') return path[1] === '状态栏' ? 'status' : path[1] === '势力资料' ? 'organizations' : null;
    if (path[0] === 'world_status_hud_history_v1') return 'status';
    if (['amin_os_organizations_v1','amin_os_organizations_history_v1'].includes(path[0])) return 'organizations';
    if (path[0] === 'dynamicMapPositionHistoryV1') return 'map';
    return Object.keys(MODULES).find(id => MODULES[id][1] === path[0]) ?? null;
}
const sourceFor = (ctx, index = (ctx.chat?.length ?? 0) - 1) => ({ identity: chatIdentity(ctx), path: chatPath(ctx.chat), index, swipe: ctx.chat?.[index]?.swipe_id ?? 0, text: ctx.chat?.[index]?.mes ?? '' });
const hash = value => 'sha256:' + sha256HexSync(typeof value === 'string' ? value : JSON.stringify(value));
const compactSource = source => ({ identity: source.identity, index: source.index, swipe: source.swipe ?? 0,
    textHash: source.textHash ?? hash(source.text), pathHash: source.pathHash ?? hash(source.path) });
const sourceEqual = (a,b) => a.identity === b.identity && a.index === b.index && (a.swipe ?? 0) === (b.swipe ?? 0)
    && (a.textHash ?? hash(a.text)) === (b.textHash ?? hash(b.text)) && (a.pathHash ?? hash(a.path)) === (b.pathHash ?? hash(b.path));
const changesEqual = (record, changes) => record.changesHash ? record.changesHash === hash(changes) : same(record.changes, changes);
const failWith = (category, text) => Object.assign(Error(text), { linkageCategory: category });
function parse(raw, options) {
    try { return parseUpdate(raw, { repair: true, ...options }); }
    catch (error) { error.linkageCategory ??= 'format'; throw error; }
}
const REJECTION_LIMIT = 10, TURN_LIMIT = 20, HINT_KEY = 'amin-os-regenerate-hint-v1';
// One notice per chat: the storage key carries the chat identity. Storage is
// best effort (private windows may refuse it); the in-memory set still applies.
const hintKey = identity => `${HINT_KEY}:${hash(identity).slice(7, 39)}`;
function rememberHint(identity, storage) {
    try {
        const key = hintKey(identity);
        if (storage?.getItem?.(key)) return false;
        storage?.setItem?.(key, '1');
    } catch { /* Fall back to the in-memory set. */ }
    return true;
}

export function createLinkageService(getContext = () => globalThis.SillyTavern?.getContext?.(), { adapters = allAdapters, createId = uuid, now = () => new Date().toISOString(), buildPrompt = buildUnifiedPrompt, manualModules = null,
    backups = null, hintStorage = (() => { try { return globalThis.localStorage; } catch { return null; } })(),
    notifyRegenerate = text => globalThis.toastr?.info?.(text, 'Amin OS', { timeOut: 12000 }) } = {}) {
    if (manualModules !== null && (!Array.isArray(manualModules) || !manualModules.length || manualModules.some(id => !['characters','inventory','relationships','scene','journal','status'].includes(id)) || new Set(manualModules).size !== manualModules.length)) throw Error('手动生成范围无效。');
    const manualScope = manualModules === null ? null : new Set(manualModules);
    const canWrite = (ctx, id) => manualScope ? manualScope.has(id) && (id !== 'status' || mayManuallyUpdateStatus(ctx)) : mayWrite(ctx,id);
    const batchLabel = manualScope ? 'AI 资料生成' : '跨应用剧情更新';
    const operation = createOperationService(getContext), listeners = new Set(), candidates = new Map();
    const paths = [...new Map([[KEY], ...adapters.flatMap(a => a.paths).filter(path => !derivedHistories.has(path[0]))].map(path => [JSON.stringify(path), path])).values()];
    let pending = null, generation = null, message = '', hostMessage = '', disposed = false, templateBusy = false, backupStore = backups;
    // Run-local records: rejected batches (any chat) and automatically applied turns.
    const rejections = [], turns = [], hinted = new Set();
    const notify = () => { for (const callback of [...listeners]) { try { callback(); } catch { /* A view cannot interrupt a commit. */ } } };
    const context = () => { if (disposed) throw Error('联动更新服务已关闭。'); const ctx = getContext(); if (!ctx?.chatMetadata || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null) throw Error('请先打开聊天。'); return ctx; };
    const rawData = ctx => {
        const readable = isIndependent(ctx) ? toLegacyContext(ctx) : ctx;
        return Object.fromEntries(adapters.map(a => [a.id, a.read(readable)]));
    };
    function allowedPatch(ctx, patch) {
        const id = pathModule(patch.path);
        if (!id || !canWrite(ctx,id)) throw failWith('permission', `本次操作没有修改 ${id ? MODULES[id][0] : patch.path.join('.')} 的权限。`);
        if (patch.path[0] === 'variables' && patch.path.length < 2) throw failWith('permission', '不能整体替换聊天变量。');
        if (patch.path[0] === 'amin_os_organizations_v1' && !['locks','assessment','backups'].includes(patch.path[1])) throw failWith('permission', '不能通过剧情更新修改势力应用设置。');
    }
    function ensureGeneration(candidate) {
        const ctx = context(), expected = candidate.basis;
        if (ctx.chatMetadata !== expected.metadata || chatIdentity(ctx) !== expected.identity || !same(chatPath(ctx.chat), candidate.source.path)) throw Error('更新来源的聊天、正文或候选已变化，请重新生成建议。');
        if (!same(rawData(ctx), expected.data) || !same(readLinkageState(ctx), expected.settings) || buildPrompt(ctx) !== expected.prompt) throw Error('生成期间关联资料或联动规则已变化，本次建议已过期。');
        return ctx;
    }
    function reject(raw, source, error, manual = false) {
        rejections.unshift({ id: createId(), at: now(), identity: source?.identity ?? null, index: Number.isInteger(source?.index) ? source.index : null,
            swipe: source?.swipe ?? 0, manual, raw: rawUpdateText(raw), item: error?.linkageItem ? clone(error.linkageItem) : null,
            category: rejectionCategory(error), reason: String(error?.message ?? error) });
        rejections.length = Math.min(rejections.length, REJECTION_LIMIT);
    }
    function stage(raw, options = {}) {
        const ctx = context();
        if (!readLinkageState(ctx).enabled && !manualScope) throw Error('请先启用统一联动更新。');
        try { return stageUpdate(raw, options); }
        catch (error) { if (!manualScope) { reject(raw, options.candidate?.source ?? sourceFor(ctx), error, !options.candidate); notify(); } throw error; }
    }
    function stageUpdate(raw, options = {}) {
        const ctx = options.candidate ? ensureGeneration(options.candidate) : context();
        const settings = readLinkageState(ctx);
        if (!settings.enabled && !manualScope) throw Error('请先启用统一联动更新。');
        const repairs = [], input = parse(raw, { notes: repairs }), literal = parse(raw, { canonical: false }), independent = isIndependent(ctx);
        const currentData = independent ? rawData(ctx) : null;
        const existingIds = independent ? [...buildReferenceIndex(currentData).entities.map(entity => entity.id),
            ...(currentData.relationships?.thresholdRules ?? []).map(rule => `relationships:${rule.id}`)] : [];
        const allocated = independent ? allocateUpdateEntityIds(input, { createId, existingIds }) : null;
        const parsed = allocated?.update ?? input;
        if (!parsed.changes.length) throw Error('本次没有需要更新的内容。');
        const source = options.candidate?.source ?? sourceFor(ctx);
        if (settings.applied.some(record => !record.archived && sourceEqual(record.source, source) && (options.candidate || changesEqual(record, input.changes) || changesEqual(record, literal.changes)))) throw Error('这次来源的更新已经应用，不会重复执行。');
        const token = operation.capture(independent ? [...paths, [STATE_KEY]] : paths);
        const operationId = createId(), at = now(), sandbox = independent ? toLegacyContext(ctx) : { ...ctx, chatMetadata: clone(ctx.chatMetadata) };
        const touched = [], descriptions = [], changes = [], beforeData = rawData(sandbox);
        for (const [index, change] of parsed.changes.entries()) try {
            if (manualScope && change.module === 'status' && change.action !== 'set-field') throw failWith('permission', '手动状态更新仅允许设置已有字段的最终值。');
            if (!canWrite(ctx,change.module)) throw failWith('permission', `${MODULES[change.module][0]} 未在本次操作的更新范围内。`);
            const adapter = adapters.find(a => a.id === change.module);
            if (!adapter?.apply) throw failWith('permission', '这个模块目前只支持读取。');
            const before = clone(adapter.read(sandbox)), original = JSON.stringify(sandbox.chatMetadata);
            const result = adapter.apply(sandbox, clone(change), { operationId: `${operationId}-${index}`, now: at });
            if (JSON.stringify(sandbox.chatMetadata) !== original) throw Error('应用适配器直接修改了资料，本次操作已拒绝。');
            if (!plain(result) || !Array.isArray(result.patches)) throw Error('应用适配器没有返回有效变更。');
            for (const patch of result.patches) { allowedPatch(ctx,patch); applyPatch(sandbox.chatMetadata,patch); touched.push(patch.path); }
            descriptions.push(String(result.summary ?? change.reason));
            changes.push({ ...change, label: adapter.label, before, after: clone(adapter.read(sandbox)) });
        } catch (error) {
            error.linkageItem ??= { index, module: change.module, label: MODULES[change.module]?.[0] ?? change.module, action: change.action, target: change.target ?? null };
            throw error;
        }
        const afterData = rawData(sandbox); // Validate every module before the first live mutation.
        const beforeRefs = buildReferenceIndex(beforeData,settings.links), afterRefs = buildReferenceIndex(afterData,settings.links);
        const referenceKey = item => JSON.stringify([item.from,item.to]);
        const priorMissing = new Set(beforeRefs.unresolved.map(referenceKey));
        const newMissing = afterRefs.unresolved.filter(item => !priorMissing.has(referenceKey(item)));
        if (newMissing.length) throw failWith('reference', '这批更新会产生新的无效引用：' + newMissing.map(item => `${item.from} → ${item.to}`).join('；'));
        const nextSettings = clone(settings);
        if (independent) {
            nextSettings.applied = compactLinkageReceipts(nextSettings).applied.slice(-63);
            nextSettings.applied.push({ id: operationId, at, source: compactSource(source), changes: [], changesHash: hash(input.changes) });
        } else nextSettings.applied.push({ id: operationId, at, source: clone(source), changes: parsed.changes });
        sandbox.chatMetadata[KEY] = validateLinkageState(nextSettings); touched.push([KEY]);
        const minimal = [...new Map(touched.map(path => [JSON.stringify(path),path])).values()].filter((path, _, all) => !all.some(other => other.length < path.length && other.every((part,i) => part === path[i])));
        const patches = minimal.flatMap(path => {
            const before = valueAt(ctx.chatMetadata,path), after = valueAt(sandbox.chatMetadata,path);
            return same(before,after) ? [] : [{ path, ...(after.exists ? { value: after.value } : { remove:true }) }];
        });
        operation.stage({ label:batchLabel, patches, summary:descriptions },token);
        pending = { label:batchLabel, changes, summary:descriptions, warnings:[...repairs, ...(afterRefs.unresolved.length ? ['已有未解析引用保持原样，请在关联目录检查。'] : [])], operationId, candidateId:options.candidate?.id,
            ...(allocated ? { entityIds: clone(allocated.mapping) } : {}) };
        message = '全部变更已校验；确认后作为同一次操作保存。'; notify(); return preview();
    }
    function preview() { if (!operation.preview()) return null; return clone(pending ?? { label:'保存联动设置', changes:[], summary:[], warnings:[] }); }
    async function confirm() {
        const candidateId = pending?.candidateId;
        if (manualScope && pending?.changes.some(change => !canWrite(context(), change.module))) throw Error('本次手动更新权限已变化，请重新预览。');
        try { const result = await operation.confirm(); pending = null; if (candidateId) candidates.delete(candidateId); message = '关联更新已保存。'; return result; }
        catch (error) { message = error.message; throw error; }
        finally { notify(); }
    }
    async function saveSettings(input) {
        if (templateBusy) throw Error('正在保存通用模板，请稍候。');
        if (manualScope) throw Error('手动资料生成不能修改统一联动设置。');
        const ctx = context(), token = operation.capture([[KEY]]), previous = readLinkageState(ctx);
        const requested = { ...clone(input), version:1, applied:previous.applied };
        const next = isIndependent(ctx) ? compactLinkageReceipts(requested) : validateLinkageState(requested);
        operation.stage({ label:'保存联动设置', patches:[{path:[KEY],value:next}] },token); pending = null;
        try { const result = await operation.confirm(); message = '联动设置已保存。'; generation = null; candidates.clear(); return result; }
        finally { notify(); }
    }
    async function saveScopeTemplate() {
        if (manualScope || templateBusy || operation.busy() || operation.dirty() || operation.preview()) throw Error('请先完成当前操作再保存通用模板。');
        const ctx = context();
        if (!ctx.extensionSettings || typeof ctx.saveSettingsDebounced !== 'function') throw Error('当前宿主缺少全局设置保存接口。');
        const before = ctx.extensionSettings[SCOPE_TEMPLATE_KEY], next = scopeTemplate(readLinkageSettings(ctx));
        templateBusy = true;
        ctx.extensionSettings[SCOPE_TEMPLATE_KEY] = next;
        try { await ctx.saveSettingsDebounced(); message = '通用联动范围模板已保存。'; return clone(next); }
        catch (error) {
            if (ctx.extensionSettings[SCOPE_TEMPLATE_KEY] === next) {
                if (before === undefined) delete ctx.extensionSettings[SCOPE_TEMPLATE_KEY];
                else ctx.extensionSettings[SCOPE_TEMPLATE_KEY] = before;
            }
            throw error;
        } finally { templateBusy = false; notify(); }
    }
    function captureGeneration(type = 'normal', source = {}) {
        generation = null;
        if (manualScope) return false;
        if (!['normal','regenerate','swipe'].includes(type)) return false;
        const ctx = context(); if (!readLinkageState(ctx).enabled || operation.busy() || operation.dirty()) return false;
        if (['regenerate','swipe'].includes(type)) hintRegenerate(ctx, source);
        const chat = [...(ctx.chat ?? [])];
        if (['regenerate','swipe'].includes(type) && chat.length && !chat.at(-1).is_user && !chat.at(-1).is_system
            && (!Object.hasOwn(source, 'excludedReply') || chat.at(-1) === source.excludedReply)) chat.pop();
        const effective = { ...ctx, chat };
        generation = { id:createId(), metadata:ctx.chatMetadata, identity:chatIdentity(ctx), path:chatPath(chat), data:clone(rawData(effective)), settings:readLinkageState(ctx), prompt:buildPrompt(effective) };
        return true;
    }
    async function collectReply(index) {
        const basis = generation; generation = null;
        if (!basis) return null;
        const ctx = context(), chat = ctx.chat ?? [], reply = chat[index];
        if (ctx.chatMetadata !== basis.metadata || chatIdentity(ctx) !== basis.identity || !Number.isInteger(index) || index !== chat.length - 1 || index !== basis.path.length || !same(chatPath(chat.slice(0,index)),basis.path) || !reply || reply.is_user || reply.is_system) return null;
        if (!hasUpdate(reply.mes)) {
            message = '本轮回复未返回 amin_update 更新块；请检查模型输出及消息原文正则。'; notify();
            return { outcome:'missing' };
        }
        const candidate = { id:basis.id, source:sourceFor(ctx,index), text:reply.mes, basis };
        try {
            const parsed = parse(reply.mes);
            if (!parsed.changes.length) {
                ensureGeneration(candidate);
                message = '模型已返回更新块：本轮无可提交的变化，未修改资料。'; notify();
                return { outcome:'empty' };
            }
        } catch (error) {
            reject(reply.mes, candidate.source, error);
            message = '更新块无效或已过期：' + error.message; notify();
            return { outcome:'invalid' };
        }
        if (readLinkageState(ctx).applied.some(record=>!record.archived && sourceEqual(record.source,candidate.source))) return null;
        candidates.set(candidate.id,candidate); message='收到跨应用更新建议，请查看预览。'; notify();
        if (readLinkageState(ctx).mode === 'auto') {
            let undo = null;
            try { undo = await prepareUndo(candidate); } catch (error) { undo = { error: error.message }; }
            try { stage(candidate.text,{candidate}); const applied = clone(pending); await confirm(); recordTurn(candidate, applied, undo); }
            catch (error) { message='自动更新未完成：'+error.message; notify(); }
        }
        return { id:candidate.id, source:clone(candidate.source), text:candidate.text };
    }
    // Before an automatic batch, make sure a pre-change backup exists for its undo.
    // The ring keeps one record per state revision; an existing record of the same
    // revision (such as a floor checkpoint) serves. Without external storage the
    // snapshot stays in memory for this run.
    async function prepareUndo(candidate) {
        const ctx = context();
        if (!isIndependent(ctx)) return null;
        const state = validateState(ctx.chatMetadata[STATE_KEY]), label = `第 ${candidate.source.index + 1} 楼更新前`;
        backupStore ??= createIndependentBackups(getContext);
        if (backupStore.available?.()) {
            const result = await backupStore.savePrevious(ctx, state, { label });
            if (result?.saved) return { backupId: result.id, revision: state.revision };
            const entry = result?.duplicate ? (await backupStore.readRing(ctx)).entries.find(item => item.revision === state.revision || item.snapshot.id === result.id) : null;
            if (entry) return { backupId: entry.snapshot.id, revision: state.revision };
        }
        return { snapshot: stateSnapshot(ctx, state, { label }).snapshot, revision: state.revision };
    }
    const stamp = ctx => isIndependent(ctx) ? ctx.chatMetadata?.[STATE_KEY]?.revision ?? null : hash(rawData(ctx));
    function recordTurn(candidate, applied, undo) {
        const ctx = context(), summary = summarizeChanges(applied?.changes ?? [], applied?.summary ?? []);
        turns.unshift({ id: applied?.operationId ?? createId(), at: now(), identity: candidate.source.identity, index: candidate.source.index, swipe: candidate.source.swipe ?? 0,
            headline: summary.headline, items: summary.items, undo: undo && !undo.error ? undo : null, undoError: undo?.error ?? '', stamp: stamp(ctx), undone: false });
        turns.length = Math.min(turns.length, TURN_LIMIT); notify();
    }
    /** Public view of a turn: only the newest turn of a chat, unchanged since, can be undone here. */
    function turnView(turn, ctx = getContext()) {
        const latest = turns.find(item => item.identity === turn.identity) === turn;
        let current = null; try { current = stamp(ctx); } catch { /* Treated as changed. */ }
        const stale = !latest || current !== turn.stamp;
        const { undo, ...rest } = turn;
        return { ...clone(rest), latest, stale, undoable: !turn.undone && !stale && !!(undo?.backupId || undo?.snapshot) };
    }
    function hintRegenerate(ctx, source) {
        const chat = ctx.chat ?? [], index = chat.length - 1, reply = chat[index];
        if (!reply || reply.is_user || reply.is_system || Object.hasOwn(source, 'excludedReply') && source.excludedReply !== reply) return;
        const identity = chatIdentity(ctx);
        if (hinted.has(identity)) return;
        const applied = readLinkageState(ctx).applied.some(record => !record.archived && record.source?.index === index && record.source?.identity === identity)
            || turns.some(turn => turn.identity === identity && turn.index === index && !turn.undone);
        if (!applied) return;
        hinted.add(identity);
        if (!rememberHint(identity, hintStorage)) return;
        try { notifyRegenerate('上一版回复的更新不会自动撤回，可在楼层小结中撤回。'); } catch { /* A notice cannot interrupt generation. */ }
    }
    const unsubscribe = operation.subscribe(notify);
    const unsubscribeState = subscribeStateChanges((_event, metadata) => { if (metadata === getContext()?.chatMetadata) notify(); });
    return {
        nativeState2Status:()=>getState2Runtime()?.status()??nativeState2Status(context()),
        updateDiagnostics:()=>getState2Runtime()?.updateDiagnostics()??[],
        clearUpdateDiagnostics:()=>getState2Runtime()?.clearUpdateDiagnostics(),
        inspectStoryReferences:()=>getState2Runtime().inspectStoryReferences(),
        repairStoryReferences:plan=>getState2Runtime().repairStoryReferences(plan),
        retryState2Restore:async()=>{const runtime=getState2Runtime();if(!runtime)throw Error('变量运行时尚未初始化，请刷新插件。');await runtime.restoreChat();const status=runtime.status();if(!runtime.ready())throw Error(status.restoreError||status.message);return status;},
        migrateState2:()=>{const runtime=getState2Runtime();if(!runtime)throw Error('变量 2.0 运行时尚未初始化，请刷新插件。');return runtime.migrate();},
        settings:()=>readLinkageSettings(context()), saveSettings,
        scopeTemplate:()=>readScopeTemplate(context()), saveScopeTemplate,
        modules:()=>{const ctx=context(),settings=readLinkageState(ctx);return adapters.map(a=>({id:a.id,label:a.label,available:moduleAvailable(ctx,a.id),...modulePolicy(ctx,a.id,settings)}));},
        prompt:()=>buildUpdateRules(context()), dataPrompt:()=>buildDataPrompt(context()), dataPromptReport:()=>buildDataPromptReport(context()), references:()=>buildReferenceIndex(rawData(context()),readLinkageState(context()).links),
        saveLinks(links){
            const ctx=context(),known=new Set(buildReferenceIndex(rawData(ctx)).entities.map(item=>item.id)),old=readLinkageState(ctx).links;
            for(const link of links)if(!old.some(value=>same(value,link))&&(!known.has(link.from)||!known.has(link.to)))throw Error('新的手动关联必须选择当前存在的条目。');
            return saveSettings({...readLinkageSettings(ctx),links:clone(links)});
        },
        stage, preview, confirm, discard(){operation.discard();pending=null;message='已取消预览。';notify();},
        async retrySave(){try{return await operation.retrySave();}finally{message=operation.status();notify();}},
        busy:()=>templateBusy || operation.busy(), dirty:operation.dirty, status:()=>[message||operation.status(),hostMessage].filter(Boolean).join('\n'), context,
        reportHost(value){hostMessage=String(value??'');notify();},
        suggestions:()=>[...candidates.values()].filter(c=>c.source.identity===chatIdentity(getContext())).map(({id,source,text})=>({id,source:clone(source),text})),
        stageSuggestion(id){const candidate=candidates.get(id);if(!candidate)throw Error('更新建议已失效。');return stage(candidate.text,{candidate});},
        captureGeneration, collectReply, cancelGeneration(){generation=null;},
        rejections:()=>clone(rejections), clearRejections(){rejections.length=0;notify();},
        turns(){const ctx=getContext();let identity=null;try{identity=chatIdentity(ctx);}catch{return [];}return turns.filter(turn=>turn.identity===identity).map(turn=>turnView(turn,ctx));},
        turnFor(index,swipe){const ctx=getContext();let identity=null;try{identity=chatIdentity(ctx);}catch{return null;}const turn=turns.find(item=>item.identity===identity&&item.index===index&&item.swipe===(swipe??0));return turn?turnView(turn,ctx):null;},
        /** What the saves restore flow needs to undo a turn: a ring backup id or an in-memory snapshot. */
        undoTarget(id){const turn=turns.find(item=>item.id===id);if(!turn)throw Error('这一轮更新记录已不存在。');const view=turnView(turn);if(!view.undoable)throw Error(turn.undone?'这一轮已经撤回。':'之后已有新的更新，请前往跨应用存档选择要恢复的记录。');return turn.undo.backupId?{id:turn.undo.backupId}:{snapshot:clone(turn.undo.snapshot)};},
        markUndone(id){const turn=turns.find(item=>item.id===id);if(turn){turn.undone=true;notify();}},
        subscribe(callback){listeners.add(callback);return()=>listeners.delete(callback);},
        dispose(){disposed=true;generation=null;candidates.clear();unsubscribe();unsubscribeState();operation.dispose();listeners.clear();},
    };
}
let shared;
export const getSharedService = () => shared ??= createLinkageService();
