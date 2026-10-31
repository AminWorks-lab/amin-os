// Lets other apps' AI tasks read the living copies instead of the original text: a card's
// description, a world-info entry's content, and the 世界资料/角色资料 created in this chat.
// Only copies whose 发送 switch is on count, so tools see what the chat itself sends.
// Synchronous and never throws: on any problem the original text is used.
import { KEY, validateStore, worldKey, NOTE_KINDS } from './model.js';
import { writeCard } from './format.js';

function store(ctx) {
    const raw = ctx?.chatMetadata?.[KEY];
    if (!raw) return null;
    try { return validateStore(structuredClone(raw)); } catch { return null; }
}
const current = profile => profile?.replace ? writeCard(profile.current) : null;

/** The card with its description swapped for the chat's current copy (same object when none). */
export function liveCard(ctx, card) {
    const text = card?.avatar ? current(store(ctx)?.profiles[card.avatar]) : null;
    if (text === null || store(ctx)?.profiles[card.avatar]?.source) return card;
    return { ...card, description: text, ...(card.data ? { data: { ...card.data, description: text } } : {}) };
}

/** A world-info entry's content, or its imported copy's current version. */
export function liveEntry(ctx, book, uid, content) {
    if (uid === undefined || uid === null) return content;
    const text = current(store(ctx)?.profiles[worldKey(book, uid)]) ?? current(store(ctx)?.profiles[worldKey(book, String(uid))]);
    return text ?? content;
}

/** 世界资料 / 角色资料 created in this chat, as {title, content}. */
export function liveNotes(ctx) {
    const value = store(ctx);
    if (!value) return [];
    return Object.values(value.profiles).filter(profile => profile.source?.type === 'custom' && profile.replace)
        .map(profile => ({ title: `${NOTE_KINDS[profile.source.kind] ?? '资料'} · ${profile.current.name}`, content: writeCard(profile.current) }));
}
export const NOTES_BOOK = '本聊天的世界资料与角色资料';
