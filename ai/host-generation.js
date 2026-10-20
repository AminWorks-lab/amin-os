import { waitForSignal } from './signal.js';
import { withLinkageToolScope } from '../apps/linkage/host.js';

// SillyTavern's ConnectionManagerRequestService routes through its own server and
// secret store. Its profile preset supplies generation parameters, not the
// Prompt Manager's assembled prompts or prompt_order.
export function getHostRouteOptions(ctx) {
    const quietAvailable = typeof ctx?.generateQuietPrompt === 'function';
    const service = ctx?.ConnectionManagerRequestService;
    let profiles = [], error = '';
    if (typeof service?.getSupportedProfiles === 'function' && typeof service?.sendRequest === 'function') {
        try {
            profiles = service.getSupportedProfiles().filter(p => !unsupportedTauriProfile(ctx, p)).map(p => ({
                id: p.id, name: p.name || p.id, api: p.api || '', model: p.model || '', preset: p.preset || '',
            })).filter(p => typeof p.id === 'string' && p.id);
        } catch (cause) { error = cause?.message || '无法读取酒馆连接配置'; }
    } else error = '当前酒馆未提供连接配置请求接口';
    return { quietAvailable, profileAvailable: !error, profiles, error };
}

function hostPreset(ctx) {
    try { return ctx?.getPresetManager?.(ctx.mainApi)?.getSelectedPresetName?.() || ''; }
    catch { return ''; }
}

function profileType(ctx, candidate) {
    const selected = ctx?.CONNECT_API_MAP?.[candidate?.api]?.selected;
    return typeof selected === 'string' ? selected : '';
}

function unsupportedTauriProfile(ctx, candidate) {
    return globalThis.__TAURI_RUNNING__ === true && profileType(ctx, candidate) === 'textgenerationwebui';
}

function assertProfilePreset(ctx, candidate) {
    const presetName = typeof candidate?.preset === 'string' ? candidate.preset.trim() : '';
    if (!presetName) return;
    const type = profileType(ctx, candidate);
    if (!type) return;
    if (typeof ctx?.getPresetManager !== 'function') {
        if (globalThis.__TAURI_RUNNING__ === true) throw Error('当前 TauriTavern 无法验证酒馆连接配置的生成参数预设，请更新宿主');
        return;
    }
    let manager;
    try { manager = ctx.getPresetManager(type); }
    catch (cause) { throw Error('无法验证酒馆连接配置的生成参数预设：' + (cause?.message || String(cause))); }
    if (typeof manager?.getCompletionPresetByName !== 'function') {
        if (globalThis.__TAURI_RUNNING__ === true) throw Error('当前 TauriTavern 无法验证酒馆连接配置的生成参数预设，请更新宿主');
        return;
    }
    let preset;
    try { preset = manager.getCompletionPresetByName(presetName); }
    catch (cause) { throw Error('无法验证酒馆连接配置的生成参数预设：' + (cause?.message || String(cause))); }
    if (!preset) throw Error(`酒馆连接配置绑定的生成参数预设“${presetName}”已删除或不可用，请重新选择`);
}

function completionChannelStamp(ctx) {
    if ((ctx?.mainApi || '') !== 'openai') return '';
    const settings = ctx?.chatCompletionSettings;
    if (!settings || typeof settings !== 'object' || typeof ctx?.getChatCompletionModel !== 'function') return '';
    const source = settings.chat_completion_source;
    if (typeof source !== 'string' || !source) return '';
    try {
        const model = ctx.getChatCompletionModel(settings);
        if (model === undefined) return '';
        return JSON.stringify({ source, model: model ?? null });
    } catch { return ''; }
}

function routeGuard(ctx) {
    const tail=ctx?.chat?.at?.(-1);
    return { chatId:ctx?.getCurrentChatId?.()??ctx?.chatId??null,characterId:ctx?.characterId??null,groupId:ctx?.groupId??null,
        length:ctx?.chat?.length??0,tail:tail?JSON.stringify([tail.name??'',!!tail.is_user,tail.mes??'',tail.swipe_id??0]):'' };
}

function assertRouteGuard(ctx, expected) {
    if (JSON.stringify(routeGuard(ctx)) !== JSON.stringify(expected)) throw Error('聊天或楼层已变化，本次 AI 请求未发送');
}

function profile(ctx, profileId) {
    const service = ctx?.ConnectionManagerRequestService;
    if (typeof service?.getSupportedProfiles !== 'function' || typeof service?.sendRequest !== 'function') {
        throw Error('当前酒馆未提供连接配置请求接口，请更新酒馆或改用 Amin API');
    }
    let found;
    try { found = service.getSupportedProfiles().find(p => p.id === profileId); }
    catch (cause) { throw Error('无法读取酒馆连接配置：' + (cause?.message || String(cause))); }
    if (!found) throw Error('所选酒馆连接配置已删除、停用或不支持，请重新选择');
    if (unsupportedTauriProfile(ctx, found)) throw Error('TauriTavern 当前不支持 Text Completion 酒馆连接配置，请改用 Chat Completion 配置');
    assertProfilePreset(ctx, found);
    return found;
}

export function captureHostRoute(ctx, route) {
    if (route.mode === 'tavern-current') {
        if (typeof ctx?.generateQuietPrompt !== 'function') throw Error('当前酒馆没有静默生成接口，请更新酒馆或改用 Amin API');
        return { mode: route.mode, profileId: '', mainApi: ctx.mainApi || '', presetName: hostPreset(ctx), channelStamp: completionChannelStamp(ctx), guard:routeGuard(ctx) };
    }
    if (route.mode === 'tavern-profile') {
        const p = profile(ctx, route.profileId);
        return { mode: route.mode, profileId: p.id, profileName: p.name || p.id, profileStamp: JSON.stringify(p), presetName: p.preset || '', guard:routeGuard(ctx) };
    }
    return { mode: 'amin', profileId: '' };
}

function chatToken(ctx) {
    const chat = ctx?.chat;
    const tail = Array.isArray(chat) ? chat.at(-1) : null;
    return { metadata: ctx?.chatMetadata, id: ctx?.getCurrentChatId?.() ?? ctx?.chatId, characterId: ctx?.characterId,
        groupId: ctx?.groupId, length: chat?.length ?? 0, tail, swipe: tail?.swipe_id ?? 0, text: tail?.mes };
}

function assertChat(ctx, expected) {
    const now = chatToken(ctx);
    if (now.metadata !== expected.metadata || now.id !== expected.id || now.characterId !== expected.characterId ||
        now.groupId !== expected.groupId || now.length !== expected.length || now.tail !== expected.tail ||
        now.swipe !== expected.swipe || now.text !== expected.text) {
        throw Error('聊天或楼层已变化，本次 AI 结果已丢弃');
    }
}

const quietSlots = new WeakMap();
function quietSlot(ctx) {
    const events = ctx?.eventSource;
    const key = events && typeof events === 'object' ? events : ctx.generateQuietPrompt;
    let slot = quietSlots.get(key);
    if (slot) return slot;
    slot = { tail: Promise.resolve(), normalActive: false, waiters: new Set() };
    const types = ctx.eventTypes || ctx.event_types || {};
    if (types.GENERATION_STARTED) events?.on?.(types.GENERATION_STARTED, (type, _options, dryRun) => {
        if (type !== 'quiet' && !dryRun) slot.normalActive = true;
    });
    const ended = () => { slot.normalActive = false; for (const wake of slot.waiters) wake(); slot.waiters.clear(); };
    if (types.GENERATION_ENDED) events?.on?.(types.GENERATION_ENDED, ended);
    if (types.GENERATION_STOPPED) events?.on?.(types.GENERATION_STOPPED, ended);
    quietSlots.set(key, slot);
    return slot;
}

export function observeHostGeneration(ctx) {
    if (typeof ctx?.generateQuietPrompt === 'function') quietSlot(ctx);
}

function normalGenerationVisible() {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return false;
    const stop = document.getElementById('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}

async function awaitNormalGeneration(slot, signal) {
    while (slot.normalActive || normalGenerationVisible()) {
        await new Promise((resolve, reject) => {
            // SillyTavern may emit GENERATION_ENDED before it hides #mes_stop.
            // Recheck after a short delay so a DOM-only transition cannot leave
            // this queue waiting forever for an event that already fired.
            let timer;
            const cleanup = () => { clearTimeout(timer); slot.waiters.delete(wake); signal?.removeEventListener('abort', abort); };
            const wake = () => { cleanup(); resolve(); };
            const abort = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : Error('已取消生成，未应用结果')); };
            if (signal?.aborted) return abort();
            slot.waiters.add(wake);
            signal?.addEventListener('abort', abort, { once: true });
            timer=setTimeout(wake, 25);
        });
    }
}

function quietPrompt(request, messages, sharedPrompt) {
    const compiled=(messages||[]).map(message=>`[${message?.role||'user'}]\n${typeof message?.content==='string'?message.content:JSON.stringify(message?.content??'')}`).join('\n\n');
    return [
        '【Amin os 本次工具任务】',
        '下列消息是 Amin os 为本次工具任务整理的完整资料与输出协议。它们只影响静默工具结果；酒馆仍按当前预设的 Quiet 触发器组装角色、世界书和聊天上下文。',
        compiled || [request.systemPrompt,request.prompt].filter(Boolean).join('\n\n'),
        sharedPrompt && !compiled.includes(sharedPrompt) ? sharedPrompt : '',
        '只返回本次工具任务所需结果，不要续写聊天正文。',
    ].filter(Boolean).join('\n\n');
}

export async function runHostGeneration({ ctx, route, request, messages, sharedPrompt = '', maxTokens, signal, getContext = () => globalThis.SillyTavern?.getContext?.() }) {
    const current = () => getContext() || ctx;
    assertRouteGuard(current(),route.guard);
    const token = chatToken(current());
    const check = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Error('已取消生成，未应用结果'); assertChat(current(), token); };
    check();
    if (route.mode === 'tavern-profile') {
        const p = profile(current(), route.profileId);
        if (JSON.stringify(p) !== route.profileStamp) throw Error('所选酒馆连接配置已变化，请重新发起生成');
        const service = current().ConnectionManagerRequestService;
        const result = await waitForSignal(() => service.sendRequest(route.profileId, messages, maxTokens,
            { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true }), signal);
        check();
        if (typeof result?.content !== 'string' || !result.content.trim()) throw Error('酒馆连接配置未返回文本');
        return result.content;
    }
    if (route.mode !== 'tavern-current') throw Error('未知的酒馆生成方式');
    if (typeof current()?.generateQuietPrompt !== 'function') throw Error('当前酒馆没有静默生成接口');
    const slot = quietSlot(current());
    const scheduled = slot.tail.catch(() => {}).then(async () => {
        await awaitNormalGeneration(slot, signal);
        check();
        const live = current();
        if ((live.mainApi || '') !== route.mainApi || hostPreset(live) !== route.presetName ||
            (route.channelStamp && completionChannelStamp(live) !== route.channelStamp)) {
            throw Error('酒馆当前连接或预设已变化，请重新发起生成');
        }
        return await withLinkageToolScope(current, () => live.generateQuietPrompt({ quietPrompt: quietPrompt(request, messages, sharedPrompt), responseLength: maxTokens }));
    });
    // Keep the slot occupied until SillyTavern itself settles, even if Amin's
    // caller stopped waiting: generateQuietPrompt has no AbortSignal option.
    slot.tail = scheduled.then(() => {}, () => {});
    const result = await waitForSignal(() => scheduled, signal);
    check();
    if (typeof result !== 'string' || !result.trim()) throw Error('酒馆静默生成未返回文本');
    return result;
}
