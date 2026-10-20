import { saveChatMetadata } from '../shared/chat-save.js';
import { chatRevision } from '../shared/chat-revision.js';
import { KEY, readStore, readCurrentScene, visibleEvents, transition, appendEvent, mapReferences, characterReferences, assertReferences, scheduleForecast, absencePreview, floorGameTime, currentPrompt, createSceneId } from './model.js';
import { acquireMetadataWrite, publishExternalMetadataChange, subscribeStateChanges } from '../shared/operations.js';
import { prepareState2ManualWrite } from '../state2/runtime.js';
import { isIndependent, legacyModule } from '../story-state/access.js';
import { promptInjectors } from '../linkage/injectors.js';
export const PROMPT_KEY = 'amin-os-scene-time';
const clone = value => structuredClone(value);
const identity = ctx => JSON.stringify([ctx?.groupId != null ? ['group', ctx.groupId] : ['character', ctx?.characters?.[ctx?.characterId]?.avatar ?? ctx?.characterId ?? null], ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null]);
const loaded = ctx => ctx?.chatMetadata && typeof ctx.chatMetadata === 'object' && (ctx.getCurrentChatId?.() ?? ctx.chatId) != null && (ctx.getCurrentChatId?.() ?? ctx.chatId) !== '';
const references = ctx => JSON.stringify([legacyModule(ctx,'characters','amin_os_characters_v1') ?? null, legacyModule(ctx,'map','dynamicMapV1') ?? null]);
const needsReferences = op => ['save-scene', 'save-schedule', 'confirm-presence'].includes(op);
export function createSceneService(getContext = () => globalThis.SillyTavern?.getContext?.(), { createId = createSceneId, now = () => new Date().toISOString(), poll = false } = {}) {
    const listeners = new Set(), dirty = new WeakSet(), removers = [];
    let pending = null, busy = false, disposed = false, lastScope = null, lastMessage = '', epoch = 0, publishing = false;
    const notify = () => { for (const callback of listeners) { try { callback(); } catch { /* A view must not interrupt persistence. */ } } };
    let injector = null;
    const clearPrompt = () => injector.clear();
    function capture() {
        const ctx = getContext();
        if (disposed) throw Error('场景服务已关闭。');
        if (!loaded(ctx)) throw Error('请先打开一个聊天。');
        return { identity: identity(ctx), metadata: ctx.chatMetadata, path: chatRevision(ctx.chat), basis: JSON.stringify(isIndependent(ctx)?readCurrentScene(ctx):ctx.chatMetadata[KEY] ?? null), references: references(ctx), epoch };
    }
    function check(token, { checkBasis = true, checkReferences = false } = {}) {
        const current = capture();
        if (!token || token.identity !== current.identity || token.metadata !== current.metadata || token.path !== current.path || token.epoch !== current.epoch) throw Error('聊天或消息候选已变化，请在当前剧情重新预览。');
        if (checkBasis && token.basis !== current.basis) throw Error('场景资料已变化，请重新预览。');
        if (checkReferences && token.references !== current.references) throw Error('人物或地图资料已变化，请重新预览。');
        return getContext();
    }
    function sync() {
        if (disposed) return;
        const ctx = getContext(), next = loaded(ctx) ? { identity: identity(ctx), metadata: ctx.chatMetadata, path: chatRevision(ctx.chat), basis: JSON.stringify(isIndependent(ctx)?readCurrentScene(ctx):ctx.chatMetadata[KEY] ?? null), references: references(ctx) } : null;
        const changed = next?.identity !== lastScope?.identity || next?.metadata !== lastScope?.metadata || next?.path !== lastScope?.path || next?.basis !== lastScope?.basis || next?.references !== lastScope?.references;
        if (!changed) return;
        clearPrompt();
        const moved = next?.identity !== lastScope?.identity || next?.metadata !== lastScope?.metadata || next?.path !== lastScope?.path;
        if (moved) { epoch++; if (pending) lastMessage = '聊天或消息候选已变化，待确认操作已取消。'; }
        if (moved || next?.basis !== lastScope?.basis || needsReferences(pending?.op)) pending = null;
        lastScope = next; notify();
    }
    async function persist(ctx, token, value) {
        check(token, { checkBasis: false });
        try { await saveChatMetadata(ctx); }
        catch (error) { throw Error(`操作已记入当前聊天，但保存失败：${error?.message ?? '未知错误'}。请重试保存；不会再次推进时间。`); }
        check(token, { checkBasis: false });
        if (ctx.chatMetadata[KEY] === value || isIndependent(ctx)) dirty.delete(ctx.chatMetadata);
    }
    function stage(op, data, token = capture()) {
        if (busy) throw Error('正在保存，请稍候。');
        const ctx = check(token, { checkReferences: needsReferences(op) }), at = now(), eventId = createId();
        assertReferences(ctx, op, data);
        const result = transition(readCurrentScene(ctx), op, clone(data), { at, sceneId: op === 'save-scene' && !data.scene?.id ? createId() : undefined,
            entryId: ['save-schedule', 'save-absence-rule'].includes(op) && !(data.schedule?.id || data.rule?.id) ? createId() : undefined });
        pending = { ...result, op, eventId, at, token };
        lastMessage = '请核对预览，确认后才更新当前剧情。'; notify(); return preview();
    }
    function preview() { if (!pending) return null; const { token, ...result } = pending; return clone(result); }
    async function confirm() {
        if (busy) throw Error('正在保存，请稍候。');
        if (!pending) throw Error('没有待确认的操作。');
        const operation = pending, ctx = check(operation.token, { checkReferences: needsReferences(operation.op) });
        if (typeof ctx.saveMetadata !== 'function') throw Error('当前酒馆缺少聊天保存接口。');
        const value = appendEvent(readStore(ctx), ctx.chat, operation, operation);
        const release = acquireMetadataWrite(getContext);
        // Consume before persistence: failure retries only saving, never the transition.
        pending = null; busy = true;
        try {
            const previous = ctx.chatMetadata[KEY], existed = Object.hasOwn(ctx.chatMetadata, KEY);
            ctx.chatMetadata[KEY] = value;
            try { prepareState2ManualWrite(ctx, [[KEY]]); }
            catch (error) {
                if (ctx.chatMetadata[KEY] === value) {
                    if (existed) ctx.chatMetadata[KEY] = previous; else delete ctx.chatMetadata[KEY];
                }
                pending = operation;
                throw error;
            }
            dirty.add(ctx.chatMetadata); clearPrompt();
            lastScope = { ...operation.token, basis: JSON.stringify(isIndependent(ctx)?operation.state:value) };
            // Time-derived effects refresh immediately, including while disk persistence is pending.
            publishing = true;
            try { publishExternalMetadataChange(() => ctx, [[KEY]], { operationId: operation.eventId }); }
            finally { publishing = false; }
            lastMessage = '正在保存已确认的场景与时间。'; notify();
            await persist(ctx, operation.token, value);
            check(operation.token, { checkBasis: false }); lastMessage = '已保存。';
            return clone(operation.state);
        } catch (error) { lastMessage = error.message; throw error; }
        finally { release(); busy = false; sync(); notify(); }
    }
    async function retrySave() {
        if (busy) throw Error('正在保存，请稍候。');
        const token = capture(), ctx = check(token), value = ctx.chatMetadata[KEY];
        if (typeof ctx.saveMetadata !== 'function') throw Error('当前酒馆缺少聊天保存接口。');
        if (!dirty.has(ctx.chatMetadata)) return;
        const release = acquireMetadataWrite(getContext);
        busy = true; notify();
        try { await persist(ctx, token, value); check(token, { checkBasis: false }); lastMessage = '已重新保存，时间没有再次推进。'; }
        catch (error) { lastMessage = error.message; throw error; }
        finally { release(); busy = false; sync(); notify(); }
    }
    const enabled = (type = 'normal', options = {}, dryRun = false) => !(disposed || dryRun || options?.signal?.aborted || !['normal', 'regenerate', 'swipe', 'continue'].includes(type));
    function build(type = 'normal') {
        let prompt = null;
        try {
            if (busy) throw Error('场景与时间正在保存，本轮未附加场景。');
            const ctx = getContext();
            if (!loaded(ctx)) return null;
            let chat = ctx.chat ?? [];
            // The replaced assistant candidate must not contribute facts to its own retry.
            if (['regenerate', 'swipe'].includes(type) && chat.length && !chat.at(-1).is_user) chat = chat.slice(0, -1);
            prompt = currentPrompt({ ...ctx, chat });
            lastMessage = prompt ? `已附加 ${prompt.length} 字符已确认场景与时间。` : '当前分支没有开启读取的场景与时间。';
        } catch (error) { prompt = null; lastMessage = error.message; }
        notify();
        return prompt;
    }
    const initial = getContext(), source = initial?.eventSource, types = initial?.eventTypes ?? initial?.event_types ?? {};
    injector = promptInjectors(getContext).register(PROMPT_KEY, { build, enabled, onError: error => { lastMessage = error.message; notify(); } });
    const supported = injector.supported;
    const clearAndSync = () => { clearPrompt(); sync(); };
    // With host prompt support the shared injector clears on chat switches.
    const handlers = { CHAT_CHANGED: supported ? () => sync() : clearAndSync, MESSAGE_SENT: clearAndSync, MESSAGE_RECEIVED: clearAndSync, MESSAGE_UPDATED: clearAndSync, MESSAGE_DELETED: clearAndSync, MESSAGE_SWIPED: clearAndSync, GENERATION_ENDED: clearAndSync, GENERATION_STOPPED: clearAndSync };
    for (const [name, callback] of Object.entries(handlers)) if (types[name] && source?.on) {
        source.on(types[name], callback); removers.push(() => source.removeListener ? source.removeListener(types[name], callback) : source.off?.(types[name], callback));
    }
    removers.push(subscribeStateChanges((detail, metadata) => {
        const ctx = getContext();
        if (disposed || publishing || detail?.phase !== 'applied' || detail.identity !== identity(ctx) || (metadata && metadata !== ctx?.chatMetadata) || !detail.paths?.some(path => [KEY, 'amin_os_characters_v1', 'dynamicMapV1'].includes(path[0]))) return;
        if (!detail.paths.some(path => path[0] === KEY)) { sync(); return; }
        // A restore or travel operation can replace the scene without a host message event.
        epoch++; pending = null; clearPrompt();
        lastScope = loaded(ctx) ? { identity: identity(ctx), metadata: ctx.chatMetadata, path: chatRevision(ctx.chat), basis: JSON.stringify(ctx.chatMetadata[KEY] ?? null), references: references(ctx) } : null;
        lastMessage = '场景与时间已由其他应用更新，待确认预览已取消。请重新核对当前剧情。'; notify();
    }));
    const timer = poll ? setInterval(sync, 800) : null;
    sync();
    return { context: getContext, capture, check, sync, stage, preview, confirm, retrySave, supported,
        read: () => readCurrentScene(getContext()), history: () => visibleEvents(getContext()), mapReferences: () => mapReferences(getContext()),
        characterReferences: () => characterReferences(getContext()), forecast: clock => scheduleForecast(getContext(), clock), absencePreview: clock => absencePreview(readCurrentScene(getContext()), clock), floorGameTime: floor => floorGameTime(getContext(), floor),
        discard() { pending = null; lastMessage = '已取消预览。'; notify(); },
        status: () => lastMessage, busy: () => busy, dirty: () => !!getContext()?.chatMetadata && dirty.has(getContext().chatMetadata),
        subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
        dispose() { disposed = true; pending = null; injector.dispose(); clearInterval(timer); for (const remove of removers) remove(); listeners.clear(); },
    };
}
let shared;
export function getSharedSceneService(getContext) { return shared ??= createSceneService(getContext, { poll: true }); }
