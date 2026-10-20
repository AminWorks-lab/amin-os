import { createDemoDocument } from '../core/demo.js';
import { validateDocument } from '../core/protocol.js';
import { createOperationService, subscribeStateChanges, acquireMetadataWrite, chatIdentity as operationIdentity } from '../../../shared/operations.js';
import { prepareState2ManualWrite } from '../../../state2/runtime.js';
import { saveChatMetadata } from '../../../shared/chat-save.js';
import { isIndependent, legacyModule, registerModuleCodec, STATE_KEY } from '../../../story-state/access.js';

export const STORAGE_KEY = 'dynamicMapV1';

registerModuleCodec('map', {
    toLegacy(ctx, snapshot) { return snapshot == null ? {} : { [STORAGE_KEY]: { updatedAt: ctx.chatMetadata?.[STATE_KEY]?.revision ?? 0, document: structuredClone(validateDocument(snapshot)) } }; },
    fromLegacy(ctx) { const raw = ctx.chatMetadata?.[STORAGE_KEY]; return raw == null ? null : structuredClone(validateDocument(raw.document)); },
});
export function chatIdentity(ctx) {
    const chat = ctx?.getCurrentChatId?.();
    if (chat === null || chat === undefined || chat === '') return null;
    const owner = ctx.groupId != null ? ['group', String(ctx.groupId)]
        : ['character', ctx.characters?.[ctx.characterId]?.avatar];
    if (!owner[1]) return null;
    return JSON.stringify([...owner, String(chat)]);
}

/** Synchronous binding changes; async save completions cannot write another chat. */
export function bindChatStore(store, { getContext, storage, namespace, report = () => {} }) {
    let binding = null, loading = false, disposed = false, generation = 0;
    const operations = createOperationService(getContext);
    const settledListeners = new Set();
    const keyFor = id => `dynamic-map.chat.${namespace}.${id}`;
    function ensureBound() {
        if (!binding || chatIdentity(getContext()) !== binding.id || getContext().chatMetadata !== binding.metadata) {
            throw new Error('聊天已切换或尚未打开，请重新打开地图后操作');
        }
    }
    function ensureReadable() {
        ensureBound();
        if (binding.invalid) throw new Error('保存的地图格式无效，请先导出原始数据备份，再导入有效地图');
    }
    function ensureWritable(recovery = false) {
        if (recovery) ensureBound(); else ensureReadable();
        if (operations.busy()) throw new Error('当前聊天正在保存，请稍候再修改地图');
        if (operations.dirty()) throw new Error('当前聊天的联合操作尚未保存，请重试保存后再修改地图');
        const descriptor = Object.getOwnPropertyDescriptor(binding.metadata, STORAGE_KEY);
        if ((descriptor && (!('value' in descriptor) || !descriptor.writable)) || (!descriptor && !Object.isExtensible(binding.metadata))) throw new Error('当前聊天地图资料不可写');
    }
    const ensureActive = ensureReadable;
    store.setGuard(ensureWritable);
    function currentReport(text, target = binding) { if (!disposed && binding === target) report(text); }
    function switchChat() {
        generation++;
        const ctx = getContext(), id = chatIdentity(ctx);
        binding = id && ctx.chatMetadata ? { id, metadata: ctx.chatMetadata, revision: 0, invalid: false, saves: 0 } : null;
        let document = createDemoDocument();
        loading = true;
        try {
            if (binding) {
                const saved = legacyModule(ctx, 'map', STORAGE_KEY);
                let raw = null;
                try { raw = storage.getItem(keyFor(id)); } catch { /* Metadata remains usable. */ }
                binding.raw = { metadata: saved ?? null, localRaw: raw };
                // A 0.16 State 2.0 chat (amin_os_state2_v1) projected the map into
                // metadata; that copy stays authoritative over a browser cache.
                const native = isIndependent(ctx) || Object.hasOwn(ctx.chatMetadata, 'amin_os_state2_v1');
                const cached = !native && raw ? JSON.parse(raw) : null;
                // A migrated State 2.0 root is authoritative after branch restore.
                // A newer browser cache belongs to an earlier view of the chat.
                const candidate = native ? saved
                    : cached && !cached.synced && (!saved || cached.updatedAt > saved.updatedAt) ? cached : saved;
                binding.raw = candidate;
                if (candidate) document = structuredClone(validateDocument(candidate.document));
                currentReport(candidate ? '已载入当前聊天地图' : '当前为初始地图，点击“保存地图”后保存到聊天');
            } else report('请先打开一个聊天；当前为只读示例');
        } catch (error) {
            if (binding) binding.invalid = true;
            currentReport(`地图载入失败，原数据未覆盖：${error.message}`);
        }
        try { store.replace(document); } finally { loading = false; }
    }
    async function persist(document, retry = false) {
        if (loading || disposed) return;
        ensureWritable();
        const release = acquireMetadataWrite(getContext);
        const target = binding, revision = ++target.revision;
        let cached = false;
        target.saves++;
        try {
            // Retrying an unsaved envelope must not mint another map revision or
            // repeat its State 2.0 checkpoint. A changed draft is a new write.
            const existing = retry && target.metadata[STORAGE_KEY]?.document
                && JSON.stringify(target.metadata[STORAGE_KEY].document) === JSON.stringify(document)
                ? target.metadata[STORAGE_KEY] : null;
            const envelope = existing ?? { updatedAt: Math.max(Date.now(), (target.raw?.updatedAt ?? 0) + 1), document };
            if (!existing) {
                const before = target.metadata[STORAGE_KEY], existed = Object.hasOwn(target.metadata, STORAGE_KEY);
                const next = structuredClone(envelope);
                target.metadata[STORAGE_KEY] = next;
                try { prepareState2ManualWrite(getContext(), [[STORAGE_KEY]]); }
                catch (error) {
                    if (target.metadata[STORAGE_KEY] === next) {
                        if (existed) target.metadata[STORAGE_KEY] = before; else delete target.metadata[STORAGE_KEY];
                    }
                    throw error;
                }
            }
            target.raw = structuredClone(envelope);
            try { storage.setItem(keyFor(target.id), JSON.stringify(envelope)); cached = true; } catch { /* Metadata remains usable. */ }
            currentReport(cached ? '本地已保存，正在同步聊天…' : '本地副本不可用，正在保存聊天…', target);
            // Call immediately with the current context, never from a delayed save queue.
            const ctx = getContext();
            if (typeof ctx.saveMetadata !== 'function') throw new Error('酒馆未提供保存接口');
            await saveChatMetadata(ctx);
            if (binding === target && target.revision === revision && chatIdentity(getContext()) === target.id && getContext().chatMetadata === target.metadata) {
                try { storage.setItem(keyFor(target.id), JSON.stringify({ ...envelope, synced: true })); } catch { /* Keep server result. */ }
                currentReport('已保存到当前聊天', target);
            }
        } catch (error) {
            if (target.revision === revision) currentReport(`${cached ? '本地副本已保留' : '保存失败，请立即导出备份'}；聊天同步失败：${error.message}`, target);
        } finally {
            target.saves--; release();
            if (!disposed && binding === target && target.revision === revision) for (const callback of [...settledListeners]) { try { callback(); } catch { /* A derived view cannot interrupt persistence. */ } }
        }
    }
    // Travel/restore already patched authoritative metadata. Replacing the live
    // view must not re-persist it or revive a newer unsynced local cache.
    function applyExternalMetadata(detail, eventMetadata) {
        if (disposed || !detail.paths.some(path => path[0] === STORAGE_KEY || path[0] === STATE_KEY)) return;
        const ctx = getContext();
        if (!binding || binding.metadata !== ctx.chatMetadata || (eventMetadata && eventMetadata !== ctx.chatMetadata) || binding.id !== chatIdentity(ctx) || detail.identity !== operationIdentity(ctx)) return;
        if (!['applied', 'saved'].includes(detail.phase)) return;
        const raw = legacyModule(ctx, 'map', STORAGE_KEY);
        let document;
        try {
            document = raw === undefined ? createDemoDocument() : structuredClone(validateDocument(raw.document));
        } catch (error) { binding.invalid = true; currentReport('外部地图资料无法载入，原记录保留：' + error.message); return; }
        // Independent commits announce logical app paths together. A change in
        // another app must not replace this map's unsaved editing session.
        if (isIndependent(ctx) && detail.phase === 'applied' &&
            (raw === undefined && binding.raw === undefined || JSON.stringify(raw?.document) === JSON.stringify(binding.raw?.document))) return;
        if (detail.phase === 'applied') {
            generation++; binding.revision++; binding.invalid = false; binding.raw = structuredClone(raw);
            loading = true;
            try { store.replace(document); } finally { loading = false; }
        }
        try { storage.setItem(keyFor(binding.id), raw === undefined ? 'null' : JSON.stringify({ ...raw, synced: detail.phase === 'saved' })); }
        catch { currentReport('地图已更新，但本地恢复副本无法写入'); }
        currentReport(detail.phase === 'saved' ? '联合操作已保存，地图已同步' : '地图已同步到已确认操作，正在保存');
    }
    const unsubscribeExternal = subscribeStateChanges(applyExternalMetadata);
    const unsubscribe = store.subscribe(persist);
    switchChat();
    return {
        switchChat, ensureActive, ensureReadable, ensureWritable, ensureBound, scope: () => binding?.id ?? null, namespace,
        saving: () => !!binding?.saves,
        suspended: () => loading || operations.busy() || operations.dirty(),
        subscribeSettled(callback) { settledListeners.add(callback); return () => settledListeners.delete(callback); },
        token: () => generation,
        importDocument(document, token) {
            ensureWritable(true);
            if (token !== generation) throw new Error('导入期间聊天已切换，请重新选择文件');
            const valid = structuredClone(validateDocument(document));
            if (!binding || chatIdentity(getContext()) !== binding.id || getContext().chatMetadata !== binding.metadata) throw new Error('请先打开聊天');
            binding.invalid = false; generation++; store.replace(valid);
        },
        exportDocument: () => binding?.invalid ? (binding.raw ?? binding.metadata[STORAGE_KEY]) : store.snapshot(),
        retry() { ensureActive(); return persist(store.snapshot(), true); },
        destroy() { disposed = true; unsubscribe(); unsubscribeExternal(); operations.dispose(); settledListeners.clear(); store.setGuard(() => { throw new Error('地图已关闭'); }); },
    };
}
