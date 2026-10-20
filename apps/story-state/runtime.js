import { STATE_KEY, isIndependent, toLegacyContext, extractModules, clearStoryDrafts, registerStoryManualPreparation } from './access.js';
import { emptyState, validateState, normalizeModules, stateHash, STATE_FORMAT } from './schema.js';
import { createIndependentBackups } from './backups.js';
import { createIndependentMigration } from './migration.js';
import { registerOperationPatchExpansion, createOperationService, chatIdentity, subscribeStateChanges, publishExternalMetadataChange } from '../shared/operations.js';
import { registerChatSavePreparation } from '../shared/chat-save.js';
import { assertChatReady, isChatReady } from '../shared/chat-lifecycle.js';
import { compactLinkageReceipts } from '../linkage/policy.js';

const copy = value => structuredClone(value);
export const LEGACY_STORY_KEYS = Object.freeze([
    'amin_os_characters_v1','amin_os_inventory_v1','amin_os_relationships_v1','amin_os_scene_v1',
    'amin_os_effects_v1','amin_os_journal_v1','amin_os_information_v1','amin_os_dice_v1',
    'dynamicMapV1','amin_os_organizations_v1','world_status_hud_history_v1',
    'amin_os_organizations_history_v1','dynamicMapPositionHistoryV1',
]);
const keys = new Set(LEGACY_STORY_KEYS);
const ownedVariables = new Set(['状态栏','势力资料','AminOS人物','AminOS背包','AminOS关系','AminOS场景','AminOS剧情','AminOS效果','AminOS地图','AminOS信息','AminOS骰子']);
const storyPath = path => path[0] === STATE_KEY || keys.has(path[0]) || path[0] === 'variables' && ownedVariables.has(path[1]);
const ignoredPath = path => ['LWB_RULES_V2','extensions','world_status_hud_history_v1','amin_os_organizations_history_v1','dynamicMapPositionHistoryV1'].includes(path[0]);
const put = (metadata, patch) => {
    let target = metadata;
    for (const key of patch.path.slice(0,-1)) target = target[key] ??= {};
    if (patch.remove) delete target[patch.path.at(-1)]; else target[patch.path.at(-1)] = copy(patch.value);
};

/** Current typed state only. No message identities, variable engine or replay. */
export function createStoryStateRuntime(getContext = () => globalThis.SillyTavern?.getContext?.(), { report = () => {}, backups, migration } = {}) {
    const backupService = backups ?? createIndependentBackups(getContext);
    const importer = migration ?? createIndependentMigration(getContext);
    const operation = createOperationService(getContext), originals = new WeakMap(), previousStates = new WeakMap(), legacyArchives = new WeakMap();
    let message = '', disposed = false, replacingInvalid = false;
    function context() {
        const ctx = getContext(); assertChatReady(ctx);
        if (!ctx?.chatMetadata || !Array.isArray(ctx.chat) || !(ctx.getCurrentChatId?.() ?? ctx.chatId)) throw Error('请先打开一个聊天。');
        return ctx;
    }
    function remember(ctx) {
        originals.set(ctx.chatMetadata, {identity:chatIdentity(ctx),variables:copy(ctx.chatMetadata.variables ?? {})});
    }
    function retainPrevious(ctx, before, after) {
        if (before && stateHash(before) !== stateHash(after)) previousStates.set(ctx.chatMetadata, {before:copy(before), revision:after.revision});
    }
    function expand(ctx, patches) {
        const direct = patches.find(patch => patch.path[0] === STATE_KEY);
        if (!isIndependent(ctx) && !direct) {
            if (patches.some(patch => storyPath(patch.path))) throw Error('请先在设置 → 剧情存储中预览导入旧资料，或开始空白剧情资料。');
            return patches;
        }
        if (!patches.some(patch => storyPath(patch.path))) return patches.filter(patch => !ignoredPath(patch.path));
        let before = null;
        if (isIndependent(ctx)) {
            try { before = validateState(ctx.chatMetadata[STATE_KEY]); }
            catch (error) { if (!replacingInvalid || !direct) throw error; }
        }
        let modules;
        if (direct) {
            if (direct.path.length !== 1 || direct.remove) throw Error('请使用完整的 Amin 状态更新或重置操作。');
            modules = validateState(direct.value).modules;
        } else {
            const shadow = toLegacyContext(ctx);
            for (const patch of patches) if (!ignoredPath(patch.path)) put(shadow.chatMetadata, patch);
            modules = normalizeModules(extractModules(shadow, before.modules));
        }
        const next = validateState({version:1,revision:(before?.revision ?? -1)+1,updatedAt:new Date().toISOString(),modules});
        retainPrevious(ctx,before,next);
        const result = [{path:[STATE_KEY],value:next}, ...patches.filter(patch => !storyPath(patch.path) && !ignoredPath(patch.path))];
        if (!isIndependent(ctx)) {
            const archiveKeys=[...LEGACY_STORY_KEYS,'amin_os_linkage_v1'];
            const source=Object.fromEntries(archiveKeys.filter(key=>Object.hasOwn(ctx.chatMetadata,key)).map(key=>[key,copy(ctx.chatMetadata[key])]));
            if (Object.keys(source).length) {
                if (backupService.available() && typeof backupService.archiveLegacy === 'function') legacyArchives.set(ctx.chatMetadata,source);
                else result.push({path:['amin_os_legacy_source_v1'],value:source});
            }
            if (ctx.chatMetadata.amin_os_linkage_v1) result.push({path:['amin_os_linkage_v1'],value:compactLinkageReceipts(ctx.chatMetadata.amin_os_linkage_v1)});
        }
        if (!isIndependent(ctx) && Array.isArray(ctx.chatMetadata.amin_os_effects_v1?.skills) && ctx.chatMetadata.amin_os_effects_v1.skills.length)
            result.push({path:['amin_os_imported_skills_v1'],value:copy(ctx.chatMetadata.amin_os_effects_v1.skills)});
        // Old app event caches are removed once; their files and native variables
        // stay untouched. Existing editors use ephemeral legacy-shaped drafts.
        for (const key of LEGACY_STORY_KEYS) if (Object.hasOwn(ctx.chatMetadata,key)) result.push({path:[key],remove:true});
        return result;
    }
    const removeExpansion = registerOperationPatchExpansion(expand, ctx => isIndependent(ctx) ? [[STATE_KEY]] : [], ctx => {
        if (isIndependent(ctx) && !replacingInvalid) validateState(ctx.chatMetadata[STATE_KEY]);
        remember(ctx);
    });
    const removeSave = registerChatSavePreparation(async ctx => {
        if (!isIndependent(ctx)) return;
        const state = validateState(ctx.chatMetadata[STATE_KEY]), pending = previousStates.get(ctx.chatMetadata);
        const source = legacyArchives.get(ctx.chatMetadata);
        if (source) {
            const archived = await backupService.archiveLegacy(ctx,source);
            if (archived.disabled) throw Error('旧资料原件尚未完成归档，请恢复本机文件存储后重试保存。');
            if (legacyArchives.get(ctx.chatMetadata) === source) legacyArchives.delete(ctx.chatMetadata);
        }
        if (pending && pending.revision === state.revision) {
            await backupService.savePrevious(ctx,pending.before);
            if (previousStates.get(ctx.chatMetadata) === pending) previousStates.delete(ctx.chatMetadata);
        }
        const identity = chatIdentity(ctx), signature = stateHash(state), metadata = ctx.chatMetadata;
        return () => {
            const current = getContext();
            if (current?.chatMetadata !== metadata || chatIdentity(current) !== identity || stateHash(metadata[STATE_KEY]) !== signature) throw Error('保存期间聊天或当前资料已变化，请返回原聊天重试保存。');
        };
    });
    // Subscribers still consume logical module paths even though storage has
    // exactly one root. Announce those paths without writing duplicate stores.
    const removeEvents = subscribeStateChanges((event, metadata) => {
        if (disposed || metadata !== getContext()?.chatMetadata || !event.paths.some(path => path[0] === STATE_KEY)) return;
        publishExternalMetadataChange(getContext,[...LEGACY_STORY_KEYS.map(key=>key==='amin_os_organizations_v1'?[key,'locks']:[key]),['variables','状态栏'],['variables','势力资料']],{phase:event.phase,operationId:event.operationId});
    });
    function prepareManual(ctx, paths) {
        if (!isIndependent(ctx)) throw Error('请先在剧情存储中导入旧资料或开始空白资料。');
        const before = copy(ctx.chatMetadata[STATE_KEY]), temp = paths.map(path => {
            let value = ctx.chatMetadata;
            for (const key of path) value = value?.[key];
            return value === undefined ? {path,remove:true} : {path,value:copy(value)};
        });
        const variables = originals.get(ctx.chatMetadata)?.variables ?? {};
        const patches = expand(ctx,temp);
        for (const patch of patches) put(ctx.chatMetadata,patch);
        for (const path of paths) if (path[0] === 'variables' && ownedVariables.has(path[1])) {
            if (Object.hasOwn(variables,path[1])) ctx.chatMetadata.variables[path[1]] = copy(variables[path[1]]);
            else delete ctx.chatMetadata.variables[path[1]];
        }
        clearStoryDrafts(ctx);
        return () => { ctx.chatMetadata[STATE_KEY] = before; previousStates.delete(ctx.chatMetadata); clearStoryDrafts(ctx); };
    }
    const removeManual = registerStoryManualPreparation(prepareManual);
    async function commit(modules,label,{discardInvalid=false}={}) {
        const ctx = context(); let old = null;
        if (isIndependent(ctx)) try { old=validateState(ctx.chatMetadata[STATE_KEY]); } catch(error) {if(!discardInvalid)throw error;}
        const next = validateState({...(old ?? emptyState()),modules:normalizeModules(modules)});
        replacingInvalid = discardInvalid;
        try {
            operation.stage({label,patches:[{path:[STATE_KEY],value:next}]});
            await operation.confirm(); message = label+'已保存。'; report(message); return status();
        } finally { replacingInvalid=false; }
    }
    function ready(ctx = getContext()) {
        if (!isChatReady(ctx) || !isIndependent(ctx)) return false;
        try { validateState(ctx.chatMetadata[STATE_KEY]); return true; } catch { return false; }
    }
    function status() {
        const ctx = getContext(), independent = isIndependent(ctx), backup = backupService.status?.() ?? {};
        let error = '';
        if (independent) try { validateState(ctx.chatMetadata[STATE_KEY]); } catch (cause) { error = cause.message; }
        return {independent,enabled:independent,migrated:independent,available:true,backupAvailable:backup.available ?? backupService.available(),
            ready:ready(ctx),currentOnly:true,mode:'independent',restoring:false,restoreError:error,requiresImport:!independent,
            backupCount:backup.count ?? 0,backupLimit:backup.limit ?? 10,revision:ctx?.chatMetadata?.[STATE_KEY]?.revision ?? null,
            message:error||message||(independent?`Amin 独立剧情资料已启用；聊天内只保存当前资料，最近 ${backup.limit ?? 10} 份备份与检查点保存在外部存储。`:'请预览导入旧资料，或开始空白剧情资料；聊天正文可照常生成。')};
    }
    const api = {
        ready,status,prepareManual,prepareGeneration:()=>ready(),
        previewLegacy:source=>importer.previewLegacy(typeof source === 'object' ? source : {source:source??'app'}),previewImport:raw=>importer.previewImport(raw),
        async applyPreview(plan) { const result=importer.validatePreview(plan); return commit(result.modules ?? result,'导入剧情资料',{discardInvalid:true}); },
        initializeEmpty:()=>commit(emptyState().modules,'开始空白剧情资料',{discardInvalid:true}),reset:()=>commit(emptyState().modules,'重置当前剧情资料',{discardInvalid:true}),
        listBackups:()=>backupService.list(),async previewBackup(id) {
            // Ring entries hold save snapshots; any kind (automatic, pre-restore, pre-change) previews as a story import.
            const entry=await backupService.load(context(),id),modules=entry.snapshot.modules;
            const state={version:1,revision:entry.revision ?? 0,updatedAt:entry.snapshot.createdAt,modules};
            return importer.previewImport({format:STATE_FORMAT,version:1,state});
        },
        exportState:()=>({format:STATE_FORMAT,version:1,state:validateState(context().chatMetadata[STATE_KEY])}),
        retrySave:()=>operation.retrySave(),storyStatus:status,storyAvailable:()=>backupService.available(),
        saveBackup:label=>backupService.savePrevious(context(),validateState(context().chatMetadata[STATE_KEY]),{label:label??'手动备份'}),
        archiveStory:()=>api.saveBackup(),
        exportLegacySource:()=>getContext()?.chatMetadata?.amin_os_legacy_source_v1
            ? {format:'amin-os-legacy-source',version:1,sources:copy(getContext().chatMetadata.amin_os_legacy_source_v1)} : backupService.exportLegacy(context()),
        sync:()=>ready(),reconcile:()=>ready(),collectReply:()=>null,restoreChat:async()=>status(),
        migrate:()=>{throw Error('请先在剧情存储中预览导入旧资料，再确认应用。');},
        updateDiagnostics:()=>[],clearUpdateDiagnostics:()=>{},inspectStoryReferences:()=>({mode:'independent',message:'独立存储不使用楼层或 Swipe 存档引用。'}),
        switchToCurrentStory:()=>status(),resetCurrentStory:()=>api.reset(),inspectCurrentStoryBackups:()=>api.listBackups(),
        destroy() {disposed=true;removeExpansion();removeSave();removeEvents();removeManual();operation.dispose();},
    };
    const initial=getContext();if(initial?.chatMetadata)remember(initial);
    return api;
}
