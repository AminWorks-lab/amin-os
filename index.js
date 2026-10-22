import { initializeState2 } from './apps/state2/runtime.js';
import { initializeChatLifecycle } from './apps/shared/chat-lifecycle.js';
import { uuid } from './uuid.js';
import {cleanupRetiredData} from './retired-data.js';
import {installExtraFloorButtons} from './apps/extra-floor-ui.js';
import {installReplyFloorButtons} from './apps/reply/floor-ui.js';
import {installTurnSummaries} from './apps/linkage/floor-turns.js';
import {initializeAppearance,installAppearance,getAppearance} from './settings/appearance.js';
import {initializeAI} from './ai/service.js';
import {installTabScroll} from './ui/tabs.js';
import { createShell } from './shell.js';
import { views } from './apps/views.js';
import { getSharedService as getLinkageService } from './apps/linkage/service.js';
import { createLinkageHost } from './apps/linkage/host.js';
import { buildUpdateRules, buildDataPrompt } from './apps/linkage/prompt.js';
import { setLinkageOpener } from './apps/linkage/open.js';
import { createLiveTileFeed } from './tile-live-feed.js';

let instance;
let surfaceLoads;
// TauriTavern awaits this hook before projecting its first virtualized message.
// Do not wait for APP_READY here: that event occurs after this startup barrier.
export async function registerChatSurface() {
    if (!initialize() || !surfaceLoads) throw Error('Amin OS 楼层入口未能初始化，请检查扩展冲突与宿主接口。');
    for (const result of await Promise.all(surfaceLoads)) if (result.error) throw result.error;
}
export function initialize() {
    if(instance)return instance;
    const ctx=globalThis.SillyTavern?.getContext?.();
    if(!ctx?.extensionSettings)return;
    initializeChatLifecycle(() => globalThis.SillyTavern?.getContext?.());
    const existing = [];
    if(globalThis.SillyTavernDynamicMap || document.querySelector('.dynamic-map-panel'))existing.push('动态地图');
    if(document.getElementById('wsh-launcher'))existing.push('世界状态栏');
    if(document.getElementById('reply-options-panel'))existing.push('回复选项');
    try {
        const cleanup=cleanupRetiredData(localStorage,ctx);
        if(cleanup.errors.length)console.warn('[Amin os] Retired data cleanup incomplete:',cleanup.errors);
    } catch(error) { console.warn('[Amin os] Retired data cleanup unavailable:',error); }
    initializeAppearance(()=>globalThis.SillyTavern?.getContext?.());
    const shell=createShell();
    installAppearance(document);
    installTabScroll(document);
    instance=shell;
    if(existing.length){
        shell.setBlocked(`检测到旧插件：${existing.join('、')}。请在扩展管理中停用这三个旧插件，然后刷新页面，再使用 Amin os。已有数据会保留。`);
        return shell;
    }
    ctx.extensionSettings.dynamicMapNamespace ||= uuid();
    ctx.saveSettingsDebounced?.();
    initializeAI(localStorage,ctx.extensionSettings.dynamicMapNamespace);
    const linkage = getLinkageService();
    const state2 = initializeState2(() => globalThis.SillyTavern?.getContext?.(), { report: linkage.reportHost });
    globalThis.AminOSStoryGenerationGuard = async (_chat, _size, abort) => {
        if (state2.status().mode !== 'independent' && globalThis.SillyTavern?.getContext?.()?.chatMetadata?.amin_os_story_storage_v2
            && (!state2.storyStatus().enabled || !state2.ready())) {
            abort(true);
            globalThis.toastr?.error?.('外置剧情状态尚未恢复，请查看 Amin OS 剧情存储或联动更新中的错误。');
        }
    };
    const linkageHost = createLinkageHost(() => globalThis.SillyTavern?.getContext?.(), {
        buildPrompt: buildUpdateRules, buildDataPrompt, beforeGeneration: type => state2.prepareGeneration(type), captureGeneration: linkage.captureGeneration,
        collectReply: linkage.collectReply, cancelGeneration: linkage.cancelGeneration,
        report: linkage.reportHost,
    });
    linkage.reportHost(linkageHost.status().message);
    // Background: services that listen to chat events, inject prompts, keep checkpoints or register floor surfaces.
    // They start now, even while the shell is collapsed. Each app's window view loads when it first opens.
    const background={
        characters:()=>import('./apps/characters/service.js').then(m=>m.getSharedCharactersService()),
        inventory:()=>import('./apps/inventory/service.js').then(m=>m.getSharedInventoryService()),
        relationships:()=>import('./apps/relationships/service.js').then(m=>m.getSharedRelationshipsService()),
        saves:()=>import('./apps/saves/service.js').then(m=>m.getSharedSavesService()),
        scene:()=>Promise.all([import('./apps/scene/service.js'),import('./apps/map/travel.js')]).then(([scene,travel])=>{travel.getSharedTravelService();return scene.getSharedSceneService();}),
        journal:()=>import('./apps/journal/service.js').then(m=>m.getSharedService()),
        dice:()=>import('./apps/dice/service.js').then(m=>m.getSharedDiceService()),
        worldbooks:()=>import('./apps/worldbooks/runtime.js').then(m=>m.getManager()),
        information:()=>import('./apps/information/service.js').then(m=>m.getSharedService()),
        effects:()=>import('./apps/effects/service.js').then(m=>m.getSharedService()),
        organizations:()=>import('./apps/organizations/service.js').then(m=>m.getStore()),
        map:()=>import('./apps/map/index.js').then(m=>m.initialize({mount:shell.panes.map,onOpen:()=>shell.showApp('map')})),
        status:()=>import('./apps/status/index.js').then(m=>m.initialize({mount:shell.panes.status})),
    };
    const settle=promise=>promise.then(value=>({value}),error=>({error}));
    const ready={},mounted={};
    for(const id of new Set([...Object.keys(background),...Object.keys(views)])){
        if(background[id])ready[id]=settle(background[id]());
        shell.register(id,async section=>{
            if(ready[id]){
                let result=await ready[id];
                if(result.error){ready[id]=settle(background[id]());result=await ready[id];}
                if(result.error)throw result.error;
                if(!views[id])return await result.value?.open?.();
            }
            // Mount once; a failed load or mount is retried on the next open. Suite windows also get their members.
            mounted[id]??=views[id]().then(m=>m.mount(shell.panes[id],shell.suiteHost(id))).catch(error=>{mounted[id]=null;throw error;});
            await (await mounted[id])?.open?.(section);
        });
    }
    surfaceLoads = [ready.map, ready.status];
    setLinkageOpener(section=>shell.showApp('linkage',section));
    createLiveTileFeed({getContext:()=>globalThis.SillyTavern?.getContext?.(),apply:summaries=>shell.setLiveTiles(summaries),
        services:Object.fromEntries(['characters','inventory','relationships','scene','journal'].map(id=>[id,ready[id]])),
        enabled:()=>getAppearance()?.snapshot().desktop.liveTiles!==false,subscribeSettings:fn=>getAppearance()?.subscribe(fn)});
    installReplyFloorButtons();
    installTurnSummaries();
    for(const id of ['characters','inventory','relationships','saves','dice','scene','journal','organizations','effects','information','worldbooks','tts'])installExtraFloorButtons(id);
    const ev=ctx.eventTypes??ctx.event_types??{};
    if(ev.CHAT_CHANGED)ctx.eventSource?.on(ev.CHAT_CHANGED,()=>queueMicrotask(()=>shell.refreshActive()));
    globalThis.AminOS=Object.freeze({version:'0.19.9',open:()=>shell.open(),openApp:id=>shell.showApp(id),close:()=>shell.close()});
    return shell;
}

function start(){
    const ctx=globalThis.SillyTavern?.getContext?.(),ev=ctx?.eventTypes??ctx?.event_types??{};
    for(const key of ['APP_INITIALIZED','APP_READY'])if(ev[key])ctx.eventSource?.on(ev[key],initialize);
    initialize();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
