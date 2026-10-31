import { KEY, emptyStore, validateStore, createProfile, setNode, addNode, removeNode, moveNode, restoreNode, resetProfile, setOptions, renderForPrompt } from './model.js';
import { candidates, replaceInMessages, replaceInText } from './prompt.js';
import { createOperationService } from '../shared/operations.js';
import { sha256HexSync } from '../tts/source-hash.js';

const copy = value => structuredClone(value);
export const hashDescription = text => 'sha256:' + sha256HexSync(String(text ?? ''));
// SillyTavern builds the prompt from the top-level field; card v2 data mirrors it.
const descriptionOf = card => card?.description ?? card?.data?.description ?? '';

/** Characters taking part in the open chat: the selected card, or every member of the group. */
export function chatCharacters(ctx) {
    const cards = Array.isArray(ctx?.characters) ? ctx.characters : [];
    if (ctx?.groupId != null) {
        const group = (ctx.groups ?? []).find(item => item?.id === ctx.groupId);
        return (group?.members ?? []).map(avatar => cards.find(card => card?.avatar === avatar)).filter(Boolean);
    }
    const card = cards[Number(ctx?.characterId ?? ctx?.this_chid)];
    return card?.avatar ? [card] : [];
}

export function createCardProfileService(getContext = () => globalThis.SillyTavern?.getContext?.(), { notice = message => globalThis.toastr?.warning?.(message, 'Amin 角色卡资料') } = {}) {
    const operation = createOperationService(getContext), listeners = new Set();
    const results = new Map(), warned = new Set();
    let installed = false;
    const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch {} } };
    const context = () => { const ctx = getContext(); if (!ctx?.chatMetadata || !(ctx.getCurrentChatId?.() ?? ctx.chatId)) throw Error('请先打开一个聊天。'); return ctx; };
    const chatKey = ctx => String(ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? '');

    function read(ctx = context()) {
        const raw = ctx.chatMetadata[KEY];
        return raw === undefined ? emptyStore() : validateStore(copy(raw));
    }
    async function write(label, change) {
        const ctx = context(), store = read(ctx);
        change(store);
        validateStore(store);
        operation.stage({ label, patches: [{ path: [KEY], value: store }] });
        await operation.confirm();
        notify();
        return store;
    }
    function card(avatar, ctx = context()) {
        const found = chatCharacters(ctx).find(item => item.avatar === avatar);
        if (!found) throw Error('这个角色不在当前聊天里。');
        return found;
    }
    function profile(avatar, ctx = context()) {
        const value = read(ctx).profiles[avatar];
        if (!value) throw Error('这个角色还没有导入资料。');
        return value;
    }
    const update = (avatar, label, fn) => write(label, store => { store.profiles[avatar] = fn(store.profiles[avatar] ?? profile(avatar)); });

    /** The view model: chat characters with their copy, card-change state and last replacement result. */
    function snapshot() {
        const ctx = context(), store = read(ctx), key = chatKey(ctx);
        return chatCharacters(ctx).map(item => {
            const description = descriptionOf(item), value = store.profiles[item.avatar] ?? null;
            return { avatar: item.avatar, name: item.name ?? item.avatar, description, profile: value,
                cardChanged: !!value && value.sourceHash !== hashDescription(description), result: results.get(key + '\n' + item.avatar) ?? null };
        });
    }
    /** Parse without saving, for the import preview. */
    function preview(avatar) {
        const item = card(avatar), description = descriptionOf(item);
        return createProfile({ avatar, cardName: item.name ?? '', description, hash: hashDescription(description) });
    }
    async function importCard(avatar) {
        const value = preview(avatar);
        await write(`导入角色卡资料：${value.cardName || avatar}`, store => { store.profiles[avatar] = value; });
        return value;
    }
    /** The card description changed: start over from the new card (the old copy is discarded). */
    const reimport = importCard;
    async function keepCopy(avatar) {
        const description = descriptionOf(card(avatar));
        await update(avatar, '保留当前角色资料副本', value => ({ ...value, sourceHash: hashDescription(description) }));
    }
    async function remove(avatar) { await write('删除角色卡资料副本', store => { delete store.profiles[avatar]; }); }

    // ---- prompt replacement ----
    function substitute(ctx) { return typeof ctx.substituteParams === 'function' ? text => ctx.substituteParams(text) : null; }
    function apply(target, dryRun) {
        let ctx; try { ctx = getContext(); } catch { return; }
        if (!ctx?.chatMetadata?.[KEY]) return;
        let store; try { store = read(ctx); } catch (error) { if (!dryRun) notice(`角色卡资料无法读取，本轮按原角色卡发送：${error.message}`); return; }
        const key = chatKey(ctx), macro = substitute(ctx);
        for (const item of chatCharacters(ctx)) {
            const value = store.profiles[item.avatar];
            if (!value?.replace) continue;
            const forms = candidates(descriptionOf(item), macro);
            let text = renderForPrompt(value);
            if (macro) { try { text = macro(text); } catch {} }
            const matched = target(forms, text);
            if (dryRun) continue;
            results.set(key + '\n' + item.avatar, { at: new Date().toISOString(), matched });
            if (!matched && !warned.has(key + '\n' + item.avatar)) {
                warned.add(key + '\n' + item.avatar);
                notice(`没有在发送内容里找到“${item.name}”的角色描述，本轮按原角色卡发送。可能是预设用别的方式引用了描述，详见角色卡资料应用。`);
            }
        }
        if (!dryRun) notify();
    }
    function onChatPrompt(data) { if (data && Array.isArray(data.chat)) apply((forms, text) => replaceInMessages(data.chat, forms, text), !!data.dryRun); }
    function onTextPrompt(data) {
        if (!data || typeof data.prompt !== 'string') return;
        apply((forms, text) => { const result = replaceInText(data.prompt, forms, text); data.prompt = result.prompt; return result.matched; }, !!data.dryRun);
    }
    function install() {
        if (installed) return;
        const ctx = getContext(), ev = ctx?.eventTypes ?? ctx?.event_types ?? {};
        if (!ctx?.eventSource?.on) return;
        if (ev.CHAT_COMPLETION_PROMPT_READY) ctx.eventSource.on(ev.CHAT_COMPLETION_PROMPT_READY, onChatPrompt);
        if (ev.GENERATE_AFTER_COMBINE_PROMPTS) ctx.eventSource.on(ev.GENERATE_AFTER_COMBINE_PROMPTS, onTextPrompt);
        if (ev.CHAT_CHANGED) ctx.eventSource.on(ev.CHAT_CHANGED, notify);
        installed = true;
    }
    return {
        install, read: () => read(), snapshot, preview, importCard, reimport, keepCopy, remove,
        hooks: { onChatPrompt, onTextPrompt },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        set: (avatar, id, fields) => update(avatar, '修改角色资料', value => setNode(value, id, fields)),
        add: async (avatar, parentId, fields) => { let id; await update(avatar, '新增角色资料条目', value => { const result = addNode(value, parentId, fields); id = result.id; return result.profile; }); return id; },
        removeNode: (avatar, id) => update(avatar, '删除角色资料条目', value => removeNode(value, id)),
        move: (avatar, id, offset) => update(avatar, '调整角色资料顺序', value => moveNode(value, id, offset)),
        restore: (avatar, id) => update(avatar, '恢复角色资料初始值', value => restoreNode(value, id)),
        reset: avatar => update(avatar, '角色资料全部恢复初始', value => resetProfile(value)),
        options: (avatar, options) => update(avatar, '修改角色资料发送设置', value => setOptions(value, options)),
        rendered: avatar => renderForPrompt(profile(avatar)),
        status: () => operation.status?.() ?? null,
    };
}

let shared;
export function getSharedCardProfileService() {
    if (!shared) { shared = createCardProfileService(); shared.install(); }
    return shared;
}
