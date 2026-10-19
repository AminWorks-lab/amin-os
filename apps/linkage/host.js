import { chatIdentity } from '../shared/operations.js';
import { managesModule, readLinkageSettings } from './policy.js';
import { isUnifiedEntry, hasUnifiedPlaceholder, LINKAGE_PLACEHOLDER } from './lorebook.js';
import { isIndependent } from '../story-state/access.js';
import { checkPromptBudget, budgetMessage } from './budget.js';

const storyTypes = new Set(['normal', 'regenerate', 'swipe']);
const buckets = ['chatLore', 'characterLore', 'globalLore', 'personaLore'];
const requiredEvents = ['GENERATION_AFTER_COMMANDS', 'WORLDINFO_ENTRIES_LOADED', 'WORLD_INFO_ACTIVATED', 'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED'];
const toolScopes = new WeakMap();
let sequence = 0;
export const LINKAGE_DATA_PROMPT_KEY = 'amin-os-linkage-data';
export const LINKAGE_UPDATE_PROMPT_KEY = 'amin-os-linkage-update';

const contextKey = ctx => ctx?.eventSource && typeof ctx.eventSource === 'object' ? ctx.eventSource : ctx?.chatMetadata;
function inToolScope(ctx) {
    const stack = toolScopes.get(contextKey(ctx));
    return !!stack?.some(scope => scope.metadata === ctx?.chatMetadata && scope.identity === chatIdentity(ctx));
}

/** Use only around the actual quiet call, after the host generation queue waits. */
export async function withLinkageToolScope(getContext, task) {
    const ctx = typeof getContext === 'function' ? getContext() : getContext;
    const key = contextKey(ctx);
    if (!key || typeof key !== 'object') return task();
    const stack = toolScopes.get(key) ?? [];
    const scope = { metadata: ctx.chatMetadata, identity: chatIdentity(ctx) };
    stack.push(scope); toolScopes.set(key, stack);
    try { return await task(); }
    finally { const index = stack.indexOf(scope); if (index >= 0) stack.splice(index, 1); if (!stack.length) toolScopes.delete(key); }
}

function legacyModule(entry) {
    if (entry?.world_status_hud_owner === 'world-status-hud/variable-update-v1') return 'status';
    if (entry?.amin_organizations_owner === 'amin-os/organizations-v1') return 'organizations';
    if (entry?.dynamic_map_owner === 'dynamic-map/tool-calling-v1') return 'map';
    return null;
}
const disabledCopy = entry => ({ ...entry, content: '', disable: true });
const entryKey = entry => JSON.stringify([entry.world ?? '', entry.uid]);
const messageSnapshot = ctx => (ctx.chat ?? []).map(message => ({ ref: message, text: message.mes, swipe: message.swipe_id ?? 0 }));
function promptContext(ctx, active) {
    const tail = ctx.chat?.at(-1);
    return tail && tail === active.excludedReply
        ? { ...ctx, chat: ctx.chat.slice(0, -1) } : ctx;
}

/**
 * Mutates only the event's arrays of scan-local entries. Both supported host
 * implementations copy cached book entries before WORLDINFO_ENTRIES_LOADED and
 * clone the scan afterward. No current-chat data is written to worldInfoCache.
 */
export function createLinkageHost(getContext, {
    captureGeneration, collectReply, buildPrompt, buildDataPrompt, beforeGeneration, cancelGeneration = () => {}, report = () => {},
    readSettings = readLinkageSettings, manages = managesModule,
    independent = isIndependent,
    warn = text => globalThis.toastr?.warning?.(text, 'Amin OS', { timeOut: 15000 }),
} = {}) {
    const initial = getContext(), events = initial?.eventTypes ?? initial?.event_types ?? {}, source = initial?.eventSource;
    const supported = !!source?.on && requiredEvents.every(key => events[key]) && typeof buildPrompt === 'function'
        && typeof captureGeneration === 'function' && typeof collectReply === 'function'
        && typeof buildDataPrompt === 'function' && typeof initial?.setExtensionPrompt === 'function';
    const independentSupported = !!source?.on && requiredEvents.filter(key => key !== 'WORLD_INFO_ACTIVATED').every(key => events[key])
        && typeof buildPrompt === 'function' && typeof captureGeneration === 'function' && typeof collectReply === 'function'
        && typeof buildDataPrompt === 'function' && typeof initial?.setExtensionPrompt === 'function';
    const hostReady = ctx => independent(ctx) ? independentSupported : supported;
    const subscriptions = [];
    let run = null, timer = null, disposed = false, epoch = 0, budgetWarning = '', message = hostReady(initial)
        ? independent(initial) ? '等待酒馆生成与 Amin 更新协议' : '等待酒馆生成和统一世界书条目'
        : '当前酒馆缺少统一联动所需的生成或世界书事件；不会自动接收更新';
    const say = value => { message = value; try { report(value); } catch { /* Status UI cannot interrupt host generation. */ } };
    const current = active => {
        const ctx = getContext();
        return !!active && !disposed && !active.signal?.aborted && ctx?.chatMetadata === active.metadata && chatIdentity(ctx) === active.identity;
    };
    function clearData() {
        initial?.setExtensionPrompt?.(LINKAGE_DATA_PROMPT_KEY, '', 1, 0, false, 0);
        initial?.setExtensionPrompt?.(LINKAGE_UPDATE_PROMPT_KEY, '', 1, 0, false, 0);
    }
    function injectData(active) {
        const ctx = getContext();
        if (!current(active) || !readSettings(ctx).enabled || active.type === 'quiet' && inToolScope(ctx)) {
            clearData(); return;
        }
        const value = buildDataPrompt(promptContext(ctx, active), { purpose: active.purpose, write: false });
        if (typeof value !== 'string') throw Error('插件资料提示词无效');
        active.data = value;
        // IN_CHAT=1, SYSTEM=0. The host consumes this during prompt assembly;
        // scan=false prevents application facts from activating worldbook entries.
        ctx.setExtensionPrompt(LINKAGE_DATA_PROMPT_KEY, value, 1, 0, false, 0, () => {
            try {
                const live = getContext();
                if (run !== active || !current(active) || !readSettings(live).enabled) return false;
                if (buildDataPrompt(promptContext(live, active), { purpose: active.purpose, write: false }) !== active.data) {
                    active.failed = true; clearData(); return false;
                }
                return true;
            } catch { active.failed = true; clearData(); return false; }
        });
    }
    function injectIndependentRules(active) {
        if (!active.independent || !active.write || !current(active) || !readSettings(getContext()).enabled) return;
        const value = buildPrompt(promptContext(getContext(), active), { purpose: active.purpose, write: true });
        if (typeof value !== 'string') throw Error('独立剧情更新规则无效');
        active.prompt = value;
        getContext().setExtensionPrompt(LINKAGE_UPDATE_PROMPT_KEY, value, 1, 0, false, 0, () => {
            try {
                if (run !== active || !current(active) || !independent(getContext()) || !readSettings(getContext()).enabled) return false;
                if (buildPrompt(promptContext(getContext(), active), { purpose: active.purpose, write: true }) !== active.prompt) {
                    active.failed = true; clearData(); return false;
                }
                return true;
            } catch { active.failed = true; clearData(); return false; }
        });
    }
    // Warn once per chat and severity; the status line keeps the latest estimate.
    function checkBudget(active) {
        if (!current(active)) return;
        const result = checkPromptBudget(getContext(), [active.data, active.prompt]);
        active.budget = result;
        const text = budgetMessage(result);
        if (!text) return;
        say(text);
        const key = `${active.identity}|${result.level}`;
        if (budgetWarning === key) return;
        budgetWarning = key;
        try { warn(text); } catch { /* A notice cannot interrupt host generation. */ }
    }
    function cancel(reason = '') {
        epoch++;
        clearData();
        clearTimeout(timer); timer = null; run = null;
        try { cancelGeneration(reason); } catch { /* The next generation will capture a new baseline. */ }
        if (reason) say(reason);
    }
    async function start(type = 'normal', options = {}, dryRun = false) {
        // A dry-run prompt inspection must not invalidate a live generation.
        if (dryRun) return;
        cancel();
        if (disposed) return;
        const ctx = getContext();
        if (!hostReady(ctx)) { say('当前宿主缺少联动生成接口或事件，本轮无法接收更新'); return; }
        if (!readSettings(ctx).enabled) { say('当前聊天未启用统一联动更新；请在此分支启用并保存设置'); return; }
        if (options?.signal?.aborted) { say('本轮生成已取消，未建立更新接收记录'); return; }
        if (!ctx?.chatMetadata) { say('当前聊天资料尚未就绪，未建立更新接收记录'); return; }
        const id = ctx.getCurrentChatId?.() ?? ctx.chatId;
        if (id == null || id === '') { say('当前聊天尚无有效标识，未建立更新接收记录'); return; }
        type ||= 'normal';
        if (beforeGeneration) {
            const identity = chatIdentity(ctx), metadata = ctx.chatMetadata, started = epoch;
            const ready = await beforeGeneration(type);
            if (disposed || epoch !== started || options?.signal?.aborted || getContext()?.chatMetadata !== metadata || chatIdentity(getContext()) !== identity) return;
            if (ready === false) {
                say('Amin 当前剧情资料尚未初始化；请在设置 → 剧情存储中导入旧资料或开始空白资料。正文可正常生成，本轮不注入更新规则。');
                return;
            }
        }
        run = {
            id: ++sequence, type, metadata: ctx.chatMetadata, identity: chatIdentity(ctx), signal: options?.signal,
            independent: independent(ctx),
            purpose: type === 'quiet' ? 'tool' : 'story', write: storyTypes.has(type),
            before: messageSnapshot(ctx), selected: null, prompt: '', data: '', captured: false,
            excludedReply: ['regenerate', 'swipe'].includes(type) && !ctx.chat?.at(-1)?.is_user && !ctx.chat?.at(-1)?.is_system ? ctx.chat?.at(-1) : null,
            candidate: null, ended: false, failed: false,
        };
        say(run.write ? run.independent ? '已收到当前聊天的生成事件，等待组装 Amin 更新规则' : '已收到当前聊天的生成事件，等待加载统一更新规则' : '本轮为续写或工具生成，仅提供资料，不接收自动更新');
        injectData(run);
        injectIndependentRules(run);
        checkBudget(run);
        options?.signal?.addEventListener?.('abort', () => { if (run?.signal === options.signal) cancel('生成已停止，未接收本轮统一更新'); }, { once: true });
    }
    async function loaded(payload) {
        const ctx = getContext(), entries = [];
        if (!payload || typeof payload !== 'object') return;
        for (const bucket of buckets) if (Array.isArray(payload[bucket])) {
            payload[bucket].forEach((entry, index) => entries.push({ list: payload[bucket], index, entry }));
        }
        // Independent state never consumes native update rules, even when its
        // master switch/module is off. Legacy mode suppresses managed modules.
        // Only marked Amin entries change in this scan; original books stay intact.
        for (const row of entries) {
            const module = legacyModule(row.entry);
            if (module && (independent(ctx) || manages(ctx, module))) row.list[row.index] = disabledCopy(row.entry);
        }
        const owned = entries.filter(row => isUnifiedEntry(row.entry));
        for (const row of owned) row.list[row.index] = disabledCopy(row.entry);
        const active = run;
        if (!hostReady(ctx) || !current(active) || !readSettings(ctx).enabled || active.type === 'quiet' && inToolScope(ctx)) { clearData(); return; }
        // Refresh after the host appends input/removes a regenerated candidate,
        // before it snapshots extension prompts. This also works without a bound book.
        injectData(active);
        if (!active.write) return;
        if (active.independent) {
            try {
                injectIndependentRules(active);
                if (!active.prompt.trim()) { say('没有允许更新的模块；本轮仅提供剧情资料'); return; }
                // This event runs after the host appended user input or removed
                // the regenerated reply. No worldbook activation is required.
                if (!active.captured) {
                    active.before = messageSnapshot(ctx);
                    const accepted = await captureGeneration(active.type, { excludedReply: active.excludedReply });
                    if (accepted === false) throw Error('当前不能建立独立剧情更新基线，请完成待保存操作后重试');
                    if (!current(active) || run !== active) return;
                    active.captured = true;
                }
                say('已注入独立剧情更新规则，等待新的完整角色回复');
            } catch (error) { active.failed = true; clearData(); say('本轮独立更新基线未建立：' + error.message); }
            return;
        }
        // Keep exactly one applicable owned entry across overlapping book bindings.
        const selected = owned.find(({ entry }) => !entry.disable && hasUnifiedPlaceholder(entry.content)
            && (!Array.isArray(entry.triggers) || !entry.triggers.length || entry.triggers.includes(active.type)));
        if (!selected) { say(owned.length ? '统一条目未启用、触发器不匹配或占位无效；本轮不会接收自动更新' : '本轮未加载统一条目；请检查世界书绑定和预设'); return; }
        try {
            const prompt = buildPrompt(promptContext(ctx, active), { purpose: active.purpose, write: active.write });
            if (typeof prompt !== 'string' || !prompt.trim()) { say('没有可用的变量更新规则；请检查当前分支的模块参与、读取与允许更新设置'); return; }
            // Replace by callback so dollar sequences in state stay literal.
            const expanded = {
                ...selected.entry,
                content: selected.entry.content.replace(LINKAGE_PLACEHOLDER, () => prompt),
                amin_os_linkage_run: active.id,
            };
            selected.list[selected.index] = expanded;
            active.selected = entryKey(expanded); active.prompt = prompt;
            say('已展开变量更新规则；资料由插件注入，等待酒馆确认规则实际激活');
        } catch (error) { active.failed = true; clearData(); say('统一条目未展开：' + error.message); }
    }
    async function activated(entries) {
        const active = run;
        if (active?.independent) return;
        if (!current(active) || active.failed || !active.write || active.captured || !Array.isArray(entries)) return;
        if (!entries.some(entry => isUnifiedEntry(entry) && entry.amin_os_linkage_run === active.id && entryKey(entry) === active.selected)) return;
        try {
            const ctx = getContext();
            if (!readSettings(ctx).enabled || buildPrompt(promptContext(ctx, active), { purpose: active.purpose, write: active.write }) !== active.prompt
                || buildDataPrompt(promptContext(ctx, active), { purpose: active.purpose, write: false }) !== active.data) {
                throw Error('提示词组装期间联动资料或设置已变化');
            }
            // AFTER_COMMANDS is too early: the host may still append the user
            // message or remove the previous reply for a regeneration afterward.
            active.before = messageSnapshot(ctx);
            const accepted = await captureGeneration(active.type, { excludedReply: active.excludedReply });
            if (accepted === false) throw Error('联动服务当前不能建立生成基线，请完成待保存操作后重试');
            if (!current(active) || run !== active) return;
            active.captured = true;
            say('统一条目已激活，等待新的完整角色回复');
        } catch (error) { active.failed = true; clearData(); say('本轮更新基线未建立：' + error.message); }
    }
    function schedule() {
        if (!run?.ended || run.candidate === null) return;
        clearTimeout(timer);
        // Some hosts emit ENDED before RECEIVED/STOPPED in the same event turn.
        timer = setTimeout(() => { void finish(); }, 0);
    }
    function received(index, type) {
        if (!run?.captured || !Number.isInteger(index) || type && !storyTypes.has(type)) return;
        const stream = getContext()?.streamingProcessor;
        run.candidate = index;
        run.failed ||= !!(stream?.isStopped || stream?.abortController?.signal?.aborted);
        schedule();
    }
    function ended() {
        clearData();
        if (!run) return;
        if (!run.write) { cancel(); return; }
        if (!run.captured) {
            if (run.independent && !run.failed) say('本轮未建立 Amin 更新基线；正文可正常生成，未修改当前资料');
            else if (run.selected && !run.failed) say('本轮规则已展开，但未确认统一条目实际激活，未接收更新；请检查世界书预算与预设');
            else if (!run.selected && message === '已收到当前聊天的生成事件，等待加载统一更新规则') say('本轮未确认世界书加载和统一更新规则激活；此提示不代表变量恢复结果或小白执行结果，请另看“剧情变量 · 小白变量 2.0”的恢复状态');
            cancel(); return;
        }
        run.ended = true; schedule();
    }
    async function finish() {
        const active = run; run = null; timer = null; clearData();
        if (!active?.captured) return;
        try {
            if (!current(active) || active.failed) throw Error('生成已停止或聊天已切换');
            const ctx = getContext(), reply = ctx.chat?.[active.candidate], before = active.before[active.candidate];
            if (!readSettings(ctx).enabled || active.candidate !== ctx.chat.length - 1 || !reply || reply.is_user || reply.is_system || !reply.gen_finished
                || before?.ref === reply && before.text === reply.mes && before.swipe === (reply.swipe_id ?? 0)) {
                throw Error('没有与本次生成对应的完整新回复');
            }
            const result = await collectReply(active.candidate);
            say(result?.outcome === 'native' ? result.message : result?.outcome === 'missing' ? '更新规则已激活，但回复原文未包含更新块' : result?.outcome === 'empty' ? '更新规则已激活；模型报告本轮无变化' : result?.outcome === 'invalid' ? '更新规则已激活；返回块无效或已过期，请查看详细提示' : '已检查本轮统一更新块；具体变更请查看联动更新页面');
        } catch (error) { say('本轮统一更新未接收：' + error.message); }
    }
    const handlers = {
        GENERATION_AFTER_COMMANDS: start, WORLDINFO_ENTRIES_LOADED: loaded, WORLD_INFO_ACTIVATED: activated,
        MESSAGE_RECEIVED: received, GENERATION_ENDED: ended,
        GENERATION_STOPPED: () => cancel('生成已停止，未接收本轮统一更新'),
        CHAT_CHANGED: () => cancel(independent(getContext()) ? '聊天已切换，等待当前聊天的 Amin 更新协议' : '聊天已切换，等待当前聊天的统一条目'),
    };
    if (source?.on) for (const [key, handler] of Object.entries(handlers)) if (events[key]) {
        const guarded = (...args) => {
            try { return Promise.resolve(handler(...args)).catch(error => cancel('联动宿主适配已停止：' + error.message)); }
            catch (error) { cancel('联动宿主适配已停止：' + error.message); }
        };
        source.on(events[key], guarded); subscriptions.push([events[key], guarded]);
    }
    return {
        status: () => ({ supported: hostReady(getContext()), message, active: !!run, captured: !!run?.captured }),
        reset: () => cancel(),
        destroy() {
            disposed = true; cancel();
            for (const [event, handler] of subscriptions) {
                if (source.removeListener) source.removeListener(event, handler); else source.off?.(event, handler);
            }
        },
    };
}
