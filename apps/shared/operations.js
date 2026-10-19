import { saveChatMetadata } from './chat-save.js';
import { uuid } from '../../uuid.js';
import { assertChatReady } from './chat-lifecycle.js';
import { chatRevisions, pathBelongs as revisionPathBelongs } from './message-revision.js';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const blocked = new Set(['__proto__', 'prototype', 'constructor']);
const tokens = new WeakMap(), coordinators = new WeakMap(), stateListeners = new Set();
const clone = value => structuredClone(value);

// Each write is restricted to a module's data or one explicitly owned variable root.
// In particular, callers cannot replace variables wholesale or touch credentials.
export const PATCH_ROOTS = Object.freeze([
    'amin_os_characters_v1', 'amin_os_inventory_v1', 'amin_os_relationships_v1',
    'amin_os_saves_v1', 'amin_os_scene_v1', 'amin_os_effects_v1', 'amin_os_dice_v1',
    'amin_os_journal_v1', 'amin_os_information_v1', 'amin_os_information_library_v1', 'dynamicMapV1',
    'world_status_hud_history_v1', 'amin_os_organizations_history_v1', 'dynamicMapPositionHistoryV1',
    'amin_os_linkage_v1', 'amin_os_state2_v1', 'amin_os_state2_backup_v1', 'amin_os_state_v1', 'amin_os_imported_skills_v1', 'amin_os_legacy_source_v1',
]);
const roots = new Set(PATCH_ROOTS), variableRoots = new Set(['状态栏', '势力资料', 'AminOS人物', 'AminOS背包', 'AminOS关系', 'AminOS场景', 'AminOS剧情', 'AminOS效果', 'AminOS地图', 'AminOS信息', 'AminOS骰子']);

let patchExpansion = null, patchDependencies = null, patchPreparation = null, preparing = false;
/** Register the native variable transaction bridge; only the app initializer installs it. */
export function registerOperationPatchExpansion(expand, dependencies = null, prepare = null) {
    if (typeof expand !== 'function') throw TypeError('Patch expansion must be a function');
    patchExpansion = expand; patchDependencies = dependencies; patchPreparation = prepare;
    return () => { if (patchExpansion === expand) { patchExpansion = null; patchDependencies = null; patchPreparation = null; } };
}

export class OperationError extends Error {
    constructor(code, message, details = {}) {
        super(message); this.name = 'OperationError'; this.code = code;
        Object.assign(this, details);
    }
}
const fail = (code, message, details) => { throw new OperationError(code, message, details); };

function safePath(path) {
    if (!Array.isArray(path) || !path.length || path.length > 16 || path.some(key => typeof key !== 'string' || !key || key.length > 128 || blocked.has(key))) {
        fail('INVALID_PATH', '操作路径无效，或包含受保护的字段名。');
    }
    return [...path];
}
function writablePath(path, organizationRemoval = false) {
    safePath(path);
    const organizationField = path[0] === 'amin_os_organizations_v1' && (path.length === 1 && organizationRemoval || path.length >= 2 && ['locks', 'assessment', 'backups'].includes(path[1]));
    const stateCheckpoint = path.length === 3 && path[0] === 'extensions' && path[1] === 'LittleWhiteBox' && ['stateCkptV2','stateLogV2'].includes(path[2]);
    const diceRule = path.length === 2 && path[0] === 'LWB_RULES_V2' && (path[1] === 'AminOS骰子' || path[1].startsWith('AminOS骰子.'));
    if (!(roots.has(path[0]) || organizationField || stateCheckpoint || diceRule || (path[0] === 'variables' && path.length >= 2 && variableRoots.has(path[1])))) {
        fail('FORBIDDEN_PATH', '此操作无权修改该聊天资料路径。');
    }
}
function safeJSON(value, depth = 0, stack = new Set()) {
    if (depth > 64) fail('INVALID_VALUE', '资料嵌套过深。');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || stack.has(value)) fail('INVALID_VALUE', '操作资料必须是有效的 JSON 数据。');
    stack.add(value);
    if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) fail('INVALID_VALUE', '数组不能含空位或额外字段。');
        for (let index = 0; index < value.length; index++) {
            if (!own(value, index)) fail('INVALID_VALUE', '数组不能含空位。');
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !('value' in descriptor)) fail('INVALID_VALUE', '操作资料不能包含访问器。');
            safeJSON(descriptor.value, depth + 1, stack);
        }
    } else {
        if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) fail('INVALID_VALUE', '操作资料不能包含 Symbol 字段。');
        for (const key of Object.keys(value)) {
            if (blocked.has(key)) fail('INVALID_VALUE', '操作资料包含受保护的字段名。');
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor)) fail('INVALID_VALUE', '操作资料不能包含访问器。');
            safeJSON(descriptor.value, depth + 1, stack);
        }
    }
    stack.delete(value);
}
function readPath(metadata, path) {
    let current = metadata;
    for (const key of path) {
        if (!plain(current)) fail('INVALID_PARENT', '操作路径的上级资料不是对象，请先检查原始资料。');
        if (!own(current, key)) return { exists: false };
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor)) fail('INVALID_PARENT', '操作路径不能包含访问器。');
        current = descriptor.value;
    }
    safeJSON(current);
    return { exists: true, value: current };
}
function basis(metadata, path) {
    let current = metadata;
    for (const key of path) {
        // A captured child may disappear when an intentional parent replacement
        // commits. Represent that state rather than throwing after the mutation.
        if (!plain(current)) { safeJSON(current); return JSON.stringify(['blocked', current]); }
        if (!own(current, key)) return '[false]';
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor)) fail('INVALID_PARENT', '操作路径不能包含访问器。');
        current = descriptor.value;
    }
    safeJSON(current); return JSON.stringify([true, current]);
}
function pathKey(path) { return JSON.stringify(path); }
function distinctPaths(paths) {
    if (!Array.isArray(paths) || paths.length > 512) fail('INVALID_PATH', '资料路径列表无效或过长。');
    const seen = new Set();
    return paths.map(safePath).filter(path => { const key = pathKey(path); if (seen.has(key)) return false; seen.add(key); return true; });
}

export function chatIdentity(ctx) {
    return JSON.stringify([ctx?.groupId != null ? ['group', ctx.groupId] : ['character', ctx?.characters?.[ctx?.characterId]?.avatar ?? ctx?.characterId ?? null], ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null]);
}
export function chatPath(chat = []) {
    if (!Array.isArray(chat)) fail('INVALID_CHAT', '当前聊天记录格式无效。');
    return chatRevisions(chat);
}
export function pathBelongs(anchor, path) {
    return revisionPathBelongs(anchor, path);
}
function currentContext(getContext) {
    if (typeof getContext !== 'function') fail('INVALID_CONTEXT', '缺少聊天上下文接口。');
    assertChatReady(getContext());
    if (patchPreparation && !preparing) {
        preparing = true;
        try { patchPreparation(getContext()); } finally { preparing = false; }
    }
    const ctx = getContext(), id = ctx?.getCurrentChatId?.() ?? ctx?.chatId;
    if (!plain(ctx?.chatMetadata) || id == null || id === '') fail('NO_CHAT', '请先打开一个聊天。');
    return ctx;
}
function makeToken(ctx, paths) {
    if (patchDependencies) paths = distinctPaths([...paths, ...patchDependencies(ctx, paths)]);
    const data = { metadata: ctx.chatMetadata, identity: chatIdentity(ctx), path: JSON.stringify(chatPath(ctx.chat)), paths, bases: paths.map(path => basis(ctx.chatMetadata, path)) };
    const token = Object.freeze({ metadata: data.metadata, identity: data.identity, path: data.path, paths: Object.freeze(paths.map(path => Object.freeze([...path]))), bases: Object.freeze([...data.bases]) });
    tokens.set(token, data); return token;
}
export function captureContext(getContext, paths = []) {
    return makeToken(currentContext(getContext), distinctPaths(paths));
}
export function assertContext(getContext, token) {
    const data = token && tokens.get(token);
    if (!data) fail('INVALID_TOKEN', '预览凭据无效，请重新打开当前操作。');
    const ctx = currentContext(getContext);
    if (ctx.chatMetadata !== data.metadata || chatIdentity(ctx) !== data.identity || JSON.stringify(chatPath(ctx.chat)) !== data.path) {
        fail('STALE_CONTEXT', '聊天或消息候选已变化，请在当前剧情重新预览。');
    }
    if (data.paths.some((path, index) => basis(ctx.chatMetadata, path) !== data.bases[index])) fail('STALE_BASIS', '相关资料已变化，请重新预览。');
    return ctx;
}
function coordinator(metadata) {
    let value = coordinators.get(metadata);
    if (!value) { value = { active: null, dirty: null, listeners: new Set() }; coordinators.set(metadata, value); }
    return value;
}
const callSafely = (callback, ...args) => {
    try {
        const returned = callback(...args);
        if (returned && typeof returned.then === 'function') Promise.resolve(returned).catch(() => {});
    } catch { /* One app must not interrupt another app's committed operation. */ }
};
function notifyCoordinator(value) { for (const listener of [...value.listeners]) callSafely(listener); }
export function subscribeStateChanges(callback) {
    if (typeof callback !== 'function') throw TypeError('State listener must be a function.');
    stateListeners.add(callback); return () => stateListeners.delete(callback);
}
/** Reserve the same save lock for a legacy writer before it changes metadata.
 * A lease does not apply data, emit state changes, or alter the writer's own
 * failure/retry policy. Call its idempotent release function in finally.
 */
export function acquireMetadataWrite(getContext, token = captureContext(getContext)) {
    const ctx = assertContext(getContext, token), state = coordinator(ctx.chatMetadata);
    if (state.active) fail('BUSY', '当前聊天正在保存，请稍候。');
    if (state.dirty) fail('DIRTY', '当前聊天有已确认但尚未保存的操作，请先重试保存。');
    const leaseId = uuid();
    state.active = leaseId; notifyCoordinator(state);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (state.active === leaseId) { state.active = null; notifyCoordinator(state); }
    };
}
export function metadataWriteStatus(getContext) {
    const metadata = getContext?.()?.chatMetadata, state = metadata && coordinators.get(metadata);
    return { busy: !!state?.active, dirty: !!state?.dirty };
}
/** Refresh derived views after a legacy writer changes owned metadata under its
 * existing lease. This announces a change; it does not mutate or save data.
 */
export function publishExternalMetadataChange(getContext, paths, { phase = 'applied', operationId } = {}) {
    const ctx = currentContext(getContext), checkedPaths = distinctPaths(paths);
    if (!checkedPaths.length) fail('INVALID_PATH', '状态通知需要至少一个资料路径。');
    for (const path of checkedPaths) writablePath(path);
    if (!['applied', 'saved', 'stale'].includes(phase)) fail('INVALID_PHASE', '状态通知阶段无效。');
    const id = operationId ?? uuid();
    if (typeof id !== 'string' || !id.trim() || id.length > 200) fail('INVALID_OPERATION', '状态通知标识无效。');
    emitStateChange({ operationId: id, patches: checkedPaths.map(path => ({ path })), token: { identity: chatIdentity(ctx) } }, phase, ctx.chatMetadata);
    return { operationId: id, phase, paths: checkedPaths };
}
function emitStateChange(operation, phase, metadata) {
    const detail = { paths: operation.patches.map(patch => [...patch.path]), operationId: operation.operationId, phase, identity: operation.token.identity };
    // The local-only second argument identifies an exact loaded metadata object;
    // it is deliberately excluded from the public DOM event payload.
    for (const listener of [...stateListeners]) callSafely(listener, clone(detail), metadata);
    try {
        if (typeof globalThis.document?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') globalThis.document.dispatchEvent(new CustomEvent('amin:state-changed', { detail: clone(detail) }));
    } catch { /* Headless environments and host listeners cannot break a commit. */ }
    notifyCoordinator(coordinator(metadata));
}
function validatePatches(patches) {
    if (!Array.isArray(patches) || !patches.length || patches.length > 256) fail('INVALID_PATCH', '操作必须包含 1 至 256 项资料变更。');
    const output = patches.map(patch => {
        if (!plain(patch) || Object.keys(patch).some(key => !['path', 'value', 'remove'].includes(key))) fail('INVALID_PATCH', '操作变更格式无效。');
        writablePath(patch.path, patch.remove === true);
        if (own(patch, 'remove')) {
            if (patch.remove !== true || own(patch, 'value')) fail('INVALID_PATCH', '删除操作不能同时指定新值。');
            return { path: [...patch.path], remove: true };
        }
        if (!own(patch, 'value')) fail('INVALID_PATCH', '资料变更缺少新值。');
        safeJSON(patch.value);
        return { path: [...patch.path], value: clone(patch.value) };
    });
    for (let i = 0; i < output.length; i++) for (let j = i + 1; j < output.length; j++) {
        const a = output[i].path, b = output[j].path;
        if (a.slice(0, Math.min(a.length, b.length)).every((key, index) => key === b[index])) fail('OVERLAPPING_PATHS', '同一次操作不能包含重复或互相覆盖的资料路径。');
    }
    if (JSON.stringify(output).length > 32 * 1024 * 1024) fail('INVALID_PATCH', '一次操作资料超过 32 MiB，请减少保存范围。');
    return output;
}
function prepareRoots(metadata, patches) {
    const result = new Map();
    for (const patch of patches) {
        const [root, ...rest] = patch.path;
        if (!rest.length) { result.set(root, patch.remove ? { remove: true } : { value: clone(patch.value) }); continue; }
        if (!result.has(root)) {
            const original = readPath(metadata, [root]);
            if (!original.exists && patch.remove) continue;
            if (original.exists && !plain(original.value)) fail('INVALID_PARENT', '操作路径的上级资料不是对象，请先检查原始资料。');
            result.set(root, { value: original.exists ? clone(original.value) : {} });
        }
        let parent = result.get(root).value;
        let missing = false;
        for (const key of rest.slice(0, -1)) {
            if (!own(parent, key)) { if (patch.remove) { missing = true; break; } parent[key] = {}; }
            if (!plain(parent[key])) fail('INVALID_PARENT', '操作路径的上级资料不是对象，请先检查原始资料。');
            parent = parent[key];
        }
        if (missing) continue;
        const key = rest.at(-1);
        if (patch.remove) delete parent[key]; else parent[key] = clone(patch.value);
    }
    // Check every root before the first mutation so frozen host objects fail atomically.
    for (const [key, change] of result) {
        const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
        if (descriptor && (!('value' in descriptor) || (change.remove ? !descriptor.configurable : !descriptor.writable))) fail('READ_ONLY', '当前聊天资料不可写。');
        if (!descriptor && !change.remove && !Object.isExtensible(metadata)) fail('READ_ONLY', '当前聊天资料不可扩展。');
    }
    return result;
}

/** Preview and commit related metadata changes once. Persistence retries never apply patches again. */
export function createOperationService(getContext = () => globalThis.SillyTavern?.getContext?.()) {
    const listeners = new Set(), observed = new Set();
    let pending = null, active = false, disposed = false, message = '';
    const notify = () => { for (const callback of [...listeners]) callSafely(callback); };
    function ensureOpen() { if (disposed) fail('DISPOSED', '操作服务已关闭。'); }
    function observe(metadata) { const state = coordinator(metadata); if (!observed.has(state)) { observed.add(state); state.listeners.add(notify); } return state; }
    function capture(paths = []) { ensureOpen(); const token = captureContext(getContext, paths); observe(token.metadata); return token; }
    function check(token) { ensureOpen(); return assertContext(getContext, token); }
    function available(state) {
        if (active || state.active) fail('BUSY', '当前聊天正在保存，请稍候。');
        if (state.dirty) fail('DIRTY', '当前聊天有已确认但尚未保存的操作，请先重试保存。');
    }
    function stage(input, token) {
        ensureOpen();
        if (!plain(input) || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200) fail('INVALID_OPERATION', '操作需要有效的名称。');
        let patches = validatePatches(input.patches);
        if (input.summary !== undefined) safeJSON(input.summary);
        const ctx = token ? check(token) : currentContext(getContext), state = observe(ctx.chatMetadata);
        available(state);
        if (patchExpansion) patches = validatePatches(patchExpansion(ctx, patches));
        // An editor may capture extra read dependencies. Preserve them when adding write bases.
        const paths = distinctPaths([...(token ? tokens.get(token).paths : []), ...patches.map(patch => patch.path)]);
        const checkedToken = makeToken(ctx, paths);
        prepareRoots(ctx.chatMetadata, patches);
        pending = { operationId: uuid(), label: input.label.trim(), patches, summary: clone(input.summary ?? null), token: checkedToken };
        message = '请核对预览，确认后更新当前聊天。'; notify(); return preview();
    }
    function preview() {
        if (!pending) return null;
        const { token, ...value } = pending; return clone(value);
    }
    async function persist(ctx, operation, token, retry, disposable = false) {
        const state = observe(ctx.chatMetadata);
        state.active = operation.operationId; active = true; message = retry ? '正在重试保存已确认的操作。' : '正在保存已确认的操作。'; notifyCoordinator(state);
        try {
            await saveChatMetadata(ctx);
            try { assertContext(getContext, token); }
            catch (error) {
                emitStateChange(operation, 'stale', ctx.chatMetadata);
                fail('STALE_COMPLETION', '操作已更新原聊天，但保存期间聊天、消息候选或相关资料发生变化。请回到该聊天重试保存；不会重复操作。', { committed: true, uncertain: true, cause: error });
            }
            state.dirty = null;
            message = retry ? '已重新保存，没有重复执行操作。' : '已保存。';
            emitStateChange(operation, 'saved', ctx.chatMetadata);
            return { operationId: operation.operationId, label: operation.label, summary: clone(operation.summary), saved: true, retried: retry };
        } catch (error) {
            // A disposable background write (an automatic checkpoint) stays in
            // memory and is persisted by the next save; it must not lock the chat.
            if (disposable && state.dirty === operation) state.dirty = null;
            if (error instanceof OperationError && error.code === 'STALE_COMPLETION') { message = disposable ? '后台记录保存期间聊天已变化；未锁定聊天，将随下次保存写入。' : error.message; throw error; }
            message = `操作已更新当前聊天，但保存失败：${error?.message ?? '未知错误'}。请重试保存，不会重复执行操作。`;
            throw new OperationError('SAVE_FAILED', message, { committed: true, cause: error });
        } finally { state.active = null; active = false; notifyCoordinator(state); }
    }
    async function confirm({ disposable = false } = {}) {
        ensureOpen();
        if (!pending) fail('NO_PENDING', '没有待确认的操作。');
        const operation = pending, ctx = check(operation.token), state = observe(ctx.chatMetadata);
        available(state);
        if (typeof ctx.saveMetadata !== 'function') fail('NO_SAVE', '当前酒馆缺少聊天保存接口。');
        const changes = prepareRoots(ctx.chatMetadata, operation.patches);
        pending = null;
        for (const [key, change] of changes) { if (change.remove) delete ctx.chatMetadata[key]; else ctx.chatMetadata[key] = change.value; }
        state.dirty = operation;
        const after = makeToken(ctx, tokens.get(operation.token).paths);
        // Lock before notifying any subscribers: a synchronous listener cannot start a second commit.
        state.active = operation.operationId; active = true;
        emitStateChange(operation, 'applied', ctx.chatMetadata);
        return persist(ctx, operation, after, false, disposable === true);
    }
    async function retrySave() {
        ensureOpen();
        const ctx = currentContext(getContext), state = observe(ctx.chatMetadata);
        if (active || state.active) fail('BUSY', '当前聊天正在保存，请稍候。');
        const operation = state.dirty;
        if (!operation) return null;
        if (operation.token.identity !== chatIdentity(ctx)) fail('STALE_CONTEXT', '未保存操作属于另一个聊天，请返回原聊天后重试。');
        if (typeof ctx.saveMetadata !== 'function') fail('NO_SAVE', '当前酒馆缺少聊天保存接口。');
        const token = makeToken(ctx, tokens.get(operation.token).paths);
        return persist(ctx, operation, token, true);
    }
    return {
        capture, check, stage, preview, confirm, retrySave,
        discard() { ensureOpen(); pending = null; message = '已取消预览。'; notify(); },
        status: () => message,
        busy() { const metadata = getContext()?.chatMetadata; return active || (!!metadata && !!coordinators.get(metadata)?.active); },
        dirty() { const metadata = getContext()?.chatMetadata; return !!metadata && !!coordinators.get(metadata)?.dirty; },
        subscribe(callback) { ensureOpen(); if (typeof callback !== 'function') throw TypeError('Listener must be a function.'); listeners.add(callback); return () => listeners.delete(callback); },
        dispose() { disposed = true; pending = null; listeners.clear(); for (const state of observed) state.listeners.delete(notify); observed.clear(); },
    };
}
