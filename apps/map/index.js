import { uuid } from '../../uuid.js';
import { createTextUpdates } from './src/integrations/text-updates.js';
import { createMapTools } from './src/integrations/tool-calling.js';
import { createVariableBridge } from './src/integrations/chat-variables.js';
import { createDraftSession } from './src/core/draft.js';
import { createApiSettings } from '../../ai/transport.js';
import { createPreferences } from './src/ui/preferences.js';
import { installMessageButtons } from './src/ui/message-buttons.js';
import { createDemoDocument } from './src/core/demo.js';
import { createStore } from './src/core/store.js';
import { createPublicApi } from './src/integrations/api.js';
import { bindChatStore } from './src/adapters/chat.js';
import { registerMapRuntime } from './src/integrations/runtime.js';
import { lazyView, floorLoading } from '../lazy-view.js';

// The map window (panel and renderer) loads when a map window first opens; background persistence and tools start at once.
const loadPanel = lazyView(retry=>import(/* view */ './src/ui/panel.js'+retry), '地图');

let instance;
export function initialize({ mount, onOpen = () => {} } = {}) {
    if (instance) return instance;
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    const store = createStore(createDemoDocument());
    const ctx = globalThis.SillyTavern?.getContext?.();
    const events = ctx?.eventTypes ?? ctx?.event_types ?? {};
    let panel, panelLoad = null, destroyed = false, status = '';
    const inlinePanels = new Set();
    const settingsObject = ctx?.extensionSettings;
    if (settingsObject && !settingsObject.dynamicMapNamespace) {
        settingsObject.dynamicMapNamespace = uuid();
        ctx.saveSettingsDebounced?.();
    }
    const persistence = bindChatStore(store, {
        getContext: () => globalThis.SillyTavern?.getContext?.() ?? {},
        storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
        namespace: settingsObject?.dynamicMapNamespace ?? 'unbound',
        report(message) { status = message; panel?.setStatus(message); for(const item of inlinePanels)item.setStatus(message); },
    });
    const preferences = createPreferences(() => globalThis.SillyTavern?.getContext?.(), localStorage, settingsObject?.dynamicMapNamespace ?? 'unbound');
    const integration=createVariableBridge({store,persistence,getContext:()=>globalThis.SillyTavern?.getContext?.()??{}});
    const shared = {integration,draft:createDraftSession(store,persistence),apiSettings:createApiSettings(localStorage,persistence.namespace)};
    const unregisterRuntime = registerMapRuntime({ store, persistence, draft: shared.draft, context: () => globalThis.SillyTavern?.getContext?.() });
    shared.tools=createMapTools({store,draft:shared.draft,persistence,getContext:()=>globalThis.SillyTavern?.getContext?.()??{}});
    shared.textUpdates=createTextUpdates({tools:shared.tools,getContext:()=>globalThis.SillyTavern?.getContext?.()??{},report(message){status=message;panel?.setStatus(message);for(const item of inlinePanels)item.setStatus(message);}});
    const ensurePanel = () => panelLoad ??= loadPanel().then(({ createPanel }) => {
        if (destroyed) throw Error('地图已关闭，请刷新页面。');
        panel = createPanel(store, persistence, preferences, { ...shared, mount, inline: !!mount, embedded: !!mount });
        panel.setStatus(status); return panel;
    }).catch(error => { panelLoad = null; throw error; });
    const messageButtons = installMessageButtons(mount=>{
        let widget=null,loading=null,closed=false;
        const start=()=>{
            loading=floorLoading(mount);
            loadPanel().then(({createPanel})=>{
                loading.done();if(closed)return;
                widget=createPanel(store,persistence,preferences,{...shared,mount,inline:true});
                inlinePanels.add(widget);widget.setStatus(status);
            },error=>{if(!closed)loading.fail(error,start);});
        };
        start();
        return {destroy(){closed=true;loading?.done();if(widget){inlinePanels.delete(widget);widget.destroy();}}};
    }, preferences);
    const onChatChanged = () => { persistence.switchChat(); messageButtons.refresh(); };
    if (events.CHAT_CHANGED) ctx.eventSource.on(events.CHAT_CHANGED, onChatChanged);
    const settings = document.createElement('div');
    settings.className = 'dm-settings';
    settings.innerHTML = '<b>动态地图</b><p>从悬浮条展开地图，拖动标题调整位置。</p><button type="button" class="menu_button">🗺 打开地图</button>';
    const openPanel = options => ensurePanel().then(view => view.open(options), error => { if (!mount) globalThis.toastr?.error?.(error.message); }); // Amin's pane shows its own error and retry.
    settings.querySelector('button').addEventListener('click', () => openPanel());

    // Without an Amin pane the standalone map creates its floating panel at once, as before.
    if (!mount) { host?.append(settings); ensurePanel().catch(error => globalThis.toastr?.error?.(error.message)); }
    const api = createPublicApi(store, options => { onOpen(); openPanel(options); }, integration);
    globalThis.SillyTavernDynamicMap = api;
    instance = { api, open: ensurePanel, destroy() {
        destroyed = true; unregisterRuntime();
        shared.textUpdates.destroy(); shared.tools.destroy(); integration.destroy(); messageButtons.destroy(); panel?.destroy(); shared.draft.destroy(); settings.remove();
        persistence.destroy();
        if (events.CHAT_CHANGED) ctx.eventSource.removeListener?.(events.CHAT_CHANGED, onChatChanged);
        if (globalThis.SillyTavernDynamicMap === api) delete globalThis.SillyTavernDynamicMap;
        instance = undefined;
    } };
    return instance;
}
