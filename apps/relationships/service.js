import { chatRevision } from '../shared/chat-revision.js';
import { uuid } from '../../uuid.js';
import { KEY as CHARACTERS_KEY, readCharacters } from '../characters/model.js';
import { createOperationService, subscribeStateChanges, chatIdentity } from '../shared/operations.js';
import { getAI } from '../../ai/service.js';
import { managesModule } from '../linkage/policy.js';
import { KEY, readStore, readRelationships, resolveRelationships, visibleEvents, transition, appendSnapshot, currentPrompt, evaluateThresholds, validateEvidence, sourceReferences } from './model.js';
import { validateEndpoints, applyRelationshipChange, UPDATE_SPEC } from './updates.js';
import { canonicalAction } from '../linkage/contract.js';
import { promptInjectors } from '../linkage/injectors.js';
import { draftRelationships } from './draft.js';

export const PROMPT_KEY = 'amin-os-person-relationships';
const copy = value => structuredClone(value);
export function createRelationshipsService(getContext = () => globalThis.SillyTavern?.getContext?.(), { createId = uuid, now = () => new Date().toISOString(), poll = false, ai = getAI } = {}) {
    const operation = createOperationService(getContext), listeners = new Set(), removers = [];
    let pending = null, disposed = false, last = null, hostMessage = '', draftController = null;
    const notify = () => { for (const callback of [...listeners]) { try { callback(); } catch { /* A view cannot break a committed change. */ } } };
    let injector = null;
    const clearPrompt = () => injector.clear();
    function ensureOpen() { if (disposed) throw Error('人物关系服务已关闭。'); }
    const capture = () => { ensureOpen(); return operation.capture([[KEY], [CHARACTERS_KEY]]); };
    const check = token => { ensureOpen(); return operation.check(token); };
    function stage(op, data, token = capture()) {
        const ctx = check(token), before = readRelationships(ctx);
        if (draftController) throw Error('正在分析关系，请等待或取消建议生成。');
        const relationshipId = op === 'save' ? data?.relationship?.id ?? createId() : undefined;
        const eventId = createId(), at = now();
        const previousEvidence = before.relationships.find(value => value.id === (relationshipId ?? data?.id))?.evidence;
        const sources = ['save', 'delete'].includes(op) ? sourceReferences(ctx.chat, data?.sources ?? []) : [];
        const evidence = ['save', 'delete'].includes(op) && (data?.reason || sources.length || previousEvidence || data?.relationship?.evidence)
            ? validateEvidence({ origin: 'manual', reason: data?.reason || '手动确认人物关系', sources }) : undefined;
        const payload = copy(data);
        if (op === 'save' && evidence) payload.relationship = { ...payload.relationship, evidence };
        let state = transition(before, op, payload, { relationshipId });
        let relationship;
        if (op === 'save') {
            relationship = state.relationships.find(value => value.id === relationshipId);
            validateEndpoints(ctx, before, relationship);
            state = evaluateThresholds(before, state, { operationId: eventId, at });
        }
        const names = new Map(readCharacters(ctx).characters.map(character => [character.id, character.name]));
        const named = id => names.get(id) ?? `未解析人物（${id}）`;
        const label = op === 'save' ? before.relationships.some(value => value.id === relationshipId) ? '修改人物关系' : '新建人物关系'
            : op === 'delete' ? '删除人物关系' : op === 'save-rule' ? '保存关系阈值规则' : op === 'delete-rule' ? '删除关系阈值规则' : op === 'acknowledge-alert' ? '标记阈值提醒已读' : '设置人物关系读取';
        const removed = op === 'delete' ? before.relationships.find(value => value.id === data.id) : null;
        const described = relationship ?? removed;
        const alerts = (state.thresholdAlerts ?? []).filter(alert => !(before.thresholdAlerts ?? []).some(previous => previous.id === alert.id));
        let summary = described ? `${named(described.fromId)} → ${named(described.toId)} · ${described.type}${described.label ? ` · ${described.label}` : ''}${Object.hasOwn(described, 'strength') ? ` · 强度 ${described.strength}` : ''}${evidence ? `\n依据：${evidence.reason}` : ''}`
            : op === 'settings' ? state.settings.includeInContext ? '普通正文生成时读取当前分支中人物引用完整的已确认关系。' : '关闭人物关系的正文读取。'
                : op === 'save-rule' ? `${data.rule.operator === 'gte' ? '强度达到或超过' : '强度降到或低于'} ${data.rule.value}：${data.rule.message}。仅在之后跨越阈值时提醒，不生成剧情事件。`
                    : op === 'delete-rule' ? '移除该阈值规则，保留已经触发的提醒记录。' : '保留提醒记录，将其标记为已读。';
        if (alerts.length) summary += '\n阈值提醒（不是剧情事件）：' + alerts.map(alert => alert.message).join('；');
        const eventOp = ['save-rule', 'delete-rule'].includes(op) ? 'rules' : op === 'acknowledge-alert' ? 'alerts' : op;
        const value = appendSnapshot(readStore(ctx), ctx.chat, state, { id: eventId, at, op: eventOp, evidence });
        operation.stage({ label, patches: [{ path: [KEY], value }], summary }, token);
        pending = { op, ...(relationship ? { relationship } : {}), ...(removed ? { id: removed.id } : {}), ...(op === 'settings' ? { includeInContext: state.settings.includeInContext } : {}) };
        hostMessage = ''; notify(); return preview();
    }
    function stageSuggestions(changes, token = capture(), sources) {
        const ctx = check(token);
        if (!Array.isArray(changes) || !changes.length || changes.length > 30) throw Error('请选择 1 至 30 条关系变更建议。');
        if (new Set(changes.map(change => change?.target)).size !== changes.length) throw Error('同一关系出现多份建议，请只保留最终变更。');
        const shadow = { ...ctx, chatMetadata: copy(ctx.chatMetadata) }, summaries = [];
        for (const change of changes) {
            if (!['save-relationship', 'delete-relationship'].includes(canonicalAction(UPDATE_SPEC, change?.action))) throw Error('关系 AI 建议只能更新关系，不可改写规则。');
            const result = applyRelationshipChange(shadow, copy(change), { operationId: createId(), now: now(), origin: 'ai', allowedSources: sources });
            shadow.chatMetadata[KEY] = result.patches[0].value; summaries.push(result.summary);
        }
        operation.stage({ label: `剧情关系建议 · ${changes.length} 项`, patches: [{ path: [KEY], value: shadow.chatMetadata[KEY] }], summary: summaries }, token);
        pending = { op: 'ai', changes: copy(changes) }; hostMessage = ''; notify(); return preview();
    }
    async function suggestUpdates({ start, end, instruction = '', signal } = {}) {
        ensureOpen();
        if (draftController || operation.busy() || operation.dirty() || operation.preview()) throw Error('请先处理待确认操作、重试保存或取消正在进行的分析。');
        const token = capture(), ctx = check(token), controller = new AbortController();
        const cancel = () => controller.abort(signal?.reason ?? Error('已取消关系建议。'));
        if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
        draftController = controller; hostMessage = '正在根据所选剧情分析关系变更…'; notify();
        try {
            const result = await draftRelationships({ ai: typeof ai === 'function' ? ai() : ai, ctx, start, end, instruction, signal: controller.signal, check: () => check(token) });
            if (controller.signal.aborted) throw controller.signal.reason ?? Error('已取消关系建议。');
            check(token);
            if (result.changes.length) return stageSuggestions(result.changes, token, result.sources);
            hostMessage = '模型未提出有充分依据的关系变更。'; return null;
        } catch (error) { hostMessage = error.message; throw error; }
        finally { signal?.removeEventListener('abort', cancel); if (draftController === controller) draftController = null; notify(); }
    }
    function preview() {
        const value = operation.preview();
        if (!value) return null;
        return { operationId: value.operationId, label: value.label, summary: value.summary, ...copy(pending ?? {}) };
    }
    function scope() {
        const ctx = getContext();
        return { metadata: ctx?.chatMetadata, identity: chatIdentity(ctx), path: chatRevision(ctx?.chat),
            basis: JSON.stringify([ctx?.chatMetadata?.[KEY], ctx?.chatMetadata?.[CHARACTERS_KEY], managesModule(ctx, 'relationships')]) };
    }
    function sync() {
        if (disposed) return;
        let next;
        try { next = scope(); } catch (error) { hostMessage = error.message; clearPrompt(); notify(); return; }
        const changed = !last || next.metadata !== last.metadata || next.identity !== last.identity || next.path !== last.path || next.basis !== last.basis;
        if (!changed) return;
        draftController?.abort(Error('聊天、人物或关系资料已变化，当前关系建议已取消。'));
        last = next; clearPrompt(); pending = null;
        if (operation.preview()) operation.discard();
        notify();
    }
    async function confirm() { ensureOpen(); const result = await operation.confirm(); pending = null; sync(); return result; }
    async function retrySave() { ensureOpen(); const result = await operation.retrySave(); sync(); return result; }
    const enabled = (type = 'normal', options = {}, dryRun = false) => !(disposed || dryRun || options?.signal?.aborted || !['normal', 'regenerate', 'swipe', 'continue'].includes(type));
    function build(type = 'normal') {
        let prompt = null;
        try {
            if (operation.busy()) throw Error('当前聊天正在保存，本轮未附加人物关系。');
            const ctx = getContext();
            if (!ctx?.chatMetadata || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null) return null;
            if (managesModule(ctx, 'relationships')) { hostMessage = '人物关系由统一联动条目管理。'; return null; }
            let chat = ctx.chat ?? [];
            if (['regenerate', 'swipe'].includes(type) && chat.length && !chat.at(-1).is_user) chat = chat.slice(0, -1);
            prompt = currentPrompt({ ...ctx, chat });
            hostMessage = prompt ? `已附加 ${prompt.length} 字符已确认人物关系。` : '当前分支未开启人物关系读取，或暂无人物引用完整的关系。';
        } catch (error) { prompt = null; hostMessage = error.message; }
        notify();
        return prompt;
    }
    removers.push(operation.subscribe(() => { hostMessage = ''; notify(); }));
    removers.push(subscribeStateChanges(detail => { if (detail.paths.some(path => path[0] === KEY || path[0] === CHARACTERS_KEY || path[0] === 'amin_os_linkage_v1')) sync(); }));
    const initial = getContext(), source = initial?.eventSource, types = initial?.eventTypes ?? initial?.event_types ?? {};
    injector = promptInjectors(getContext).register(PROMPT_KEY, { build, enabled, onError: error => { hostMessage = error.message; notify(); } });
    const supported = injector.supported;
    const clearAndSync = () => { clearPrompt(); sync(); };
    const handlers = Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'GENERATION_ENDED', 'GENERATION_STOPPED'].map(name => [name, clearAndSync]));
    // With host prompt support the shared injector clears on chat switches.
    if (supported) handlers.CHAT_CHANGED = () => sync();
    for (const [name, callback] of Object.entries(handlers)) if (source?.on && types[name]) {
        source.on(types[name], callback); removers.push(() => source.removeListener ? source.removeListener(types[name], callback) : source.off?.(types[name], callback));
    }
    const timer = poll ? setInterval(sync, 800) : null;
    sync();
    return { context: getContext, capture, check, stage, preview, confirm, retrySave, sync, supported, suggestUpdates, stageSuggestions,
        read: () => readRelationships(getContext()), characters: () => readCharacters(getContext()).characters, resolved: () => resolveRelationships(getContext()), history: () => visibleEvents(getContext()),
        saveRelationship: (relationship, token) => stage('save', { relationship }, token), deleteRelationship: (id, token) => stage('delete', { id }, token),
        saveThresholdRule: (rule, token) => stage('save-rule', { rule: { ...rule, id: rule.id ?? createId() } }, token),
        cancelSuggestions() { draftController?.abort(Error('已取消关系建议。')); },
        generating: () => !!draftController,
        managed: () => managesModule(getContext(), 'relationships'),
        discard() { pending = null; hostMessage = ''; operation.discard(); },
        status: () => hostMessage || operation.status(), busy: () => !!draftController || operation.busy(), dirty: () => operation.dirty(),
        subscribe(callback) { ensureOpen(); listeners.add(callback); return () => listeners.delete(callback); },
        dispose() { if (disposed) return; disposed = true; draftController?.abort(Error('人物关系窗口已关闭。')); pending = null; injector.dispose(); clearInterval(timer); for (const remove of removers) remove(); operation.dispose(); listeners.clear(); },
    };
}
let shared;
export function getSharedRelationshipsService(getContext) { return shared ??= createRelationshipsService(getContext, { poll: true }); }
