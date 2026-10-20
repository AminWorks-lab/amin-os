import { KEY, FORMAT, LIMITS, readStore, validateStore, validateSnapshot, parseImport, validateCheckpointSettings, candidateBinding } from './model.js';
import { MODULE_LABELS, RESTORE_DEPENDENCIES, materialize, restorePatches, moduleChanges } from './adapters.js';
import { createOperationService, chatIdentity, chatPath, subscribeStateChanges, acquireMetadataWrite } from '../shared/operations.js';
import { branchAvailability, assertOpenedBranch, loadBranchHost as defaultLoadBranchHost } from './branch.js';
import { uuid } from '../../uuid.js';
import { assertMapReady } from '../map/src/integrations/runtime.js';
import { isIndependent, readModule } from '../story-state/access.js';

const clone = value => structuredClone(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const names = saved => Object.keys(MODULE_LABELS).filter(key => saved.modules[key] != null).map(key => MODULE_LABELS[key]);

export function createSavesService(getContext = () => globalThis.SillyTavern?.getContext?.(), {
    createId = uuid, now = () => new Date().toISOString(), loadBranchHost = defaultLoadBranchHost, autoCheckpoints = true,
} = {}) {
    const operations = createOperationService(getContext), listeners = new Set(), hostListeners = [];
    let branchPending = null, branching = false, branchMessage = '', checkpointMessage = '', timer = null, disposed = false, generating = false;
    const generationActive = () => { const stream = getContext()?.streamingProcessor; return generating || (!!stream && stream.isFinished === false); };
    const notify = () => { for (const fn of listeners) { try { fn(); } catch {} } };
    const capture = () => operations.capture([[KEY], ...RESTORE_DEPENDENCIES]);
    const off = operations.subscribe(notify);
    const offState = subscribeStateChanges((detail, metadata) => {
        notify();
        if (detail.phase === 'saved' && metadata === getContext()?.chatMetadata && detail.paths.some(path => path[0] !== KEY)) scheduleCheckpoint();
    });

    function snapshot(ctx, { name, note = '' }) {
        const path = chatPath(ctx.chat), candidate = ctx.chat?.at(-1)?.swipe_id ?? 0;
        return validateSnapshot({ format: FORMAT, version: 1, id: createId(), name: String(name ?? '').trim(), note, createdAt: now(),
            source: { identity: chatIdentity(ctx), floor: path.length, candidate, path, candidateBinding: candidateBinding(path,candidate) }, modules: materialize(ctx) });
    }
    function find(id) {
        const store = readStore(getContext()), value = [...store.saves, ...store.backups, ...store.checkpoints].find(item => item.id === id);
        if (!value) throw Error('存档已不存在。'); return value;
    }
    function ensureIdle() {
        if (branching) throw Error('正在创建并恢复分支，请稍候。');
        if (branchPending) throw Error('请先确认或取消创建分支预览。');
    }
    function stageStore(label, store, summary, token) {
        ensureIdle(); validateStore(store); return operations.stage({ label, patches: [{ path: [KEY], value: store }], summary }, token);
    }
    function stageSave(input, token = capture()) {
        const ctx = operations.check(token), store = readStore(ctx), saved = snapshot(ctx, input);
        if (store.saves.length >= LIMITS.saves) throw Error('最多保留 ' + LIMITS.saves + ' 个命名存档，请先导出或删除旧存档。');
        store.saves.push(saved);
        return stageStore('建立当前剧情存档', store, { kind: 'save', name: saved.name, snapshot: { id: saved.id, name: saved.name, createdAt: saved.createdAt, source: saved.source }, moduleNames: names(saved), changes: [], warnings: [] }, token);
    }
    function prepareRestore(ctx, saved) {
        if (saved.modules.map !== null || (isIndependent(ctx) ? readModule(ctx,'map') !== null : ctx.chatMetadata.dynamicMapV1 !== undefined)) assertMapReady(ctx, { allowEmpty: true });
        const before = materialize(ctx), result = restorePatches(ctx, saved.modules, { at: now(), makeId: createId });
        const projected = { ...ctx, chatMetadata: clone(ctx.chatMetadata) };
        for (const patch of result.patches) {
            let parent = projected.chatMetadata;
            for (const key of patch.path.slice(0, -1)) { parent[key] ??= {}; parent = parent[key]; }
            if (patch.remove) delete parent[patch.path.at(-1)]; else parent[patch.path.at(-1)] = clone(patch.value);
        }
        return { ...result, effective: materialize(projected), before };
    }
    function stageRestore(input, token = capture()) {
        ensureIdle();
        const ctx = operations.check(token), saved = typeof input === 'string' ? find(input) : validateSnapshot(input), store = readStore(ctx);
        const backup = snapshot(ctx, { name: ('恢复前 · ' + saved.name).slice(0, 120), note: '自动备份：在当前楼层应用存档前的剧情状态。' });
        const { patches, warnings, before, effective } = prepareRestore(ctx, saved);
        store.backups.push(backup); store.backups = store.backups.slice(-LIMITS.backups); validateStore(store);
        if (saved.source.identity !== chatIdentity(ctx)) warnings.push('来源为其他聊天；只应用插件剧情状态，不导入原聊天消息。');
        return operations.stage({ label: '将存档应用到当前楼层', patches: [...patches, { path: [KEY], value: store }], summary: { kind: 'restore', name: saved.name, source: clone(saved.source), backup: { id: backup.id, name: backup.name, createdAt: backup.createdAt }, moduleNames: names(saved), changes: moduleChanges(before, effective), warnings } }, token);
    }
    function stageImport(raw, token = capture()) {
        const ctx = operations.check(token), store = readStore(ctx), saved = parseImport(raw);
        if (store.saves.length >= LIMITS.saves) throw Error('存档数量已达上限。');
        if ([...store.saves, ...store.backups, ...store.checkpoints].some(item => item.id === saved.id)) throw Error('该存档编号已存在，请使用已有存档。');
        store.saves.push(saved);
        return stageStore('导入存档到当前聊天', store, { kind: 'import', name: saved.name, snapshot: { id: saved.id, name: saved.name, createdAt: saved.createdAt, source: saved.source }, moduleNames: names(saved), changes: [], warnings: ['导入仅添加存档，恢复需要另行预览确认。'] }, token);
    }
    function stageDelete(id, token = capture()) {
        const ctx = operations.check(token), store = readStore(ctx), saved = find(id);
        for (const key of ['saves', 'backups', 'checkpoints']) store[key] = store[key].filter(item => item.id !== id);
        return stageStore('删除存档', store, { kind: 'delete', name: saved.name, changes: [], warnings: [] }, token);
    }
    function stageCheckpointSettings(input, token = capture()) {
        const ctx = operations.check(token), store = readStore(ctx), settings = validateCheckpointSettings(input);
        store.checkpointSettings = settings; store.checkpoints = store.checkpoints.slice(-settings.limit);
        return stageStore('调整楼层检查点', store, { kind: 'checkpoint-settings', name: settings.enabled ? '自动记录 · 最近 ' + settings.limit + ' 份' : '暂停自动记录', changes: [], warnings: ['减少保留数量会移除最早的自动检查点；命名存档与安全备份保留。'] }, token);
    }
    function fitCheckpoints(store) {
        store.checkpoints = store.checkpoints.slice(-store.checkpointSettings.limit);
        while (true) {
            try { validateStore(store); return; }
            catch (error) {
                if (!/超过大小上限/.test(error.message) || store.checkpoints.length <= 1) throw error;
                store.checkpoints.shift();
            }
        }
    }
    async function captureCheckpoint({ automatic = false } = {}) {
        ensureIdle();
        if (operations.preview()) throw Error('请先确认或取消当前预览，再记录检查点。');
        const token = capture(), ctx = operations.check(token);
        const store = readStore(ctx);
        if (automatic && !store.checkpointSettings.enabled) return null;
        if (!ctx.chat?.length) return null;
        assertMapReady(ctx, { allowEmpty: true });
        const saved = snapshot(ctx, { name: '第 ' + ctx.chat.length + ' 楼 · 候选 ' + ((ctx.chat.at(-1)?.swipe_id ?? 0) + 1), note: '在该消息与候选实际处于聊天末尾时记录的完整应用状态。' });
        const index = store.checkpoints.findIndex(item => item.source.identity === saved.source.identity && same(item.source.path, saved.source.path));
        if (index >= 0 && same(store.checkpoints[index].modules, saved.modules)) return clone(store.checkpoints[index]);
        if (index >= 0) { saved.id = store.checkpoints[index].id; store.checkpoints.splice(index, 1); }
        store.checkpoints.push(saved); fitCheckpoints(store);
        operations.stage({ label: '记录当前楼层检查点', patches: [{ path: [KEY], value: store }], summary: { kind: 'checkpoint', name: saved.name, moduleNames: names(saved), changes: [], warnings: [] } }, token);
        await operations.confirm({ disposable: automatic }); checkpointMessage = ''; notify(); return clone(saved);
    }
    function stageBranch(id, token = capture()) {
        ensureIdle();
        if (operations.preview()) throw Error('请先确认或取消当前预览。');
        const ctx = operations.check(token), saved = validateSnapshot(find(id)), availability = branchAvailability(ctx, saved);
        if (!availability.available) throw Error(availability.reason);
        assertMapReady(ctx, { allowEmpty: true });
        branchPending = { token, saved, operationId: createId(), label: '从检查点创建酒馆分支', summary: { kind: 'branch', name: saved.name, source: clone(saved.source), moduleNames: names(saved), changes: moduleChanges(materialize(ctx), saved.modules), warnings: ['酒馆会新建并打开独立聊天，再恢复此检查点的应用状态。原聊天仍保留。', '新分支创建与应用状态保存分两步完成；保存失败时留在新分支重试，不会重复创建分支。'] } };
        branchMessage = '请核对检查点和来源候选，确认后创建新分支。'; notify(); return preview();
    }
    async function confirmBranch() {
        if (branching) throw Error('正在创建并恢复分支，请勿重复确认。');
        const pending = branchPending;
        if (!pending) throw Error('没有待确认的分支。');
        branching = true; branchMessage = '正在检查酒馆分支接口。'; notify();
        let name, branchStarted = false, release = () => {};
        try {
            const host = await loadBranchHost();
            if (typeof host?.branchChat !== 'function') throw Error('当前酒馆未提供兼容的创建分支接口。');
            if (disposed || branchPending !== pending) throw Error('分支预览已取消或关闭。');
            const sourceCtx = operations.check(pending.token), availability = branchAvailability(sourceCtx, pending.saved);
            if (!availability.available) throw Error(availability.reason);
            assertMapReady(sourceCtx, { allowEmpty: true });
            release = acquireMetadataWrite(getContext, pending.token);
            branchPending = null; branchMessage = '正在创建酒馆分支。'; notify();
            // Omitting the newer swipeId option also supports the original host signature.
            // The current candidate and every prior message were validated above.
            branchStarted = true;
            name = await host.branchChat(pending.saved.source.floor - 1);
            const ctx = assertOpenedBranch(getContext(), pending.saved.source, name);
            if (ctx.chatMetadata === sourceCtx.chatMetadata) throw Error('新分支复用了原聊天资料对象，未恢复插件数据以免影响原聊天。');
            release();
            const token = capture(), { patches, warnings, before, effective } = prepareRestore(ctx, pending.saved), store = readStore(ctx);
            const checkpoint = validateSnapshot({ ...pending.saved, id: createId(), createdAt: now(), source: { ...pending.saved.source, identity: chatIdentity(ctx) }, name: ('分支起点 · ' + pending.saved.name).slice(0, 120) });
            store.checkpoints.push(checkpoint); fitCheckpoints(store);
            operations.stage({ label: '恢复新分支的检查点状态', patches: [...patches, { path: [KEY], value: store }], summary: { kind: 'branch-restored', name: pending.saved.name, branch: name, changes: moduleChanges(before, effective), warnings } }, token);
            const result = await operations.confirm();
            branchMessage = '已创建「' + name + '」并恢复检查点状态。'; return { ...result, branch: name };
        } catch (error) {
            branchMessage = name ? '已创建「' + name + '」，但检查点状态尚未完成保存：' + error.message + '。请在此分支重试保存或重新预览恢复，勿再次创建分支。'
                : branchStarted ? '酒馆分支调用未完成，可能已建立分支：' + error.message + '。请先检查聊天列表，勿重复创建。' : '创建分支未完成：' + error.message;
            throw Error(branchMessage, { cause: error });
        } finally { release(); branching = false; notify(); }
    }
    function preview() {
        if (!branchPending) return operations.preview();
        const { token, saved, ...value } = branchPending; return { ...clone(value), patches: [] };
    }
    function confirm() {
        if (branchPending) return confirmBranch();
        if (operations.preview()?.patches.some(patch => patch.path[0] === 'dynamicMapV1')) assertMapReady(getContext(), { allowEmpty: true });
        branchMessage = ''; return operations.confirm();
    }
    function scheduleCheckpoint() {
        // The reply is still changing the tail; GENERATION_ENDED/STOPPED schedules again.
        if (!autoCheckpoints || !hostListeners.length || disposed || branching || generationActive()) return;
        clearTimeout(timer);
        let token;
        try { token = capture(); } catch { return; }
        timer = setTimeout(async () => {
            timer = null;
            if (disposed || branching || branchPending || generationActive() || operations.preview() || operations.busy() || operations.dirty()) return;
            try { operations.check(token); await captureCheckpoint({ automatic: true }); }
            catch (error) { if (!['STALE_CONTEXT', 'STALE_BASIS', 'STALE_COMPLETION'].includes(error?.code)) { checkpointMessage = '自动检查点未记录：' + error.message; notify(); } }
        }, 400);
        timer?.unref?.();
    }
    const ctx = getContext(), events = ctx?.eventTypes ?? ctx?.event_types ?? {}, source = ctx?.eventSource;
    if (autoCheckpoints && source?.on) {
        for (const key of ['GENERATION_STARTED', 'CHAT_CHANGED', 'MESSAGE_RECEIVED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'GENERATION_ENDED', 'GENERATION_STOPPED']) {
            const event = events[key]; if (!event) continue;
            const callback = key === 'GENERATION_STARTED'
                ? (type, _options, dryRun) => { if (type !== 'quiet' && !dryRun) { generating = true; clearTimeout(timer); timer = null; } }
                : () => { if (['CHAT_CHANGED', 'GENERATION_ENDED', 'GENERATION_STOPPED'].includes(key)) generating = false; scheduleCheckpoint(); };
            source.on(event, callback);
            hostListeners.push(() => { if (source.removeListener) source.removeListener(event, callback); else source.off?.(event, callback); });
        }
        scheduleCheckpoint();
    }
    return { context: getContext, capture, check: operations.check, read: () => readStore(getContext()), stageSave, stageRestore, stageImport, stageDelete, stageCheckpointSettings, captureCheckpoint, stageBranch,
        branchAvailability: id => branchAvailability(getContext(), find(id)), checkpointStatus: () => checkpointMessage,
        inspectImport: parseImport, exportSave: id => JSON.stringify(validateSnapshot(find(id)), null, 2), preview, confirm,
        async retrySave() { const result = await operations.retrySave(); branchMessage = ''; checkpointMessage = ''; return result; },
        discard() { branchPending = null; branchMessage = ''; operations.discard(); }, status: () => branchMessage || operations.status(), busy: () => branching || operations.busy(), dirty: operations.dirty,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        dispose() { disposed = true; clearTimeout(timer); for (const release of hostListeners) release(); off(); offState(); operations.dispose(); listeners.clear(); },
    };
}
let shared;
export const getSharedSavesService = getContext => shared ??= createSavesService(getContext);
