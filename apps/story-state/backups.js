import { assertChatReady } from '../shared/chat-lifecycle.js';
import { chatIdentity, chatPath } from '../shared/operations.js';
import { sha256HexSync } from '../tts/source-hash.js';
import { validateJSON, validateSnapshot, candidateBinding, ringLimit, modulesHash, RING_KINDS, FORMAT as SNAPSHOT_FORMAT, LIMITS as SAVE_LIMITS } from '../saves/model.js';
import { KEY, validateState, stateHash, canonicalJSON } from './schema.js';

export const BACKUP_NAMESPACE = 'amin-os';
export const BACKUP_TABLE = 'amin-state-backups-v1';
export const BACKUP_OWNER = 'amin-os/independent-backups-v1';
export const NAMED_OWNER = 'amin-os/named-saves-v1';
export const BACKUP_FORMAT = 'amin-os-independent-backups';
export const LEGACY_TABLE = 'amin-state-legacy-source-v1';
export const LEGACY_OWNER = 'amin-os/legacy-source-v1';
export const LEGACY_FORMAT = 'amin-os-legacy-source';
/** One ring per chat: automatic checkpoints, pre-restore and pre-change backups. */
export { RING_KINDS, modulesHash };
export const RING_MAX = SAVE_LIMITS.ring;
const MAX_BYTES = 192 * 1024 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const locks = new WeakMap();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const clone = value => structuredClone(value);
export const backupKey = identity => 'backups-' + sha256HexSync(identity);
export const namedKey = identity => 'saves-' + sha256HexSync(identity);
export const legacySourceKey = identity => 'legacy-' + sha256HexSync(identity);
const recordHash = value => 'sha256:' + sha256HexSync(canonicalJSON(value));
const seal = value => ({ ...value, hash: recordHash(value) });
const validRevision = value => value === null || Number.isSafeInteger(value) && value >= 0;

/** Ring entries carry a full save snapshot; chat metadata keeps only this reference. */
export function ringRef(entry) {
    return { id: entry.snapshot.id, hash: entry.hash, revision: entry.revision, kind: entry.kind, at: entry.snapshot.createdAt, label: entry.snapshot.name };
}
export function validateRingEntry(entry) {
    if (!plain(entry) || Object.keys(entry).sort().join(',') !== 'hash,kind,revision,snapshot'
        || !RING_KINDS.includes(entry.kind) || !validRevision(entry.revision) || !HASH.test(entry.hash ?? ''))
        fail('AMIN_BACKUP_INVALID', 'Amin 备份条目格式无效。');
    const snapshot = validateSnapshot(entry.snapshot);
    if (modulesHash(snapshot.modules) !== entry.hash) fail('AMIN_BACKUP_CORRUPT', 'Amin 备份状态校验不一致，已停止读取。');
    return { kind: entry.kind, revision: entry.revision, hash: entry.hash, snapshot };
}
export function ringEntry(snapshot, { kind, revision = null }) {
    return validateRingEntry({ kind, revision, hash: modulesHash(snapshot.modules), snapshot });
}
export function stateSnapshot(ctx, state, { label, kind = 'before-change', at = new Date().toISOString(), note = '' }) {
    const path = chatPath(ctx.chat ?? []), candidate = ctx.chat?.at(-1)?.swipe_id ?? 0, hash = modulesHash(state.modules);
    const source = { identity: chatIdentity(ctx), floor: path.length, candidate };
    if (path.length) Object.assign(source, { path, candidateBinding: candidateBinding(path, candidate) });
    return ringEntry({ format: SNAPSHOT_FORMAT, version: 1, id: `r${state.revision}-${hash.slice(7)}`, name: label, note, createdAt: at,
        source, modules: clone(state.modules) }, { kind, revision: state.revision });
}
function legacyEntry(entry, identity) {
    if (!plain(entry) || Object.keys(entry).sort().join(',') !== 'at,hash,id,label,state'
        || typeof entry.id !== 'string' || !/^r[0-9]+-[a-f0-9]{64}$/u.test(entry.id)
        || !HASH.test(entry.hash ?? '') || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
        || typeof entry.label !== 'string' || entry.label.length > 160)
        fail('AMIN_BACKUP_INVALID', 'Amin 最近备份条目无效或重复。');
    const state = validateState(entry.state), hash = stateHash(state);
    if (hash !== entry.hash || entry.id !== `r${state.revision}-${hash.slice(7)}`)
        fail('AMIN_BACKUP_CORRUPT', 'Amin 备份状态校验不一致，已停止读取。');
    return ringEntry({ format: SNAPSHOT_FORMAT, version: 1, id: entry.id, name: entry.label.slice(0, 120) || '操作前状态',
        note: '', createdAt: entry.at, source: { identity, floor: 0, candidate: 0 }, modules: state.modules }, { kind: 'before-change', revision: state.revision });
}
/** Reads v1 (five pre-change states) and v2 ring records; always returns v2 entries. */
export function validateBackupRecord(input, identity) {
    validateJSON(input, MAX_BYTES);
    const v1 = plain(input) && input.version === 1;
    if (!plain(input) || Object.keys(input).sort().join(',') !== 'chat,entries,hash,owner,version'
        || ![1, 2].includes(input.version) || input.owner !== BACKUP_OWNER || input.chat !== identity
        || !Array.isArray(input.entries) || input.entries.length > (v1 ? 5 : RING_MAX) || !HASH.test(input.hash ?? ''))
        fail('AMIN_BACKUP_INVALID', 'Amin 备份格式、归属或数量无效，原文件未改写。');
    const { hash, ...data } = input;
    if (recordHash(data) !== hash) fail('AMIN_BACKUP_CORRUPT', 'Amin 备份文件校验不一致，已停止读取。');
    const entries = input.entries.map(entry => v1 ? legacyEntry(entry, identity) : validateRingEntry(entry)), ids = new Set();
    for (const entry of entries) {
        if (ids.has(entry.snapshot.id)) fail('AMIN_BACKUP_INVALID', 'Amin 备份条目编号重复。');
        ids.add(entry.snapshot.id);
    }
    return entries;
}
export function validateNamedRecord(input, identity) {
    validateJSON(input, MAX_BYTES);
    if (!plain(input) || Object.keys(input).sort().join(',') !== 'chat,entries,hash,owner,version'
        || input.version !== 1 || input.owner !== NAMED_OWNER || input.chat !== identity
        || !Array.isArray(input.entries) || input.entries.length > SAVE_LIMITS.saves || !HASH.test(input.hash ?? ''))
        fail('AMIN_BACKUP_INVALID', 'Amin 命名存档文件格式、归属或数量无效，原文件未改写。');
    const { hash, ...data } = input;
    if (recordHash(data) !== hash) fail('AMIN_BACKUP_CORRUPT', 'Amin 命名存档文件校验不一致，已停止读取。');
    const entries = input.entries.map(validateSnapshot);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail('AMIN_BACKUP_INVALID', 'Amin 命名存档编号重复。');
    return entries;
}
export function validateLegacySource(input, identity) {
    validateJSON(input, MAX_BYTES);
    if (!plain(input) || Object.keys(input).sort().join(',') !== 'at,chat,hash,owner,sources,version'
        || input.version !== 1 || input.owner !== LEGACY_OWNER || input.chat !== identity || !plain(input.sources)
        || typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at)) || !HASH.test(input.hash ?? ''))
        fail('AMIN_LEGACY_SOURCE_INVALID', '原始旧资料归档格式或归属无效，未覆盖。');
    const { hash, ...data } = input;
    if (recordHash(data) !== hash) fail('AMIN_LEGACY_SOURCE_CORRUPT', '原始旧资料归档校验不一致，未覆盖。');
    return clone(input);
}

/** Separate backup table; expected/readback checks are not cross-device CAS. */
export function createIndependentBackupFileStore({ getHostWindow = () => globalThis.window } = {}) {
    const api = () => {
        const host = getHostWindow(), store = host?.__TAURITAVERN__?.api?.extension?.store;
        return typeof store?.tryGetJson === 'function' && typeof store?.setJson === 'function' ? store : null;
    };
    async function requireApi() {
        const host = getHostWindow(), ready = host?.__TAURITAVERN__?.ready ?? host?.__TAURITAVERN_MAIN_READY__;
        if (ready && typeof ready.then === 'function') await ready;
        const store = api();
        if (!store) fail('AMIN_BACKUP_UNAVAILABLE', '外部备份存储不可用；当前 Amin 状态仍随聊天保存。');
        return store;
    }
    async function read(store, key, table = BACKUP_TABLE) {
        const result = await store.tryGetJson({ namespace: BACKUP_NAMESPACE, table, key });
        const found = plain(result) && Object.getOwnPropertyDescriptor(result, 'found');
        if (!found || !Object.hasOwn(found, 'value') || typeof found.value !== 'boolean')
            fail('AMIN_BACKUP_RESPONSE_INVALID', '外部备份存储读取结果无效。');
        if (!found.value) return null;
        const value = Object.getOwnPropertyDescriptor(result, 'value');
        if (!value || !Object.hasOwn(value, 'value')) fail('AMIN_BACKUP_RESPONSE_INVALID', '外部备份存储没有返回有效记录。');
        validateJSON(value.value, MAX_BYTES);
        if (!plain(value.value)) fail('AMIN_BACKUP_INVALID', '外部备份记录无法解析，未覆盖。');
        return clone(value.value);
    }
    function checkedKey(key, legacy = false) {
        if (typeof key !== 'string' || !(legacy ? /^legacy-[a-f0-9]{64}$/u : /^(?:backups|saves)-[a-f0-9]{64}$/u).test(key))
            fail('AMIN_BACKUP_KEY_INVALID', '备份文件标识无效。');
        return key;
    }
    async function write(table, key, value, { expected } = {}) {
            checkedKey(key, table === LEGACY_TABLE); validateJSON(value, MAX_BYTES);
            if (!plain(value) || expected === undefined) fail('AMIN_BACKUP_EXPECTED_REQUIRED', '写入备份必须提供完整预期旧记录或 null。');
            if (table === LEGACY_TABLE && expected !== null) fail('AMIN_LEGACY_IMMUTABLE', '原始旧资料只能归档一次，不能覆盖。');
            if (expected !== null) validateJSON(expected, MAX_BYTES);
            const snapshot = clone(value), old = clone(expected), store = await requireApi();
            let pending = locks.get(store); if (!pending) locks.set(store, pending = new Set());
            if (pending.has(key)) fail('AMIN_BACKUP_CONFLICT', '备份文件正在写入，请稍后重试。');
            pending.add(key);
            try {
                const previous = await read(store, key, table);
                if (canonicalJSON(previous) !== canonicalJSON(old)) fail('AMIN_BACKUP_CONFLICT', '备份文件已变化，请重新读取。');
                await store.setJson({ namespace: BACKUP_NAMESPACE, table, key, value: snapshot });
                if (canonicalJSON(await read(store, key, table)) !== canonicalJSON(snapshot))
                    fail('AMIN_BACKUP_WRITE_VERIFY_FAILED', '备份写入后回读校验失败。');
            } finally { pending.delete(key); }
    }
    return {
        available() { try { return !!api(); } catch { return false; } },
        async get(key) { return read(await requireApi(), checkedKey(key)); },
        put: (key, value, options) => write(BACKUP_TABLE, key, value, options),
        async getLegacy(key) { return read(await requireApi(), checkedKey(key, true), LEGACY_TABLE); },
        putLegacy: (key, value, options) => write(LEGACY_TABLE, key, value, options),
    };
}

/** Keep the newest entries; a ring above its limit (after migration) shrinks by one per write. */
export function trimRing(entries, limit, previousLength = entries.length) {
    const target = Math.min(RING_MAX, previousLength > limit ? Math.max(limit, previousLength - 1) : limit);
    return entries.slice(0, target);
}

export function createIndependentBackups(getContext, { files, getHostWindow, now = () => new Date().toISOString() } = {}) {
    if (typeof getContext !== 'function') throw TypeError('独立备份需要聊天上下文接口。');
    files ??= createIndependentBackupFileStore({ getHostWindow });
    const counts = new Map(), queues = new Map();
    const available = () => { try { return typeof files?.get === 'function' && typeof files?.put === 'function'
        && (typeof files.available !== 'function' || files.available()); } catch { return false; } };
    function context(ctx = getContext()) {
        assertChatReady(ctx);
        if (!plain(ctx?.chatMetadata) || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null)
            fail('AMIN_BACKUP_NO_CHAT', '请先打开已经加载完成的聊天。');
        return ctx;
    }
    function token(ctx) { return { metadata: ctx.chatMetadata, identity: chatIdentity(ctx), integrity: ctx.chatMetadata.integrity,
        state: canonicalJSON(ctx.chatMetadata[KEY] ?? null) }; }
    function check(saved, { state = true } = {}) {
        const ctx = context();
        if (ctx.chatMetadata !== saved.metadata || chatIdentity(ctx) !== saved.identity || ctx.chatMetadata.integrity !== saved.integrity
            || state && canonicalJSON(ctx.chatMetadata[KEY] ?? null) !== saved.state)
            fail('AMIN_BACKUP_CONTEXT_CHANGED', '聊天或 Amin 当前状态已变化，备份操作已取消。');
    }
    // Writers of one record run one at a time; a second writer waits instead of failing.
    function serial(key, task) {
        const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
        const tail = run.catch(() => {}); queues.set(key, tail);
        tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
        return run;
    }
    function requireAvailable() { if (!available()) fail('AMIN_BACKUP_UNAVAILABLE', '外部备份存储不可用。'); }
    async function readRing(ctx = getContext(), { checkState = false } = {}) {
        ctx = context(ctx); requireAvailable();
        const saved = token(ctx), raw = await files.get(backupKey(saved.identity)); check(saved, { state: checkState });
        const entries = raw === null ? [] : validateBackupRecord(raw, saved.identity);
        counts.set(saved.identity, entries.length); return { raw, entries };
    }
    async function writeRing(ctx, update, { checkState = false } = {}) {
        ctx = context(ctx); requireAvailable();
        const saved = token(ctx), key = backupKey(saved.identity);
        return serial(key, async () => {
            check(saved, { state: checkState });
            const { raw, entries } = await readRing(ctx, { checkState });
            const result = update(entries.map(clone));
            if (!result.changed) return { ...result, entries };
            const next = seal({ version: 2, owner: BACKUP_OWNER, chat: saved.identity, entries: result.entries });
            validateBackupRecord(next, saved.identity);
            await files.put(key, next, { expected: clone(raw) }); check(saved, { state: checkState });
            counts.set(saved.identity, result.entries.length);
            return { ...result, entries: result.entries };
        });
    }
    /** Adds entries newest-first. A revision already present is never stored again. */
    function push(ctx, added, { limit = ringLimit(ctx ?? getContext()) } = {}) {
        const list = (Array.isArray(added) ? added : [added]).map(validateRingEntry);
        return writeRing(ctx, entries => {
            const fresh = list.filter(entry => !entries.some(old => old.snapshot.id === entry.snapshot.id
                || entry.revision !== null && old.revision === entry.revision));
            if (!fresh.length) return { changed: false, added: [], duplicate: true };
            return { changed: true, added: fresh, entries: trimRing([...fresh, ...entries], limit, entries.length) };
        });
    }
    /** Older entries (such as migrated metadata checkpoints) go after the newest ones. */
    function append(ctx, added) {
        const list = added.map(validateRingEntry);
        return writeRing(ctx, entries => {
            const fresh = list.filter(entry => !entries.some(old => old.snapshot.id === entry.snapshot.id));
            if (!fresh.length) return { changed: false, added: [] };
            const next = [...entries, ...fresh];
            if (next.length > RING_MAX) fail('AMIN_BACKUP_FULL', '外部备份已满，未迁移旧检查点；原资料保留在聊天内。');
            return { changed: true, added: fresh, entries: next };
        });
    }
    function remove(ctx, ids, { limit } = {}) {
        const removed = new Set(ids);
        return writeRing(ctx, entries => {
            let next = entries.filter(entry => !removed.has(entry.snapshot.id));
            if (limit !== undefined) next = next.slice(0, limit);
            return { changed: next.length !== entries.length, entries: next };
        });
    }
    async function list(ctx = getContext()) {
        ctx = context(ctx); if (!available()) return [];
        return (await readRing(ctx)).entries.map(ringRef);
    }
    async function load(ctx, id) {
        if (id === undefined) { id = ctx; ctx = getContext(); }
        const entry = (await readRing(ctx)).entries.find(item => item.snapshot.id === id);
        if (!entry) fail('AMIN_BACKUP_MISSING', '所选备份不在当前聊天的最近备份中，请刷新列表。');
        return entry;
    }
    async function savePrevious(ctx, input, { label = '操作前状态', kind = 'before-change' } = {}) {
        ctx = context(ctx); const state = validateState(input);
        if (!available()) return { saved: false, disabled: true, message: '外部备份不可用，当前状态仍随聊天保存。' };
        if (typeof label !== 'string' || !label.trim() || label.length > 120) fail('AMIN_BACKUP_INVALID', '备份说明无效。');
        const at = now(); if (!Number.isFinite(Date.parse(at))) fail('AMIN_BACKUP_INVALID', '备份时间无效。');
        const entry = stateSnapshot(ctx, state, { label, kind, at }), result = await push(ctx, entry);
        return { saved: !result.duplicate, id: entry.snapshot.id, hash: entry.hash, ...(result.duplicate ? { duplicate: true } : {}) };
    }
    async function readNamed(ctx = getContext()) {
        ctx = context(ctx); requireAvailable();
        const saved = token(ctx), raw = await files.get(namedKey(saved.identity)); check(saved, { state: false });
        return { raw, entries: raw === null ? [] : validateNamedRecord(raw, saved.identity) };
    }
    function writeNamed(ctx, update) {
        ctx = context(ctx); requireAvailable();
        const saved = token(ctx), key = namedKey(saved.identity);
        return serial(key, async () => {
            const { raw, entries } = await readNamed(ctx), next = update(entries.map(clone));
            if (!next) return entries;
            const record = seal({ version: 1, owner: NAMED_OWNER, chat: saved.identity, entries: next });
            validateNamedRecord(record, saved.identity);
            await files.put(key, record, { expected: clone(raw) }); check(saved, { state: false });
            return next;
        });
    }
    async function exportBackups(ctx = getContext()) {
        ctx = context(ctx); requireAvailable();
        const saved = token(ctx), { entries } = await readRing(ctx);
        return { format: BACKUP_FORMAT, version: 2, chat: saved.identity, entries: clone(entries) };
    }
    const legacyAvailable = () => available() && typeof files.getLegacy === 'function' && typeof files.putLegacy === 'function';
    async function archiveLegacy(ctx, sources) {
        ctx = context(ctx); validateJSON(sources, MAX_BYTES);
        if (!plain(sources)) fail('AMIN_LEGACY_SOURCE_INVALID', '原始旧资料必须是原始根字段对象，未归档。');
        if (!legacyAvailable()) return { archived: false, disabled: true, message: '外部原始归档不可用，请将旧资料保留为聊天内的静态源。' };
        const saved = token(ctx), identity = saved.identity, key = legacySourceKey(identity), snapshot = clone(sources);
        const sourceBasis = () => canonicalJSON(Object.fromEntries(Object.keys(snapshot).map(name => [name,
            [Object.hasOwn(ctx.chatMetadata, name), ctx.chatMetadata[name] ?? null]])));
        const beforeSources = sourceBasis();
        const guard = () => { check(saved); if (sourceBasis() !== beforeSources) fail('AMIN_LEGACY_SOURCE_CHANGED', '待归档旧资料已变化，请重新预览。'); };
        const raw = await files.getLegacy(key); guard();
        if (raw !== null) {
            const existing = validateLegacySource(raw, identity);
            if (canonicalJSON(existing.sources) !== canonicalJSON(snapshot))
                fail('AMIN_LEGACY_SOURCE_EXISTS', '本聊天已有不同的原始旧资料归档，不会覆盖；请先导出并检查。');
            return { archived: false, duplicate: true, key, hash: existing.hash };
        }
        const record = seal({ version: 1, owner: LEGACY_OWNER, chat: identity, at: now(), sources: snapshot });
        validateLegacySource(record, identity);
        await files.putLegacy(key, record, { expected: null }); guard();
        return { archived: true, key, hash: record.hash };
    }
    async function exportLegacy(ctx = getContext()) {
        ctx = context(ctx); if (!legacyAvailable()) fail('AMIN_BACKUP_UNAVAILABLE', '外部原始旧资料归档不可用。');
        const saved = token(ctx), raw = await files.getLegacy(legacySourceKey(saved.identity)); check(saved);
        if (raw === null) return null;
        return { format: LEGACY_FORMAT, version: 1, record: validateLegacySource(raw, saved.identity) };
    }
    function status() {
        let limit = 10;
        try { limit = ringLimit(getContext()); } catch { /* default */ }
        try { return { available: !!available(), count: counts.get(chatIdentity(getContext())) ?? 0, limit }; }
        catch { return { available: false, count: 0, limit }; }
    }
    return { available, status, list, load, readRing, push, append, remove, readNamed, writeNamed,
        savePrevious, archiveLegacy, exportLegacy, export: exportBackups, exportBackups };
}
