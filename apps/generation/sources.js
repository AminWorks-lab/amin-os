import { collectWorldbooks } from '../worldbook-sources.js';
import { requireStatusPersona } from '../status/sources.js';
import { liveCard } from '../cardprofile/live.js';

const cardFields = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
const stable = value => JSON.stringify(value);

function characterSources(ctx) {
    const grouped = ctx.groupId != null && ctx.groupId !== '';
    const group = grouped ? ctx.groups?.find(item => String(item.id) === String(ctx.groupId)) : null;
    const cards = grouped ? (ctx.characters ?? []).filter(card => group?.members?.includes(card.avatar)) : [ctx.characters?.[ctx.characterId]].filter(Boolean);
    if (!cards.length) throw Error('当前没有可读取的角色卡，请选择角色或取消读取角色卡。');
    return cards.map(card => liveCard(ctx, card)).map(card => ({ avatar: String(card.avatar ?? ''), ...Object.fromEntries(cardFields.map(key => [key, String(card.data?.[key] ?? card[key] ?? '')])) }));
}

function localSources(ctx, sources) {
    const result = {};
    if (sources.includeCharacter === true) result.characters = characterSources(ctx);
    if (sources.includePersona === true) result.persona = requireStatusPersona(ctx);
    if (sources.includeChat === true) {
        const { start, end } = sources;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= (ctx.chat?.length ?? 0)) throw Error('请选择有效的来源楼层范围。');
        result.chat = [];
        for (let index = start; index <= end; index++) {
            const message = ctx.chat[index];
            if (!message || typeof message.mes !== 'string') throw Error(`第 ${index + 1} 楼没有有效的文本，未截断或跳过来源。`);
            result.chat.push({ index, floor: index + 1, name: String(message.name ?? ''), isUser: !!message.is_user, isSystem: !!message.is_system, swipeId: message.swipe_id ?? null, text: message.mes });
        }
    }
    return result;
}

// Reads material for a user-requested generation only. Never changes activation or settings.
// Extra options are the same injectable readers used by the shared worldbook collector.
export async function collectGenerationSources(ctx, sources = {}, options = {}) {
    const { signal, check = () => {} } = options;
    if (!ctx || !sources || typeof sources !== 'object' || Array.isArray(sources)) throw Error('生成来源设置无效。');
    if (sources.selectedBooks != null && (!Array.isArray(sources.selectedBooks) || sources.selectedBooks.some(name => typeof name !== 'string' || !name.trim()))) throw Error('世界书选择必须是名称列表。');
    const selectedBooks = [...new Set((sources.selectedBooks ?? []).map(name => name.trim()))].sort();
    const selection = stable(sources);
    const identity = stable([ctx.groupId ?? null, ctx.characterId ?? null, ctx.getCurrentChatId?.() ?? null]);
    const initial = localSources(ctx, sources), baseline = stable(initial);
    const bindings = () => stable({ chat: ctx.chatMetadata?.world_info, persona: ctx.powerUserSettings?.persona_description_lorebook, cards: (ctx.characters ?? []).map(card => ({ avatar: card.avatar, world: card.data?.extensions?.world, book: card.data?.character_book })), groups: ctx.groups, worldInfo: ctx.worldInfoSettings });
    const bookBaseline = sources.readWorldbooks === true && selectedBooks.length ? bindings() : null;
    const guard = () => {
        if (signal?.aborted) throw signal.reason ?? Error('已取消读取生成来源。');
        check();
        if (stable(sources) !== selection || stable([ctx.groupId ?? null, ctx.characterId ?? null, ctx.getCurrentChatId?.() ?? null]) !== identity || stable(localSources(ctx, sources)) !== baseline || (bookBaseline !== null && bindings() !== bookBaseline)) throw Error('生成来源已变化，请重新生成。');
    };
    guard();
    const books = sources.readWorldbooks === true && selectedBooks.length
        ? await collectWorldbooks(ctx, { readWorldbooks: true, includeCharacter: false, selectedBooks }, { ...options, check: guard, includeKeys: true })
        : [];
    guard();
    books.sort((a, b) => a.name.localeCompare(b.name));
    const payload = { ...initial, worldbooks: books };
    return {
        text: stable(payload),
        provenance: {
            characters: initial.characters?.map(card => ({ avatar: card.avatar, name: card.name })) ?? [],
            persona: !!initial.persona,
            worldbooks: books.map(book => ({ name: book.name, entries: book.entries.map(entry => entry.title) })),
            chat: initial.chat ? { start: sources.start, end: sources.end, indices: initial.chat.map(message => message.index) } : null,
        },
    };
}
