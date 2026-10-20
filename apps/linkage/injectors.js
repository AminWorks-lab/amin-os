// Shared extension-prompt injectors. Each app registers its keyed prompt once;
// one registry per host event source subscribes to GENERATION_AFTER_COMMANDS
// and CHAT_CHANGED for all of them, so host-support checks and the
// clear-then-build cycle live here. Keys, positions, depths and texts stay
// each app's own. Apps still clear their key on their other events.
//
// register(key, { build, position = 1, depth = 0, enabled, keepOnDryRun, onError })
// - On each generation the key is cleared first (unless keepOnDryRun and this
//   is a dry run), then enabled(type, options, dryRun) gates the build.
// - Dry runs never build. build(type, options) returns the text to inject, or
//   null/undefined to leave the prompt cleared.
// - Every key is cleared on CHAT_CHANGED.
// Returns { supported, clear(), dispose() }; dispose clears and unregisters.
const registries = new WeakMap();

function entryFor(getContext, key, { build, position = 1, depth = 0, enabled, keepOnDryRun = false, onError } = {}) {
    if (typeof key !== 'string' || !key || typeof build !== 'function') throw Error('提示词注入需要键名与构建函数。');
    const entry = {
        clear() { try { getContext()?.setExtensionPrompt?.(key, '', position, depth, false); } catch { /* The host may be switching chats. */ } },
        generate(type, options, dryRun) {
            if (!(dryRun && keepOnDryRun)) entry.clear();
            try {
                if (enabled && !enabled(type, options, dryRun)) return;
                if (dryRun) return;
                const text = build(type, options);
                if (typeof text === 'string') getContext().setExtensionPrompt(key, text, position, depth, false);
            } catch (error) { try { onError?.(error); } catch { /* A status view cannot interrupt generation. */ } }
        },
    };
    return entry;
}

function createRegistry(source, events, release) {
    const entries = [];
    const generate = (type, options, dryRun) => { for (const entry of [...entries]) entry.generate(type, options, dryRun); };
    const changed = () => { for (const entry of [...entries]) entry.clear(); };
    source.on(events.GENERATION_AFTER_COMMANDS, generate);
    source.on(events.CHAT_CHANGED, changed);
    const off = (event, handler) => { if (source.removeListener) source.removeListener(event, handler); else source.off?.(event, handler); };
    return {
        add(entry) {
            entries.push(entry);
            return () => {
                const index = entries.indexOf(entry);
                if (index < 0) return;
                entries.splice(index, 1);
                if (entries.length) return;
                off(events.GENERATION_AFTER_COMMANDS, generate); off(events.CHAT_CHANGED, changed); release();
            };
        },
    };
}

export function promptInjectors(getContext) {
    const initial = getContext?.(), source = initial?.eventSource, events = initial?.eventTypes ?? initial?.event_types ?? {};
    const supported = !!(typeof initial?.setExtensionPrompt === 'function' && source && typeof source === 'object' && typeof source.on === 'function'
        && events.GENERATION_AFTER_COMMANDS && events.CHAT_CHANGED);
    return {
        supported,
        register(key, options) {
            const entry = entryFor(getContext, key, options);
            let remove = () => {};
            if (supported) {
                let registry = registries.get(source);
                if (!registry) { registry = createRegistry(source, events, () => registries.delete(source)); registries.set(source, registry); }
                remove = registry.add(entry);
            }
            let disposed = false;
            return { supported, clear: entry.clear, dispose() { if (disposed) return; disposed = true; remove(); entry.clear(); } };
        },
    };
}
