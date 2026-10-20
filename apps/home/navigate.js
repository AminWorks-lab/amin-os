// Opens a search result in its app and asks the app to show that entry.
// Apps take `{ focus, ... }` through takeAppRequest when they open; 人物卡 keeps its
// existing select event, and the map opens through its public API.
export async function openSearchResult(entry, { openApp, document = globalThis.document, map = globalThis.SillyTavernDynamicMap } = {}) {
    if (entry.app === 'map' && typeof map?.open === 'function') { map.open({ focus: entry.request.focus }); return; }
    if (entry.app === 'characters') {
        await openApp('characters');
        const Event = document?.defaultView?.CustomEvent ?? globalThis.CustomEvent;
        if (typeof Event === 'function') document?.dispatchEvent?.(new Event('amin:select-character', { detail: { app: 'characters', characterId: entry.id } }));
        return;
    }
    await openApp(entry.app, entry.request);
}
