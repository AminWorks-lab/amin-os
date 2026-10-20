import { saveChatMetadata } from '../shared/chat-save.js';
import { uuid } from '../../uuid.js';
import { KEY, readStore, path, compile, sourceFromRange, autoSettings, dueRanges, currentDrafts, putAutoDraft, snapshotJournal } from './model.js';
import { isIndependent } from '../story-state/access.js';
import { draftChronicle } from './draft.js';
import { getAI } from '../../ai/service.js';
import { acquireMetadataWrite, chatIdentity, subscribeStateChanges } from '../shared/operations.js';
import { managesModule } from '../linkage/policy.js';
import { prepareState2ManualWrite } from '../state2/runtime.js';
import { promptInjectors } from '../linkage/injectors.js';

export const PROMPT_KEY = 'amin-os-journal';

export function createJournal(getContext, { ai = getAI } = {}) {
    const listeners = new Set(), pending = new Set(), saved = new WeakMap();
    let busy = false, disposed = false, epoch = 0, autoRunning = false, normalGeneration = false, message = '引用默认关闭；只有已保存且明确启用的条目会附加到后续生成。';
    const identity = ctx => JSON.stringify([ctx?.groupId ?? null, ctx?.characterId ?? null, ctx?.getCurrentChatId?.() ?? null]);
    const stamp = ctx => JSON.stringify(isIndependent(ctx) ? snapshotJournal(readStore(ctx), ctx.chat) : readStore(ctx));
    const notify = event => { for (const callback of listeners) { try { callback(event); } catch { /* A view must not interrupt persistence. */ } } };
    let injector = null;
    const clear = () => injector.clear();

    function capture() {
        const ctx = getContext();
        if (disposed) throw Error('剧情档案已关闭');
        if (!ctx?.chatMetadata || ctx.getCurrentChatId?.() == null) throw Error('请先打开一个聊天');
        return { metadata: ctx.chatMetadata, identity: identity(ctx), path: JSON.stringify(path(ctx.chat)), baseline: stamp(ctx), epoch, operationId: uuid() };
    }

    function check(token) {
        const ctx = getContext();
        if (disposed || !token || token.metadata !== ctx?.chatMetadata || token.identity !== identity(ctx) || token.epoch !== epoch) throw Error('聊天已切换或来源已变化，请重新打开编辑器');
        if (token.path !== JSON.stringify(path(ctx.chat))) throw Error('楼层或回复内容已变化，请重新打开编辑器');
        if (token.baseline !== stamp(ctx)) throw Error('剧情档案已被其他窗口修改，请重新打开编辑器');
        return ctx;
    }

    async function save(token, update) {
        if (saved.has(token)) { const previous = saved.get(token); check(previous.token); return structuredClone(previous.value); }
        if (busy) throw Error('正在保存剧情档案，请稍候');
        const ctx = check(token);
        if (typeof ctx.saveMetadata !== 'function') throw Error('当前前端缺少聊天保存接口');
        const release = acquireMetadataWrite(getContext), metadata = ctx.chatMetadata, before = metadata[KEY];
        let next, nativeRollback, persisted = false, failed = false;
        busy = true;
        try {
            next = update(readStore(ctx), ctx);
            if (!next || next.version !== 1 || !Array.isArray(next.events)) throw Error('待保存档案格式无效');
            const after = { ...token, baseline: JSON.stringify(isIndependent(ctx) ? snapshotJournal(next, ctx.chat) : next) };
            metadata[KEY] = next;
            nativeRollback = prepareState2ManualWrite(ctx, [[KEY]]);
            await saveChatMetadata(ctx);
            persisted = true;
            check(after);
            saved.set(token, { value: structuredClone(next), token: after });
            clear(); message = '剧情档案已保存到当前聊天。';
            return structuredClone(next);
        } catch (error) {
            failed = true;
            if (!persisted && next !== undefined) {
                if (isIndependent(ctx)) nativeRollback?.();
                else if (metadata[KEY] === next) {
                    if (before === undefined) delete metadata[KEY]; else metadata[KEY] = before;
                    nativeRollback?.();
                }
            }
            message = persisted ? '档案已保存到原聊天，但聊天或来源已变化，请重新打开档案。' : '保存失败：' + error.message;
            throw error;
        } finally { release(); busy = false; notify({ type: 'save', error: failed }); }
    }

    async function generateDraft(token, fields, { signal, check: checkForm = () => {} } = {}) {
        const ctx = check(token), controller = new AbortController();
        const onAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.add(controller);
        const frozenFields = structuredClone(fields);
        const guard = () => { check(token); checkForm(); };
        try {
            return await draftChronicle({ ai: ai(), ctx, ...frozenFields,
                sources: sourceFromRange(ctx.chat, frozenFields.start, frozenFields.end), signal: controller.signal, check: guard });
        } finally { pending.delete(controller); signal?.removeEventListener('abort', onAbort); }
    }

    async function generateAutoDraft({ draftId = null, signal } = {}) {
        if (autoRunning) throw Error('正在整理自动编年史，请稍候');
        const token = capture(), ctx = check(token), store = readStore(ctx), settings = autoSettings(store);
        const previous = draftId ? currentDrafts(store, ctx.chat).find(draft => draft.id === draftId && draft.status === 'ready') : null;
        if (draftId && !previous) throw Error('草稿已处理或不在当前分支，请刷新');
        const range = previous ? { start: previous.sources.start, end: previous.sources.end } : dueRanges(store, ctx.chat)[0];
        if (!range) return null;
        autoRunning = true;
        message = `正在整理第 ${range.start + 1}–${range.end + 1} 楼的待确认草稿…`; notify({ type: 'auto' });
        try {
            const title = previous?.title ?? `第 ${range.start + 1}–${range.end + 1} 楼纪要`;
            const body = await generateDraft(token, { ...range, title, current: previous?.body ?? '', instruction: settings.instruction }, { signal });
            const sources = sourceFromRange(check(token).chat, range.start, range.end), id = previous?.id ?? uuid();
            await save(token, (latest, current) => putAutoDraft(latest, current.chat, { id, title, body, sources }, token.operationId));
            message = '自动编年史草稿已就绪；请到“自动整理”核对后确认保存。'; notify({ type: 'auto' });
            return id;
        } finally { autoRunning = false; notify({ type: 'auto' }); }
    }

    function ended() {
        clear(); const shouldRun = normalGeneration; normalGeneration = false;
        if (!shouldRun || disposed || autoRunning || busy) return;
        // Quiet generations and failed/stopped generations never start another AI task.
        return Promise.resolve().then(() => generateAutoDraft()).catch(error => {
            if (disposed) return;
            message = '自动整理未保存：' + error.message; notify({ type: 'auto', error: true });
        });
    }

    // The shared injector clears the prompt first; this gate also records
    // whether the generation may start an automatic chronicle when it ends.
    function enabled(type = 'normal', options = {}, dryRun = false) {
        normalGeneration = !disposed && !dryRun && ['normal', 'regenerate', 'swipe', 'continue'].includes(type) && !options?.signal?.aborted;
        return normalGeneration;
    }
    function build(type = 'normal') {
        let prompt = null;
        try {
            if (busy) throw Error('剧情档案正在保存，本轮未附加引用');
            const ctx = getContext(); let chat = ctx.chat ?? [];
            if (['regenerate', 'swipe'].includes(type) && chat.length && !chat.at(-1).is_user) chat = chat.slice(0, -1);
            prompt = managesModule(ctx, 'journal') ? '' : compile(readStore(ctx), chat);
            message = prompt ? `已附加 ${prompt.length} 字符剧情档案引用` : '当前分支没有启用引用的有效条目';
        } catch (error) { prompt = null; message = error.message; }
        notify({ type: 'prompt' });
        return prompt;
    }

    function invalidate(type, clearPrompt = true) {
        epoch++; normalGeneration = false;
        for (const controller of pending) controller.abort(new Error('聊天或来源已变化'));
        if (clearPrompt) clear();
        message = type === 'chat' ? '已切换聊天，未保存的档案编辑已关闭。' : '楼层或来源已变化，请重新核对档案来源。';
        notify({ type });
    }

    const initial = getContext(), events = initial?.eventTypes ?? initial?.event_types ?? {}, source = initial?.eventSource;
    injector = promptInjectors(getContext).register(PROMPT_KEY, { build, enabled, onError: error => { message = error.message; notify({ type: 'prompt' }); } });
    const supported = injector.supported;
    // Without host prompt support the chat switch still invalidates editors and clears the prompt here.
    const handlers = { CHAT_CHANGED: () => invalidate('chat', !supported), GENERATION_ENDED: ended, GENERATION_STOPPED: () => { normalGeneration = false; clear(); },
        MESSAGE_DELETED: () => invalidate('source'), MESSAGE_SWIPED: () => invalidate('source'), MESSAGE_UPDATED: () => invalidate('source') };
    if (source?.on) for (const [event, callback] of Object.entries(handlers)) if (events[event]) source.on(events[event], callback);
    const unsubscribeState = subscribeStateChanges((detail, metadata) => {
        const ctx = getContext();
        if (disposed || detail?.phase !== 'applied' || detail.identity !== chatIdentity(ctx) || (metadata && metadata !== ctx?.chatMetadata) || !detail.paths?.some(path => path[0] === KEY)) return;
        // Same-content restores also invalidate earlier drafts and cached operation tokens.
        invalidate('source');
    });

    return { capture, check, save, generateDraft, generateAutoDraft, autoBusy: () => autoRunning, supported, context: getContext, read: () => readStore(getContext()), status: () => message, busy: () => busy,
        subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
        dispose() { if (disposed) return; disposed = true; epoch++; for (const controller of pending) controller.abort(); pending.clear(); injector.dispose();
            unsubscribeState();
            for (const [event, callback] of Object.entries(handlers)) if (events[event]) (source?.removeListener ?? source?.off)?.call(source, events[event], callback);
            listeners.clear();
        },
    };
}

let shared;
export const getSharedService = () => shared ??= createJournal(() => globalThis.SillyTavern?.getContext?.());
