import { KEY, FORMAT, LIMITS, readStore, validateStore, validateSnapshot, parseImport, validateCheckpointSettings, candidateBinding, upgradeStore, itemOf, refOf, modulesHash } from './model.js';
import { MODULE_LABELS, RESTORE_DEPENDENCIES, materialize, restorePatches, moduleChanges } from './adapters.js';
import { createOperationService, chatIdentity, chatPath, subscribeStateChanges, acquireMetadataWrite } from '../shared/operations.js';
import { branchAvailability, assertOpenedBranch, loadBranchHost as defaultLoadBranchHost } from './branch.js';
import { uuid } from '../../uuid.js';
import { assertMapReady } from '../map/src/integrations/runtime.js';
import { isIndependent, readModule, STATE_KEY } from '../story-state/access.js';
import { createIndependentBackups, ringEntry, ringRef, trimRing } from '../story-state/backups.js';

const clone = value => structuredClone(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const names = saved => Object.keys(MODULE_LABELS).filter(key => saved.modules[key] != null).map(key => MODULE_LABELS[key]);
const newestFirst = (left, right) => Date.parse(right.at ?? right.snapshot.createdAt) - Date.parse(left.at ?? left.snapshot.createdAt);
const legacyEntries = legacy => [...(legacy?.backups ?? []).map(snapshot => ringEntry(snapshot, { kind: 'before-restore' })),
    ...(legacy?.checkpoints ?? []).map(snapshot => ringEntry(snapshot, { kind: 'auto' }))]
    .sort((left, right) => Date.parse(right.snapshot.createdAt) - Date.parse(left.snapshot.createdAt));

/**
 * Named saves and the backup ring live in the external extension store; chat
 * metadata keeps references {id, hash, revision, kind, at, label}. Without that
 * store, named saves stay inline and at most two ring snapshots are kept inline.
 * Version 1 metadata (full snapshots) stays readable and moves out on the next write.
 */
export function createSavesService(getContext = () => globalThis.SillyTavern?.getContext?.(), {
    createId = uuid, now = () => new Date().toISOString(), loadBranchHost = defaultLoadBranchHost, autoCheckpoints = true, backups,
} = {}) {
    const operations = createOperationService(getContext), listeners = new Set(), hostListeners = [];
    const storage = backups ?? createIndependentBackups(getContext, { now });
    let branchPending = null, branching = false, branchMessage = '', checkpointMessage = '', timer = null, disposed = false, generating = false;
    let plan = null, external = null, loading = null, externalError = '', attempted = null;
    const generationActive = () => { const stream = getContext()?.streamingProcessor; return generating || (!!stream && stream.isFinished === false); };
    const notify = () => { for (const fn of listeners) { try { fn(); } catch {} } };
    const capture = () => operations.capture([[KEY], ...RESTORE_DEPENDENCIES]);
    const available = () => { try { return storage.available(); } catch { return false; } };
    const off = operations.subscribe(notify);
    const offState = subscribeStateChanges((detail, metadata) => {
        notify();
        if (detail.phase === 'saved' && metadata === getContext()?.chatMetadata && detail.paths.some(path => path[0] !== KEY)) scheduleCheckpoint();
    });

    // External lists are cached per chat; display falls back to metadata while loading.
    const loadedFor = ctx => !!ctx?.chatMetadata && available() && external?.metadata === ctx.chatMetadata && external.identity === chatIdentity(ctx);
    function remember(ctx, ring, named) { external = { metadata: ctx.chatMetadata, identity: chatIdentity(ctx), ring: clone(ring), named: clone(named) }; externalError = ''; }
    async function load(ctx = getContext()) {
        if (!available()) { external = null; return null; }
        const [{ entries: ring }, { entries: named }] = await Promise.all([storage.readRing(ctx), storage.readNamed(ctx)]);
        const current = getContext();
        if (current?.chatMetadata === ctx.chatMetadata && chatIdentity(current) === chatIdentity(ctx)) remember(ctx, ring, named);
        return external;
    }
    // One automatic read per loaded chat. The read's own refresh calls read()
    // again, so a failed or discarded read must not start another by itself;
    // reloadExternal() retries on request.
    function ensureLoaded(ctx) {
        if (!ctx?.chatMetadata || !available() || loadedFor(ctx) || loading?.metadata === ctx.chatMetadata) return;
        if (attempted?.metadata === ctx.chatMetadata && attempted.identity === chatIdentity(ctx)) return;
        attempted = { metadata: ctx.chatMetadata, identity: chatIdentity(ctx) };
        const request = { metadata: ctx.chatMetadata };
        request.promise = load(ctx).catch(error => { if (getContext()?.chatMetadata === request.metadata) externalError = '外置存档读取失败：' + error.message; })
            .finally(() => { if (loading === request) loading = null; if (!disposed) notify(); });
        loading = request;
    }
    function placeholder(item, ctx) {
        const note = !available() ? '外置存储当前不可用，这份记录暂时无法读取。' : loadedFor(ctx) ? '外置存储中找不到这份记录。' : externalError || '正在从外置存储读取…';
        return { format: FORMAT, version: 1, id: item.id, name: item.label, note, createdAt: item.at, source: {}, modules: {}, unavailable: true };
    }
    /** Every visible record with its full snapshot when one is readable. */
    function known(ctx = getContext()) {
        const store = upgradeStore(readStore(ctx)), loaded = loadedFor(ctx) ? external : null;
        const named = loaded ? loaded.named.map(snapshot => ({ ...refOf(itemOf(snapshot, 'named')), snapshot }))
            : store.saves.map(item => ({ ...item, snapshot: item.snapshot ?? null }));
        if (loaded) for (const item of store.saves) if (item.snapshot && !named.some(row => row.id === item.id)) named.push(item);
        const ring = loaded ? loaded.ring.map(entry => ({ ...ringRef(entry), snapshot: entry.snapshot }))
            : store.ring.map(item => ({ ...item, snapshot: item.snapshot ?? null }));
        if (loaded) for (const item of store.ring) if (item.snapshot && !ring.some(row => row.id === item.id)) ring.push(item);
        ring.sort(newestFirst);
        const legacy = legacyEntries(store.legacy).map(entry => ({ ...ringRef(entry), snapshot: entry.snapshot, legacy: true }));
        return { store, named, ring, legacy };
    }
    function find(id, ctx = getContext()) {
        const { named, ring, legacy } = known(ctx), item = [...named, ...ring, ...legacy].find(row => row.id === id);
        if (!item) throw Error('存档已不存在。');
        if (!item.snapshot) { ensureLoaded(ctx); throw Error(placeholder(item, ctx).note); }
        return clone(item.snapshot);
    }

    function snapshot(ctx, { name, note = '' }, modules = materialize(ctx)) {
        const path = chatPath(ctx.chat), candidate = ctx.chat?.at(-1)?.swipe_id ?? 0;
        return validateSnapshot({ format: FORMAT, version: 1, id: createId(), name: String(name ?? '').trim(), note, createdAt: now(),
            source: { identity: chatIdentity(ctx), floor: path.length, candidate, path, candidateBinding: candidateBinding(path,candidate) }, modules });
    }
    const revisionOf = ctx => isIndependent(ctx) ? ctx.chatMetadata[STATE_KEY]?.revision ?? null : null;
    function ensureIdle() {
        if (branching) throw Error('正在创建并恢复分支，请稍候。');
        if (branchPending) throw Error('请先确认或取消创建分支预览。');
    }

    // ops: { addNamed, remove: ids, push: ring entries, settings, trim: limit }
    function namedList(list, inline, ops) {
        const removed = new Set(ops.remove ?? []);
        let next = [...list];
        for (const saved of inline) if (!next.some(item => item.id === saved.id)) next.push(saved);
        if (ops.addNamed) {
            if (next.some(item => item.id === ops.addNamed.id)) throw Error('该存档编号已存在，请使用已有存档。');
            next.push(ops.addNamed);
        }
        next = next.filter(item => !removed.has(item.id));
        if (next.length > LIMITS.saves) throw Error('最多保留 ' + LIMITS.saves + ' 个命名存档，请先导出或删除旧存档。');
        return next;
    }
    /** The new metadata store from current metadata and (when present) the resulting external lists. */
    function compose(store, ops, ext) {
        const removed = new Set(ops.remove ?? []), settings = ops.settings ?? store.checkpointSettings;
        const next = { version: 2, saves: [], ring: [], checkpointSettings: clone(settings) };
        const keep = items => items.filter(item => !removed.has(item.id));
        if (ext) {
            next.saves = ext.named.map(saved => refOf(itemOf(saved, 'named')));
            next.ring = ext.ring.map(ringRef);
            if (!ext.migrated) {
                next.ring.push(...keep(store.ring.filter(item => item.snapshot && !next.ring.some(ref => ref.id === item.id))));
                if (store.legacy) next.legacy = { backups: keep(store.legacy.backups), checkpoints: keep(store.legacy.checkpoints) };
            }
        } else {
            const refs = keep(store.saves.filter(item => !item.snapshot));
            next.saves = [...refs, ...namedList([], store.saves.filter(item => item.snapshot).map(item => item.snapshot), ops).map(saved => itemOf(saved, 'named'))];
            if (next.saves.length > LIMITS.saves) throw Error('最多保留 ' + LIMITS.saves + ' 个命名存档，请先导出或删除旧存档。');
            let ring = keep(store.ring);
            for (const entry of ops.push ?? []) {
                if (ring.some(item => item.id === entry.snapshot.id || entry.revision !== null && item.revision === entry.revision)) continue;
                ring.unshift(itemOf(entry.snapshot, entry.kind, entry.revision));
            }
            ring.sort(newestFirst);
            const inline = ring.filter(item => item.snapshot).slice(0, LIMITS.inlineRing);
            ring = ring.filter(item => !item.snapshot || inline.includes(item));
            if (ops.trim !== undefined) ring = ring.slice(0, ops.trim);
            next.ring = ring.slice(0, LIMITS.ring);
            if (store.legacy) next.legacy = { backups: keep(store.legacy.backups), checkpoints: keep(store.legacy.checkpoints) };
        }
        if (next.legacy && !next.legacy.backups.length && !next.legacy.checkpoints.length) delete next.legacy;
        return validateStore(next);
    }
    /** Writes external records first: a chat never refers to a record that does not exist. */
    async function writeExternal(ctx, store, ops) {
        const inlineNamed = store.saves.filter(item => item.snapshot).map(item => item.snapshot);
        const named = ops.addNamed || ops.remove?.length || inlineNamed.length
            ? await storage.writeNamed(ctx, list => { const next = namedList(list, inlineNamed, ops); return same(next, list) ? null : next; })
            : (await storage.readNamed(ctx)).entries;
        const migrating = [...store.ring.filter(item => item.snapshot).map(item => ringEntry(item.snapshot, { kind: item.kind, revision: item.revision })),
            ...legacyEntries(store.legacy)];
        let migrated = true, added = [], ring;
        if (migrating.length) {
            try { await storage.append(ctx, migrating); }
            catch (error) { migrated = false; checkpointMessage = '旧检查点暂未迁出聊天，原资料保留：' + error.message; }
        }
        if (ops.push?.length) {
            const result = await storage.push(ctx, ops.push, { limit: (ops.settings ?? store.checkpointSettings).limit });
            ring = result.entries; added = result.added ?? [];
        }
        if (ops.remove?.length || ops.trim !== undefined) ring = (await storage.remove(ctx, ops.remove ?? [], { limit: ops.trim })).entries;
        ring ??= (await storage.readRing(ctx)).entries;
        return { ring, named, migrated, added, migratedAny: migrated && migrating.length > 0 };
    }
    function predict(ctx, store, ops) {
        if (!available()) return null;
        const loaded = loadedFor(ctx) ? external : { ring: [], named: [] };
        const removed = new Set(ops.remove ?? []), inline = store.ring.filter(item => item.snapshot).map(item => ringEntry(item.snapshot, { kind: item.kind, revision: item.revision }));
        let ring = [...loaded.ring, ...inline, ...legacyEntries(store.legacy)];
        const fresh = (ops.push ?? []).filter(entry => !ring.some(old => old.snapshot.id === entry.snapshot.id || entry.revision !== null && old.revision === entry.revision));
        ring = trimRing([...fresh, ...ring], (ops.settings ?? store.checkpointSettings).limit, ring.length).filter(entry => !removed.has(entry.snapshot.id));
        if (ops.trim !== undefined) ring = ring.slice(0, ops.trim);
        return { ring, named: namedList(loaded.named, store.saves.filter(item => item.snapshot).map(item => item.snapshot), ops), migrated: true };
    }
    async function apply(token, { label, ops, summary, extraPatches = [] }, { disposable = false, skipUnchanged = false } = {}) {
        let ctx = operations.check(token);
        const raw = ctx.chatMetadata[KEY], store = upgradeStore(readStore(ctx));
        const ext = available() ? await writeExternal(ctx, store, ops) : null;
        ctx = operations.check(token);
        const next = compose(store, ops, ext);
        if (ext) remember(ctx, ext.ring, ext.named);
        if (skipUnchanged && !ext?.added.length && !ext?.migratedAny && same(next, raw)) return { unchanged: true };
        if (skipUnchanged && ext && !ext.added.length && !ext.migratedAny) return { unchanged: true, duplicate: true };
        operations.stage({ label, patches: [...extraPatches, { path: [KEY], value: next }], summary }, token);
        return operations.confirm({ disposable });
    }
    function stagePlan(input, token) {
        ensureIdle();
        const ctx = operations.check(token), store = upgradeStore(readStore(ctx));
        const next = compose(store, input.ops, predict(ctx, store, input.ops));
        const result = operations.stage({ label: input.label, patches: [...(input.extraPatches ?? []), { path: [KEY], value: next }], summary: input.summary }, token);
        plan = { ...input, token, operationId: result.operationId };
        return result;
    }

    function stageSave(input, token = capture()) {
        const ctx = operations.check(token), saved = snapshot(ctx, input);
        if (known(ctx).named.length >= LIMITS.saves) throw Error('最多保留 ' + LIMITS.saves + ' 个命名存档，请先导出或删除旧存档。');
        return stagePlan({ label: '建立当前剧情存档', ops: { addNamed: saved }, summary: { kind: 'save', name: saved.name, snapshot: { id: saved.id, name: saved.name, createdAt: saved.createdAt, source: saved.source }, moduleNames: names(saved), changes: [], warnings: [] } }, token);
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
        const ctx = operations.check(token), saved = typeof input === 'string' ? find(input, ctx) : validateSnapshot(input);
        const backup = snapshot(ctx, { name: ('恢复前 · ' + saved.name).slice(0, 120), note: '自动备份：在当前楼层应用存档前的剧情状态。' });
        const { patches, warnings, before, effective } = prepareRestore(ctx, saved);
        if (saved.source.identity !== chatIdentity(ctx)) warnings.push('来源为其他聊天；只应用插件剧情状态，不导入原聊天消息。');
        return stagePlan({ label: '将存档应用到当前楼层', ops: { push: [ringEntry(backup, { kind: 'before-restore', revision: revisionOf(ctx) })] }, extraPatches: patches,
            summary: { kind: 'restore', name: saved.name, source: clone(saved.source), backup: { id: backup.id, name: backup.name, createdAt: backup.createdAt }, moduleNames: names(saved), changes: moduleChanges(before, effective), warnings } }, token);
    }
    function stageImport(raw, token = capture()) {
        const ctx = operations.check(token), saved = parseImport(raw), { named, ring, legacy } = known(ctx);
        if (named.length >= LIMITS.saves) throw Error('存档数量已达上限。');
        if ([...named, ...ring, ...legacy].some(item => item.id === saved.id)) throw Error('该存档编号已存在，请使用已有存档。');
        return stagePlan({ label: '导入存档到当前聊天', ops: { addNamed: saved }, summary: { kind: 'import', name: saved.name, snapshot: { id: saved.id, name: saved.name, createdAt: saved.createdAt, source: saved.source }, moduleNames: names(saved), changes: [], warnings: ['导入仅添加存档，恢复需要另行预览确认。'] } }, token);
    }
    function stageDelete(id, token = capture()) {
        const ctx = operations.check(token), { named, ring, legacy } = known(ctx), item = [...named, ...ring, ...legacy].find(row => row.id === id);
        if (!item) throw Error('存档已不存在。');
        return stagePlan({ label: '删除存档', ops: { remove: [id] }, summary: { kind: 'delete', name: item.label, changes: [], warnings: [] } }, token);
    }
    function stageCheckpointSettings(input, token = capture()) {
        operations.check(token); const settings = validateCheckpointSettings(input);
        return stagePlan({ label: '调整楼层检查点', ops: { settings, trim: settings.limit }, summary: { kind: 'checkpoint-settings', name: settings.enabled ? '自动记录 · 最近 ' + settings.limit + ' 份' : '暂停自动记录', changes: [], warnings: ['自动检查点、恢复前备份和操作前备份共用这一数量上限；减少数量会移除最早的记录。命名存档保留。'] } }, token);
    }
    async function captureCheckpoint({ automatic = false } = {}) {
        ensureIdle();
        if (operations.preview()) throw Error('请先确认或取消当前预览，再记录检查点。');
        const token = capture(), ctx = operations.check(token), store = upgradeStore(readStore(ctx));
        if (automatic && !store.checkpointSettings.enabled) return null;
        if (!ctx.chat?.length) return null;
        // Only chats with Amin story data or saves the user already made get automatic records;
        // any other chat is left untouched.
        if (automatic && !isIndependent(ctx) && ctx.chatMetadata[KEY] === undefined) return null;
        const revision = revisionOf(ctx);
        if (available() && !loadedFor(ctx)) await load(ctx);
        const ring = known(ctx).ring, existing = revision === null ? null : ring.find(item => item.revision === revision);
        if (existing) return existing.snapshot ? clone(existing.snapshot) : null;
        assertMapReady(ctx, { allowEmpty: true });
        const modules = isIndependent(ctx) ? { ...materialize(ctx), informationLibrary: null, linkage: null } : materialize(ctx);
        const saved = snapshot(ctx, { name: '第 ' + ctx.chat.length + ' 楼 · 候选 ' + ((ctx.chat.at(-1)?.swipe_id ?? 0) + 1), note: '在该消息与候选实际处于聊天末尾时记录的完整剧情状态。' }, modules);
        // Without a revision (chats not yet on independent storage) the same state at the same tail is one record.
        const hash = modulesHash(modules), twin = ring.find(item => item.hash === hash && item.snapshot
            && same(item.snapshot.source.path, saved.source.path) && item.snapshot.source.candidate === saved.source.candidate);
        if (twin) return clone(twin.snapshot);
        const result = await apply(token, { label: '记录当前楼层检查点', ops: { push: [ringEntry(saved, { kind: 'auto', revision })] },
            summary: { kind: 'checkpoint', name: saved.name, moduleNames: names(saved), changes: [], warnings: [] } }, { disposable: automatic, skipUnchanged: true });
        checkpointMessage = ''; notify();
        return result?.duplicate ? null : clone(saved);
    }
    function stageBranch(id, token = capture()) {
        ensureIdle();
        if (operations.preview()) throw Error('请先确认或取消当前预览。');
        const ctx = operations.check(token), saved = validateSnapshot(find(id, ctx)), availability = branchAvailability(ctx, saved);
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
            const token = capture(), { patches, warnings, before, effective } = prepareRestore(ctx, pending.saved);
            const checkpoint = validateSnapshot({ ...pending.saved, id: createId(), createdAt: now(), source: { ...pending.saved.source, identity: chatIdentity(ctx) }, name: ('分支起点 · ' + pending.saved.name).slice(0, 120) });
            const result = await apply(token, { label: '恢复新分支的检查点状态', ops: { push: [ringEntry(checkpoint, { kind: 'auto' })] }, extraPatches: patches,
                summary: { kind: 'branch-restored', name: pending.saved.name, branch: name, changes: moduleChanges(before, effective), warnings } });
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
    // Map and preview checks throw synchronously, before anything is written.
    function confirm() {
        if (branchPending) return confirmBranch();
        const pending = operations.preview();
        if (pending?.patches.some(patch => patch.path[0] === 'dynamicMapV1')) assertMapReady(getContext(), { allowEmpty: true });
        branchMessage = '';
        const current = plan; plan = null;
        if (!current || current.operationId !== pending?.operationId) return operations.confirm();
        return apply(current.token, current).catch(error => {
            if (!operations.preview() && !operations.dirty()) { try { operations.stage({ label: pending.label, patches: pending.patches, summary: pending.summary }, current.token); plan = { ...current, operationId: operations.preview()?.operationId }; } catch {} }
            throw error;
        });
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
        // Opening or rendering a chat is not a story change: only replies, swipes and
        // saved story writes (state 'saved' events) may record a checkpoint.
        for (const key of ['GENERATION_STARTED', 'CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'GENERATION_ENDED', 'GENERATION_STOPPED']) {
            const event = events[key]; if (!event) continue;
            const callback = key === 'GENERATION_STARTED'
                ? (type, _options, dryRun) => { if (type !== 'quiet' && !dryRun) { generating = true; clearTimeout(timer); timer = null; } }
                : key === 'CHAT_CHANGED' ? () => { generating = false; clearTimeout(timer); timer = null; }
                : (_index, type) => { if (['GENERATION_ENDED', 'GENERATION_STOPPED'].includes(key)) generating = false; if (type !== 'first_message') scheduleCheckpoint(); };
            source.on(event, callback);
            hostListeners.push(() => { if (source.removeListener) source.removeListener(event, callback); else source.off?.(event, callback); });
        }
    }
    function read() {
        const ctx = getContext(), { store, named, ring, legacy } = known(ctx);
        ensureLoaded(ctx);
        // Readable records are plain snapshots, so callers may pass them back to restore or export.
        const full = item => item.snapshot ? clone(item.snapshot) : placeholder(item, ctx);
        const oldestFirst = items => [...items].sort(newestFirst).reverse().map(full);
        return { version: 2, checkpointSettings: clone(store.checkpointSettings),
            saves: named.map(full), backups: oldestFirst([...ring, ...legacy].filter(item => item.kind === 'before-restore')),
            checkpoints: oldestFirst([...ring, ...legacy].filter(item => item.kind !== 'before-restore')),
            storage: { external: available(), loaded: loadedFor(ctx), error: externalError, legacy: !!store.legacy || ctx?.chatMetadata?.[KEY]?.version === 1 } };
    }
    function safeAvailability(id) {
        try { return branchAvailability(getContext(), find(id)); }
        catch (error) { return { available: false, reason: error.message }; }
    }
    return { context: getContext, capture, check: operations.check, read, load: () => load(getContext()), stageSave, stageRestore, stageImport, stageDelete, stageCheckpointSettings, captureCheckpoint, stageBranch,
        branchAvailability: safeAvailability, checkpointStatus: () => checkpointMessage || externalError,
        inspectImport: parseImport, exportSave: id => JSON.stringify(validateSnapshot(find(id)), null, 2), preview, confirm,
        async retrySave() { const result = await operations.retrySave(); branchMessage = ''; checkpointMessage = ''; return result; },
        discard() { branchPending = null; branchMessage = ''; plan = null; operations.discard(); }, status: () => branchMessage || operations.status(), busy: () => branching || operations.busy(), dirty: operations.dirty,
        reloadExternal() { if (loading) return; attempted = null; external = null; externalError = ''; notify(); },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        dispose() { disposed = true; clearTimeout(timer); for (const release of hostListeners) release(); off(); offState(); operations.dispose(); listeners.clear(); },
    };
}
let shared;
export const getSharedSavesService = getContext => shared ??= createSavesService(getContext);
