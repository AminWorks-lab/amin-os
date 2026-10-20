import { uuid } from '../uuid.js';
import {resolveHostConnection} from './host-connection.js';
import {waitForSignal} from './signal.js';
import {currentPrompt} from '../apps/effects/model.js';
import {currentPrompt as currentJournalPrompt} from '../apps/journal/model.js';
import {currentPrompt as currentScenePrompt} from '../apps/scene/model.js';
import { createApiSettings, createApiProfiles, generateText } from './transport.js';
import { createPresetLibrary, compilePreset } from './presets.js';
import { parseRequestBody } from './request-body.js';
import {createHostRoutes} from './host-settings.js';
import {getHostRouteOptions, captureHostRoute, observeHostGeneration, runHostGeneration} from './host-generation.js';
import { managesModule } from '../apps/linkage/policy.js';
import { buildDataPrompt } from '../apps/linkage/prompt.js';

export const AI_APPS = [
    {id:'map',name:'地图',tasks:['地图']},
    {id:'status',name:'世界状态',tasks:['世界状态']},
    {id:'reply',name:'回复选项',tasks:['回复选项']},
    {id:'stylewriter',name:'文风转换',tasks:['文风转换']},
    {id:'effects',name:'能力面板',tasks:['持续效果 · 规则起草']},
    {id:'information',name:'信息面板',tasks:['信息面板','信息面板 · 模拟推演']},
    {id:'organizations',name:'势力概览',tasks:['势力概览']},
    {id:'journal',name:'剧情档案',tasks:['剧情档案 · 编年史','剧情档案 · 资料生成']},
    {id:'relationships',name:'人物关系',tasks:['人物关系 · 剧情更新','人物关系 · 资料生成']},
    {id:'characters',name:'人物卡',tasks:['人物卡 · 资料生成']},
    {id:'inventory',name:'背包与账本',tasks:['背包与账本 · 资料生成']},
    {id:'scene',name:'场景与时间',tasks:['场景与时间 · 资料生成']},
    {id:'linkage',name:'联合初始化',tasks:['联合初始化 · 资料生成']},
];
const appId = app => AI_APPS.find(a=>a.id===app||a.tasks.includes(app))?.id;
const renderMessages = messages => messages.map(m => `[${m?.role ?? '未知'}]\n${typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? m) ?? ''}`).join('\n\n');
const shortValue = value => { const text = JSON.stringify(value); return text === undefined ? String(value) : text.length > 48 ? text.slice(0, 48) + '…' : text; };
/**
 * Previews must reflect the request that is really sent: the transport merges the custom requestBody
 * last, on the independent route and on the inherited host route alike, so an overridden messages
 * array replaces every assembled block.
 */
function previewText(captured, request, messages) {
    if (captured.route?.mode === 'tavern-current') return [
        `酒馆原生静默生成 · 跟随当前 ${captured.route.mainApi || 'API'} 连接及预设 ${captured.route.presetName || '当前设置'}`,
        '酒馆按 Quiet 触发器组装完整提示词及聊天上下文。下面只显示 Amin os 提交的工具任务；酒馆最终请求由酒馆组装，无法在此完整预览。',
        request.systemPrompt || '', request.prompt || '',
    ].filter(Boolean).join('\n\n');
    if (captured.route?.mode === 'tavern-profile') return [
        `酒馆连接配置 ${captured.route.profileName} · 模型由酒馆配置决定 · 生成参数预设 ${captured.route.presetName || '未指定'}`,
        '通过酒馆连接配置接口发送，使用 Amin os 组装的以下消息。配置内预设只提供生成参数，不加入酒馆 Prompt Manager 提示词块。',
        renderMessages(messages),
    ].join('\n\n');
    const { config } = captured;
    let overrides = {};
    try { overrides = parseRequestBody(config.requestBody); } catch { overrides = {}; }
    const pick = (key, fallback) => Object.hasOwn(overrides, key) ? overrides[key] === null ? undefined : overrides[key] : fallback;
    const replaced = Object.hasOwn(overrides, 'messages'), custom = Object.keys(overrides).filter(key => key !== 'messages');
    const stream = pick('stream', config.stream), sent = replaced ? pick('messages') : messages;
    const limits = [['max_tokens', pick('max_tokens', config.maxTokens)], ['max_completion_tokens', pick('max_completion_tokens')]].filter(([, value]) => value !== undefined).map(([key, value]) => `${key} ${value}`).join(' / ');
    const header = `最终请求体：模型 ${pick('model', config.enabled ? config.model : '由酒馆配置决定') ?? '已删除（请求会失败）'} · 输出上限 ${limits || '未设置'} · 流式 ${stream === undefined ? '未设置' : stream ? '开' : '关'}`;
    const lines = [header];
    if (custom.length) lines.push(`自定义字段 ${custom.map(key => overrides[key] === null ? `${key}（已删除）` : `${key}=${shortValue(overrides[key])}`).join('、')}`);
    if (replaced && (!Array.isArray(sent) || !sent.length)) { lines.push('自定义 messages 必须是非空数组；这个请求会被拒绝，请修正自定义请求参数。'); return lines.join('\n\n'); }
    if (replaced) lines.push('自定义 requestBody 覆盖了 messages：以下就是实际发送的内容，应用组装的上下文不会被发送。');
    lines.push(renderMessages(sent));
    return lines.join('\n\n');
}
let shared;
export const getAI = () => shared;
// Only used when the shared layer was never initialized (index.js always initializes it
// before any app runs; unit tests and directly loaded modules may not). It still goes
// through the shared transport: with default, disabled independent-API settings
// generateText sends the request unchanged to the host's current connection
// (ctx.generateRaw), the same path an Amin route without an enabled API takes.
const HOST_AI = Object.freeze({
    capture: () => null,
    generate: (app, ctx, request, { signal } = {}) => generateText(ctx, {}, request, { signal }),
});
export const getAIOrHost = () => shared ?? HOST_AI;
export function initializeAI(storage, namespace, options) {
    return shared ??= createAI(storage, namespace, options);
}
export function createAI(storage, namespace, {resolveConnection=resolveHostConnection, fetchImpl, getHostContext=()=>globalThis.SillyTavern?.getContext?.()} = {}) {
    observeHostGeneration(getHostContext());
    const connections=new WeakMap();
    const scope = `amin-os:${namespace}`;
    const settings = createApiSettings(storage, scope);
    const profiles = createApiProfiles(storage, scope);
    const hostRoutes = createHostRoutes(storage, namespace);
    const presets = createPresetLibrary(storage, scope);
    const initialPreset=presets.list().find(p=>p.id==='default');
    if(initialPreset?.name==='默认地图预设')presets.save({...initialPreset,name:'默认共享预设'});
    const selectionKey = `amin-os.ai-preset:${namespace}`;
    const listeners = new Set(), tasks = [], previews = new Map();
    let selected = storage.getItem(selectionKey) || presets.list()[0].id;
    const notify = () => listeners.forEach(f => f());
    return {
        settings, profiles, presets,
        selected: () => selected,
        select(id) { if (!presets.list().some(p => p.id === id)) throw Error('预设不存在'); storage.setItem(selectionKey, id); selected = id; notify(); },
        hostRoutes() { const ctx=getHostContext();observeHostGeneration(ctx);return getHostRouteOptions(ctx); },
        route(app) { const id=appId(app);return id?hostRoutes.get(id):{mode:'amin',profileId:''}; },
        setRoute(app, route) {
            const id=appId(app);if(!id)throw Error('未知的 AI 应用');
            if(route?.mode==='tavern-current' || route?.mode==='tavern-profile') captureHostRoute(getHostContext(),route);
            const saved=hostRoutes.set(id,route);notify();return saved;
        },
        channel(app) { const id=appId(app);return id?profiles.binding('app:'+id):''; },
        setChannel(app, profileId) {
            const id=appId(app);if(!id)throw Error('未知的 AI 应用');
            if(profileId&&!profiles.get(profileId))throw Error('API 配置不存在，请重新选择');
            profiles.bind('app:'+id,profileId||'');notify();
        },
        capture(app) {
            const id=appId(app),profileId=id?profiles.binding('app:'+id):'';
            const route=id?hostRoutes.get(id):{mode:'amin',profileId:''};
            const config=route.mode==='amin'&&profileId?profiles.get(profileId):settings.snapshot();
            if(!config)throw Error('应用指定的 API 配置已不存在，请在 AI 设置重新选择');
            const host=route.mode==='amin'?route:captureHostRoute(getHostContext(),route);
            const channelName=route.mode==='tavern-current'?'酒馆当前连接':route.mode==='tavern-profile'?`酒馆 · ${host.profileName}`:profileId?profiles.list().find(p=>p.id===profileId)?.name:'全局默认';
            return structuredClone({config, app:id, profileId, channelName, route:host, preset:presets.list().find(p=>p.id===selected)??presets.list()[0]});
        },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        tasks: () => tasks.map(({controller, ...rest}) => ({...rest})),
        previews: () => [...previews].map(([app, text]) => ({app, text})),
        cancel(id) { tasks.find(t => t.id === id)?.controller.abort(new Error('已从 AI 设置取消任务')); },
        async generate(app, ctx, request, { signal, snapshot, data, includeEffects = true, includeJournal = includeEffects, includeScene = includeEffects, includeLinkage = includeEffects } = {}) {
            const sharedPrompt=[
                includeEffects&&!managesModule(ctx,'effects')?currentPrompt(ctx):'',
                includeJournal&&!managesModule(ctx,'journal')?currentJournalPrompt(ctx):'',
                includeScene&&!managesModule(ctx,'scene')?currentScenePrompt(ctx):'',
                includeLinkage?buildDataPrompt(ctx,{purpose:'tool',write:false}):'',
            ].filter(Boolean).join('\n\n');
            const captured = snapshot ?? this.capture(app);
            if(!captured.preset.blocks.some(b=>b.type==='request'&&b.enabled))throw Error('共享预设必须启用“本次要求”块，请在 AI 设置中恢复。');
            const controller = new AbortController();
            const abort = () => controller.abort(signal?.reason);
            if (signal?.aborted) abort();
            signal?.addEventListener('abort', abort, {once:true});
            const task = {id:uuid(), app, channel:captured.channelName||'全局默认', state:'等待模型 / 排队中', controller};
            // The fixed application contract is a single system message. Amin's
            // editable preset supplies task data, not a second copy of the contract.
            const messages = [{role:'system',content:request.systemPrompt}, ...compilePreset(captured.preset, data ?? {request:request.prompt})];
            if(sharedPrompt)messages.push({role:'system',content:sharedPrompt});
            previews.set(app, previewText(captured, request, messages));
            tasks.push(task); while(tasks.length > 40 && ['完成','已取消','失败'].includes(tasks[0].state)) tasks.shift(); notify();
            try {
                if(captured.route?.mode==='tavern-current'||captured.route?.mode==='tavern-profile') {
                    const timer=setTimeout(()=>controller.abort(new Error('酒馆生成等待超时，未应用结果')),captured.config.timeoutSeconds*1000);
                    try {
                        const result=await runHostGeneration({ctx,route:captured.route,request,messages,sharedPrompt,maxTokens:captured.config.maxTokens,signal:controller.signal,getContext:getHostContext});
                        task.state='完成';return result;
                    } finally {clearTimeout(timer);}
                }
                if(!connections.has(captured))connections.set(captured,Promise.resolve().then(()=>resolveConnection(captured.config,ctx)));
                const timer=setTimeout(()=>controller.abort(new Error('读取 API 配置超时，未应用生成结果')),captured.config.timeoutSeconds*1000);
                let connection;
                try {connection=await waitForSignal(()=>connections.get(captured),controller.signal);}finally{clearTimeout(timer);}
                const text = await generateText(ctx, connection, {...request, messages, responseLength:captured.config.maxTokens}, {signal:controller.signal, targetKey:scope, fetchImpl});
                task.state = '完成'; return text;
            } catch(error) { task.state = controller.signal.aborted ? '已取消' : '失败'; throw error; }
            finally { signal?.removeEventListener('abort', abort); notify(); }
        },
        importLegacy() {
            const old = createApiSettings(storage, namespace).snapshot();
            if(old.enabled || old.baseUrl) profiles.save('legacy-map', '原地图 API', old);
            const oldProfiles = createApiProfiles(storage, namespace);
            for(const p of oldProfiles.list()) profiles.save(`legacy-${p.id}`, `原地图 · ${p.name}`, oldProfiles.get(p.id));
            for(const p of createPresetLibrary(storage, namespace).list()) presets.save({...p,id:`legacy-${p.id}`,name:`原地图 · ${p.name}`});
            const status = globalThis.SillyTavern?.getContext?.().extensionSettings?.world_status_hud_v1;
            if(status?.baseUrl && status?.model) profiles.save('legacy-status','原状态栏 API',{...old,enabled:true,baseUrl:status.baseUrl,model:status.model,maxTokens:status.maxTokens||4096,apiKey:'',rememberKey:false});
            notify();
        },
    };
}
