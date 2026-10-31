// Read selected/bound books directly; do not run keyword scans or change entries.
import { liveEntry } from '../cardprofile/live.js';
export async function readWorldContext(ctx, settings, getSettings) {
    if (!settings.character && !settings.world) return { entries: [], books: [] };
    const config = getSettings ? await getSettings() : ctx.worldInfoSettings ?? {};
    const wi = config.world_info ?? config;
    const names = new Map();
    const add = (name, source) => {
        if (typeof name !== 'string' || !name.trim()) return;
        if (!names.has(name)) names.set(name, new Set());
        names.get(name).add(source);
    };
    const group = (ctx.groups ?? []).find(g => String(g.id) === String(ctx.groupId));
    const members = group ? (ctx.characters ?? []).filter(c => group.members?.includes(c.avatar)) : [ctx.characters?.[ctx.characterId]].filter(Boolean);
    const embedded = [];
    for (const c of members) {
        const primary = c.data?.extensions?.world;
        add(primary, 'character');
        const file = (c.avatar ?? '').replace(/\.[^.]+$/, '');
        for (const name of wi.charLore?.find(x => x.name === file)?.extraBooks ?? []) add(name, 'character');
        if (!primary && c.data?.character_book?.entries) embedded.push({ name: `内嵌世界书：${c.name}`, data: c.data.character_book });
    }
    if (settings.world) {
        for (const name of config.selected_world_info ?? wi.globalSelect ?? []) add(name, 'global');
        add(ctx.chatMetadata?.world_info, 'chat');
        add(ctx.powerUserSettings?.persona_description_lorebook, 'persona');
    }
    const entries = [], books = [];
    const append = (name, data, sources) => {
        if (!data || !data.entries) throw new Error(`无法读取世界书「${name}」，请检查绑定或文件。`);
        books.push(name);
        for (const [id, e] of Object.entries(data.entries)) {
            if (e.disable === true || e.enabled === false || typeof e.content !== 'string' || !e.content.trim()) continue;
            entries.push({ book: name, id: String(e.uid ?? e.id ?? id), sources, title: e.comment ?? e.name ?? '', content: liveEntry(ctx, name, e.uid ?? e.id ?? id, e.content) });
        }
    };
    for (const [name, sources] of names) {
        if (typeof ctx.loadWorldInfo !== 'function') throw new Error('当前前端缺少世界书读取接口 loadWorldInfo。');
        append(name, await ctx.loadWorldInfo(name), [...sources]);
    }
    for (const book of embedded) append(book.name, book.data, ['character']);
    return { entries, books };
}

export async function hostWorldSettings(ctx) {
    if (ctx.worldInfoSettings) return ctx.worldInfoSettings;
    // The public context exposes loadWorldInfo, but not global/extra-book selection.
    try {
        const module = await import('/scripts/world-info.js');
        return module.getWorldInfoSettings();
    } catch {
        throw new Error('无法读取当前启用的世界书及角色附加绑定。请使用兼容的酒馆版本，或暂时关闭角色设定与全体世界书。');
    }
}
