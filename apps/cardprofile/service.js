import { KEY, emptyStore, validateStore, normalizeProfile, LIMITS, createProfile, setNode, addNode, removeNode, moveNode, restoreNode, resetProfile, setOptions, renderForPrompt } from './model.js';
import { candidates, replaceInMessages, replaceInText } from './prompt.js';
import { createOperationService } from '../shared/operations.js';
import { promptInjectors } from '../linkage/injectors.js';
import { buildRules, extract, checkItem, applyItem, undoItem, messageKey, targetAvatar } from './proposals.js';
import { uuid } from '../../uuid.js';
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
        if (raw === undefined) return emptyStore();
        const store = validateStore(copy(raw));
        for (const [avatar, value] of Object.entries(store.profiles)) store.profiles[avatar] = normalizeProfile(value);
        store.proposals ??= [];
        return store;
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
    // ---- AI proposals ----
    function activeProfiles(ctx) {
        let store; try { store = read(ctx); } catch { return []; }
        const avatars = new Set(chatCharacters(ctx).map(item => item.avatar));
        return Object.values(store.profiles).filter(value => value.propose && avatars.has(value.avatar));
    }
    function rules() {
        let ctx; try { ctx = getContext(); } catch { return null; }
        if (!ctx?.chatMetadata?.[KEY]) return null;
        const profiles = activeProfiles(ctx);
        return profiles.length ? buildRules(profiles) : null;
    }
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    /** Record proposals from a finished reply. Retries while another app is saving the chat. */
    async function receive(index) {
        let ctx; try { ctx = getContext(); } catch { return; }
        const message = ctx?.chat?.[Number(index)];
        if (!message || message.is_user || message.is_system || !ctx.chatMetadata?.[KEY]) return;
        const { items, errors } = extract(message.mes);
        if (!items.length) { if (errors.length) notice(errors[0]); return; }
        const profiles = activeProfiles(ctx);
        if (!profiles.length) return;
        const key = messageKey(message, Number(index)), chat = chatKey(ctx);
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                const current = getContext();
                if (chatKey(current) !== chat || current.chat?.[Number(index)] !== message) return;
                await write('记录角色设定建议', store => {
                    if (store.proposals.some(entry => entry.key === key)) return;
                    const groups = new Map();
                    for (const raw of items) {
                        const avatar = targetAvatar(raw, message, profiles);
                        const value = avatar && store.profiles[avatar];
                        if (!value) continue;
                        const item = checkItem(value, raw, uuid());
                        if (item.status === 'locked') continue;
                        if (!groups.has(avatar)) groups.set(avatar, []);
                        groups.get(avatar).push(item);
                    }
                    for (const [avatar, list] of groups) {
                        // 自动应用: valid items go straight into the copy; each can still be undone under the reply.
                        if (store.profiles[avatar].proposeMode === 'auto') for (const item of list) {
                            if (item.status !== 'pending') continue;
                            try { store.profiles[avatar] = applyItem(store.profiles[avatar], item); item.status = 'accepted'; item.auto = true; }
                            catch (error) { item.status = 'invalid'; item.error = error.message; }
                        }
                        store.proposals.push({ id: uuid(), avatar, key, index: Number(index), at: new Date().toISOString(), items: list });
                    }
                    prune(store);
                });
                return;
            } catch (error) {
                if (!['BUSY', 'DIRTY'].includes(error?.code) || attempt === 7) { notice(`角色设定建议没有记录：${error.message}`); return; }
                await wait(400 * (attempt + 1));
            }
        }
    }
    function prune(store) {
        while (store.proposals.length > LIMITS.proposals) {
            const index = store.proposals.findIndex(entry => !entry.items.some(item => item.status === 'pending'));
            store.proposals.splice(index < 0 ? 0 : index, 1);
        }
    }
    function proposalsFor(index) {
        const ctx = context(), message = ctx.chat?.[index];
        if (!message || !ctx.chatMetadata?.[KEY]) return [];
        const key = messageKey(message, index);
        return read(ctx).proposals.filter(entry => entry.key === key);
    }
    async function decide(entryId, itemIds, accept) {
        await write(accept ? '采纳角色设定建议' : '忽略角色设定建议', store => {
            const entry = store.proposals.find(value => value.id === entryId);
            if (!entry) throw Error('这条建议已不存在。');
            for (const item of entry.items) {
                if (!itemIds.includes(item.id) || item.status !== 'pending') continue;
                if (accept) {
                    const value = store.profiles[entry.avatar];
                    if (!value) throw Error('这个角色的副本已删除。');
                    try { store.profiles[entry.avatar] = applyItem(value, item); item.status = 'accepted'; }
                    catch (error) { item.status = 'invalid'; item.error = error.message; }
                } else item.status = 'ignored';
            }
        });
    }
    async function undo(entryId, itemId) {
        await write('撤销角色设定改动', store => {
            const entry = store.proposals.find(value => value.id === entryId), item = entry?.items.find(value => value.id === itemId);
            if (!item || item.status !== 'accepted') throw Error('这条改动已不存在或未应用。');
            const value = store.profiles[entry.avatar];
            if (!value) throw Error('这个角色的副本已删除。');
            store.profiles[entry.avatar] = undoItem(value, item);
            item.status = 'undone';
        });
    }
    function install() {
        if (installed) return;
        const ctx = getContext(), ev = ctx?.eventTypes ?? ctx?.event_types ?? {};
        if (!ctx?.eventSource?.on) return;
        promptInjectors(getContext).register('amin-os-card-profile', { build: rules, position: 1, depth: 0 });
        if (ev.MESSAGE_RECEIVED) ctx.eventSource.on(ev.MESSAGE_RECEIVED, index => { receive(index).catch(() => {}); });
        if (ev.CHAT_COMPLETION_PROMPT_READY) ctx.eventSource.on(ev.CHAT_COMPLETION_PROMPT_READY, onChatPrompt);
        if (ev.GENERATE_AFTER_COMBINE_PROMPTS) ctx.eventSource.on(ev.GENERATE_AFTER_COMBINE_PROMPTS, onTextPrompt);
        if (ev.CHAT_CHANGED) ctx.eventSource.on(ev.CHAT_CHANGED, notify);
        installed = true;
    }
    return {
        install, read: () => read(), snapshot, preview, importCard, reimport, keepCopy, remove,
        hooks: { onChatPrompt, onTextPrompt }, rules, receive, proposalsFor,
        pending: () => { const ctx = context(); return read(ctx).proposals.filter(entry => entry.items.some(item => item.status === 'pending')); },
        accept: (entryId, itemIds) => decide(entryId, itemIds, true),
        ignore: (entryId, itemIds) => decide(entryId, itemIds, false),
        undo,
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
