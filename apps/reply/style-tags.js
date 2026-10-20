// Quick style tags on the reply candidates page: recently used content styles and
// writing presets, or three default content styles before anything has been used.
export const RECENT_LIMIT = 6;
export const DEFAULT_CONTENT_TAGS = Object.freeze(['normal', 'violence', 'absurd']);
const KEY = /^(content|writing):(.+)$/;
export function normalizeRecent(value) {
    const out = [];
    for (const item of Array.isArray(value) ? value : []) if (typeof item === 'string' && KEY.test(item) && !out.includes(item) && item !== 'content:none') out.push(item);
    return out.slice(0, RECENT_LIMIT);
}
/** Keys of the styles used by one generation, most specific first. */
export function usedStyleKeys(settings) {
    const keys = [];
    if (settings?.writingStyleMode === 'custom' && settings.writingStyleId) keys.push('writing:' + settings.writingStyleId);
    if (settings?.contentMode && settings.contentMode !== 'none') keys.push('content:' + settings.contentMode);
    return keys;
}
export function rememberStyles(recent, keys) {
    return normalizeRecent([...keys, ...normalizeRecent(recent).filter(key => !keys.includes(key))]);
}
/** Tags to show. `contents` and `styles` are the writing-library stores (get/list). */
export function styleTags({ recent, contents, styles, settings }) {
    const tag = key => {
        const [, kind, id] = KEY.exec(key) ?? [];
        const preset = kind === 'content' ? contents?.get?.(id) : kind === 'writing' ? styles?.get?.(id) : null;
        if (!preset) return null;
        const active = kind === 'content' ? settings?.contentMode === id : settings?.writingStyleMode === 'custom' && settings?.writingStyleId === id;
        return { key, kind, id, label: preset.name, active, recent: true };
    };
    // Recent styles first; defaults fill the row up to three tags.
    const used = normalizeRecent(recent).map(tag).filter(Boolean), keys = new Set(used.map(item => item.key));
    const ids = [...new Set([...DEFAULT_CONTENT_TAGS.filter(id => contents?.get?.(id)), ...(contents?.list?.() ?? []).map(preset => preset.id)])];
    const fill = ids.filter(id => !keys.has('content:' + id)).slice(0, Math.max(0, 3 - used.length)).map(id => ({ ...tag('content:' + id), recent: false }));
    return [...used, ...fill];
}
