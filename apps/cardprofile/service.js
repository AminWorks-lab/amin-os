import { transferPanel, KEY, emptyStore, validateStore, normalizeProfile, worldKey, noteKey, NOTE_KINDS, LIMITS, createProfile, setNode, addNode, removeNode, moveNode, restoreNode, resetProfile, setOptions, renderForPrompt } from './model.js';
import { candidates, coverage, replaceInMessages, replaceInText, messageText } from './prompt.js';
import { createOperationService } from '../shared/operations.js';
import { promptInjectors } from '../linkage/injectors.js';
import { buildRules, extract, checkItem, applyItem, undoItem, messageKey, targetAvatar, resolvePath, panelManner } from './proposals.js';
import { uuid } from '../../uuid.js';
import { parseCard } from './format.js';
import { worldbookChoices, freshWorldbook } from '../worldbook-sources.js';
import { sha256HexSync } from '../tts/source-hash.js';
import { generateNote as runNoteTask, requestEdits } from './generate.js';

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

export function createCardProfileService(getContext = () => globalThis.SillyTavern?.getContext?.(), { notice = message => globalThis.toastr?.warning?.(message, 'Amin 角色卡资料'), worldbooks = null } = {}) {
    const operation = createOperationService(getContext), listeners = new Set();
    const results = new Map(), warned = new Set();
    let lastPrompt = null;
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
    async function writeOnce(label, change) {
        const ctx = context(), store = read(ctx);
        change(store);
        validateStore(store);
        operation.stage({ label, patches: [{ path: [KEY], value: store }] });
        await operation.confirm();
        notify();
        return store;
    }
    // Writes run one at a time (a setting changed while the previous one is still saving used to
    // fail with BUSY and silently stay unsaved), and wait briefly while another app is saving.
    let queue = Promise.resolve();
    function write(label, change) {
        const run = queue.then(async () => {
            for (let attempt = 0; ; attempt++) {
                try { return await writeOnce(label, change); }
                catch (error) {
                    if (error?.code === 'DIRTY' && attempt === 0) { try { await operation.retrySave(); continue; } catch { throw Error('当前聊天有一次保存没有完成（可能是别的应用的操作），这次修改没有保存。请稍后重试，或刷新酒馆后再改。'); } }
                    if (error?.code !== 'BUSY' || attempt >= 20) throw error;
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            }
        });
        queue = run.catch(() => {});
        return run;
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
    // Copies that belong to the open chat: one per card description, plus world-info entries
    // imported while one of the chat's characters was active (multi-character cards).
    function owned(ctx, store) {
        const avatars = new Set(chatCharacters(ctx).map(item => item.avatar));
        return Object.entries(store.profiles).filter(([, value]) => value.source?.type === 'world' && avatars.has(value.avatar));
    }
    // Copies created in the app live in this chat's metadata and always belong to it.
    const notes = store => Object.entries(store.profiles).filter(([, value]) => value.source?.type === 'custom');
    function snapshot() {
        const ctx = context(), store = read(ctx), key = chatKey(ctx);
        const cards = chatCharacters(ctx).map(item => {
            const description = descriptionOf(item), value = store.profiles[item.avatar] ?? null;
            return { key: item.avatar, avatar: item.avatar, kind: 'card', name: item.name ?? item.avatar, description, profile: value,
                cardChanged: !!value && value.sourceHash !== hashDescription(description), result: results.get(key + '\n' + item.avatar) ?? null };
        });
        const worlds = owned(ctx, store).map(([id, value]) => ({ key: id, avatar: value.avatar, kind: 'world', name: value.current.name, book: value.source.book, title: value.source.title,
            description: value.source.text, profile: value, cardChanged: false, result: results.get(key + '\n' + id) ?? null }));
        const extra = notes(store).map(([id, value]) => ({ key: id, avatar: value.avatar, kind: 'note', noteKind: value.source.kind, name: value.current.name,
            description: '', profile: value, cardChanged: false, result: results.get(key + '\n' + id) ?? null }));
        return [...cards, ...worlds, ...extra];
    }
    /** World-info entries in the books this chat uses whose content is a bracket template. */
    async function worldCandidates() {
        const ctx = context(), store = read(ctx);
        const books = await (worldbooks?.choices ?? (c => worldbookChoices(c)))(ctx);
        const found = [], failed = [];
        for (const book of books) {
            let data;
            try { data = book.data ?? await (worldbooks?.load ?? ((c, name) => freshWorldbook(c, name)))(ctx, book.name); }
            catch (error) { failed.push(`${book.name}：${error.message}`); continue; }
            for (const entry of Object.values(data?.entries ?? {})) {
                if (!entry || typeof entry.content !== 'string' || !entry.content.includes('=[')) continue;
                let tree; try { tree = parseCard(entry.content); } catch { continue; }
                const uid = entry.uid ?? entry.id;
                found.push({ book: book.name, uid, title: entry.comment || entry.name || tree.name, name: tree.name, text: entry.content, disabled: !!entry.disable || entry.enabled === false,
                    constant: !!entry.constant, imported: !!store.profiles[worldKey(book.name, uid)] });
            }
        }
        return { entries: found, failed };
    }
    async function importWorld(picks) {
        const ctx = context(), owner = chatCharacters(ctx)[0];
        if (!owner) throw Error('当前聊天没有角色卡。');
        const values = picks.map(pick => createProfile({ avatar: owner.avatar, cardName: owner.name ?? '', description: pick.text, hash: hashDescription(pick.text),
            source: { type: 'world', book: pick.book, uid: pick.uid, title: String(pick.title ?? '').slice(0, 200), text: pick.text } }));
        await write(`从世界书导入角色资料：${values.map(value => value.current.name).join('、')}`, store => {
            for (const value of values) store.profiles[worldKey(value.source.book, value.source.uid)] = value;
        });
        return values.map(value => worldKey(value.source.book, value.source.uid));
    }
    /** Create a 世界资料 / 角色资料 from a pasted or generated template. Returns its key. */
    async function createNote({ kind = 'world', text }) {
        if (!Object.hasOwn(NOTE_KINDS, kind)) throw Error('资料类型无效。');
        const ctx = context(), owner = chatCharacters(ctx)[0], id = uuid().replace(/[^\w-]/g, '').slice(0, 40);
        const value = createProfile({ avatar: owner?.avatar ?? 'chat', cardName: owner?.name ?? '', description: String(text ?? ''), hash: hashDescription(text), source: { type: 'custom', id, kind } });
        await write(`新建${NOTE_KINDS[kind]}：${value.current.name}`, store => { store.profiles[noteKey(id)] = value; });
        return noteKey(id);
    }
    /** Ask the shared AI for a template built from the card, world info and recent chat. */
    async function generateNote(options, { signal, ai } = {}) {
        const ctx = context();
        return runNoteTask(ctx, { ...options, characters: chatCharacters(ctx), worldbooks }, { signal, ai });
    }
    /** 让 AI 改: ask for edits to one copy. Returns checked items (nothing is saved yet).
     *  The player decided who rewrites, so panel permissions are not applied here. */
    async function askEdits(key, { request, by = '' } = {}, { signal, ai } = {}) {
        const ctx = context(), value = profile(key, ctx);
        const raws = await requestEdits(ctx, { profile: value, request, by, manner: by && value.panel?.on ? panelManner(value) : '' }, { signal, ai });
        return raws.map(raw => { const { by: _ignored, ...rest } = raw; const item = checkItem(value, rest, uuid(), { user: ctx.name1 ?? '' }); if (by) item.by = by; return item; });
    }
    /** Apply the accepted items in order; each failure is reported on the item and skipped. */
    async function applyEdits(key, items) {
        const done = [];
        await write(`按要求修改：${items.length} 项`, store => {
            let value = store.profiles[key];
            if (!value) throw Error('这份资料已删除。');
            for (const item of items) {
                if (item.status !== 'pending') continue;
                try {
                    const path = resolvePath(value.current, item.path).path.map(step => step.key ?? step.value);
                    value = applyItem(value, item); item.status = 'accepted'; done.push({ ...item, names: path });
                } catch (error) { item.status = 'invalid'; item.error = error.message; }
            }
            store.profiles[key] = value;
        });
        return done;
    }
    /** The world-info entry was edited after import: match its current text from now on (the copy is kept). */
    async function refreshWorldSource(key) {
        const ctx = context(), value = profile(key, ctx);
        if (value.source?.type !== 'world') throw Error('这份资料不是从世界书导入的。');
        const books = await (worldbooks?.choices ?? (c => worldbookChoices(c)))(ctx), book = books.find(item => item.name === value.source.book);
        if (!book) throw Error(`当前聊天没有启用世界书“${value.source.book}”。`);
        const data = book.data ?? await (worldbooks?.load ?? ((c, name) => freshWorldbook(c, name)))(ctx, book.name);
        const entry = Object.values(data?.entries ?? {}).find(item => String(item?.uid ?? item?.id) === String(value.source.uid));
        if (!entry || typeof entry.content !== 'string') throw Error('世界书里找不到这个条目了，可能被删除。');
        if (entry.content === value.source.text) return false;
        await write('按世界书现内容更新原文', store => { store.profiles[key] = { ...store.profiles[key], source: { ...store.profiles[key].source, text: entry.content }, sourceHash: hashDescription(entry.content) }; });
        for (const id of [...warned]) if (id.endsWith('\n' + key)) warned.delete(id);
        return true;
    }
    /** Why a world-info entry was not in the last prompt: reads the entry's own settings and
     *  checks the rest of the book against that prompt. Returns a list of readable reasons. */
    async function diagnoseWorld(key) {
        const ctx = context(), value = profile(key, ctx);
        if (value.source?.type !== 'world') throw Error('这份资料不是从世界书导入的。');
        const books = await (worldbooks?.choices ?? (c => worldbookChoices(c)))(ctx), book = books.find(item => item.name === value.source.book);
        if (!book) return [`当前聊天没有启用世界书“${value.source.book}”，条目不会发送。在聊天或角色的世界书设置里启用它。`];
        const data = book.data ?? await (worldbooks?.load ?? ((c, name) => freshWorldbook(c, name)))(ctx, book.name);
        const entries = Object.values(data?.entries ?? {}).filter(Boolean);
        const entry = entries.find(item => String(item.uid ?? item.id) === String(value.source.uid));
        if (!entry) return ['世界书里找不到这个条目了，可能被删除或换了编号。删除副本后重新导入。'];
        const reasons = [];
        if (entry.disable) reasons.push('条目被禁用了（开关是关的）。');
        if (!entry.constant) reasons.push('条目不是常驻（蓝灯），要关键词出现才会发送。');
        if (entry.useProbability !== false && Number.isFinite(entry.probability) && entry.probability < 100) reasons.push(`条目的触发概率是 ${entry.probability}%，不是每轮都发送。`);
        if (entry.group) { const same = entries.filter(item => item !== entry && !item.disable && String(item.group ?? '').split(/,\s*/).some(name => String(entry.group).split(/,\s*/).includes(name))); if (same.length) reasons.push(`条目在包含组“${entry.group}”里，同组还有 ${same.length} 条；同一组每轮只会选一条发送。`); }
        const filter = entry.characterFilter;
        if (filter && ((filter.names ?? []).length || (filter.tags ?? []).length)) reasons.push(`条目设置了角色过滤（${filter.isExclude ? '排除' : '只给'}：${[...(filter.names ?? []), ...(filter.tags ?? [])].join('、')}），当前角色可能不符合。`);
        if (Array.isArray(entry.triggers) && entry.triggers.length) reasons.push(`条目只在这些生成类型时发送：${entry.triggers.join('、')}。`);
        for (const [field, label] of [['delay', '延迟'], ['cooldown', '冷却'], ['sticky', '粘滞']]) if (Number(entry[field]) > 0) reasons.push(`条目设置了${label} ${entry[field]}，有些轮次不会发送。`);
        if (entry.delayUntilRecursion) reasons.push('条目设置了“延迟到递归”，只有被其他条目递归触发时才发送。');
        if (Number(entry.position) === 7) reasons.push(`条目的位置是“出口（outlet）”，只会出现在预设或卡里写了 {{outlet::${entry.outletName || '名字'}}} 的地方。`);
        if (typeof entry.content === 'string' && entry.content !== value.source.text) reasons.push('条目内容和导入时不一样（导入后改过）。点“按世界书现内容更新原文”。');
        const prompt = lastPrompt?.chat === chatKey(ctx) ? lastPrompt.text : '';
        if (prompt && !reasons.length) {
            // Other always-on entries at the same place: if none of them is in the prompt either,
            // the preset does not send that world-info slot at all.
            const place = Number(entry.position ?? 0);
            const others = entries.filter(item => item !== entry && item.constant && !item.disable && Number(item.position ?? 0) === place && typeof item.content === 'string' && item.content.trim().length >= 8);
            const seen = others.filter(item => coverage([item.content.trim()], prompt).found > 0);
            const slot = { 0: '世界信息（角色定义之前）', 1: '世界信息（角色定义之后）' }[place];
            if (others.length && !seen.length) reasons.push(`同一位置的其他常驻条目也都不在发送内容里${slot ? `，预设里很可能关掉了“${slot}”这一块` : ''}。在预设的提示词列表里把它打开。`);
            else reasons.push('条目设置看起来没问题，同位置的其他条目也发送了。最可能是世界书 token 预算不够，这条被挤掉了：在世界书设置里调高“上下文百分比”或“预算上限”，或者给这条打开“忽略预算”。');
        } else if (!prompt && !reasons.length) reasons.push('条目设置看起来没问题。先发送一次消息，再点这个按钮，可以对照那次的发送内容继续检查。');
        return reasons;
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
    function apply(target, dryRun, promptText = () => '', insert = () => {}) {
        let ctx; try { ctx = getContext(); } catch { return; }
        if (!ctx?.chatMetadata?.[KEY]) return;
        let store; try { store = read(ctx); } catch (error) { if (!dryRun) notice(`角色卡资料无法读取，本轮按原角色卡发送：${error.message}`); return; }
        const key = chatKey(ctx), macro = substitute(ctx);
        const jobs = [
            ...chatCharacters(ctx).map(item => ({ id: item.avatar, value: store.profiles[item.avatar], original: descriptionOf(item),
                missing: `没有在发送内容里找到“${item.name}”的角色描述，本轮按原角色卡发送。可能是预设用别的方式引用了描述，详见角色卡资料应用。` })),
            ...owned(ctx, store).map(([id, value]) => ({ id, value, original: value.source.text,
                world: value.source.title || value.current.name })),
        ];
        const changed = [], extra = [];
        let whole = null;
        for (const job of jobs) {
            if (!job.value?.replace) continue;
            let text = renderForPrompt(job.value);
            if (macro) { try { text = macro(text); } catch {} }
            const forms = candidates(job.original, macro);
            // Read before replacing: a miss is then measured against what the prompt really had.
            const matched = target(forms, text);
            let check = null;
            if (!matched && job.world) { whole ??= promptText(); if (!dryRun) lastPrompt = { chat: key, text: whole }; check = coverage(forms, whole); }
            // The entry is not in the prompt at all (preset slot off, budget, not triggered): send
            // the copy on its own. When the entry is there but changed, sending both would duplicate it.
            const gone = !!check && check.found * 2 < check.lines;
            if (gone && job.value.fallback) extra.push(`【世界书条目 · ${job.world}（本聊天的当前版本）】\n${text}`);
            if (dryRun) continue;
            results.set(key + '\n' + job.id, { at: new Date().toISOString(), matched, ...(check ? { absent: gone, extra: gone && !!job.value.fallback, lines: check.lines, found: check.found, sample: check.sample.slice(0, 60) } : {}) });
            if (matched || gone || warned.has(key + '\n' + job.id)) continue;
            warned.add(key + '\n' + job.id);
            if (!job.world) { notice(job.missing); continue; }
            changed.push({ name: job.world, ...check });
        }
        if (extra.length) { try { insert(extra.join('\n\n')); } catch {} }
        if (!dryRun && changed.length) {
            notice([
                ...changed.map(item => `世界书条目“${item.name}”发送了，但和导入时的原文对不上（${item.lines} 行里有 ${item.lines - item.found} 行不一样，比如「${item.sample.slice(0, 30)}」），本轮按世界书原样发送。条目改过的话，在角色卡资料里点“按世界书现内容更新原文”。`),
            ].filter(Boolean).join('\n'));
        }
        if (!dryRun) notify();
    }
    function onChatPrompt(data) {
        if (!data || !Array.isArray(data.chat)) return;
        let history = []; try { history = (getContext()?.chat ?? []).map(message => message?.mes).filter(text => typeof text === 'string'); } catch {}
        // Extra blocks go after the leading system messages (where character definitions sit).
        const insert = text => { let at = data.chat.findIndex(message => message?.role !== 'system'); if (at < 0) at = data.chat.length; data.chat.splice(at, 0, { role: 'system', content: text }); };
        apply((forms, text) => replaceInMessages(data.chat, forms, text, { history }), !!data.dryRun, () => data.chat.map(messageText).join('\n'), insert);
    }
    function onTextPrompt(data) {
        if (!data || typeof data.prompt !== 'string') return;
        apply((forms, text) => { const result = replaceInText(data.prompt, forms, text); data.prompt = result.prompt; return result.matched; }, !!data.dryRun, () => data.prompt, text => { data.prompt = `${text}\n\n${data.prompt}`; });
    }
    // ---- AI proposals ----
    function activeProfiles(ctx) {
        let store; try { store = read(ctx); } catch { return []; }
        const avatars = new Set(chatCharacters(ctx).map(item => item.avatar));
        return Object.entries(store.profiles).filter(([id, value]) => value.propose && avatars.has(value.avatar) && (value.source?.type === 'world' || id === value.avatar) || value.propose && value.source?.type === 'custom')
            .map(([id, value]) => ({ ...value, key: id }));
    }
    function rules() {
        let ctx; try { ctx = getContext(); } catch { return null; }
        if (!ctx?.chatMetadata?.[KEY]) return null;
        const profiles = activeProfiles(ctx);
        return profiles.length ? buildRules(profiles, { user: ctx.name1 ?? '' }) : null;
    }
    /** Created copies have no original text to replace: they are sent as an extra block. */
    function notesPrompt() {
        let ctx; try { ctx = getContext(); } catch { return null; }
        if (!ctx?.chatMetadata?.[KEY]) return null;
        let store; try { store = read(ctx); } catch { return null; }
        const macro = substitute(ctx), key = chatKey(ctx), blocks = [];
        for (const [id, value] of notes(store)) {
            if (!value.replace) continue;
            let text = renderForPrompt(value);
            if (macro) { try { text = macro(text); } catch {} }
            blocks.push(text); results.set(key + '\n' + id, { at: new Date().toISOString(), matched: true });
        }
        return blocks.length ? blocks.join('\n\n') : null;
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
                        const item = checkItem(value, raw, uuid(), { user: ctx.name1 ?? '' });
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
                        store.proposals.push({ id: uuid(), avatar, name: store.profiles[avatar].current.name, key, index: Number(index), at: new Date().toISOString(), items: list });
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
        // With the character definitions (in-prompt), not after the last message: a block at the
        // very end outranks the preset's own closing instructions (length, format, date line).
        promptInjectors(getContext).register('amin-os-card-profile', { build: rules, position: 0, depth: 0 });
        promptInjectors(getContext).register('amin-os-card-profile-notes', { build: notesPrompt, position: 0, depth: 0 });
        if (ev.MESSAGE_RECEIVED) ctx.eventSource.on(ev.MESSAGE_RECEIVED, index => { receive(index).catch(() => {}); });
        if (ev.CHAT_COMPLETION_PROMPT_READY) ctx.eventSource.on(ev.CHAT_COMPLETION_PROMPT_READY, onChatPrompt);
        if (ev.GENERATE_AFTER_COMBINE_PROMPTS) ctx.eventSource.on(ev.GENERATE_AFTER_COMBINE_PROMPTS, onTextPrompt);
        if (ev.CHAT_CHANGED) ctx.eventSource.on(ev.CHAT_CHANGED, notify);
        installed = true;
    }
    return {
        install, read: () => read(), snapshot, preview, importCard, reimport, keepCopy, remove, worldCandidates, importWorld, refreshWorldSource, diagnoseWorld, createNote, generateNote, notesPrompt, askEdits, applyEdits,
        /** 让 AI 改's 由谁改写 / 写入剧情 for the whole chat (kept when switching between copies). */
        /** Copy one copy's panel settings (editors, manner) to other copies in this chat. */
        copyPanel: (fromKey, toKeys) => write('同步面板设置', store => {
            const from = store.profiles[fromKey];
            if (!from) throw Error('这份资料已删除。');
            for (const key of toKeys) if (key !== fromKey && store.profiles[key]) store.profiles[key] = transferPanel(from, store.profiles[key], { on: true });
        }),
        /** The panel settings to start from when panel play is turned on for a copy. */
        panelTemplate: key => { const store = read(context()); return Object.entries(store.profiles).find(([id, value]) => id !== key && value.panel?.on && value.panel.editors.length)?.[0] ?? null; },
        askDefaults: () => { const value = read(context()).ask; return value ? { ...value } : null; },
        setAskDefaults: ({ by = '', story = true } = {}) => write('“让 AI 改”默认设置', store => { store.ask = { by: String(by).trim().slice(0, LIMITS.key), story: !!story }; }),
        hooks: { onChatPrompt, onTextPrompt }, rules, receive, proposalsFor,
        pending: () => { const ctx = context(); return read(ctx).proposals.filter(entry => entry.items.some(item => item.status === 'pending')); },
        accept: (entryId, itemIds) => decide(entryId, itemIds, true),
        ignore: (entryId, itemIds) => decide(entryId, itemIds, false),
        undo,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        set: (avatar, id, fields, label = '修改角色资料') => update(avatar, String(label).slice(0, 300), value => setNode(value, id, fields)),
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
